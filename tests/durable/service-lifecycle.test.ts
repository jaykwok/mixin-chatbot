import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession, defineExtension } from "@earendil-works/pi-durable";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { AttemptsDoc } from "../../src/durable/attempts.ts";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { MemberDirectory } from "../../src/durable/identity.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { DurableService, type DurableServiceOptions, memberKey } from "../../src/durable/service.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, gatedResponse } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("service-lifecycle-");
afterAll(() => fixture.cleanup());
const URL = "https://example.invalid/synthetic-callback", GROUP = "a", PHONE = "1001", KEY = memberKey(GROUP, PHONE);
let sequence = 0;
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out: " + label); await Bun.sleep(20); }
}
function setup() {
  const stateDb = new Database(":memory:"), deliveries = new DeliveryStore(stateDb), { faux, models, model } = fauxModels();
  const texts: string[] = [];
  const common = {
    root: join(fixture.root, String(++sequence)), stateDb, deliveries, modules: [], relay: null, materials: false,
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)!,
      ref: model, thinkingLevel: "off" as const, harnessSettings: {}, notices: [] },
    limits: { runTimeoutMs: 30000, modelIdleMs: 120000, modelResponseMs: 120000, tickMs: 1000, activeRequests: 1 },
    outbound: { sendText: async (text: string) => { texts.push(text); return true; }, sendReply: async (text: string) => { texts.push(text); return true; },
      rate: () => ({ used: 0, limit: 20 }), refresh: async (item: { text: string }) => item.text },
  } satisfies DurableServiceOptions;
  return { common, faux, models, stateDb, deliveries, texts };
}
async function stored<T>(root: string, work: (session: ReturnType<typeof createSession>, id: ConversationId,
  storage: Awaited<ReturnType<typeof openGroupStorage>>) => Promise<T>): Promise<T> {
  const storage = await openGroupStorage(groupDatabasePath(root, GROUP)), session = createSession(storage);
  try {
    const member = await session.snapshot(MemberDirectory, PHONE, context);
    return await work(session, member!.conversationId as ConversationId, storage);
  } finally { await session.close(context); }
}

for (const succeeds of [true, false]) test(`manual delivery waits for automatic send/ack; automatic success=${succeeds}`, async () => {
  const f = setup(), answer = "one answer"; f.faux.setResponses([fauxAssistantMessage(answer)]);
  const sending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const bodies: string[] = [];
  const service = new DurableService({ ...f.common, outbound: { ...f.common.outbound,
    sendText: async text => { if (text === answer) bodies.push("manual"); return true; },
    sendReply: async () => { bodies.push("automatic"); sending.resolve(); await release.promise; return succeeds; },
  } });
  try {
    await service.admit(PHONE, GROUP, "question", URL); await sending.promise;
    expect(f.deliveries.pending(KEY)).toHaveLength(1);
    const manual = service.control(PHONE, GROUP, "/deliver", URL);
    await Bun.sleep(50); expect(bodies).toEqual(["automatic"]);
    release.resolve(); await manual;
    await until(() => service.hasUserRequestCapacity() && f.deliveries.pending(KEY).length === 0, "send/ack completion");
    expect(bodies).toEqual(succeeds ? ["automatic"] : ["automatic", "manual"]);
  } finally { release.resolve(); await service.close(); f.stateDb.close(); }
}, 30000);

test("two manual deliveries read the ledger after the preceding acknowledgement", async () => {
  const f = setup(), sending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.deliveries.put(KEY, "reply:synthetic", "saved answer");
  let sends = 0;
  const service = new DurableService({ ...f.common, outbound: { ...f.common.outbound, sendText: async text => {
    if (text === "saved answer") { sends++; sending.resolve(); await release.promise; } return true;
  } } });
  try {
    const first = service.control(PHONE, GROUP, "/deliver", URL); await sending.promise;
    const second = service.control(PHONE, GROUP, "/deliver", URL);
    await Bun.sleep(50); expect(sends).toBe(1); release.resolve(); await Promise.all([first, second]);
    expect(sends).toBe(1); expect(f.deliveries.pending(KEY)).toEqual([]);
  } finally { release.resolve(); await service.close(); f.stateDb.close(); }
}, 30000);

test("recovery and manual delivery share the same lock while a fresh request runs", async () => {
  const f = setup(), sending = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), next = gatedResponse("fresh answer");
  f.faux.setResponses([next.step]); f.deliveries.put(KEY, "reply:recovered", "saved answer");
  let sends = 0;
  const service = new DurableService({ ...f.common, outbound: { ...f.common.outbound, sendText: async text => {
    if (text === "saved answer") { sends++; sending.resolve(); await release.promise; } return true;
  } } });
  try {
    await service.admit(PHONE, GROUP, "fresh question", URL); await sending.promise;
    const manual = service.control(PHONE, GROUP, "/deliver", URL); await Bun.sleep(50);
    expect(sends).toBe(1); release.resolve(); await manual;
    expect(sends).toBe(1); expect(f.deliveries.find(KEY, "reply:recovered")).toBeUndefined();
  } finally { release.resolve(); next.open(); await service.close(); f.stateDb.close(); }
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
      return { content: [] };
    },
  }] })] : undefined;
  f.faux.setResponses([phase === "model" ? first.step : fauxAssistantMessage([fauxToolCall("safe_wait", {}, { id: "read" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("new answer")]);
  const original = new DurableService({ ...f.common, extensions }); let resumed: DurableService | undefined;
  try {
    await original.admit(PHONE, GROUP, "old question", URL); await (phase === "model" ? first.started : toolStarted.promise); await original.close();
    // Simulate offline time in the persisted timestamp, using a plain Session so no task is resumed by the fixture.
    await stored(f.common.root, (session, id) => session.commit(async tx => {
      (await tx.doc(InboxDoc, id)).items[0]!.startedAt = Date.now() - 31000;
    }, context));
    resumed = new DurableService({ ...f.common, extensions }); await resumed.start();
    await until(() => resumed!.hasUserRequestCapacity(), "expired run removed");
    expect(f.faux.state.callCount).toBe(1); expect(toolCalls).toBe(phase === "safe-tool" ? 1 : 0);
    expect(f.deliveries.pending(KEY)).toEqual([]);
    await resumed.admit(PHONE, GROUP, "new question", URL);
    await until(() => resumed!.hasUserRequestCapacity(), "new request completed");
    expect(f.faux.state.callCount).toBe(2); expect(f.texts).toContain("new answer");
    await resumed.close();
    const starts = await stored(f.common.root, async (session, id) => Object.values((await session.snapshot(AttemptsDoc, id, context))?.starts ?? {}));
    expect(starts.filter(start => !start.withdrawn)).toHaveLength(2);
  } finally { first.open(); await resumed?.close(); await original.close(); f.stateDb.close(); }
}, 30000);

for (const submitted of [false, true]) test(`offline expiry preserves an already settled answer but never submits an expired unstarted item; submitted=${submitted}`, async () => {
  const f = setup(); f.faux.setResponses([fauxAssistantMessage("completed answer")]);
  const original = new DurableService(f.common); let resumed: DurableService | undefined;
  try {
    await original.admit(PHONE, GROUP, "old question", URL); await until(() => original.hasUserRequestCapacity(), "original completed"); await original.close();
    await stored(f.common.root, async (session, id, storage) => {
      const previous = (await storage.scanSubmissions({ conversationId: id }, 10, undefined, context)).items.find(item => item.type === "input")!;
      expect(previous.status).toBe("done");
      await session.commit(async tx => {
        (await tx.doc(InboxDoc, id)).items.push({ requestId: submitted ? previous.requestId! : "msg:never-submitted", content: "old question",
          receivedAt: Date.now() - 32000, startedAt: Date.now() - 31000 });
      }, context);
    });
    resumed = new DurableService(f.common); await resumed.start(); await until(() => resumed!.hasUserRequestCapacity(), "recovery complete");
    expect(f.faux.state.callCount).toBe(1);
    expect(f.deliveries.pending(KEY).map(item => item.text)).toEqual(submitted ? ["completed answer"] : []);
  } finally { await resumed?.close(); await original.close(); f.stateDb.close(); }
}, 30000);

test("a deadline crossed during auth is checked at final dispatch and the unsent start is withdrawn", async () => {
  const f = setup(), authenticating = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.models.setProvider({ ...f.faux.provider, auth: { apiKey: { name: "Synthetic auth", resolve: async () => {
    authenticating.resolve(); await release.promise; return { auth: { apiKey: "synthetic" } };
  } } } });
  const service = new DurableService({ ...f.common, limits: { ...f.common.limits, runTimeoutMs: 500, tickMs: 5000 } });
  try {
    await service.admit(PHONE, GROUP, "question", URL); await authenticating.promise;
    await Bun.sleep(600); release.resolve();
    await until(() => service.hasUserRequestCapacity(), "deadline refused before next tick");
    expect(f.faux.state.callCount).toBe(0); expect(f.texts.some(text => text.includes("任务总时限 0.5 秒已到"))).toBe(true);
    await service.close();
    const starts = await stored(f.common.root, async (session, id) => Object.values((await session.snapshot(AttemptsDoc, id, context))?.starts ?? {}));
    expect(starts).toHaveLength(1); expect(starts[0]!.withdrawn).toBe(true);
  } finally { release.resolve(); await service.close(); f.stateDb.close(); }
}, 30000);
