// The Durable message lifecycle (D3, src/durable/service.ts): durable admission, the member worker and its replies,
// queue limit, /stop, /clear, /deliver, /status, the watchdog, restart recovery, control replay (also of a /clear queued
// while stopped, src/durable/offline.ts), storage identity and usage projection. Faux providers and a recording outbound; no network, no real IM.
import { afterAll, describe, spyOn, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { Database } from "bun:sqlite";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type AssistantMessage, type Message, type Models, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession, defineExtension, type Harness, type ModelRef } from "@earendil-works/pi-durable";
import { ResultsDoc } from "../../src/durable/result-lifecycle.ts";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { userTempDir } from "../../src/agent/paths.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { resultsRoot } from "../../src/durable/codemode/results.ts";
import { holdDirectory, type HeldDirectory } from "../../src/durable/codemode/directory.ts";
import { GroupHarnesses, groupDatabasePath } from "../../src/durable/groups.ts";
import { RequestDoor } from "../../src/durable/door.ts";
import { memberConversation, MemberDirectory } from "../../src/durable/identity.ts";
import { ControlsDoc, InboxDoc, type InboxItem, type StoredControl } from "../../src/durable/inbox.ts";
import { queueGroupClear } from "../../src/durable/offline.ts";
import { LegacyImportDoc } from "../../src/durable/projection.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import type { ModelSelection } from "../../src/durable/models.ts";
import { DurableService, type DurableServiceOptions, type Outbound, STATUS_TEXT } from "../../src/durable/service.ts";
import { SqliteClient } from "../../src/durable/sqlite-client.ts";
import { DurableStorageFailure } from "../../src/durable/storage-failure.ts";
import { fauxModels, openGroupHarness, TEST_PROGRESS } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import "../helpers/restore-spies.ts";

const fixture = await tempFixture("durable-service-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a";
const ALICE = "13800000001";
const BOB = "13800000002";
const URL = "https://example.invalid/callback?key=synthetic";
let counter = 0;

type Sent = { kind: "status" | "text" | "reply"; text: string; phone: string; appendix?: string };

function recordingOutbound() {
  const sent: Sent[] = [];
  /** Every send as "group phone url: text". */
  const targets: string[] = [];
  const state = { fail: false };
  const outbound: Outbound = {
    async sendText(text, groupId, phone, url, options) {
      sent.push({ kind: options?.traffic === "status" ? "status" : "text", text, phone });
      targets.push(`${groupId} ${phone} ${url}: ${text}`);
      return !state.fail;
    },
    async sendReply(text, groupId, phone, url, _signal, appendix) {
      sent.push({ kind: "reply", text, phone, ...(appendix === undefined ? {} : { appendix }) });
      targets.push(`${groupId} ${phone} ${url}: ${text}`);
      return !state.fail;
    },
    rate: () => ({ used: 1, limit: 20 }),
    refresh: async (item) => item.text,
  };
  return { sent, targets, outbound, state };
}

function selection(models: Models, ref: ModelRef, contextWindow = 128000): ModelSelection {
  const model = models.getModel(ref.provider, ref.modelId)!;
  return {
    runtime: models as never, settings: undefined as never, model: { ...model, contextWindow } as never, ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
    notices: [],
  };
}

type Fixture = { root: string; stateDb: Database; deliveries: DeliveryStore };

function place(): Fixture {
  const stateDb = new Database(":memory:");
  return { root: join(fixture.root, `root-${++counter}`), stateDb, deliveries: new DeliveryStore(stateDb) };
}

/** Harness is a public factory. Obtain the implementation prototype from a real, closed instance. */
async function harnessPrototype(models: Models): Promise<Pick<Harness, "conversation" | "snapshot">> {
  const opened = await openGroupHarness(join(fixture.root, `prototype-${++counter}.sqlite`), models);
  try { return Object.getPrototypeOf(opened.harness) as Pick<Harness, "conversation" | "snapshot">; }
  finally { await opened.close(); }
}

function open(where: Fixture, models: Models, ref: ModelRef, outbound: Outbound, options: Partial<DurableServiceOptions> = {}) {
  const reports: unknown[] = [];
  const service = new DurableService({
    root: where.root, selection: selection(models, ref), modules: [], relay: null, materials: false,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 },
    outbound, deliveries: where.deliveries, stateDb: where.stateDb, onReport: (error) => reports.push(error), ...options,
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

const replies = (sent: Sent[]) => sent.filter((item) => item.kind === "reply").map((item) => item.text);

async function registeredResult(where: Fixture, models: Models, model: ModelRef, name: string) {
  const opened = await openGroupHarness(groupDatabasePath(where.root, GROUP), models, { group: GROUP });
  try {
    await memberConversation(opened.harness, GROUP, ALICE, { model }, context);
    await opened.harness.commit(async tx => { (await tx.doc(ResultsDoc)).calls[name] = { phone: ALICE, createdAt: Date.now() }; }, context);
  } finally { await opened.close(); }
}

/** Change Alice's inbox and the control stream directly in the closed group database (a crash window). */
async function inject(where: Fixture, change: (inbox: { items: InboxItem[] }, controls: { seq: number; pending: StoredControl[] }) => void) {
  const session = createSession(await openGroupStorage(groupDatabasePath(where.root, GROUP)));
  try {
    const member = await session.snapshot(MemberDirectory, ALICE, context);
    await session.commit(async (tx) => {
      change(await tx.doc(InboxDoc, member!.conversationId as ConversationId), await tx.doc(ControlsDoc));
    }, context);
  } finally { await session.close(context); }
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
    const acquire = GroupHarnesses.prototype.acquire;
    let first = true, secondSettled = false;
    const spy = spyOn(GroupHarnesses.prototype, "acquire").mockImplementation(async function(this: GroupHarnesses, groupId) {
      if (first) { first = false; entered.resolve(); await release.promise; if (failFirst) throw new Error("synthetic admission failure"); }
      return acquire.call(this, groupId);
    });
    let earlier: Promise<unknown> | undefined, later: Promise<unknown> | undefined;
    try {
      earlier = service.admit(ALICE, GROUP, "FIRST: template A", URL).catch(error => error);
      await entered.promise;
      later = service.admit(ALICE, GROUP, "SECOND: template B", URL).finally(() => { secondSettled = true; });
      await service.admit(BOB, GROUP, "OTHER", URL);
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
    const acquire = GroupHarnesses.prototype.acquire;
    let first = true;
    const spy = spyOn(GroupHarnesses.prototype, "acquire").mockImplementation(async function(this: GroupHarnesses, groupId) {
      if (first) { first = false; entered.resolve(); await release.promise; }
      return acquire.call(this, groupId);
    });
    let earlier: Promise<unknown> | undefined, later: Promise<unknown> | undefined;
    try {
      earlier = service.admit(ALICE, GROUP, "OLD", URL); await entered.promise;
      await service.control(ALICE, GROUP, command, URL);
      later = service.admit(ALICE, GROUP, "FRESH", URL);
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
      await service.admit(ALICE, GROUP, "history", URL); await until(() => replies(out.sent).length === 1, "history");
      await service.admit(ALICE, GROUP, "live", URL); await until(() => held.state.started === 1, "live generation");
      pending.push(service.control(ALICE, GROUP, "/compact", URL));
      pending.push(service.control(ALICE, GROUP, "/compact", URL));
      const storage = await openGroupStorage(groupDatabasePath(where.root, GROUP));
      try {
        await until(async () => (await storage.scanSubmissions({}, 100, undefined, context)).items.some(s => s.type === "write" && s.status === "queued"), "queued summary");
        await service.control(ALICE, GROUP, command, URL);
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
      await service.admit(ALICE, GROUP, "historical request", URL); await until(() => replies(out.sent).length === 1, "history");
      await service.admit(ALICE, GROUP, "live request", URL); await until(() => held.state.started === 1, "live generation");
      let resolved = false;
      compact = service.control(ALICE, GROUP, "/compact", URL).then(reply => { resolved = true; return reply; });
      const storage = await openGroupStorage(groupDatabasePath(where.root, GROUP));
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
    try { expect(await service.control(ALICE, GROUP, "/compact", URL)).toContain("无需压缩"); }
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
      expect(await service.admit(ALICE, GROUP, "你好", URL)).toEqual({ status: "accepted" });
      await until(() => held.state.started === 1, "the request");
      expect(out.sent).toEqual([{ kind: "status", text: STATUS_TEXT, phone: ALICE }]);
      held.open();
      await until(() => replies(out.sent).length === 1, "the reply");
      expect(replies(out.sent)).toEqual(["你好，这是回答"]);
      expect(where.deliveries.pending(JSON.stringify([GROUP, ALICE]))).toEqual([]);
      const ledger = openStatsLedger(where.root);
      try {
        const rows = readLedger(ledger);
        expect(rows.activity.map(({ group, user, asks, replies: answered }) => ({ group, user, asks, replies: answered })))
          .toEqual([{ group: GROUP, user: ALICE, asks: 1, replies: 1 }]);
        expect(rows.usage.map(({ kind, requests }) => ({ kind, requests }))).toEqual([{ kind: "assistant", requests: 1 }]);
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
      expect((await service.admit(ALICE, GROUP, "第1条", URL)).status).toBe("accepted");
      await until(() => first.state.started === 1, "the first request");
      expect((await service.admit(BOB, GROUP, "别人的消息", URL)).status).toBe("accepted");
      await until(() => replies(out.sent).includes("别人"), "the other member's reply");
      for (let index = 2; index <= 9; index++) expect((await service.admit(ALICE, GROUP, `第${index}条`, URL)).status).toBe("accepted");
      expect(await service.admit(ALICE, GROUP, "第10条", URL)).toEqual({ status: "full", message: "本会话已有 8 条消息排队，请稍后重发" });
      first.open();
      await until(() => replies(out.sent).length === 10, "all replies");
      expect(replies(out.sent).filter((text) => text !== "别人")).toEqual(["一", ...Array.from({ length: 8 }, (_, index) => `回答${index + 2}`)]);
    } finally { await service.close(); }
  });

  test("a model error is reported to the member as the AgentSession engine reports it; nothing is stored for /deliver", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 invalid api key" })]);
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(ALICE, GROUP, "会失败", URL);
      await until(() => out.sent.some((item) => item.kind === "text"), "the failure text");
      const failure = out.sent.find((item) => item.kind === "text")!.text;
      expect(failure).toContain("⚠️ 抱歉，处理您的请求时出错了。");
      expect(failure).toContain("401 invalid api key");
      expect(where.deliveries.pending(JSON.stringify([GROUP, ALICE]))).toEqual([]);
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
      await service.admit(ALICE, GROUP, "第一条", URL);
      await until(() => started === 1, "the first request");
      await service.admit(ALICE, GROUP, "第二条", URL);
      failNow();
      await until(() => replies(out.sent).length === 1, "the second reply");
      expect(out.sent.filter((item) => item.kind === "text").map((item) => item.text).join("\n")).toContain("401 invalid api key");
      expect(replies(out.sent)).toEqual(["第二条的回答"]);
    } finally { await service.close(); }
  });

  test("one member in two groups: two independent runs at once; replies, callbacks and usage stay in their group", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const first = gate("甲群的回答");
    const second = gate("乙群的回答");
    faux.setResponses([first.step, second.step]);
    const { service } = open(where, models, model, out.outbound);
    const urlB = "https://example.invalid/callback?key=synthetic-b";
    try {
      await service.admit(ALICE, GROUP, "甲群的问题", URL);
      await until(() => first.state.started === 1, "the first group's request");
      await service.admit(ALICE, "group-b", "乙群的问题", urlB);
      // Both run at once: neither waits for the other.
      await until(() => second.state.started === 1, "the second group's request");
      expect(JSON.stringify(second.state.transcripts[0])).not.toContain("甲群");
      second.open();
      await until(() => replies(out.sent).length === 1, "the second group's reply");
      first.open();
      await until(() => replies(out.sent).length === 2, "the first group's reply");
      expect(out.targets.filter((line) => line.endsWith("的回答")))
        .toEqual([`group-b ${ALICE} ${urlB}: 乙群的回答`, `${GROUP} ${ALICE} ${URL}: 甲群的回答`]);
      const ledger = openStatsLedger(where.root);
      try {
        expect(readLedger(ledger).activity.map(({ group, user, asks, replies: answered }) => ({ group, user, asks, replies: answered }))
          .sort((a, b) => a.group.localeCompare(b.group)))
          .toEqual([{ group: GROUP, user: ALICE, asks: 1, replies: 1 }, { group: "group-b", user: ALICE, asks: 1, replies: 1 }]);
      } finally { ledger.close(); }
    } finally { await service.close(); }
  });

  test("a failed reply send stays in the outbox; /deliver sends it", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    faux.setResponses([fauxAssistantMessage("要补发的回答")]);
    const { service } = open(where, models, model, out.outbound);
    try {
      out.state.fail = true;
      await service.admit(ALICE, GROUP, "问题", URL);
      await until(() => out.sent.some((item) => item.text === "回复未能完整发到群里，已保存的内容可用 /deliver 补发"), "the failure notice");
      expect(where.deliveries.pending(JSON.stringify([GROUP, ALICE])).map((item) => item.text)).toEqual(["要补发的回答"]);
      out.state.fail = false;
      expect(await service.control(ALICE, GROUP, "/deliver", URL)).toBe("");
      expect(out.sent.at(-1)).toEqual({ kind: "text", text: "要补发的回答", phone: ALICE });
      expect(where.deliveries.pending(JSON.stringify([GROUP, ALICE]))).toEqual([]);
      await service.control(ALICE, GROUP, "/deliver", URL);
      expect(out.sent.at(-1)!.text).toBe("你在本群没有待补发的回复。");
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
      await service.admit(ALICE, GROUP, "长任务", URL);
      await service.admit(ALICE, GROUP, "排队的", URL);
      await until(() => held.state.started === 1, "the request");
      const receipt = await service.control(ALICE, GROUP, "/stop", URL);
      expect(receipt).toContain("⏹ 已停止你在本群的当前任务");
      await service.admit(ALICE, GROUP, "停止之后", URL);
      await until(() => replies(out.sent).length === 1, "the next reply");
      expect(replies(out.sent)).toEqual(["新的回答"]);
      expect(faux.state.callCount).toBe(2);
    } finally { await service.close(); }
    const database = createSession(await openGroupStorage(groupDatabasePath(where.root, GROUP)));
    try {
      expect((await database.snapshot(ControlsDoc, context))?.pending).toEqual([]);
    } finally { await database.close(context); }
  });

  test("/clear waits for the run to end, starts a new context and removes codemode results; a message sent meanwhile runs in the new context", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("旧回答");
    let seen: Message[] = [];
    faux.setResponses([fauxAssistantMessage("第一轮回答"), held.step, (transcript) => { seen = transcript.messages as Message[]; return fauxAssistantMessage("新会话回答"); }]);
    await registeredResult(where, models, model, "1-call_a");
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(ALICE, GROUP, "第一轮", URL);
      await until(() => replies(out.sent).length === 1, "the first reply");
      const results = join(resultsRoot(userTempDir(where.root, GROUP, ALICE)), "1-call_a");
      await mkdir(results, { recursive: true });
      await writeFile(join(results, "index.txt"), "x");
      await service.admit(ALICE, GROUP, "第二轮", URL);
      await until(() => held.state.started === 1, "the second request");
      const clearing = service.control(ALICE, GROUP, "/clear", URL);
      await service.admit(ALICE, GROUP, "清空之后", URL);
      expect(await clearing).toContain("🧹 已为你在本群开启新会话");
      await until(() => replies(out.sent).length === 2, "the reply after clear");
      expect(replies(out.sent)).toEqual(["第一轮回答", "新会话回答"]);
      const text = JSON.stringify(seen);
      expect(text).toContain("清空之后");
      expect(text).not.toContain("第一轮");
      expect(text).not.toContain("第二轮");
      expect(await readdir(resultsRoot(userTempDir(where.root, GROUP, ALICE)))).toEqual(process.platform === "linux" ? ["1-call_a"] : []);
      if (process.platform === "linux") expect(await readFile(join(results, "index.txt"), "utf8")).toBe("x");
    } finally { await service.close(); }
    const database = createSession(await openGroupStorage(groupDatabasePath(where.root, GROUP)));
    try {
      const receipt = (await database.snapshot(ResultsDoc, context))!.calls["1-call_a"]!;
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
      async execute() { started = true; await released; return { content: [{ type: "text", text: "done" }] }; },
    }] });
    faux.setResponses([fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call_slow" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("新会话回答")]);
    const { service } = open(where, models, model, out.outbound, { extensions: () => [slow] });
    const realNow = Date.now;
    try {
      await service.admit(ALICE, GROUP, "第一轮", URL);
      await until(() => started, "the slow tool");
      const stopping = service.control(ALICE, GROUP, "/stop", URL);
      // The clock stands still: the /clear and the message after it arrive in the same millisecond.
      const frozen = realNow() + 1000;
      Date.now = () => frozen;
      let clearing: Promise<string>;
      try {
        clearing = service.control(ALICE, GROUP, "/clear", URL);
        expect(await service.admit(ALICE, GROUP, "清空之后", URL)).toEqual({ status: "accepted" });
      } finally { Date.now = realNow; }
      release();
      await stopping;
      await clearing;
      await until(() => replies(out.sent).length === 1, "the reply after clear");
      expect(replies(out.sent)).toEqual(["新会话回答"]);
    } finally { Date.now = realNow; release(); await service.close(); }
  });

  test("/status reports the running message, the queue and the outbox", async () => {
    const { faux, models, model } = fauxModels();
    const where = place();
    const out = recordingOutbound();
    const held = gate("回答");
    faux.setResponses([held.step, fauxAssistantMessage("第二条")]);
    const { service } = open(where, models, model, out.outbound);
    try {
      await service.admit(ALICE, GROUP, "一", URL);
      await service.admit(ALICE, GROUP, "二", URL);
      await until(() => held.state.started === 1, "the request");
      const status = await service.control(ALICE, GROUP, "/status", URL);
      expect(status).toContain("状态：执行中");
      expect(status).toContain("等待处理的消息：1");
      expect(status).toContain("待补发回复：0");
      expect(status).toContain("最长处理时间：60 秒");
      expect(status).toMatch(/任务编号：[0-9a-f]{8}\n/);
      held.open();
      await until(() => replies(out.sent).length === 2, "both replies");
      expect(await service.control(ALICE, GROUP, "/help", URL)).toContain("可用指令");
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
      await service.admit(ALICE, GROUP, "慢任务", URL);
      await until(() => out.sent.some((item) => item.kind === "text"), "the timeout text");
      expect(out.sent.find((item) => item.kind === "text")!.text).toMatch(/任务总时限 0\.3 秒已到（任务：[0-9a-f]{8}）/);
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
      await service.admit(ALICE, GROUP, "慢任务", URL);
      await until(() => logs.filter((line) => line.startsWith("任务仍在运行")).length >= 2, "two heartbeats");
      held.open();
      await until(() => logs.some((line) => line.startsWith("任务结束")), "the end line");
      const task = /任务: ([0-9a-f]{8})/.exec(logs.find((line) => line.startsWith("任务开始"))!)![1];
      expect(logs.find((line) => line.startsWith("任务开始"))).toContain(`群: ${GROUP}, 用户: ${ALICE}, 任务: ${task}, 总时限: 60秒`);
      expect(logs.find((line) => line.startsWith("任务仍在运行"))).toMatch(new RegExp(`任务: ${task}, 已用: \\d+秒, 阶段: 等待或接收模型输出`));
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
      await service.admit(ALICE, GROUP, "卡住", URL);
      await until(() => out.sent.some((item) => item.kind === "text"), "the idle text");
      expect(out.sent.find((item) => item.kind === "text")!.text).toContain("模型连续 0.3 秒无有效进展");
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
      await service.admit(ALICE, GROUP, "第一轮", URL);
      await until(() => replies(out.sent).length === 1, "the first reply");
      await service.admit(ALICE, GROUP, "第二轮", URL);
      await until(() => summary.state.started === 1, "the summarize request");
      // The second request is the summary of the first turn.
      expect(JSON.stringify(summary.state.transcripts[0])).toContain("第一轮");
      // Held for more than twice the model idle limit: compaction is not a model round, nothing is aborted.
      await until(() => logs.some((line) => line.startsWith("任务仍在运行") && line.endsWith("阶段: 压缩会话历史")), "a heartbeat in the compaction phase");
      await Bun.sleep(700);
      expect(out.sent.filter((item) => item.kind === "text")).toEqual([]);
      summary.open();
      await until(() => replies(out.sent).length === 2, "the second reply");
      expect(replies(out.sent)[1]).toBe("第二轮回答");
      expect(logs.filter((line) => line.startsWith("任务结束")).map((line) => line.includes("结果: done"))).toEqual([true, true]);
      const ledger = openStatsLedger(where.root);
      try {
        const kinds = readLedger(ledger).usage.map(({ kind, requests }) => ({ kind, requests }))
          .sort((a, b) => a.kind.localeCompare(b.kind));
        expect(kinds).toEqual([{ kind: "assistant", requests: 2 }, { kind: "compaction", requests: 1 }]);
      } finally { ledger.close(); }
      expect(reports).toEqual([]);
    } finally { await service.close(); }
  });
});

describe("durable service: restart", () => {
  test("a run cut off by shutdown resumes at start; its reply waits for the member's next message (no callback URL is stored)", async () => {
    const where = place();
    const first = fauxModels();
    const held = gate("不会到");
    first.faux.setResponses([held.step]);
    const out = recordingOutbound();
    let opened = open(where, first.models, first.model, out.outbound);
    await opened.service.admit(ALICE, GROUP, "跨重启的问题", URL);
    await until(() => held.state.started === 1, "the request");
    await opened.service.close();

    const second = fauxModels();
    second.faux.setResponses([fauxAssistantMessage("重启后的回答"), fauxAssistantMessage("第二条的回答")]);
    const after = recordingOutbound();
    opened = open(where, second.models, second.model, after.outbound);
    try {
      expect(await opened.service.start()).toEqual([GROUP]);
      await until(() => where.deliveries.pending(JSON.stringify([GROUP, ALICE])).length === 1, "the stored reply");
      expect(after.sent).toEqual([]);
      await opened.service.admit(ALICE, GROUP, "第二条", URL);
      await until(() => after.sent.filter((item) => item.kind !== "status").length === 2, "both replies");
      expect(after.sent.filter((item) => item.kind !== "status").map((item) => item.text).sort()).toEqual(["第二条的回答", "重启后的回答"]);
      expect(where.deliveries.pending(JSON.stringify([GROUP, ALICE]))).toEqual([]);
    } finally { await opened.service.close(); }
  });

  test("an admitted message never submitted (crash after admission) is submitted at start, once", async () => {
    const where = place();
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("第一条回答")]);
    const out = recordingOutbound();
    let opened = open(where, models, model, out.outbound);
    await opened.service.admit(ALICE, GROUP, "先建会话", URL);
    await until(() => replies(out.sent).length === 1, "the first reply");
    await opened.service.close();
    await inject(where, (inbox) => inbox.items.push({ requestId: "msg:unsubmitted", content: "未提交的问题", receivedAt: Date.now() }));
    faux.setResponses([fauxAssistantMessage("补交后的回答"), fauxAssistantMessage("不该有第二次")]);
    opened = open(where, models, model, out.outbound);
    try {
      expect(await opened.service.start()).toEqual([GROUP]);
      await until(() => where.deliveries.pending(JSON.stringify([GROUP, ALICE])).length === 1, "the stored answer");
      await Bun.sleep(100);
      expect(faux.state.callCount).toBe(2);
      expect(where.deliveries.pending(JSON.stringify([GROUP, ALICE])).map((item) => item.text)).toEqual(["补交后的回答"]);
    } finally { await opened.service.close(); }
  });

  test("a /stop waiting in the control stream runs again at start, before the worker: what arrived before it is dropped, what arrived after it runs", async () => {
    const where = place();
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("第一条回答")]);
    const out = recordingOutbound();
    let opened = open(where, models, model, out.outbound);
    await opened.service.admit(ALICE, GROUP, "先建会话", URL);
    await until(() => replies(out.sent).length === 1, "the first reply");
    await opened.service.close();
    // A crash between the control's admission and its execution: one message admitted before it, one after it.
    const at = Date.now();
    await inject(where, (inbox, controls) => {
      controls.seq = 1;
      controls.pending.push({ phone: ALICE, requestId: "ctl:replayed", seq: 1, command: "/stop", receivedAt: at });
      inbox.items.push({ requestId: "msg:before", content: "不该运行", receivedAt: at - 1 });
      inbox.items.push({ requestId: "msg:after", content: "停止之后", receivedAt: at + 1 });
    });
    const seen: string[] = [];
    faux.setResponses(["停止之后的回答", "重启后新消息的回答", "不该有第四次"].map((answer) => (transcript: { messages: unknown[] }) => {
      seen.push(JSON.stringify(transcript.messages));
      return fauxAssistantMessage(answer);
    }));
    opened = open(where, models, model, out.outbound);
    try {
      expect(await opened.service.start()).toEqual([GROUP]);
      // The message after the /stop runs once the /stop ran (its reply waits for a callback URL); the one before it never
      // reaches the model.
      await until(() => faux.state.callCount === 2, "the message after the /stop");
      await until(() => where.deliveries.pending(JSON.stringify([GROUP, ALICE])).some((item) => item.text === "停止之后的回答"),
        "the reply committed before the new callback arrives");
      await opened.service.admit(ALICE, GROUP, "重启后的新消息", URL);
      await until(() => replies(out.sent).includes("重启后新消息的回答"), "the new reply");
      await Bun.sleep(100);
      expect(faux.state.callCount).toBe(3);
      // A callback can arrive after finalization but before the worker finishes. Either that worker or outbox
      // recovery sends the stored answer; both routes must send it exactly once before the new answer.
      expect(out.sent.filter((item) => item.kind !== "status").map((item) => item.text))
        .toEqual(["第一条回答", "停止之后的回答", "重启后新消息的回答"]);
      expect(where.deliveries.pending(JSON.stringify([GROUP, ALICE]))).toEqual([]);
      expect(seen.join("")).not.toContain("不该运行");
    } finally { await opened.service.close(); }
    const database = createSession(await openGroupStorage(groupDatabasePath(where.root, GROUP)));
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
    await opened.service.admit(ALICE, GROUP, "Alice 第一轮", URL);
    await until(() => replies(out.sent).length === 1, "Alice's first reply");
    await opened.service.admit(BOB, GROUP, "Bob 第一轮", URL);
    await until(() => replies(out.sent).length === 2, "Bob's first reply");
    await opened.service.close();
    // The stopped process's clock can be ahead of maintenance's clock: every existing input still precedes this clear.
    await inject(where, (inbox) => { inbox.items.push({ requestId: "msg:queued", content: "清空前排队", receivedAt: Date.now() + 60_000 }); });
    const path = groupDatabasePath(where.root, GROUP);
    expect(await queueGroupClear(path)).toEqual({ groupId: GROUP, queued: [ALICE, BOB], waiting: [] });
    // Run twice: no second /clear per member.
    expect(await queueGroupClear(path)).toEqual({ groupId: GROUP, queued: [], waiting: [ALICE, BOB] });
    expect(await queueGroupClear(join(where.root, "no-group", "durable.sqlite"))).toBeUndefined();
    const seen: Message[][] = [];
    faux.setResponses([1, 2].map(() => (transcript: { messages: unknown[] }) => {
      seen.push(transcript.messages as Message[]);
      return fauxAssistantMessage("新会话回答");
    }));
    opened = open(where, models, model, out.outbound);
    try {
      expect(await opened.service.start()).toEqual([GROUP]);
      await opened.service.admit(ALICE, GROUP, "Alice 清空之后", URL);
      await opened.service.admit(BOB, GROUP, "Bob 清空之后", URL);
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
    await mkdir(join(where.root, GROUP, "users", "Abc"), { recursive: true });
    const { service } = open(where, models, model, out.outbound);
    try {
      await expect(service.admit("abc", GROUP, "大小写别名", URL)).rejects.toThrow("标识大小写与已有目录 Abc 冲突");
      expect(await readdir(join(where.root, GROUP))).toEqual(["users"]);
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
  const originalAcquire = GroupHarnesses.prototype.acquire;
  const acquireSpy = spyOn(GroupHarnesses.prototype, "acquire").mockImplementation(async function (this: GroupHarnesses, groupId) {
    if (blockAcquire) { acquireEntered = true; await acquire.promise; }
    return originalAcquire.call(this, groupId);
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
    await service.admit(ALICE, GROUP, "held before dispatch", URL);
    await until(() => authEntered, "credential resolution");
    blockAcquire = true;
    command = service.control(ALICE, GROUP, "/stop", URL);
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
    await service.admit(ALICE, GROUP, "must be cancelled before it starts", URL);
    await entered.promise;
    command = service.control(ALICE, GROUP, "/clear", URL);
    await admitted.promise;
    // The mutation removing the wait synchronously calls harness.conversation before this continuation.
    expect(earlyLookup).toBe(false);
    block = false; release.resolve(); await command;
    expect(faux.state.callCount).toBe(0);
    await service.admit(ALICE, GROUP, "new question after clear", URL);
    await until(() => replies(out.sent).length === 1, "the new question's answer");
    expect(replies(out.sent)).toEqual(["after the control"]);
  } finally {
    block = false; release.resolve(); await command?.catch(() => {});
    await service.close(); conversationSpy.mockRestore(); admittedSpy.mockRestore(); snapshotSpy.mockRestore();
  }
});

test.skipIf(process.getuid?.() === 0)("a clear blocked by a real directory/file hold retries itself, preserves later messages and resets once", async () => {
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
  const { service, reports } = open(where, models, model, out.outbound);
  const temp = userTempDir(where.root, GROUP, ALICE), locked = join(resultsRoot(temp), "1-locked");
  let held: HeldDirectory | undefined, command: Promise<string> | undefined;
  try {
    await service.admit(ALICE, GROUP, "seed", URL);
    await until(() => replies(out.sent).length === 1, "seed reply");
    await mkdir(locked, { recursive: true }); await writeFile(join(locked, "index.txt"), "synthetic");
    if (process.platform === "win32") held = await holdDirectory(temp, ["codemode", "1-locked"]);
    else await chmod(locked, 0o555);
    command = service.control(ALICE, GROUP, "/clear", URL);
    if (process.platform === "linux") {
      expect(await command).toContain("开启新会话");
      await service.admit(ALICE, GROUP, "later question", URL);
      await until(() => replies(out.sent).length === 2, "new context proceeds with deferred physical reclamation");
      expect(replies(out.sent)).toEqual(["seed", "after the failed cleanup"]);
      expect(resets).toBe(1); expect(await readFile(join(locked, "index.txt"), "utf8")).toBe("synthetic");
      expect(await service.control(ALICE, GROUP, "/status", URL)).toContain("待物理回收");
      return;
    }
    await until(() => reports.length > 0, "actual filesystem cleanup failure");
    await service.admit(ALICE, GROUP, "later question", URL);
    expect(faux.state.callCount).toBe(1);
    expect(await service.control(ALICE, GROUP, "/status", URL)).toContain("自动重试");
    // Keep it locked through multiple real retries; no second reset is allowed.
    await until(() => reports.length >= 2, "second cleanup failure");
    expect(resets).toBe(1);
    if (held) { await held.release(); held = undefined; } else await chmod(locked, 0o755);
    expect(await command).toContain("开启新会话");
    await until(() => replies(out.sent).length === 2, "later message resumed automatically");
    expect(replies(out.sent)).toEqual(["seed", "after the failed cleanup"]);
    expect(resets).toBe(1); expect(await readdir(resultsRoot(temp))).toEqual([]);
  } finally {
    await held?.release(); await chmod(locked, 0o755).catch(() => {}); await command?.catch(() => {});
    await service.close(); spy.mockRestore();
  }
}, 20_000);

test("a callback arriving during finalization sends the recovered answer once across worker and outbox recovery", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  faux.setResponses([fauxAssistantMessage("recovered answer"), fauxAssistantMessage("next answer")]);
  const seeded = await openGroupHarness(groupDatabasePath(where.root, GROUP), models);
  try {
    const { conversation } = await memberConversation(seeded.harness, GROUP, ALICE, { model }, context);
    await seeded.harness.commit(async (tx) => {
      (await tx.doc(InboxDoc, conversation.id)).items.push({ requestId: "msg:recover-send", content: "recovered question", receivedAt: Date.now() });
    }, context);
  } finally { await seeded.close(); }
  const prototype = await harnessPrototype(models), original = prototype.snapshot;
  const release = Promise.withResolvers<void>();
  let atProjection = false, held = false;
  const spy = spyOn(prototype, "snapshot").mockImplementation(async function (this: Harness, ...args: unknown[]) {
    if (!held && args[0] === LegacyImportDoc && where.deliveries.pending(JSON.stringify([GROUP, ALICE])).some((item) => item.text === "recovered answer")) {
      held = true; atProjection = true;
      await release.promise;
    }
    return Reflect.apply(original, this, args);
  } as Harness["snapshot"]);
  const { service, reports } = open(where, models, model, out.outbound);
  try {
    await service.start();
    await until(() => atProjection, "the finalized answer before worker send");
    await service.admit(ALICE, GROUP, "next question", URL);
    await until(() => out.sent.some((item) => item.text === "recovered answer"), "outbox recovery send");
    release.resolve();
    await until(() => replies(out.sent).includes("next answer"), "next answer");
    await Bun.sleep(30);
    expect(out.sent.filter((item) => item.text === "recovered answer")).toHaveLength(1);
    expect(faux.state.callCount).toBe(2);
    expect(where.deliveries.pending(JSON.stringify([GROUP, ALICE]))).toEqual([]);
    expect(reports).toEqual([]);
  } finally { release.resolve(); await service.close(); spy.mockRestore(); }
});

test.each(["before", "after"] as const)("worker retries an outbox failure %s commit, without another message or duplicate provider/send", async (mode) => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
  class FailOnce extends DeliveryStore {
    failed = false;
    override finalize(...args: Parameters<DeliveryStore["finalize"]>): void {
      if (mode === "after") super.finalize(...args);
      if (!this.failed) { this.failed = true; throw new Error("transient outbox I/O failure"); }
      if (mode === "before") super.finalize(...args);
    }
  }
  const store = new FailOnce(where.stateDb), { service, reports } = open(where, models, model, out.outbound, { deliveries: store });
  // Seed both inputs offline: start() kicks this worker once, so no second admit/member.again can rescue a broken retry.
  const seeded = await openGroupHarness(groupDatabasePath(where.root, GROUP), models);
  try {
    const { conversation } = await memberConversation(seeded.harness, GROUP, ALICE, { model }, context);
    await seeded.harness.commit(async (tx) => {
      (await tx.doc(InboxDoc, conversation.id)).items.push(
        { requestId: "msg:first-retry", content: "first question", receivedAt: Date.now() },
        { requestId: "msg:second-retry", content: "second question", receivedAt: Date.now() + 1 });
    }, context);
  } finally { await seeded.close(); }
  try {
    await service.start(); await service.control(ALICE, GROUP, "/status", URL);
    // A failed mutant reports counts at an assertion, not as the test framework's timeout.
    await until(() => out.sent.filter((item) => ["first", "second"].includes(item.text)).length === 2,
      "automatic outbox retry and queued message", 1500).catch(() => {});
    expect(faux.state.callCount).toBe(2);
    expect(out.sent.filter((item) => ["first", "second"].includes(item.text)).map((item) => item.text)).toEqual(["first", "second"]);
    expect(reports.some((error) => String(error).includes("transient outbox"))).toBe(true);
    expect(store.pending(JSON.stringify([GROUP, ALICE]))).toEqual([]);
  } finally { await service.close(); }
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
    await service.admit(ALICE, GROUP, "first", URL); await until(() => held.state.started === 1, "provider");
    armed = true;
    await expect(service.admit(ALICE, GROUP, "second", URL)).rejects.toBeInstanceOf(DurableStorageFailure);
    expect(fatal).toHaveLength(1);
    await expect(service.admit(BOB, GROUP, "third", URL)).rejects.toBe(fatal[0]);
    expect(faux.state.callCount).toBe(1);
  } finally { spy.mockRestore(); held.open(); await service.close().catch(() => {}); }
});

test("a new clear cancels older persisted input even when its old-process timestamp is ahead of the current clock", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  const seeded = await openGroupHarness(groupDatabasePath(where.root, GROUP), models);
  try {
    const { conversation } = await memberConversation(seeded.harness, GROUP, ALICE, { model }, context);
    await seeded.harness.commit(async (tx) => {
      (await tx.doc(InboxDoc, conversation.id)).items.push({ requestId: "msg:old-clock", content: "old persisted input", receivedAt: Date.now() + 60_000 });
    }, context);
  } finally { await seeded.close(); }
  const seen: string[] = [];
  const step: FauxResponseFactory = (transcript) => {
    const input = transcript.messages.filter((message) => message.role === "user").at(-1)!;
    seen.push(JSON.stringify(input));
    return fauxAssistantMessage(JSON.stringify(input).includes("after clear") ? "new answer" : "old leaked");
  };
  faux.setResponses([step, step]);
  const { service } = open(where, models, model, out.outbound);
  try {
    await service.control(ALICE, GROUP, "/clear", URL);
    await service.admit(ALICE, GROUP, "after clear", URL);
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
  await service.admit(ALICE, GROUP, "seed", URL);
  await until(() => replies(out.sent).length === 1, "seed reply");
  expect(await service.control(ALICE, GROUP, "/status", URL)).toContain("状态：空闲");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = GroupHarnesses.prototype.acquire;
  let blocked = false;
  const spy = spyOn(GroupHarnesses.prototype, "acquire").mockImplementation(async function (this: GroupHarnesses, ...args) {
    if (!blocked) { blocked = true; entered.resolve(); await release.promise; }
    return original.call(this, ...args);
  });
  const admitting = service.admit(ALICE, GROUP, "old delayed admit", URL);
  try {
    await entered.promise;
    await service.control(ALICE, GROUP, "/clear", URL);
    release.resolve(); await admitting;
    await service.admit(ALICE, GROUP, "after clear", URL);
    await until(() => replies(out.sent).includes("new answer"), "the new input");
    expect(faux.state.callCount).toBe(2);
    expect(seen.join("")).not.toContain("old delayed admit");
  } finally { release.resolve(); await admitting.catch(() => {}); await service.close(); spy.mockRestore(); }
});

test("replaying an earlier-epoch stop preserves a later-epoch input after the clock moves backwards", async () => {
  const where = place(), { faux, models, model } = fauxModels(), out = recordingOutbound();
  const seeded = await openGroupHarness(groupDatabasePath(where.root, GROUP), models);
  try {
    const { conversation } = await memberConversation(seeded.harness, GROUP, ALICE, { model }, context);
    await seeded.harness.commit(async (tx) => {
      const controls = await tx.doc(ControlsDoc);
      controls.epoch = 2; controls.seq = 1;
      controls.pending.push({ phone: ALICE, requestId: "ctl:old-epoch", seq: 1, command: "/stop", receivedAt: 90_000, epoch: 1 });
      (await tx.doc(InboxDoc, conversation.id)).items.push(
        { requestId: "msg:older-epoch", content: "must never reach model", receivedAt: 100_000, epoch: 0 },
        { requestId: "msg:newer-epoch", content: "later epoch input", receivedAt: 10_000, epoch: 2 });
    }, context);
  } finally { await seeded.close(); }
  const seen: string[] = [];
  faux.setResponses([(transcript) => { seen.push(JSON.stringify(transcript.messages)); return fauxAssistantMessage("later epoch answer"); }]);
  const { service } = open(where, models, model, out.outbound);
  try {
    await service.start();
    await until(() => where.deliveries.pending(JSON.stringify([GROUP, ALICE])).some((item) => item.text === "later epoch answer"), "later-epoch recovery");
    expect(faux.state.callCount).toBe(1);
    expect(seen.join("")).toContain("later epoch input");
    expect(seen.join("")).not.toContain("must never reach model");
  } finally { await service.close(); }
});
