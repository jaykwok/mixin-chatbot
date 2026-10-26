// The Durable message lifecycle (src/durable/service.ts): durable admission with receipts, the member worker and its
// replies and their retries, queue limit, /stop, /clear, /status, the watchdog, restart recovery, control replay (also of a
// /clear queued while stopped, src/durable/offline.ts), storage identity and usage projection. Faux providers and a
// recording outbound; no network, no platform.
import { afterAll, describe, spyOn, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type AssistantMessage, type Message, type Models, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession, defineExtension, type Harness, LiveDoc, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import { ReclamationItems } from "../../src/durable/results/queue.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { resultsRoot } from "../../src/durable/results/files.ts";
import { holdDirectory, type HeldDirectory } from "../../src/core/held-directory.ts";
import { SpaceHarnesses } from "../../src/durable/spaces.ts";
import { RequestDoor } from "../../src/durable/door.ts";
import { memberConversation, MemberDirectory } from "../../src/durable/identity.ts";
import { ControlsDoc, InboxDoc, type InboxItem, type StoredControl } from "../../src/durable/inbox.ts";
import { queueSpaceClear } from "../../src/durable/offline.ts";
import { pendingDeliveries, recordsOf, ReceiptsDoc } from "../../src/durable/records.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import type { ModelSelection } from "../../src/durable/models.ts";
import { DurableService, type DurableServiceOptions } from "../../src/durable/service.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import { SqliteClient } from "../../src/durable/sqlite-client.ts";
import { DurableStorageFailure } from "../../src/durable/storage-failure.ts";
import { fauxModels, openGroupHarness, TEST_PROGRESS } from "../helpers/durable.ts";
import { type Recording, recordingOutbound, replyTexts, type Sent } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import "../helpers/restore-spies.ts";
import { databaseOf, scopeOf, statsOf, tmpOf } from "../helpers/layout.ts";
import { awaitingRemoval } from "../helpers/results.ts";
import { appLayout } from "../../src/core/layout.ts";

const fixture = await tempFixture("durable-service-");
afterAll(() => fixture.cleanup());
const GROUP = "100";
const GROUP_B = "200";
const ALICE = "13800000001";
const BOB = "13800000002";
let counter = 0;

function selection(models: Models, ref: ModelRef, contextWindow = 128000): ModelSelection {
  const model = models.getModel(ref.provider, ref.modelId)!;
  return {
    runtime: models as never, settings: undefined as never, model: { ...model, contextWindow } as never, ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
  };
}

type Fixture = { root: string };

function place(): Fixture {
  return { root: join(fixture.root, `root-${++counter}`) };
}

/** Harness is a public factory. Obtain the implementation prototype from a real, closed instance. */
async function harnessPrototype(models: Models): Promise<Pick<Harness, "conversation" | "snapshot" | "commit">> {
  const opened = await openGroupHarness(join(fixture.root, `prototype-${++counter}.sqlite`), models);
  try { return Object.getPrototypeOf(opened.harness) as Pick<Harness, "conversation" | "snapshot" | "commit">; }
  finally { await opened.close(); }
}

function open(where: Fixture, models: Models, ref: ModelRef, outbound: Outbound, options: Partial<DurableServiceOptions> = {}) {
  const reports: unknown[] = [];
  const service = new DurableService({
    layout: appLayout(where.root), selection: selection(models, ref), modules: [], relay: null, materials: false,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 },
    outbound, onReport: (error) => reports.push(error), ...options,
  });
  return { service, reports };
}

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

/** A response that waits for `open()` or the request's abort; `started` counts the requests it got. */
function gate(answer: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const state = { started: 0, transcripts: [] as Message[][] };
  const step: FauxResponseFactory = (transcript, options) => new Promise<AssistantMessage>((done) => {
    state.started++;
    state.transcripts.push(transcript.messages as Message[]);
    if (options?.signal?.aborted) return done(fauxAssistantMessage("", { stopReason: "aborted" }));
    options?.signal?.addEventListener("abort", () => done(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    void promise.then(() => done(fauxAssistantMessage(answer)));
  });
  return { step, open: resolve, state };
}

/** Answers (joined segments per message); terminal errors, also delivered as replies, are `failures`. */
const replies = (sent: Sent[]) => replyTexts(sent).filter((text) => !text.startsWith("⚠️"));
const failures = (sent: Sent[]) => replyTexts(sent).filter((text) => text.startsWith("⚠️"));
const notices = (sent: Sent[]) => sent.filter((item) => item.kind === "notice").map((item) => item.text);

/** The reply texts of a member's records that still wait for delivery. */
/** Default limits with retries of failed deliveries 100 ms apart. */
const RETRY_LIMITS = { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20, deliveryRetryMs: [100] };

async function pending(service: DurableService, phone = ALICE, group = GROUP): Promise<string[]> {
  return pendingDeliveries(await service.records(scopeOf(group), phone))
    .map((record) => record.delivery!.parts.filter((part) => part.kind === "markdown").map((part) => part.body).join(""));
}

async function registeredResult(where: Fixture, models: Models, model: ModelRef, name: string) {
  const opened = await openGroupHarness(databaseOf(where.root, GROUP), models, { group: GROUP });
  try {
    await memberConversation(opened.harness, scopeOf(GROUP), ALICE, { model }, context);
    await opened.harness.commit(async tx => { (await tx.doc(ResultsDoc)).calls[name] = { phone: ALICE, createdAt: Date.now() }; }, context);
  } finally { await opened.close(); }
}

/** An inbox item stored with its run record and receipt, as admission commits them (seeding a crash window). */
async function seedItem(tx: Tx, conversationId: ConversationId, out: Recording, phone: string, item: InboxItem): Promise<void> {
  (await tx.doc(InboxDoc, conversationId)).items.push(item);
  const { reply } = out.message(GROUP, phone, item.content);
  (await recordsOf(tx, phone)).requests[item.requestId] = { requestId: item.requestId, reply, createdAt: Date.now(), notes: [], deliverables: [], files: [], events: {} };
  (await tx.doc(ReceiptsDoc)).items[reply.msgUid] = { at: Date.now(), phone, request: item.requestId };
}

/** Change Alice's inbox and the control stream directly in the closed group database (a crash window). */
async function inject(where: Fixture, change: (tx: Tx, conversationId: ConversationId, controls: { seq: number; pending: StoredControl[] }) => Promise<void>) {
  const session = createSession(await openGroupStorage(databaseOf(where.root, GROUP)));
  try {
    const member = await session.snapshot(MemberDirectory, ALICE, context);
    await session.commit(async (tx) => change(tx, member!.conversationId as ConversationId, await tx.doc(ControlsDoc)), context);
  } finally { await session.close(context); }
}

/** Seed Alice's conversation and inbox in a fresh group database before the service opens it. */
async function seed(where: Fixture, models: Models, model: ModelRef, change: (tx: Tx, conversationId: ConversationId) => Promise<void>) {
  const seeded = await openGroupHarness(databaseOf(where.root, GROUP), models, { group: GROUP });
  try {
    const { conversation } = await memberConversation(seeded.harness, scopeOf(GROUP), ALICE, { model }, context);
    await seeded.harness.commit((tx) => change(tx, conversation.id), context);
  } finally { await seeded.close(); }
}

describe("durable service: admission order across asynchronous boundaries", () => {
  for (const failFirst of [false, true]) test(`a delayed first admission reserves FIFO; failure=${failFirst}; other members still run`, async () => {
    const { faux, models, model } = fauxModels(), where = place(), out = recordingOutbound();
    const inputs: string[] = [];
    faux.setResponses(Array.from({ length: 3 }, () => (transcript: Parameters<FauxResponseFactory>[0]) => {
      const input = JSON.stringify(transcript.messages.filter(message => message.role === "user").at(-1)?.content);
      inputs.push(input); return fauxAssistantMessage(input);
    }));
    const { service, reports } = open(where, models, model, out.outbound);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const acquire = SpaceHarnesses.prototype.acquire;
    let first = true, secondSettled = false;
    const spy = spyOn(SpaceHarnesses.prototype, "acquire").mockImplementation(async function(this: SpaceHarnesses, scope) {
      if (first) { first = false; entered.resolve(); await release.promise; if (failFirst) throw new Error("synthetic admission failure"); }
      return acquire.call(this, scope);
    });
    let earlier: Promise<unknown> | undefined, later: Promise<unknown> | undefined;
    try {
      earlier = service.admit(out.message(GROUP, ALICE, "FIRST: template A")).catch(error => error);
      await entered.promise;
      later = service.admit(out.message(GROUP, ALICE, "SECOND: template B")).finally(() => { secondSettled = true; });
      await service.admit(out.message(GROUP, BOB, "OTHER"));
      await until(() => replies(out.sent).length === 1, "other member's reply");
      expect(secondSettled).toBe(false); expect(inputs).toHaveLength(1); expect(inputs[0]).toContain("OTHER");
      release.resolve();
      const result = await earlier; await later;
      if (failFirst) expect(result).toBeInstanceOf(Error);
      await until(() => replies(out.sent).length === (failFirst ? 2 : 3), "ordered replies");
      expect(inputs.slice(1).map(value => value.includes("FIRST") ? "FIRST" : "SECOND")).toEqual(failFirst ? ["SECOND"] : ["FIRST", "SECOND"]);
      expect(reports).toEqual([]);
    } finally { release.resolve(); spy.mockRestore(); await earlier; await later; await service.close(); }
  });

  for (const command of ["/stop", "/clear"]) test(`${command} passes a slow admission and cancels only older arrivals`, async () => {
    const { faux, models, model } = fauxModels(), where = place(), out = recordingOutbound();
    const inputs: string[] = [];
    faux.setResponses(Array.from({ length: 2 }, () => (transcript: Parameters<FauxResponseFactory>[0]) => {
      const input = JSON.stringify(transcript.messages.filter(message => message.role === "user").at(-1)?.content);
      inputs.push(input); return fauxAssistantMessage("fresh reply");
    }));
    const { service, reports } = open(where, models, model, out.outbound);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const acquire = SpaceHarnesses.prototype.acquire;
    let first = true;
    const spy = spyOn(SpaceHarnesses.prototype, "acquire").mockImplementation(async function(this: SpaceHarnesses, scope) {
      if (first) { first = false; entered.resolve(); await release.promise; }
      return acquire.call(this, scope);
    });
    let earlier: Promise<unknown> | undefined, later: Promise<unknown> | undefined;
    try {
      earlier = service.admit(out.message(GROUP, ALICE, "OLD")); await entered.promise;
      await service.control(out.message(GROUP, ALICE, command));
      later = service.admit(out.message(GROUP, ALICE, "FRESH"));
      release.resolve(); await earlier; await later;
      await until(() => replies(out.sent).length === 1, "fresh reply");
      expect(inputs).toHaveLength(1); expect(inputs[0]).toContain("FRESH"); expect(inputs[0]).not.toContain("OLD");
      expect(reports).toEqual([]);
    } finally { release.resolve(); spy.mockRestore(); await earlier; await later; await service.close(); }
    // The reply probe has a 10 s deadline. Let it report its label and run cleanup before Bun's forced timeout.
  }, 15000);
});

describe("durable service: manual compaction receipt", () => {
  for (const command of ["/stop", "/clear"]) test(`${command} remains available while duplicate compact commands wait for summary placement`, async () => {
    const { faux, models, model } = fauxModels(), where = place(), out = recordingOutbound(), held = gate("live answer");
    faux.setResponses([fauxAssistantMessage("historical answer"), held.step, fauxAssistantMessage("summary")]);
    const configured = selection(models, model);
    configured.harnessSettings = { ...configured.harnessSettings, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } };
    const { service } = open(where, models, model, out.outbound, { selection: configured });
    const pending: Promise<string>[] = [];
    try {
      await service.admit(out.message(GROUP, ALICE, "history")); await until(() => replies(out.sent).length === 1, "history");
      await service.admit(out.message(GROUP, ALICE, "live")); await until(() => held.state.started === 1, "live generation");
      pending.push(service.control(out.message(GROUP, ALICE, "/compact")));
      pending.push(service.control(out.message(GROUP, ALICE, "/compact")));
      const storage = await openGroupStorage(databaseOf(where.root, GROUP));
      try {
        await until(async () => (await storage.scanSubmissions({}, 100, undefined, context)).items.some(s => s.type === "write" && s.status === "queued"), "queued summary");
        await service.control(out.message(GROUP, ALICE, command));
        const receipts = await Promise.all(pending);
        const summaries = (await storage.scanSubmissions({}, 100, undefined, context)).items.filter(s => s.requestId?.startsWith("compaction:"));
        expect(summaries).toHaveLength(1);
        for (const receipt of receipts) expect(receipt.includes("压缩已完成")).toBe(summaries[0]?.status === "done");
      } finally { await storage.close(context); }
    } finally { held.open(); await service.close(); await Promise.allSettled(pending); }
  });

  test("a summary queued behind a live reply cannot report completion until it is placed", async () => {
    const { faux, models, model } = fauxModels(), where = place(), out = recordingOutbound();
    const held = gate("second answer");
    faux.setResponses([fauxAssistantMessage("historical answer"), held.step, fauxAssistantMessage("summary of earlier history")]);
    const configured = selection(models, model);
    configured.harnessSettings = { ...configured.harnessSettings, compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 } };
    const { service, reports } = open(where, models, model, out.outbound, { selection: configured });
    let compact: Promise<string> | undefined;
    try {
      await service.admit(out.message(GROUP, ALICE, "historical request")); await until(() => replies(out.sent).length === 1, "history");
      await service.admit(out.message(GROUP, ALICE, "live request")); await until(() => held.state.started === 1, "live generation");
      let resolved = false;
      compact = service.control(out.message(GROUP, ALICE, "/compact")).then(reply => { resolved = true; return reply; });
      const storage = await openGroupStorage(databaseOf(where.root, GROUP));
      try {
        await until(async () => (await storage.scanSubmissions({}, 100, undefined, context)).items.some(s => s.type === "write" && s.status === "queued"), "queued summary");
        expect(resolved).toBe(false);
        expect(out.sent.some(item => item.text.includes("压缩已完成"))).toBe(false);
        held.open();
        expect(await compact).toContain("摘要已写入会话");
        const summaries = (await storage.scanSubmissions({}, 100, undefined, context)).items.filter(s => s.requestId?.startsWith("compaction:"));
        expect(summaries).toHaveLength(1); expect(summaries[0]?.status).toBe("done");
      } finally { await storage.close(context); }
      expect(reports).toEqual([]);
    } finally { held.open(); await compact?.catch(() => {}); await service.close(); }
  });
  test("an empty conversation reports no history to compact", async () => {
    const { models, model } = fauxModels(), where = place(), out = recordingOutbound();
    const { service } = open(where, models, model, out.outbound);
    try { expect(await service.control(out.message(GROUP, ALICE, "/compact"))).toContain("无需压缩"); }
    finally { await service.close(); }
  });
});

describe("durable service: admission, worker and reply", () => {
  test("a message is in the inbox when admit returns; the worker answers it, the reply goes out with the mention, usage is projected", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("你好，这是回答");
    faux.setResponses([held.step]);
    const { service, reports } = open(where, models, model, out.outbound);
    try {
      const asked = out.message(GROUP, ALICE, "你好");
      expect(await service.admit(asked)).toEqual({ status: "accepted" });
      await until(() => held.state.started === 1, "the request");
      // No "working on it" notice: nothing is sent before the answer.
      expect(out.sent).toEqual([]);
      held.open();
      await until(() => replies(out.sent).length === 1, "the reply");
      expect(replies(out.sent)).toEqual(["你好，这是回答"]);
      // The lead segment answers the message it came from and @-mentions its sender.
      const reply = out.sent.find((item) => item.kind === "reply")!;
      expect([reply.msgUid, reply.mention]).toEqual([asked.reply.msgUid, `im-${ALICE}`]);
      await until(async () => (await pending(service)).length === 0, "no pending delivery");
      const ledger = openStatsLedger(statsOf(where.root));
      try {
        const rows = readLedger(ledger);
        expect(rows.asks.map(({ group, user, asks }) => ({ group, user, asks }))).toEqual([{ group: GROUP, user: ALICE, asks: 1 }]);
        expect(rows.usage.map(({ group, user, bucket }) => ({ group, user, bucket }))).toEqual([{ group: GROUP, user: ALICE, bucket: "models" }]);
        expect(rows.usage[0]!.totalTokens).toBeGreaterThan(0);
      } finally { ledger.close(); }
      expect(reports).toEqual([]);
    } finally { await service.close(); }
  });

  test("one member's messages run one at a time in arrival order; another member is not queued behind them; the queue holds eight", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const first = gate("一");
    faux.setResponses([first.step, fauxAssistantMessage("别人"), ...Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(`回答${index + 2}`))]);
    const { service } = open(where, models, model, out.outbound);
    try {
      expect((await service.admit(out.message(GROUP, ALICE, "第1条"))).status).toBe("accepted");
      await until(() => first.state.started === 1, "the first request");
      expect((await service.admit(out.message(GROUP, BOB, "别人的消息"))).status).toBe("accepted");
      await until(() => replies(out.sent).includes("别人"), "the other member's reply");
      for (let index = 2; index <= 9; index++) expect((await service.admit(out.message(GROUP, ALICE, `第${index}条`))).status).toBe("accepted");
      expect(await service.admit(out.message(GROUP, ALICE, "第10条"))).toEqual({ status: "full", message: "本会话已有 8 条消息排队，请稍后重发" });
      first.open();
      await until(() => replies(out.sent).length === 10, "all replies");
      expect(replies(out.sent).filter((text) => text !== "别人")).toEqual(["一", ...Array.from({ length: 8 }, (_, index) => `回答${index + 2}`)]);
    } finally { await service.close(); }
  });

  test("a model error is delivered to the member as the AgentSession engine reports it, with the mention; nothing is left to send", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" })]);
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(out.message(GROUP, ALICE, "会失败"));
      await until(() => failures(out.sent).length === 1, "the failure text");
      const failure = failures(out.sent)[0]!;
      expect(failure).toContain("⚠️ 抱歉，处理您的请求时出错了。");
      expect(failure).toContain("401 invalid api key");
      expect(out.sent.find((item) => item.kind === "reply")!.mention).toBe(`im-${ALICE}`);
      await until(async () => (await pending(service)).length === 0, "no pending delivery");
    } finally { await service.close(); }
  });

  test("a failed run does not stop the member's queue: the message behind it runs next", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const { promise: fail, resolve: failNow } = Promise.withResolvers<void>();
    let started = 0;
    faux.setResponses([
      async () => { started++; await fail; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" }); },
      fauxAssistantMessage("第二条的回答"),
    ]);
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(out.message(GROUP, ALICE, "第一条"));
      await until(() => started === 1, "the first request");
      await service.admit(out.message(GROUP, ALICE, "第二条"));
      failNow();
      await until(() => replies(out.sent).length === 1, "the second reply");
      expect(failures(out.sent).join("\n")).toContain("401 invalid api key");
      expect(replies(out.sent)).toEqual(["第二条的回答"]);
    } finally { await service.close(); }
  });

  test("one member in two groups: two independent runs at once; replies and usage stay in their group", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const first = gate("甲群的回答");
    const second = gate("乙群的回答");
    faux.setResponses([first.step, second.step]);
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(out.message(GROUP, ALICE, "甲群的问题"));
      await until(() => first.state.started === 1, "the first group's request");
      await service.admit(out.message(GROUP_B, ALICE, "乙群的问题"));
      // Both run at once: neither waits for the other.
      await until(() => second.state.started === 1, "the second group's request");
      expect(JSON.stringify(second.state.transcripts[0])).not.toContain("甲群");
      second.open();
      await until(() => replies(out.sent).length === 1, "the second group's reply");
      first.open();
      await until(() => replies(out.sent).length === 2, "the first group's reply");
      expect(out.sent.filter((item) => item.kind === "reply").map((item) => `${item.space} ${item.phone}: ${item.text}`))
        .toEqual([`${GROUP_B} ${ALICE}: 乙群的回答`, `${GROUP} ${ALICE}: 甲群的回答`]);
      const ledger = openStatsLedger(statsOf(where.root));
      try {
        const rows = readLedger(ledger);
        expect(rows.asks.map(({ group, user, asks }) => ({ group, user, asks })).sort((a, b) => a.group.localeCompare(b.group)))
          .toEqual([{ group: GROUP, user: ALICE, asks: 1 }, { group: GROUP_B, user: ALICE, asks: 1 }]);
        expect([...new Set(rows.usage.map(row => row.group))].sort()).toEqual([GROUP, GROUP_B].sort());
      } finally { ledger.close(); }
    } finally { await service.close(); }
  });

  test("a reply the platform refused stays in the run record and is sent again on its own to the original message", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    faux.setResponses([fauxAssistantMessage("要重发的回答")]);
    const { service } = open(where, models, model, out.outbound, { limits: { ...RETRY_LIMITS } });
    try {
      let refused = 0;
      out.state.failWhen = (item) => item.kind === "reply" && ++refused > 0 ? "failed" : false;
      const question = out.message(GROUP, ALICE, "问题");
      await service.admit(question);
      await until(() => refused >= 2, "a second refused attempt");
      expect(await pending(service)).toEqual(["要重发的回答"]);
      out.state.failWhen = undefined;
      await until(async () => (await pending(service)).length === 0, "the retry");
      const sent = out.sent.at(-1)!;
      expect([sent.kind, sent.text, sent.msgUid, sent.mention]).toEqual(["reply", "要重发的回答", question.reply.msgUid, `im-${ALICE}`]);
      expect(replies(out.sent)).toEqual(["要重发的回答"]);
      expect(notices(out.sent)).toEqual([]);
    } finally { await service.close(); }
  });

  test("interleaved members and a restart before a retry: every reply keeps its own question's summary, name and @ target", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound(), raw: { msgUid: string; body: string; mention?: string }[] = [];
    const send = out.outbound.send;
    out.outbound.send = async (target, message, options) => {
      const outcome = await send(target, message, options);
      if (outcome.status === "sent" && message.msgType === "markdown") raw.push({ msgUid: options?.replyMsgId ?? "", body: message.content.content,
        ...(message.content.a?.[0]?.i ? { mention: message.content.a[0].i } : {}) });
      return outcome;
    };
    faux.setResponses([fauxAssistantMessage("答甲一"), fauxAssistantMessage("答乙"), fauxAssistantMessage("答甲二")]);
    let { service } = open(where, models, model, out.outbound, { limits: { ...RETRY_LIMITS, deliveryRetryMs: [300] } });
    try {
      // Alice's first answer is refused, so its retry comes after the restart.
      out.state.failWhen = (item) => item.kind === "reply" && item.text === "答甲一" ? "failed" : false;
      const a1 = out.message(GROUP, ALICE, "甲的第一个问题", { name: "张三" });
      const b = out.message(GROUP, BOB, "乙的问题", { name: "李四" });
      const a2 = out.message(GROUP, ALICE, "甲的第二个问题", { name: "张三" });
      await service.admit(a1); await service.admit(b); await service.admit(a2);
      await until(() => replies(out.sent).length === 2, "two answers");
      await service.close();
      out.state.failWhen = undefined;
      ({ service } = open(where, models, model, out.outbound, { limits: { ...RETRY_LIMITS } }));
      await service.start();
      const lead = (question: typeof a1) => raw.filter((item) => item.msgUid === question.reply.msgUid && item.mention !== undefined);
      await until(() => lead(a1).length > 0, "the retried first answer");
      for (const [question, phone, name, summary, answer] of [[a1, ALICE, "张三", "甲的第一个问题", "答甲一"], [b, BOB, "李四", "乙的问题", "答乙"],
        [a2, ALICE, "张三", "甲的第二个问题", "答甲二"]] as const) {
        const sent = lead(question).filter((item) => item.body.endsWith(answer));
        // Delivered once to its own message, with the asker's @ and the asker's summary line.
        expect(sent).toHaveLength(1);
        expect(sent[0]!.mention).toBe(`im-${phone}`);
        expect(sent[0]!.body.startsWith(`> 回复 ${name}：${summary}`)).toBe(true);
      }
    } finally { await service.close(); }
  });

  test("an uncertain reply counts as sent: never sent again, nothing left to send, no notice", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    faux.setResponses([fauxAssistantMessage("不确定是否送达的回答")]);
    const { service } = open(where, models, model, out.outbound, { limits: { ...RETRY_LIMITS } });
    try {
      out.state.failWhen = (item) => item.kind === "reply" ? "uncertain" : false;
      await service.admit(out.message(GROUP, ALICE, "问题"));
      const part = async () => Object.values((await service.records(scopeOf(GROUP), ALICE)).requests)[0]?.delivery?.parts[0];
      await until(async () => (await part())?.state === "uncertain", "the uncertain send");
      out.state.failWhen = undefined;
      // Neither maintenance nor a retry wait resends it.
      await service.maintain();
      await Bun.sleep(300);
      expect(replies(out.sent)).toEqual([]);
      expect([(await part())!.attempts, (await part())!.retryAt]).toEqual([1, undefined]);
      expect(await pending(service)).toEqual([]);
      expect(notices(out.sent)).toEqual([]);
    } finally { await service.close(); }
  });
});

describe("durable service: controls", () => {
  test("/stop aborts the run and drops the queued messages: no replies for them, a receipt, and the next message runs", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("不会发出");
    faux.setResponses([held.step, fauxAssistantMessage("新的回答")]);
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(out.message(GROUP, ALICE, "长任务"));
      await service.admit(out.message(GROUP, ALICE, "排队的"));
      await until(() => held.state.started === 1, "the request");
      const receipt = await service.control(out.message(GROUP, ALICE, "/stop"));
      expect(receipt).toContain("⏹ 已停止你在本群的当前任务");
      await service.admit(out.message(GROUP, ALICE, "停止之后"));
      await until(() => replies(out.sent).length === 1, "the next reply");
      expect(replies(out.sent)).toEqual(["新的回答"]);
      expect(faux.state.callCount).toBe(2);
    } finally { await service.close(); }
    const database = createSession(await openGroupStorage(databaseOf(where.root, GROUP)));
    try {
      expect((await database.snapshot(ControlsDoc, context))?.pending).toEqual([]);
    } finally { await database.close(context); }
  });

  test("/clear waits for the run to end, starts a new context and schedules idle reclamation; a message sent meanwhile runs in the new context", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("旧回答");
    let seen: Message[] = [];
    faux.setResponses([fauxAssistantMessage("第一轮回答"), held.step, (transcript) => { seen = transcript.messages as Message[]; return fauxAssistantMessage("新会话回答"); }]);
    await registeredResult(where, models, model, "1-call_a");
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(out.message(GROUP, ALICE, "第一轮"));
      await until(() => replies(out.sent).length === 1, "the first reply");
      const results = join(resultsRoot(tmpOf(where.root, GROUP, ALICE)), "1-call_a");
      await mkdir(results, { recursive: true });
      await writeFile(join(results, "index.txt"), "x");
      await service.admit(out.message(GROUP, ALICE, "第二轮"));
      await until(() => held.state.started === 1, "the second request");
      const clearing = service.control(out.message(GROUP, ALICE, "/clear"));
      await service.admit(out.message(GROUP, ALICE, "清空之后"));
      expect(await clearing).toContain("🧹 已为你在本群开启新会话");
      await until(() => replies(out.sent).length === 2, "the reply after clear");
      expect(replies(out.sent)).toEqual(["第一轮回答", "新会话回答"]);
      const text = JSON.stringify(seen);
      expect(text).toContain("清空之后");
      expect(text).not.toContain("第一轮");
      expect(text).not.toContain("第二轮");
      // /clear requests the expiry; wait for the maintenance outcome itself (the first pass may still find the group
      // busy finishing the reply). The receipt is checked in the database below.
      await until(async () => {
        await service.maintain();
        return process.platform === "linux" ? await awaitingRemoval(databaseOf(where.root, GROUP), ALICE) > 0
          : (await readdir(resultsRoot(tmpOf(where.root, GROUP, ALICE)))).length === 0;
      }, "idle result reclamation");
      expect(await readdir(resultsRoot(tmpOf(where.root, GROUP, ALICE)))).toEqual(process.platform === "linux" ? ["1-call_a"] : []);
      if (process.platform === "linux") expect(await readFile(join(results, "index.txt"), "utf8")).toBe("x");
    } finally { await service.close(); }
    const database = createSession(await openGroupStorage(databaseOf(where.root, GROUP)));
    try {
      const receipt = process.platform === "linux"
        ? (await database.snapshot(ReclamationItems, "1-call_a", context))!.call
        : (await database.snapshot(ResultsDoc, context))!.calls["1-call_a"]!;
      expect(receipt.expiryRequestedAt).toBeDefined();
      if (process.platform === "linux") { expect(receipt.expiredAt).toBeUndefined(); expect(receipt.reclamation?.status).toBe("deferred"); }
      else expect(receipt.expiredAt).toBeDefined();
    } finally { await database.close(context); }
  });

  test("/clear cancels only what arrived before it, also a message in the same millisecond that is stored before the clear runs", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    // A tool that ignores the abort until released: the /stop waits for it, so the /clear queues behind the /stop and
    // the message after the /clear is stored before the /clear cancels anything.
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    let started = false;
    const slow = defineExtension({ name: "test.slow", tools: [{
      name: "slow", description: "Wait until the test releases it.", parameters: Type.Object({}),
      async execute() { started = true; await released; return { output: [{ type: "text", text: "done" }] }; },
    }] });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call_slow" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("新会话回答")]);
    const { service } = open(where, models, model, out.outbound, { extensions: () => [slow] });
    const realNow = Date.now;
    try {
      await service.admit(out.message(GROUP, ALICE, "第一轮"));
      await until(() => started, "the slow tool");
      const stopping = service.control(out.message(GROUP, ALICE, "/stop"));
      // The clock stands still: the /clear and the message after it arrive in the same millisecond.
      const frozen = realNow() + 1000;
      Date.now = () => frozen;
      let clearing: Promise<string>;
      try {
        clearing = service.control(out.message(GROUP, ALICE, "/clear"));
        expect(await service.admit(out.message(GROUP, ALICE, "清空之后"))).toEqual({ status: "accepted" });
      } finally { Date.now = realNow; }
      release();
      await stopping;
      await clearing;
      await until(() => replies(out.sent).length === 1, "the reply after clear");
      expect(replies(out.sent)).toEqual(["新会话回答"]);
    } finally { Date.now = realNow; release(); await service.close(); }
  });

  test("/status reports the running message and the queue", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("回答");
    faux.setResponses([held.step, fauxAssistantMessage("第二条")]);
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(out.message(GROUP, ALICE, "一"));
      await service.admit(out.message(GROUP, ALICE, "二"));
      await until(() => held.state.started === 1, "the request");
      const status = await service.control(out.message(GROUP, ALICE, "/status"));
      expect(status).toContain("状态：执行中");
      expect(status).toContain("等待处理的消息：1");
      expect(status).not.toContain("待补发");
      expect(status).toContain("最长处理时间：60 秒");
      expect(status).toMatch(/任务编号：[0-9a-f]{8}\n/);
      held.open();
      await until(() => replies(out.sent).length === 2, "both replies");
      // The platform accepted the second reply before its record is marked sent.
      await until(async () => (await pending(service)).length === 0, "the delivery records");
      expect(await service.control(out.message(GROUP, ALICE, "/help"))).toContain("可用指令");
      expect(await service.control(out.message(GROUP, ALICE, "/status"))).toContain("状态：空闲");
    } finally { await service.close(); }
  });
});

describe("durable service: watchdog", () => {
  test("the total deadline aborts the run and tells the member", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("太慢了");
    faux.setResponses([held.step]);
    const { service } = open(where, models, model, out.outbound, { limits: { runTimeoutMs: 300, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 } });
    try {
      await service.admit(out.message(GROUP, ALICE, "慢任务"));
      await until(() => failures(out.sent).length === 1, "the timeout text");
      expect(failures(out.sent)[0]).toMatch(/任务总时限 0\.3 秒已到（任务：[0-9a-f]{8}）/);
      expect(replies(out.sent)).toEqual([]);
    } finally { await service.close(); }
  });

  test("the log carries the task number: start, a heartbeat while it runs, end", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("回答");
    faux.setResponses([held.step]);
    const logs: string[] = [];
    const { service } = open(where, models, model, out.outbound, {
      limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20, heartbeatMs: 100 },
      onLog: (line) => logs.push(line),
    });
    try {
      await service.admit(out.message(GROUP, ALICE, "慢任务"));
      await until(() => logs.filter((line) => line.startsWith("任务仍在运行")).length >= 2, "two heartbeats");
      // On a busy machine the first heartbeat can still be in the preparation phase; the model is held, so one in its phase follows.
      const waiting = (line: string) => line.startsWith("任务仍在运行") && line.endsWith("阶段: 等待或接收模型输出");
      await until(() => logs.some(waiting), "a heartbeat while the model is held");
      held.open();
      await until(() => logs.some((line) => line.startsWith("任务结束")), "the end line");
      const task = /任务: ([0-9a-f]{8})/.exec(logs.find((line) => line.startsWith("任务开始"))!)![1];
      expect(logs.find((line) => line.startsWith("任务开始"))).toContain(`群 ${GROUP}, 用户: ${ALICE}, 任务: ${task}, 总时限: 60秒`);
      expect(logs.find(waiting)).toMatch(new RegExp(`任务: ${task}, 已用: \\d+秒, 阶段: 等待或接收模型输出`));
      expect(logs.find((line) => line.startsWith("任务结束"))).toContain(`任务: ${task}, 结果: done`);
    } finally { await service.close(); }
  });

  test("a model request without progress for the idle limit is aborted", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("不会到");
    faux.setResponses([held.step]);
    const { service } = open(where, models, model, out.outbound, { limits: { runTimeoutMs: 60_000, modelIdleMs: 300, modelResponseMs: 60_000, tickMs: 20 } });
    try {
      await service.admit(out.message(GROUP, ALICE, "卡住"));
      await until(() => failures(out.sent).length === 1, "the idle text");
      expect(failures(out.sent)[0]).toContain("模型连续 0.3 秒无有效进展");
    } finally { await service.close(); }
  });
});

describe("durable service: segmented replies", () => {
  test("two members' long answers in one group arrive each in one piece: only the lead segment has the @, nothing lands between", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    // About 9,000 characters: three segments each.
    const first = gate("甲".repeat(9_000)), second = gate("乙".repeat(9_000));
    faux.setResponses([first.step, second.step]);
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(out.message(GROUP, ALICE, "长问题一"));
      await service.admit(out.message(GROUP, BOB, "长问题二"));
      await until(() => first.state.started + second.state.started === 2, "both requests");
      first.open(); second.open();
      await until(() => out.sent.filter((item) => item.kind === "reply").length === 6, "both answers");
      const segments = out.sent.filter((item) => item.kind === "reply");
      // Each member's segments are consecutive, and only each first one mentions the sender.
      const owners = segments.map((item) => item.phone);
      expect(owners.filter((phone, index) => index > 0 && phone !== owners[index - 1])).toHaveLength(1);
      expect(segments.map((item) => item.mention !== undefined)).toEqual([true, false, false, true, false, false]);
    } finally { await service.close(); }
  });
});

describe("durable service: threshold compaction", () => {
  test("a turn over the blocking threshold compacts first: the model limits pause meanwhile, the log shows the phase, the ledger counts the summarize request", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    // Faux usage is estimated from the text (4 characters a token): the first answer alone is about 12,000 tokens, over
    // the 8,000-token blocking threshold below; the system prompt and the questions are far less.
    const long = "x".repeat(48_000);
    const summary = gate("第一轮的摘要");
    faux.setResponses([fauxAssistantMessage(long), summary.step, fauxAssistantMessage("第二轮回答")]);
    const base = selection(models, model);
    const logs: string[] = [];
    const { service, reports } = open(where, models, model, out.outbound, {
      selection: { ...base, harnessSettings: { ...base.harnessSettings,
        compaction: { enabled: true, reserveTokens: 128_000 - 8_000, keepRecentTokens: 100, backgroundTokens: 0 } } },
      limits: { runTimeoutMs: 60_000, modelIdleMs: 300, modelResponseMs: 60_000, tickMs: 20, heartbeatMs: 100 },
      onLog: (line) => logs.push(line),
    });
    try {
      await service.admit(out.message(GROUP, ALICE, "第一轮"));
      await until(() => replies(out.sent).length === 1, "the first reply");
      await service.admit(out.message(GROUP, ALICE, "第二轮"));
      await until(() => summary.state.started === 1, "the summarize request");
      // The second request is the summary of the first turn.
      expect(JSON.stringify(summary.state.transcripts[0])).toContain("第一轮");
      // Held for more than twice the model idle limit: compaction is not a model round, nothing is aborted.
      await until(() => logs.some((line) => line.startsWith("任务仍在运行") && line.endsWith("阶段: 压缩会话历史")), "a heartbeat in the compaction phase");
      await Bun.sleep(700);
      expect(failures(out.sent)).toEqual([]);
      summary.open();
      await until(() => replies(out.sent).length === 2, "the second reply");
      expect(replies(out.sent)[1]).toBe("第二轮回答");
      expect(logs.filter((line) => line.startsWith("任务结束")).map((line) => line.includes("结果: done"))).toEqual([true, true]);
      const ledger = openStatsLedger(statsOf(where.root));
      try {
        // The compaction's usage joins the model's totals in pi.usage; both rounds and the summary are one model row.
        const rows = readLedger(ledger);
        expect(rows.usage.map(({ bucket }) => bucket)).toEqual(["models"]);
        expect(rows.asks.reduce((sum, row) => sum + row.asks, 0)).toBe(2);
      } finally { ledger.close(); }
      expect(reports).toEqual([]);
    } finally { await service.close(); }
  });

  test("a blocking compaction that fails: the member is told the history could not be compacted, /status shows the failure", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const long = "x".repeat(48_000);
    // Every summarize request fails (with each retry the harness allows); the second turn is never asked.
    const failed = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 synthetic summarize refusal" });
    faux.setResponses([fauxAssistantMessage(long), ...Array.from({ length: 8 }, failed)]);
    const base = selection(models, model);
    const { service } = open(where, models, model, out.outbound, {
      selection: { ...base, harnessSettings: { ...base.harnessSettings,
        compaction: { enabled: true, reserveTokens: 128_000 - 8_000, keepRecentTokens: 100, backgroundTokens: 0 } } },
    });
    try {
      await service.admit(out.message(GROUP, ALICE, "第一轮"));
      await until(() => replies(out.sent).length === 1, "the first reply");
      await service.admit(out.message(GROUP, ALICE, "第二轮"));
      await until(() => failures(out.sent).some((text) => text.includes("会话历史压缩未完成")), "the failure text");
      const text = failures(out.sent).find((text) => text.includes("会话历史压缩未完成"))!;
      expect(text).toStartWith("⚠️ 抱歉，处理您的请求时出错了。");
      expect(text).toMatch(/会话历史压缩未完成（任务 \d+，达到阈值时压缩；Compaction failed: /);
      expect(text).toContain("400 synthetic summarize refusal");
      expect(replies(out.sent)).toHaveLength(1);
      expect(await service.control(out.message(GROUP, ALICE, "/status"))).toMatch(/\n最近一次会话历史压缩失败：任务 \d+，达到阈值时压缩：.*400 synthetic summarize refusal/);
    } finally { await service.close(); }
  });
});

describe("durable service: restart", () => {
  test("a run cut off by shutdown resumes at start; its reply goes to the message it answers without waiting for another", async () => {
    const where = place();
    const first = fauxModels();
    const held = gate("不会到");
    first.faux.setResponses([held.step]);
    const out = recordingOutbound();
    let opened = open(where, first.models, first.model, out.outbound);
    const question = out.message(GROUP, ALICE, "跨重启的问题");
    await opened.service.admit(question);
    await until(() => held.state.started === 1, "the request");
    await opened.service.close();

    const second = fauxModels();
    second.faux.setResponses([fauxAssistantMessage("重启后的回答"), fauxAssistantMessage("第二条的回答")]);
    const after = recordingOutbound();
    opened = open(where, second.models, second.model, after.outbound);
    try {
      expect(await opened.service.start()).toEqual([scopeOf(GROUP)]);
      await until(() => replies(after.sent).length === 1, "the recovered reply");
      // No second status notice: the message had started before the restart.
      expect(after.sent.map((item) => [item.kind, item.text, item.msgUid])).toEqual([["reply", "重启后的回答", question.reply.msgUid]]);
      await opened.service.admit(after.message(GROUP, ALICE, "第二条"));
      await until(() => replies(after.sent).length === 2, "both replies");
      expect(replies(after.sent)).toEqual(["重启后的回答", "第二条的回答"]);
      await until(async () => (await pending(opened.service)).length === 0, "no pending delivery");
    } finally { await opened.service.close(); }
  });

  test("an admitted message never submitted (crash after admission) is submitted at start, once", async () => {
    const where = place();
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("第一条回答")]);
    const out = recordingOutbound();
    let opened = open(where, models, model, out.outbound);
    await opened.service.admit(out.message(GROUP, ALICE, "先建会话"));
    await until(() => replies(out.sent).length === 1, "the first reply");
    await opened.service.close();
    await inject(where, (tx, id) => seedItem(tx, id, out, ALICE, { requestId: "msg:unsubmitted", content: "未提交的问题", receivedAt: Date.now() }));
    faux.setResponses([fauxAssistantMessage("补交后的回答"), fauxAssistantMessage("不该有第二次")]);
    opened = open(where, models, model, out.outbound);
    try {
      expect(await opened.service.start()).toEqual([scopeOf(GROUP)]);
      await until(() => replies(out.sent).length === 2, "the recovered answer");
      await Bun.sleep(100);
      expect(faux.state.callCount).toBe(2);
      expect(replies(out.sent)).toEqual(["第一条回答", "补交后的回答"]);
    } finally { await opened.service.close(); }
  });

  test("a /stop waiting in the control stream runs again at start, before the worker: what arrived before it is dropped, what arrived after it runs", async () => {
    const where = place();
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("第一条回答")]);
    const out = recordingOutbound();
    let opened = open(where, models, model, out.outbound);
    await opened.service.admit(out.message(GROUP, ALICE, "先建会话"));
    await until(() => replies(out.sent).length === 1, "the first reply");
    await opened.service.close();
    // A crash between the control's admission and its execution: one message admitted before it, one after it.
    const at = Date.now();
    await inject(where, async (tx, id, controls) => {
      controls.seq = 1;
      controls.pending.push({ phone: ALICE, requestId: "ctl:replayed", seq: 1, command: "/stop", receivedAt: at, reply: out.message(GROUP, ALICE, "/stop").reply });
      await seedItem(tx, id, out, ALICE, { requestId: "msg:before", content: "不该运行", receivedAt: at - 1 });
      await seedItem(tx, id, out, ALICE, { requestId: "msg:after", content: "停止之后", receivedAt: at + 1 });
    });
    const seen: string[] = [];
    faux.setResponses(["停止之后的回答", "重启后新消息的回答", "不该有第四次"].map((answer) => (transcript: { messages: unknown[] }) => {
      seen.push(JSON.stringify(transcript.messages));
      return fauxAssistantMessage(answer);
    }));
    opened = open(where, models, model, out.outbound);
    try {
      expect(await opened.service.start()).toEqual([scopeOf(GROUP)]);
      // The message after the /stop runs once the /stop ran; the one before it never reaches the model.
      await until(() => faux.state.callCount === 2, "the message after the /stop");
      await until(() => replies(out.sent).includes("停止之后的回答"), "the reply of the message after the /stop");
      await opened.service.admit(out.message(GROUP, ALICE, "重启后的新消息"));
      await until(() => replies(out.sent).includes("重启后新消息的回答"), "the new reply");
      await Bun.sleep(100);
      expect(faux.state.callCount).toBe(3);
      expect(replies(out.sent)).toEqual(["第一条回答", "停止之后的回答", "重启后新消息的回答"]);
      // The replayed /stop answers its own command message.
      expect(notices(out.sent).some((text) => text.startsWith("⏹ 已停止你在本群的当前任务"))).toBe(true);
      await until(async () => (await pending(opened.service)).length === 0, "no pending delivery");
      expect(seen.join("")).not.toContain("不该运行");
    } finally { await opened.service.close(); }
    const database = createSession(await openGroupStorage(databaseOf(where.root, GROUP)));
    try {
      expect((await database.snapshot(ControlsDoc, context))?.pending).toEqual([]);
    } finally { await database.close(context); }
  });

  test("a /clear queued while stopped (history clear) runs at start for every member: queued messages dropped, new context", async () => {
    const where = place();
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("Alice 第一轮回答"), fauxAssistantMessage("Bob 第一轮回答")]);
    const out = recordingOutbound();
    let opened = open(where, models, model, out.outbound);
    await opened.service.admit(out.message(GROUP, ALICE, "Alice 第一轮"));
    await until(() => replies(out.sent).length === 1, "Alice's first reply");
    await opened.service.admit(out.message(GROUP, BOB, "Bob 第一轮"));
    await until(() => replies(out.sent).length === 2, "Bob's first reply");
    await opened.service.close();
    // The stopped process's clock can be ahead of maintenance's clock: every existing input still precedes this clear.
    await inject(where, (tx, id) => seedItem(tx, id, out, ALICE, { requestId: "msg:queued", content: "清空前排队", receivedAt: Date.now() + 60_000 }));
    const path = databaseOf(where.root, GROUP);
    expect(await queueSpaceClear(path)).toEqual({ scope: scopeOf(GROUP), queued: [ALICE, BOB], waiting: [] });
    // Run twice: no second /clear per member.
    expect(await queueSpaceClear(path)).toEqual({ scope: scopeOf(GROUP), queued: [], waiting: [ALICE, BOB] });
    expect(await queueSpaceClear(databaseOf(where.root, "no-group"))).toBeUndefined();
    const seen: Message[][] = [];
    faux.setResponses([1, 2].map(() => (transcript: { messages: unknown[] }) => {
      seen.push(transcript.messages as Message[]);
      return fauxAssistantMessage("新会话回答");
    }));
    opened = open(where, models, model, out.outbound);
    try {
      expect(await opened.service.start()).toEqual([scopeOf(GROUP)]);
      await opened.service.admit(out.message(GROUP, ALICE, "Alice 清空之后"));
      await opened.service.admit(out.message(GROUP, BOB, "Bob 清空之后"));
      await until(() => replies(out.sent).length === 4, "the replies after the clear");
      await Bun.sleep(100);
      // The message queued before the clear never reached the model; neither member sees its old context.
      expect(faux.state.callCount).toBe(4);
      const text = JSON.stringify(seen);
      expect(text).toContain("Alice 清空之后");
      expect(text).toContain("Bob 清空之后");
      for (const old of ["第一轮", "清空前排队"]) expect(text).not.toContain(old);
    } finally { await opened.service.close(); }
    const database = createSession(await openGroupStorage(path));
    try {
      expect((await database.snapshot(ControlsDoc, context))?.pending).toEqual([]);
    } finally { await database.close(context); }
  });
});

describe("durable service: storage identity", () => {
  test("a member whose directory is an alias of another spelling is refused at admission, before anything is stored", async () => {
    const where = place();
    const { models, model } = fauxModels();
    const out = recordingOutbound();
    await mkdir(join(where.root, "tmp", "groups", GROUP, "Abc"), { recursive: true });
    const { service } = open(where, models, model, out.outbound);
    try {
      await expect(service.admit(out.message(GROUP, "abc", "大小写别名"))).rejects.toThrow("标识大小写与已有目录 Abc 冲突");
      expect(service.seen(out.sent[0]?.msgUid ?? "none")).toBe(false);
      expect(await readdir(join(where.root, "tmp", "groups", GROUP))).toEqual(["Abc"]);
      expect(existsSync(databaseOf(where.root, GROUP))).toBe(false);
    } finally { await service.close(); }
  });
});

test("a control holds the request door at receipt, before its asynchronous group acquire", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  const held = gate("must not be dispatched"); faux.setResponses([held.step]);
  const auth = Promise.withResolvers<void>(), acquire = Promise.withResolvers<void>();
  let authEntered = false, authReturned = false, blockAcquire = false, acquireEntered = false;
  let checked: number | undefined;
  const originalAuth = models.getAuth.bind(models);
  const authSpy = spyOn(models, "getAuth").mockImplementation(async (...args) => {
    authEntered = true; await auth.promise; authReturned = true;
    return typeof args[0] === "string" ? originalAuth(args[0], args[1]) : originalAuth(args[0], args[1]);
  });
  const originalAcquire = SpaceHarnesses.prototype.acquire;
  const acquireSpy = spyOn(SpaceHarnesses.prototype, "acquire").mockImplementation(async function (this: SpaceHarnesses, scope) {
    if (blockAcquire) { acquireEntered = true; await acquire.promise; }
    return originalAcquire.call(this, scope);
  });
  const originalPending = RequestDoor.prototype.pendingControls;
  const pendingSpy = spyOn(RequestDoor.prototype, "pendingControls").mockImplementation(function (this: RequestDoor, phone) {
    const count = originalPending.call(this, phone);
    if (authReturned && acquireEntered) checked ??= count;
    return count;
  });
  const { service } = open(where, models, model, out.outbound);
  let command: Promise<string> | undefined;
  try {
    await service.admit(out.message(GROUP, ALICE, "held before dispatch"));
    await until(() => authEntered, "credential resolution");
    blockAcquire = true;
    command = service.control(out.message(GROUP, ALICE, "/stop"));
    await until(() => acquireEntered, "control's group acquire");
    auth.resolve();
    await until(() => checked !== undefined, "serial boundary after credential resolution");
    expect(checked).toBeGreaterThan(0);
    expect(faux.state.callCount).toBe(0);
  } finally {
    blockAcquire = false; auth.resolve(); acquire.resolve();
    await command?.catch(() => {}); held.open();
    await service.close(); pendingSpy.mockRestore(); acquireSpy.mockRestore(); authSpy.mockRestore();
  }
});

test("a control waits for a start that passed its gate, before looking up/aborting the conversation", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  faux.setResponses([fauxAssistantMessage("after the control")]);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), admitted = Promise.withResolvers<void>();
  let submitExists = false, block = true, admittedSeen = false, earlyLookup = false;
  const prototype = await harnessPrototype(models), originalConversation = prototype.conversation;
  const originalSnapshot = prototype.snapshot;
  const snapshotSpy = spyOn(prototype, "snapshot").mockImplementation(function (this: Harness, ...args: unknown[]) {
    if (admittedSeen && !submitExists && args[0] === ControlsDoc) earlyLookup = true;
    return Reflect.apply(originalSnapshot, this, args);
  } as Harness["snapshot"]);
  const conversationSpy = spyOn(prototype, "conversation").mockImplementation(async function (this: Harness, ...args) {
    if (admittedSeen && !submitExists) earlyLookup = true;
    const conversation = await originalConversation.call(this, ...args);
    if (!conversation) return conversation;
    return new Proxy(conversation, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "submit") return async (...params: Parameters<typeof target.submit>) => {
        if (block) { entered.resolve(); await release.promise; }
        const submission = await target.submit(...params); submitExists = true; return submission;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  const originalAdmitted = RequestDoor.prototype.controlAdmitted;
  const admittedSpy = spyOn(RequestDoor.prototype, "controlAdmitted").mockImplementation(function (this: RequestDoor, ...args) {
    originalAdmitted.call(this, ...args); admittedSeen = true; admitted.resolve();
  });
  const { service } = open(where, models, model, out.outbound);
  let command: Promise<string> | undefined;
  try {
    await service.admit(out.message(GROUP, ALICE, "must be cancelled before it starts"));
    await entered.promise;
    command = service.control(out.message(GROUP, ALICE, "/clear"));
    await admitted.promise;
    // The mutation removing the wait synchronously calls harness.conversation before this continuation.
    expect(earlyLookup).toBe(false);
    block = false; release.resolve(); await command;
    expect(faux.state.callCount).toBe(0);
    await service.admit(out.message(GROUP, ALICE, "new question after clear"));
    await until(() => replies(out.sent).length === 1, "the new question's answer");
    expect(replies(out.sent)).toEqual(["after the control"]);
  } finally {
    block = false; release.resolve(); await command?.catch(() => {});
    await service.close(); conversationSpy.mockRestore(); admittedSpy.mockRestore(); snapshotSpy.mockRestore();
  }
});

/**
 * A run settles while a /stop or /clear waits before its receipt check (its group acquire is held). `redelivered`: the
 * control is the platform's redelivery of one executed before a restart, so the run's answer goes out; otherwise it is a
 * new control and the run is cancelled.
 */
async function settleDuringReceiptCheck(command: "/stop" | "/clear", redelivered: boolean) {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  const control = out.message(GROUP, ALICE, command);
  let { service, reports } = open(where, models, model, out.outbound);
  if (redelivered) {
    await service.control(control);
    await service.close();
    ({ service, reports } = open(where, models, model, out.outbound));
    await service.start();
    expect(service.seen(control.reply.msgUid)).toBe(false);
  }
  const held = gate("重启后的回答"); faux.setResponses([held.step]);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let block = false;
  const originalAcquire = SpaceHarnesses.prototype.acquire;
  const acquireSpy = spyOn(SpaceHarnesses.prototype, "acquire").mockImplementation(async function (this: SpaceHarnesses, scope) {
    if (block) { block = false; entered.resolve(); await release.promise; }
    return originalAcquire.call(this, scope);
  });
  let receipt: Promise<string> | undefined;
  try {
    const question = out.message(GROUP, ALICE, "重启后的问题");
    await service.admit(question);
    await until(() => held.state.started === 1, "the request");
    block = true;
    receipt = service.control(control);
    await entered.promise;
    held.open();
    // The settled run waits for the receipt check: nothing is decided or sent yet.
    await Bun.sleep(100);
    expect(out.sent.filter(item => item.msgUid === question.reply.msgUid)).toEqual([]);
    release.resolve();
    const text = await receipt;
    const record = async () => Object.values((await service.records(scopeOf(GROUP), ALICE)).requests).find(each => each.reply.msgUid === question.reply.msgUid)!;
    await until(async () => (await record()).closedAt !== undefined, "the run's record closed");
    if (redelivered) await until(() => replies(out.sent).includes("重启后的回答"), "the answer");
    else await Bun.sleep(100);
    return { text, record: await record(), answers: out.sent.filter(item => item.msgUid === question.reply.msgUid), reports };
  } finally {
    block = false; release.resolve(); held.open();
    await receipt?.catch(() => {});
    await service.close(); acquireSpy.mockRestore();
  }
}

for (const command of ["/stop", "/clear"] as const) {
  test(`a ${command} redelivered after a restart neither cancels nor withholds a reply that settles during its receipt check`, async () => {
    const { text, record, answers, reports } = await settleDuringReceiptCheck(command, true);
    expect(text).toBe("");
    expect(record.cancelled).not.toBe(true);
    expect(answers.map(item => item.text)).toEqual(["重启后的回答"]);
    expect(reports).toEqual([]);
  });

  test(`a new ${command} still cancels a run that settles during its receipt check`, async () => {
    const { text, record, answers, reports } = await settleDuringReceiptCheck(command, false);
    expect(text).not.toBe("");
    expect(record.cancelled).toBe(true);
    expect(record.delivery).toBeUndefined();
    expect(answers).toEqual([]);
    expect(reports).toEqual([]);
  });
}

test.skipIf(process.getuid?.() === 0)("a held result defers idle reclamation without blocking clear or later messages", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  faux.setResponses([fauxAssistantMessage("seed"), fauxAssistantMessage("after the failed cleanup")]);
  let resets = 0;
  const prototype = await harnessPrototype(models), originalConversation = prototype.conversation;
  const spy = spyOn(prototype, "conversation").mockImplementation(async function (this: Harness, ...args) {
    const conversation = await originalConversation.call(this, ...args);
    if (!conversation) return conversation;
    return new Proxy(conversation, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "reset") return (...params: Parameters<typeof target.reset>) => { resets++; return target.reset(...params); };
      return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  await registeredResult(where, models, model, "1-locked");
  const { service } = open(where, models, model, out.outbound);
  const temp = tmpOf(where.root, GROUP, ALICE), locked = join(resultsRoot(temp), "1-locked");
  let held: HeldDirectory | undefined, command: Promise<string> | undefined;
  try {
    await service.admit(out.message(GROUP, ALICE, "seed"));
    await until(() => replies(out.sent).length === 1, "seed reply");
    await mkdir(locked, { recursive: true }); await writeFile(join(locked, "index.txt"), "synthetic");
    if (process.platform === "win32") held = await holdDirectory(temp, ["codemode", "1-locked"]);
    else await chmod(locked, 0o555);
    command = service.control(out.message(GROUP, ALICE, "/clear"));
    expect(await command).toContain("开启新会话");
    await service.admit(out.message(GROUP, ALICE, "later question"));
    await until(() => replies(out.sent).length === 2, "new context proceeds with deferred physical reclamation");
    expect(replies(out.sent)).toEqual(["seed", "after the failed cleanup"]);
    await until(async () => {
      await service.maintain();
      return await awaitingRemoval(databaseOf(where.root, GROUP), ALICE) > 0;
    }, "held result remains recorded for maintenance");
    expect(resets).toBe(1);
    expect(await readFile(join(locked, "index.txt"), "utf8")).toBe("synthetic");
    if (process.platform === "linux") return;
    if (held) { await held.release(); held = undefined; } else await chmod(locked, 0o755);
    const later = Date.now() + 61_000, clock = spyOn(Date, "now").mockReturnValue(later);
    try { await until(async () => { await service.maintain(later); return !(await readdir(resultsRoot(temp))).includes("1-locked"); }, "unlocked result reclaimed"); }
    finally { clock.mockRestore(); }
    expect(resets).toBe(1); expect(await readdir(resultsRoot(temp))).toEqual([]);
  } finally {
    await held?.release(); await chmod(locked, 0o755).catch(() => {}); await command?.catch(() => {});
    await service.close(); spy.mockRestore();
  }
}, 20_000);

test("a transient storage error while settling: the worker settles the same submission again, without another provider call or duplicate send", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  let armed = false;
  faux.setResponses([() => { armed = true; return fauxAssistantMessage("first"); }, fauxAssistantMessage("second")]);
  await seed(where, models, model, async (tx, id) => {
    await seedItem(tx, id, out, ALICE, { requestId: "msg:first-retry", content: "first question", receivedAt: Date.now() });
    await seedItem(tx, id, out, ALICE, { requestId: "msg:second-retry", content: "second question", receivedAt: Date.now() + 1 });
  });
  const prototype = await harnessPrototype(models), original = prototype.commit;
  const spy = spyOn(prototype, "commit").mockImplementation(function (this: Harness, ...args: unknown[]) {
    if (armed) { armed = false; return Promise.reject(new Error("transient settle I/O failure")); }
    return Reflect.apply(original, this, args);
  } as Harness["commit"]);
  const { service, reports } = open(where, models, model, out.outbound);
  try {
    await service.start();
    // A failed mutant reports counts at an assertion, not as the test framework's timeout.
    await until(() => replies(out.sent).length === 2, "automatic retry and queued message", 3000).catch(() => {});
    expect(faux.state.callCount).toBe(2);
    expect(replies(out.sent)).toEqual(["first", "second"]);
    expect(reports.some((error) => String(error).includes("transient settle"))).toBe(true);
    await until(async () => (await pending(service)).length === 0, "no pending delivery");
  } finally { await service.close(); spy.mockRestore(); }
}, 20_000);

test("an uncertain COMMIT fences the whole service immediately and reports fatal once", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  const held = gate("unused"); faux.setResponses([held.step]);
  const fatal: unknown[] = [], { service } = open(where, models, model, out.outbound, { onFatal: (error) => fatal.push(error) });
  const original = SqliteClient.prototype.request;
  let armed = false;
  const spy = spyOn(SqliteClient.prototype, "request").mockImplementation(function (this: SqliteClient, command) {
    const result = original.call(this, command);
    if (armed && command.kind === "sql" && command.sql === "COMMIT") {
      armed = false; return result.then(() => { throw new Error("lost native COMMIT acknowledgement"); }) as never;
    }
    return result as never;
  });
  try {
    await service.admit(out.message(GROUP, ALICE, "first")); await until(() => held.state.started === 1, "provider");
    armed = true;
    await expect(service.admit(out.message(GROUP, ALICE, "second"))).rejects.toBeInstanceOf(DurableStorageFailure);
    expect(fatal).toHaveLength(1);
    await expect(service.admit(out.message(GROUP, BOB, "third"))).rejects.toBe(fatal[0]);
    expect(faux.state.callCount).toBe(1);
  } finally { spy.mockRestore(); held.open(); await service.close().catch(() => {}); }
});

test("an admission whose commit rolled back leaves no receipt: the platform's redelivery is admitted and answered once", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  faux.setResponses([fauxAssistantMessage("warm-up"), fauxAssistantMessage("answer")]);
  const prototype = await harnessPrototype(models), original = prototype.commit;
  let armed = false;
  const spy = spyOn(prototype, "commit").mockImplementation(function (this: Harness, ...args: unknown[]) {
    if (armed) { armed = false; return Promise.reject(new Error("admission rolled back")); }
    return Reflect.apply(original, this, args);
  } as Harness["commit"]);
  const { service } = open(where, models, model, out.outbound);
  try {
    // The member's conversation exists: the next commit of an admission is the admission itself.
    await service.admit(out.message(GROUP, ALICE, "warm-up")); await until(() => replies(out.sent).length === 1, "warm-up");
    const message = out.message(GROUP, ALICE, "question");
    armed = true;
    await expect(service.admit(message)).rejects.toThrow("admission rolled back");
    expect(service.seen(message.reply.msgUid)).toBe(false);
    expect(await service.admit(message)).toEqual({ status: "accepted" });
    await until(() => replies(out.sent).length === 2, "the answer");
    expect(await service.admit(message)).toEqual({ status: "duplicate" });
    await Bun.sleep(50);
    expect(replies(out.sent)).toEqual(["warm-up", "answer"]); expect(faux.state.callCount).toBe(2);
  } finally { spy.mockRestore(); await service.close(); }
});

test("an admission whose COMMIT outcome was lost but landed: after the restart the message runs once and its redelivery is a duplicate", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  faux.setResponses([fauxAssistantMessage("warm-up"), fauxAssistantMessage("answer")]);
  const fatal: unknown[] = [], first = open(where, models, model, out.outbound, { onFatal: (error) => fatal.push(error) });
  const original = SqliteClient.prototype.request;
  let armed = false;
  const spy = spyOn(SqliteClient.prototype, "request").mockImplementation(function (this: SqliteClient, command) {
    const result = original.call(this, command);
    if (armed && command.kind === "sql" && command.sql === "COMMIT") {
      armed = false; return result.then(() => { throw new Error("lost native COMMIT acknowledgement"); }) as never;
    }
    return result as never;
  });
  const message = out.message(GROUP, ALICE, "question");
  let second: DurableService | undefined;
  try {
    await first.service.admit(out.message(GROUP, ALICE, "warm-up")); await until(() => replies(out.sent).length === 1, "warm-up");
    // Arm only after the warm-up turn's own closing commits, or the lost acknowledgement could hit one of them.
    await until(async () => {
      const records = await first.service.records(scopeOf(GROUP), ALICE);
      return pendingDeliveries(records).length === 0 && Object.values(records.requests).every(record => record.closedAt !== undefined);
    }, "the warm-up request closed");
    armed = true;
    await expect(first.service.admit(message)).rejects.toBeInstanceOf(DurableStorageFailure);
    expect(fatal).toHaveLength(1);
    spy.mockRestore();
    await first.service.close().catch(() => {});
    second = open(where, models, model, out.outbound).service;
    await second.start();
    await until(() => replies(out.sent).length === 2, "the answer after the restart");
    expect(await second.admit(message)).toEqual({ status: "duplicate" });
    await Bun.sleep(50);
    expect(replies(out.sent)).toEqual(["warm-up", "answer"]); expect(faux.state.callCount).toBe(2);
  } finally { spy.mockRestore(); await first.service.close().catch(() => {}); await second?.close(); }
});

test("a new clear cancels older persisted input even when its old-process timestamp is ahead of the current clock", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  await seed(where, models, model, (tx, id) => seedItem(tx, id, out, ALICE, { requestId: "msg:old-clock", content: "old persisted input", receivedAt: Date.now() + 60_000 }));
  const seen: string[] = [];
  const step: FauxResponseFactory = (transcript) => {
    const input = transcript.messages.filter((message) => message.role === "user").at(-1)!;
    seen.push(JSON.stringify(input));
    return fauxAssistantMessage(JSON.stringify(input).includes("after clear") ? "new answer" : "old leaked");
  };
  faux.setResponses([step, step]);
  const { service } = open(where, models, model, out.outbound);
  try {
    await service.control(out.message(GROUP, ALICE, "/clear"));
    await service.admit(out.message(GROUP, ALICE, "after clear"));
    await until(() => replies(out.sent).includes("new answer"), "the input after clear");
    expect(faux.state.callCount).toBe(1);
    expect(seen.join("")).not.toContain("old persisted input");
  } finally { await service.close(); }
});

test("a clear also cancels an older admit that commits only after the clear finishes", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  const seen: string[] = [];
  const step: FauxResponseFactory = (transcript) => {
    const input = transcript.messages.filter((message) => message.role === "user").at(-1)!;
    seen.push(JSON.stringify(input));
    return fauxAssistantMessage(JSON.stringify(input).includes("after clear") ? "new answer" : "seed or leaked");
  };
  faux.setResponses([step, step, step]);
  const { service } = open(where, models, model, out.outbound);
  await service.admit(out.message(GROUP, ALICE, "seed"));
  await until(() => replies(out.sent).length === 1, "seed reply");
  expect(await service.control(out.message(GROUP, ALICE, "/status"))).toContain("状态：空闲");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = SpaceHarnesses.prototype.acquire;
  let blocked = false;
  const spy = spyOn(SpaceHarnesses.prototype, "acquire").mockImplementation(async function (this: SpaceHarnesses, ...args) {
    if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
    return original.call(this, ...args);
  });
  const admitting = service.admit(out.message(GROUP, ALICE, "old delayed admit"));
  try {
    await entered.promise;
    await service.control(out.message(GROUP, ALICE, "/clear"));
    release.resolve(); await admitting;
    await service.admit(out.message(GROUP, ALICE, "after clear"));
    await until(() => replies(out.sent).includes("new answer"), "the new input");
    expect(faux.state.callCount).toBe(2);
    expect(seen.join("")).not.toContain("old delayed admit");
  } finally { release.resolve(); await admitting.catch(() => {}); await service.close(); spy.mockRestore(); }
});

test("replaying an earlier-epoch stop preserves a later-epoch input after the clock moves backwards", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  await seed(where, models, model, async (tx, id) => {
    const controls = await tx.doc(ControlsDoc);
    controls.epoch = 2; controls.seq = 1;
    controls.pending.push({ phone: ALICE, requestId: "ctl:old-epoch", seq: 1, command: "/stop", receivedAt: 90_000, epoch: 1 });
    await seedItem(tx, id, out, ALICE, { requestId: "msg:older-epoch", content: "must never reach model", receivedAt: 100_000, epoch: 0 });
    await seedItem(tx, id, out, ALICE, { requestId: "msg:newer-epoch", content: "later epoch input", receivedAt: 10_000, epoch: 2 });
  });
  const seen: string[] = [];
  faux.setResponses([(transcript) => { seen.push(JSON.stringify(transcript.messages)); return fauxAssistantMessage("later epoch answer"); }]);
  const { service } = open(where, models, model, out.outbound);
  try {
    await service.start();
    await until(() => replies(out.sent).includes("later epoch answer"), "later-epoch recovery");
    expect(faux.state.callCount).toBe(1);
    expect(seen.join("")).toContain("later epoch input");
    expect(seen.join("")).not.toContain("must never reach model");
  } finally { await service.close(); }
});

test("a message arriving during maintenance waits for one member, not the whole group; the next pass resumes with the next member", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  faux.setResponses([fauxAssistantMessage("answer during maintenance")]);
  const opened = await openGroupHarness(databaseOf(where.root, GROUP), models, { group: GROUP });
  const ids = new Map<number, string>();
  try {
    for (const phone of [ALICE, BOB]) ids.set((await memberConversation(opened.harness, scopeOf(GROUP), phone, { model }, context)).conversation.id, phone);
  } finally { await opened.close(); }
  const visits: string[] = [], entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let block = true;
  const prototype = await harnessPrototype(models), originalSnapshot = prototype.snapshot;
  // Maintenance reads each member's live document once while it holds the group gate.
  const spy = spyOn(prototype, "snapshot").mockImplementation(async function (this: Harness, ...args: unknown[]) {
    if (args[0] === LiveDoc && ids.has(args[1] as number)) {
      visits.push(ids.get(args[1] as number)!);
      if (block) { block = false; entered.resolve(); await release.promise; }
    }
    return Reflect.apply(originalSnapshot, this, args);
  } as Harness["snapshot"]);
  const { service } = open(where, models, model, out.outbound);
  try {
    await service.start();
    const maintenance = service.maintain();
    await entered.promise;
    const first = visits[0]!;
    let admitted = false;
    const message = service.admit(out.message(GROUP, first === ALICE ? BOB : ALICE, "question")).then(result => { admitted = true; return result; });
    await Bun.sleep(50);
    expect(admitted).toBe(false);
    release.resolve();
    expect(await message).toEqual({ status: "accepted" });
    await maintenance;
    expect(visits).toEqual([first]);
    await until(() => replies(out.sent).length === 1, "the answer");
    await until(async () => { await service.maintain(); return visits.length > 1; }, "the next maintenance pass");
    expect(visits[1]).not.toBe(first);
  } finally { release.resolve(); await service.close(); spy.mockRestore(); }
});

test("a /clear after the member's in-memory state was dropped as idle still resets the persisted conversation", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  const users: number[] = [];
  faux.setResponses(Array.from({ length: 2 }, () => (transcript: Parameters<FauxResponseFactory>[0]) => {
    users.push(transcript.messages.filter(message => message.role === "user").length);
    return fauxAssistantMessage("answer");
  }));
  const { service } = open(where, models, model, out.outbound,
    { limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20, memberIdleMs: 1 } });
  try {
    await service.admit(out.message(GROUP, ALICE, "before"));
    await until(() => replies(out.sent).length === 1, "the first answer");
    await Bun.sleep(20);
    // The pass drops idle member state; the persisted conversation stays.
    await service.maintain();
    await service.control(out.message(GROUP, ALICE, "/clear"));
    await service.admit(out.message(GROUP, ALICE, "after"));
    await until(() => replies(out.sent).length === 2, "the second answer");
    expect(users).toEqual([1, 1]);
  } finally { await service.close(); }
});
