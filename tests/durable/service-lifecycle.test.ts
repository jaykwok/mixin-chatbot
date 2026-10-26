import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession, defineExtension, type Tx } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { memberConversation, MemberDirectory } from "../../src/durable/identity.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { pendingDeliveries, recordsOf, type RequestRecord } from "../../src/durable/records.ts";
import { DurableService, type DurableServiceOptions } from "../../src/durable/service.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, gatedResponse, openGroupHarness } from "../helpers/durable.ts";
import { recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { databaseOf, scopeOf, statsOf } from "../helpers/layout.ts";
import { appLayout } from "../../src/core/layout.ts";

const fixture = await tempFixture("service-lifecycle-");
afterAll(() => fixture.cleanup());
const GROUP = "100", PHONE = "13800000001";
let sequence = 0;
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await Bun.sleep(20); }
}
function setup() {
  const { faux, models, model } = fauxModels(), out = recordingOutbound();
  const common = {
    layout: appLayout(join(fixture.root, String(++sequence))), modules: [], relay: null, materials: false,
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)!,
      ref: model, thinkingLevel: "off" as const, harnessSettings: {} },
    limits: { runTimeoutMs: 30000, modelIdleMs: 120000, modelResponseMs: 120000, tickMs: 1000, activeRequests: 1 },
    outbound: out.outbound,
  } satisfies DurableServiceOptions;
  return { common, faux, models, model, out };
}
async function stored<T>(root: string, work: (session: ReturnType<typeof createSession>, id: ConversationId,
  storage: Awaited<ReturnType<typeof openGroupStorage>>) => Promise<T>): Promise<T> {
  const storage = await openGroupStorage(databaseOf(root, GROUP)), session = createSession(storage);
  try {
    const member = await session.snapshot(MemberDirectory, PHONE, context);
    return await work(session, member!.conversationId as ConversationId, storage);
  } finally { await session.close(context); }
}
/** A closed run whose reply was never sent (a crash after its closing commit). */
async function savedReply(f: ReturnType<typeof setup>, requestId: string, body: string, now = Date.now()): Promise<RequestRecord> {
  const { reply } = f.out.message(GROUP, PHONE, "earlier question");
  const record: RequestRecord = { requestId, reply, createdAt: now, closedAt: now, notes: [], deliverables: [], files: [], events: {},
    delivery: { kind: "reply", createdAt: now, parts: [{ id: "m0", kind: "markdown", body, lead: true, state: "pending", attempts: 0 }] } };
  const opened = await openGroupHarness(databaseOf(f.common.layout.data, GROUP), f.models, { group: GROUP });
  try {
    await memberConversation(opened.harness, scopeOf(GROUP), PHONE, { model: f.model }, context);
    await opened.harness.commit(async (tx: Tx) => { (await recordsOf(tx, PHONE)).requests[requestId] = record; }, context);
  } finally { await opened.close(); }
  return record;
}
const pendingOf = async (service: DurableService) => pendingDeliveries(await service.records(scopeOf(GROUP), PHONE)).map(record => record.requestId);

for (const outcome of ["failed", "uncertain"] as const) test(`automatic delivery: a ${outcome} reply is ${outcome === "failed" ? "sent again after its wait" : "counted as sent, never resent"}`, async () => {
  const f = setup(), answer = "one answer"; f.faux.setResponses([fauxAssistantMessage(answer)]);
  let attempts = 0;
  const send = f.out.outbound.send;
  const service = new DurableService({ ...f.common, limits: { ...f.common.limits, deliveryRetryMs: [50] },
    outbound: { ...f.out.outbound, send: async (target, message, options) => {
      if (message.msgType === "markdown" && message.content.content.endsWith(answer) && ++attempts === 1) return { status: outcome, reason: "synthetic" };
      return send(target, message, options);
    } } });
  try {
    await service.admit(f.out.message(GROUP, PHONE, "question"));
    await until(async () => service.hasUserRequestCapacity() && attempts > 0 && (await pendingOf(service)).length === 0, "delivery settled");
    await Bun.sleep(200);
    expect(attempts).toBe(outcome === "failed" ? 2 : 1);
    expect(replyTexts(f.out.sent)).toEqual(outcome === "failed" ? [answer] : []);
    const part = Object.values((await service.records(scopeOf(GROUP), PHONE)).requests)[0]!.delivery!.parts[0]!;
    expect([part.state, part.attempts, part.retryAt]).toEqual(outcome === "failed" ? ["sent", 2, undefined] : ["uncertain", 1, undefined]);
  } finally { await service.close(); }
}, 30000);

test("startup sends a saved reply once while a fresh request runs", async () => {
  const f = setup(), sending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), next = gatedResponse("fresh answer");
  f.faux.setResponses([next.step]); await savedReply(f, "msg:recovered", "saved answer");
  let sends = 0;
  const send = f.out.outbound.send;
  const service = new DurableService({ ...f.common, outbound: { ...f.out.outbound, send: async (target, message, options) => {
    if (message.msgType === "markdown" && message.content.content.endsWith("saved answer")) { sends++; sending.resolve(); await release.promise; }
    return send(target, message, options);
  } } });
  try {
    expect(await service.start()).toEqual([scopeOf(GROUP)]);
    await service.admit(f.out.message(GROUP, PHONE, "fresh question")); await sending.promise;
    release.resolve();
    await until(async () => (await pendingOf(service)).length === 0, "the saved reply");
    expect(sends).toBe(1); expect(replyTexts(f.out.sent)).toEqual(["saved answer"]);
  } finally { release.resolve(); next.open(); await service.close(); }
}, 30000);

test("a failed part due later is sent at startup when its retry comes; a delivery past its window is given up unsent", async () => {
  const f = setup(), now = Date.now();
  const due = await savedReply(f, "msg:due", "due answer");
  const expired = await savedReply(f, "msg:expired", "expired answer", now - 10_000);
  const opened = await openGroupHarness(databaseOf(f.common.layout.data, GROUP), f.models, { group: GROUP });
  try {
    await opened.harness.commit(async (tx: Tx) => {
      const records = await recordsOf(tx, PHONE);
      Object.assign(records.requests[due.requestId]!.delivery!.parts[0]!, { state: "failed", attempts: 1, retryAt: now + 300, error: "synthetic" });
    }, context);
  } finally { await opened.close(); }
  const reports: unknown[] = [];
  const service = new DurableService({ ...f.common, limits: { ...f.common.limits, deliveryWindowMs: 5_000 }, onReport: error => reports.push(error) });
  try {
    await service.start();
    await until(async () => (await pendingOf(service)).length === 0, "both deliveries settled");
    expect(Date.now()).toBeGreaterThanOrEqual(now + 300);
    expect(replyTexts(f.out.sent)).toEqual(["due answer"]);
    const records = await service.records(scopeOf(GROUP), PHONE);
    expect(records.requests[expired.requestId]!.delivery!.abandoned).toEqual({ at: expect.any(Number), reason: "expired" });
    expect(records.requests[expired.requestId]!.delivery!.parts[0]!.attempts).toBe(0);
    expect(reports.map(String)).toContainEqual(expect.stringContaining("交付超时放弃"));
    // /health carries the count for the doctor and the TUI overview: the space label only.
    expect(service.attention()).toEqual({ deliveryAbandoned: { count: 1, lastAt: expect.any(Number), space: `群 ${GROUP}` } });
  } finally { await service.close(); }
}, 30000);

test("/stop ends the retries of an earlier failing reply", async () => {
  const f = setup(), answer = "failing answer"; f.faux.setResponses([fauxAssistantMessage(answer)]);
  let attempts = 0;
  const send = f.out.outbound.send;
  const service = new DurableService({ ...f.common, limits: { ...f.common.limits, deliveryRetryMs: [300] },
    outbound: { ...f.out.outbound, send: async (target, message, options) => {
      if (message.msgType === "markdown" && message.content.content.endsWith(answer)) { attempts++; return { status: "failed", reason: "synthetic" }; }
      return send(target, message, options);
    } } });
  try {
    await service.admit(f.out.message(GROUP, PHONE, "question"));
    await until(() => attempts === 1, "the first attempt");
    expect(await service.control(f.out.message(GROUP, PHONE, "/stop"))).toContain("已停止");
    await Bun.sleep(600);
    expect(attempts).toBe(1);
    expect(await pendingOf(service)).toEqual([]);
    const delivery = Object.values((await service.records(scopeOf(GROUP), PHONE)).requests)[0]!.delivery!;
    expect(delivery.abandoned?.reason).toBe("withdrawn");
  } finally { await service.close(); }
}, 30000);

for (const phase of ["model", "safe-tool"] as const) test(`offline expiry cancels a recovered ${phase} without redispatch; the next request still works`, async () => {
  const f = setup(), first = gatedResponse("interrupted answer"), toolStarted = Promise.withResolvers<void>();
  let toolCalls = 0;
  const extensions = phase === "safe-tool" ? () => [defineExtension({ name: "deadline-fixture", tools: [{
    name: "safe_wait", description: "Synthetic cancellable read", parameters: Type.Object({}), replay: "safe",
    async execute(_args, _api, context) {
      toolCalls++; toolStarted.resolve();
      await new Promise<void>((_resolve, reject) => {
        const signal = context.abortSignal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { output: [] };
    },
  }] })] : undefined;
  f.faux.setResponses([phase === "model" ? first.step : fauxAssistantMessage([fauxToolCall("safe_wait", {}, { id: "read" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("new answer")]);
  const original = new DurableService({ ...f.common, extensions }); let resumed: DurableService | undefined;
  try {
    await original.admit(f.out.message(GROUP, PHONE, "old question")); await (phase === "model" ? first.started : toolStarted.promise); await original.close();
    // Simulate offline time in the persisted timestamp, using a plain Session so no task is resumed by the fixture.
    await stored(f.common.layout.data, (session, id) => session.commit(async tx => {
      (await tx.doc(InboxDoc, id)).items[0]!.startedAt = Date.now() - 31000;
    }, context));
    resumed = new DurableService({ ...f.common, extensions }); await resumed.start();
    await until(() => resumed!.hasUserRequestCapacity(), "expired run removed");
    expect(f.faux.state.callCount).toBe(1); expect(toolCalls).toBe(phase === "safe-tool" ? 1 : 0);
    // The expired run is answered with the timeout, at its own message.
    await until(() => replyTexts(f.out.sent).some(text => text.includes("任务总时限 30 秒已到")), "the timeout reply");
    await resumed.admit(f.out.message(GROUP, PHONE, "new question"));
    await until(() => resumed!.hasUserRequestCapacity() && replyTexts(f.out.sent).includes("new answer"), "new request completed");
    expect(f.faux.state.callCount).toBe(2);
    await resumed.close();
    const ledger = openStatsLedger(statsOf(f.common.layout.data));
    try {
      const rows = readLedger(ledger);
      expect(rows.asks.reduce((sum, row) => sum + row.asks, 0)).toBe(2);
      expect(rows.usage.reduce((sum, row) => sum + row.totalTokens, 0)).toBeGreaterThan(0);
    }
    finally { ledger.close(); }
  } finally { first.open(); await resumed?.close(); await original.close(); }
}, 30000);

for (const submitted of [false, true]) test(`offline expiry preserves an already settled answer but never submits an expired unstarted item; submitted=${submitted}`, async () => {
  const f = setup(); f.faux.setResponses([fauxAssistantMessage("completed answer")]);
  const original = new DurableService(f.common); let resumed: DurableService | undefined;
  try {
    await original.admit(f.out.message(GROUP, PHONE, "old question"));
    await until(() => original.hasUserRequestCapacity() && replyTexts(f.out.sent).length === 1, "original completed"); await original.close();
    await stored(f.common.layout.data, async (session, id, storage) => {
      const previous = (await storage.scanSubmissions({ conversationId: id }, 10, undefined, context)).items.find(item => item.type === "input")!;
      expect(previous.status).toBe("done");
      await session.commit(async tx => {
        const requestId = submitted ? previous.requestId! : "msg:never-submitted";
        (await tx.doc(InboxDoc, id)).items.push({ requestId, content: "old question", receivedAt: Date.now() - 32000, startedAt: Date.now() - 31000 });
        if (!submitted) {
          const { reply } = f.out.message(GROUP, PHONE, "old question");
          (await recordsOf(tx, PHONE)).requests[requestId] = { requestId, reply, createdAt: Date.now() - 32000, notes: [], deliverables: [], files: [], events: {} };
        }
      }, context);
    });
    resumed = new DurableService(f.common); await resumed.start(); await until(() => resumed!.hasUserRequestCapacity(), "recovery complete");
    expect(f.faux.state.callCount).toBe(1);
    // A settled answer keeps its single delivery; an expired unstarted item gets the timeout instead of a model call.
    await until(async () => (await pendingOf(resumed!)).length === 0 && replyTexts(f.out.sent).length === (submitted ? 1 : 2), "deliveries settled");
    expect(replyTexts(f.out.sent).filter(text => text === "completed answer")).toHaveLength(1);
    if (!submitted) expect(replyTexts(f.out.sent)[1]).toContain("任务总时限 30 秒已到");
  } finally { await resumed?.close(); await original.close(); }
}, 30000);

test("a deadline crossed during auth is checked at final dispatch and the unsent start is withdrawn", async () => {
  const f = setup(), authenticating = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { name: "Synthetic auth", resolve: async () => {
    authenticating.resolve(); await release.promise; return { auth: { apiKey: "synthetic" } };
  } } } });
  const service = new DurableService({ ...f.common, limits: { ...f.common.limits, runTimeoutMs: 500, tickMs: 5000 } });
  try {
    await service.admit(f.out.message(GROUP, PHONE, "question")); await authenticating.promise;
    await Bun.sleep(600); release.resolve();
    await until(() => service.hasUserRequestCapacity(), "deadline refused before next tick");
    expect(f.faux.state.callCount).toBe(0);
    await until(() => replyTexts(f.out.sent).some(text => text.includes("任务总时限 0.5 秒已到")), "the timeout reply");
    await service.close();
    const ledger = openStatsLedger(statsOf(f.common.layout.data));
    try { expect(readLedger(ledger).usage).toEqual([]); } finally { ledger.close(); }
  } finally { release.resolve(); await service.close(); }
}, 30000);
