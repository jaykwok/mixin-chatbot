// What the message service gives the push service (src/push/service.ts PushHost) and the pushers' tools: held attachments
// (a push reply's files), passive conversation notes, and the member extension only a pusher's conversation selects.
import { afterAll, expect, test } from "bun:test";
import type { Message, Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { AttachmentEvent, AttachmentSource } from "../../src/durable/attachments.ts";
import type { ModelSelection } from "../../src/durable/models.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import type { Attachment } from "../../src/durable/records.ts";
import { DurableService, type DurableServiceOptions, type InboundAttachment } from "../../src/durable/service.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { downloadFile } from "../../src/integrations/open-platform/files.ts";
import { appLayout, DIRECT_SCOPE, groupScope } from "../../src/core/layout.ts";
import { PUSH_NOTE_KIND } from "../../src/push/note.ts";
import { PUSH_EXTENSION, pushExtension } from "../../src/push/tools.ts";
import { FakePlatform } from "../helpers/fake-platform.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { DIRECT_SPACE, type Recording, recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { tmpOf } from "../helpers/layout.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import "../helpers/restore-spies.ts";

const fixture = await tempFixture("durable-push-host-");
const platform = new FakePlatform();
const client = new PlatformClient(platform.config, { endpoints: platform.endpoints, retryDelaysMs: [5, 5] });
afterAll(async () => { client.close(); platform.stop(); await fixture.cleanup(); });
const ALICE = "13800000001";
const BOB = "13800000002";
let counter = 0;
const root = () => join(fixture.root, `root-${++counter}`);

const download: AttachmentSource = (fileId, destination, options) => downloadFile(client, fileId, destination, options);
function upload(content: string, fileName: string): string {
  const id = `file-${++counter}`;
  platform.files.set(id, Buffer.from(content));
  platform.fileInfo.set(id, { fileName, mimeType: "text/plain" });
  return id;
}

function selection(models: Models, ref: ModelRef): ModelSelection {
  return {
    runtime: models as never, settings: undefined as never, model: models.getModel(ref.provider, ref.modelId) as never, ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
  };
}

/** A faux model that keeps each request's transcript; `answers` decide the replies (default: a plain answer). */
function model(answers: ((messages: Message[]) => ReturnType<FauxResponseFactory>)[] = []) {
  const { faux, models, model } = fauxModels();
  const requests: Message[][] = [];
  const state: { hold?: Promise<void> } = {};
  faux.setResponses(Array.from({ length: 30 }, (_, index) => ((transcript, options) => {
    requests.push(structuredClone(transcript.messages));
    const answer = answers[index]?.(transcript.messages) ?? fauxAssistantMessage(`answer ${requests.length}`);
    if (!state.hold) return answer;
    return new Promise(done => {
      options?.signal?.addEventListener("abort", () => done(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
      void state.hold!.then(() => done(answer));
    });
  }) as FauxResponseFactory));
  return { models, ref: model, requests, state };
}

function open(where: string, m: ReturnType<typeof model>, outbound: Outbound, options: Partial<DurableServiceOptions> = {}) {
  return new DurableService({
    layout: appLayout(where), selection: selection(m.models, m.ref), modules: [], relay: null, materials: false,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 },
    outbound, attachments: { source: download, limits: { memberCount: 1 } }, ...options,
  });
}

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

const ask = (out: Recording, phone: string, text: string) => out.message(DIRECT_SPACE, phone, text);
function attachment(out: Recording, phone: string, event: Partial<AttachmentEvent> & { fileId: string }, hold?: string): InboundAttachment {
  const { scope, reply } = out.message(DIRECT_SPACE, phone, "[文件]");
  return { scope, phone, reply, attachment: { kind: "file", name: "a.txt", ...event }, ...(hold ? { hold } : {}) };
}
async function stateOf(service: DurableService, msgUid: string, phone = ALICE): Promise<Attachment | undefined> {
  return Object.values((await service.records(DIRECT_SCOPE, phone)).attachments).find(item => item.msgUid === msgUid);
}
const received = (where: string, phone = ALICE) => readdir(join(tmpOf(where, DIRECT_SPACE, phone), "received")).catch(() => [] as string[]);

const text = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => "text" in part ? part.text : "").join("");
const userTexts = (messages: Message[]) => messages.filter(message => message.role === "user").map(text);
/** The tools and sections in effect at the end of the transcript's system messages. */
function declared(messages: Message[]) {
  const tools = new Set<string>(), sections = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const [name, body] of Object.entries(message.sections ?? {})) { if (body === null) sections.delete(name); else sections.add(name); }
  }
  return { tools, sections };
}

test("a held attachment downloads but is not counted, acknowledged, bound, voided or expired until its holder releases it", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const service = open(where, m, out.outbound);
  try {
    const held = attachment(out, ALICE, { fileId: upload("reply", "reply.txt"), name: "reply.txt" }, "push:p1");
    expect(await service.attach(held)).toMatchObject({ status: "accepted" });
    await until(async () => (await stateOf(service, held.reply.msgUid))?.state === "ready", "the held download");
    // The member's own limit is one unconsumed attachment: the held one does not take it.
    const own = attachment(out, ALICE, { fileId: upload("own", "own.txt"), name: "own.txt" });
    expect(await service.attach(own)).toMatchObject({ status: "accepted" });
    await until(async () => (await stateOf(service, own.reply.msgUid))?.state === "ready", "the member's download");
    expect(out.texts("notice", ALICE)).toEqual(["已收到文件「own.txt」，请说明要怎么处理。"]);
    await service.admit(ask(out, ALICE, "what did I send"));
    await until(() => replyTexts(out.sent).length === 1, "the answer");
    const prompt = userTexts(m.requests[0]!).at(-1)!;
    expect(prompt).toContain("own.txt"); expect(prompt).not.toContain("reply.txt");
    // /clear and a day of maintenance void or drop the member's attachments, not the held one.
    await service.control(ask(out, ALICE, "/clear"));
    await service.maintain(Date.now() + 25 * 3600_000);
    const kept = (await stateOf(service, held.reply.msgUid))!;
    expect(kept).toMatchObject({ state: "ready", heldBy: "push:p1" });
    expect(kept.boundTo).toBeUndefined();
    const file = kept.path!.split(/[\\/]/).at(-1)!;
    // Only its holder releases it; the record goes, the file is left to the tmp lifecycle.
    expect(await service.releaseAttachments(DIRECT_SCOPE, ALICE, "push:p2", [kept.id])).toBe(0);
    expect(await service.releaseAttachments(DIRECT_SCOPE, ALICE, "push:p1", [kept.id, "missing"])).toBe(1);
    expect(await stateOf(service, held.reply.msgUid)).toBeUndefined();
    expect(await received(where)).toContain(file);
    expect(await service.attach(held)).toEqual({ status: "duplicate" });
  } finally { await service.close(); }
});

test("a note is a passive entry: no run, written once per request id, seen by the member's next request and kept by a busy one", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const service = open(where, m, out.outbound);
  const note = (requestId: string, body: string) => service.note(DIRECT_SCOPE, ALICE, requestId, {
    kind: PUSH_NOTE_KIND, data: { push: "p1" }, model: [{ role: "user", content: [{ type: "text", text: body }], timestamp: Date.now() }] });
  try {
    // The member has no conversation yet: the note creates it.
    await note("push-note:card:p1", "[推送] 第一条备注");
    await note("push-note:card:p1", "[推送] 第一条备注");
    await Bun.sleep(100);
    expect(m.requests).toHaveLength(0);
    expect(out.sent).toEqual([]);
    await service.admit(ask(out, ALICE, "question one"));
    await until(() => replyTexts(out.sent).length === 1, "the first answer");
    expect(userTexts(m.requests[0]!)).toEqual(["[推送] 第一条备注", expect.stringContaining("question one")]);
    // A note written while a run is busy is not part of that run; the next request has it before its question.
    const hold = Promise.withResolvers<void>();
    m.state.hold = hold.promise;
    await service.admit(ask(out, ALICE, "question two"));
    await until(() => m.requests.length === 2, "the second run");
    await note("push-note:reply:p1:1", "[推送回复] 第二条备注");
    hold.resolve();
    await until(() => replyTexts(out.sent).length === 2, "the second answer");
    m.state.hold = undefined;
    await service.admit(ask(out, ALICE, "question three"));
    await until(() => replyTexts(out.sent).length === 3, "the third answer");
    const third = userTexts(m.requests.at(-1)!);
    expect(third.filter(each => each.startsWith("[推送"))).toEqual(["[推送] 第一条备注", "[推送回复] 第二条备注"]);
    expect(third.indexOf("[推送回复] 第二条备注")).toBeLessThan(third.findIndex(each => each.includes("question three")));
    expect(userTexts(m.requests[1]!)).not.toContain("[推送回复] 第二条备注");
  } finally { await service.close(); }
});

test("a note into a group nobody has asked in yet creates the space and the member's conversation; their first question there sees it", async () => {
  const where = root(), m = model(), out = recordingOutbound();
  const service = open(where, m, out.outbound);
  try {
    await service.note(groupScope("100"), BOB, "push-note:card:p1", {
      kind: PUSH_NOTE_KIND, data: { push: "p1" }, model: [{ role: "user", content: [{ type: "text", text: "[推送] 推送到本群的备注" }], timestamp: Date.now() }] });
    await Bun.sleep(100);
    expect(m.requests).toHaveLength(0);
    await service.admit(out.message("100", BOB, "群里的问题"));
    await until(() => replyTexts(out.sent).length === 1, "the group answer");
    expect(userTexts(m.requests[0]!)).toEqual(["[推送] 推送到本群的备注", expect.stringContaining("群里的问题")]);
  } finally { await service.close(); }
});

test("only a pusher's conversation selects the push tools and section; a revoked pusher's next request has neither", async () => {
  const where = root(), out = recordingOutbound();
  const status: string[] = [];
  const pushers = new Set([ALICE]);
  const fake = { prepare: async () => "预览已发出", status: (phone: string) => { status.push(phone); return "没有推送"; } };
  const m = model([() => fauxAssistantMessage([fauxToolCall("push_status", {}, { id: "status-1" })], { stopReason: "toolUse" })]);
  const service = open(where, m, out.outbound, {
    memberExtensions: {
      install: scope => scope.kind === "direct" ? [pushExtension(fake, { layout: appLayout(where) })] : [],
      selected: (scope, phone) => scope.kind === "direct" && pushers.has(phone) ? [PUSH_EXTENSION] : [],
    },
  });
  try {
    await service.admit(ask(out, ALICE, "how are my pushes"));
    await until(() => replyTexts(out.sent).length === 1, "Alice's answer");
    expect(status).toEqual([ALICE]);
    const alice = declared(m.requests[0]!);
    expect(alice.tools.has("push_prepare")).toBe(true); expect(alice.tools.has("push_status")).toBe(true);
    expect(alice.sections.has("push")).toBe(true);
    expect(m.requests[1]!.some(message => message.role === "toolResult" && text(message) === "没有推送")).toBe(true);
    await service.admit(ask(out, BOB, "hello"));
    await until(() => replyTexts(out.sent).length === 2, "Bob's answer");
    const bob = declared(m.requests[2]!);
    expect([...bob.tools].filter(name => name.startsWith("push_"))).toEqual([]);
    expect(bob.sections.has("push")).toBe(false);
    pushers.delete(ALICE);
    await service.admit(ask(out, ALICE, "and now"));
    await until(() => replyTexts(out.sent).length === 3, "Alice's answer after the revocation");
    const revoked = declared(m.requests[3]!);
    expect([...revoked.tools].filter(name => name.startsWith("push_"))).toEqual([]);
    expect(revoked.sections.has("push")).toBe(false);
  } finally { await service.close(); }
});
