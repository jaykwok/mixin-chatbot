// Real force-kill at persisted boundaries. Faux model, synthetic group/state databases, no network or IM.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession, LiveDoc } from "@earendil-works/pi-durable";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { AttemptsDoc } from "../../src/durable/attempts.ts";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { MemberDirectory } from "../../src/durable/identity.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { DurableService, type Outbound } from "../../src/durable/service.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-recovery-windows-");
afterAll(() => fixture.cleanup());
const spec = (path: string) => JSON.stringify(import.meta.resolve(path));
const group = "synthetic", phone = "13800000001", url = "https://example.invalid/callback";
const limits = { runTimeoutMs: 600_000, modelIdleMs: 600_000, modelResponseMs: 600_000, tickMs: 20 };
const child = `
import { Database } from "bun:sqlite";
import { createModels, createAssistantMessageEventStream } from ${spec("@earendil-works/pi-ai")};
import { fauxAssistantMessage, fauxProvider } from ${spec("@earendil-works/pi-ai/providers/faux")};
import { defineExtension, GenerationTask, Harness, hook, LiveDoc } from ${spec("@earendil-works/pi-durable")};
import { BACKGROUND_CONTEXT as context } from ${spec("@earendil-works/chord/context")};
import { DeliveryStore } from ${spec("../../src/agent/delivery-store.ts")};
import { DurableService } from ${spec("../../src/durable/service.ts")};
import { groupDatabasePath } from ${spec("../../src/durable/groups.ts")};
import { MemberDirectory } from ${spec("../../src/durable/identity.ts")};
import { openGroupStorage } from ${spec("../../src/durable/sqlite.ts")};
import { TEST_PROGRESS } from ${spec("../helpers/durable.ts")};
const [root, statePath, mode] = process.argv.slice(2);
let observedHarness;
const originalOpen = Harness.open.bind(Harness);
Harness.open = async (...args) => { const opened = await originalOpen(...args); observedHarness = opened; return opened; };
const models = createModels(), faux = fauxProvider({ tokenSize: { min: 1, max: 1 }, tokensPerSecond: 1000 });
const ref = { provider: faux.getModel().provider, modelId: faux.getModel().id };
const complete = { ...fauxAssistantMessage('completed before kill'.repeat(20)), usage: {
  input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 }
} };
// Faux recomputes usage. Supply a terminal bill at the provider boundary, while partial estimates stay unconfirmed.
const stream = faux.provider.streamSimple.bind(faux.provider);
faux.provider.streamSimple = (...args) => {
  const inner = stream(...args), outer = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      if (event.type === 'done') event.message.usage = complete.usage;
      outer.push(event);
    }
    outer.end(await inner.result());
  })();
  return outer;
};
models.setProvider(faux.provider);
const ready = () => console.log('READY ' + mode);
if (mode === 'before-partial') faux.setResponses([async () => { ready(); return await new Promise(() => {}); }]);
else if (mode === 'retry') faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 service unavailable' })]);
else faux.setResponses([complete]);
const stateDb = new Database(statePath);
class BlockingOutbox extends DeliveryStore {
  announced = false;
  finalize(...args) {
    if (mode === 'publication') super.finalize(...args);
    if (mode !== 'outbox' && mode !== 'publication') return super.finalize(...args);
    if (!this.announced) { this.announced = true; ready(); }
    throw new Error('held before durable outbox commit');
  }
}
const service = new DurableService({ root, stateDb, deliveries: new BlockingOutbox(stateDb), modules: [], relay: null, materials: false,
  limits: ${JSON.stringify(limits)},
  outbound: { sendText: async () => true, sendReply: async () => { console.log('UNEXPECTED_REPLY'); return true; },
    rate: () => ({ used: 0, limit: 20 }), refresh: async (item) => item.text },
  selection: { runtime: models, model: models.getModel(ref.provider, ref.modelId), ref, thinkingLevel: 'off', notices: [],
    harnessSettings: { retry: { maxRetries: 2, baseDelayMs: 1500, maxAgentDelayMs: 1500 },
      ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } },
  extensions: () => [defineExtension({ name: 'kill-boundary', hooks: [hook(GenerationTask, {
    async afterResponse() { if (mode === 'usage') { ready(); await new Promise(() => {}); } }
  })] })],
});
await service.admit(${JSON.stringify(phone)}, ${JSON.stringify(group)}, 'synthetic question', ${JSON.stringify(url)});
if (mode === 'retry') {
  // A second Session does not follow another Session's commits; read through the actual running Harness.
  const read = observedHarness;
  const id = (await read.snapshot(MemberDirectory, ${JSON.stringify(phone)}, context)).conversationId;
  for (;;) {
    const live = await read.snapshot(LiveDoc, id, context);
    if (live?.generation?.retry) { ready(); break; }
    await Bun.sleep(10);
  }
}
await new Promise(() => {});
`;

async function until(probe: () => boolean, label: string) {
  const deadline = Date.now() + 20_000;
  while (!probe()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await Bun.sleep(10); }
}

test.each(["before-partial", "retry", "usage", "outbox", "publication"] as const)("force-kill in %s preserves the request facts and resumes without duplicate model/reply", async (mode) => {
  const root = join(fixture.root, mode), statePath = join(root, "state.sqlite"), script = join(fixture.root, `child-${mode}.ts`);
  // State Database needs an existing parent, made by the isolated fixture.
  const { mkdir } = await import("node:fs/promises"); await mkdir(root);
  await writeFile(script, child);
  const processChild = Bun.spawn([process.execPath, script, root, statePath, mode], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const stderr = new Response(processChild.stderr).text();
  let output = "";
  const watchdog = setTimeout(() => processChild.kill("SIGKILL"), 25_000);
  try {
    for await (const bytes of processChild.stdout) {
      output += Buffer.from(bytes).toString();
      if (output.includes(`READY ${mode}\n`)) break;
    }
  } finally { clearTimeout(watchdog); processChild.kill("SIGKILL"); await processChild.exited; }
  const errors = await stderr;
  expect(output, errors).toContain(`READY ${mode}\n`); expect(output).not.toContain("UNEXPECTED_REPLY");
  expect(errors).toBe("");

  const session = createSession(await openGroupStorage(groupDatabasePath(root, group)));
  let conversationId: ConversationId;
  try {
    conversationId = (await session.snapshot(MemberDirectory, phone, context))!.conversationId as ConversationId;
    const starts = Object.values((await session.snapshot(AttemptsDoc, conversationId, context))!.starts);
    expect(starts).toHaveLength(1);
    expect(starts[0]!.usage === undefined).toBe(mode === "retry" || mode === "before-partial");
    if (mode === "usage" || mode === "outbox" || mode === "publication") expect(starts[0]!.usage!.cost.total).toBe(0.03);
    if (mode === "retry") expect((await session.snapshot(LiveDoc, conversationId, context))!.generation!.retry).toBeDefined();
    expect((await session.snapshot(InboxDoc, conversationId, context))!.items).toHaveLength(1);
  } finally { await session.close(context); }

  const { faux, models, model } = fauxModels(), sent: string[] = [], stateDb = new Database(statePath), deliveries = new DeliveryStore(stateDb);
  expect(deliveries.pending(JSON.stringify([group, phone]))).toHaveLength(mode === "publication" ? 1 : 0);
  faux.setResponses([fauxAssistantMessage("recovered answer")]);
  const outbound: Outbound = { sendText: async (text) => { sent.push(text); return true; }, sendReply: async (text) => { sent.push(text); return true; },
    rate: () => ({ used: 0, limit: 20 }), refresh: async (item) => item.text };
  const service = new DurableService({ root, stateDb, deliveries, modules: [], relay: null, materials: false, limits, outbound,
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)! as never,
      ref: model, thinkingLevel: "off", notices: [], harnessSettings: { retry: { maxRetries: 2, baseDelayMs: 5, maxAgentDelayMs: 20 },
        ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } } });
  try {
    expect(await service.start()).toEqual([group]); await service.control(phone, group, "/status", url);
    const completed = mode === "outbox" || mode === "publication";
    const answer = completed ? "completed before kill".repeat(20) : "recovered answer";
    await until(() => sent.includes(answer), "the recovered reply");
    expect(sent.filter((text) => text === answer)).toHaveLength(1);
    expect(faux.state.callCount).toBe(completed ? 0 : 1);
    const ledger = openStatsLedger(root);
    try {
      const rows = readLedger(ledger);
      expect(rows.activity.reduce((n, row) => n + row.asks, 0)).toBe(1);
      expect(rows.usage.reduce((n, row) => n + row.requests, 0)).toBe(completed ? 1 : 2);
      if (mode === "before-partial") expect(rows.usage.find((row) => row.kind === "generation_unconfirmed")!.unknownCost).toBe(1);
      if (mode === "usage") {
        const interrupted = rows.usage.filter((row) => row.kind !== "assistant");
        expect(interrupted.reduce((n, row) => n + row.cost, 0)).toBe(0.03);
        expect(interrupted.reduce((n, row) => n + row.missingUsage, 0)).toBe(0);
      }
    } finally { ledger.close(); }
  } finally { await service.close(); stateDb.close(); }
}, 45_000);
