// Real force-kill at persisted boundaries. Faux model, synthetic group databases, no network or platform.
import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession, LiveDoc } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { MemberDirectory } from "../../src/durable/identity.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { memberRecords, pendingDeliveries } from "../../src/durable/records.ts";
import { DurableService } from "../../src/durable/service.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { appLayout } from "../../src/core/layout.ts";
import { recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { databaseOf, scopeOf, statsOf } from "../helpers/layout.ts";

const fixture = await tempFixture("durable-recovery-windows-");
afterAll(() => fixture.cleanup());
const spec = (path: string) => JSON.stringify(import.meta.resolve(path));
const group = "100", phone = "13800000001";
const limits = { runTimeoutMs: 600_000, modelIdleMs: 600_000, modelResponseMs: 600_000, tickMs: 20 };

/**
 * Kill points: before-partial (the model call is open), retry (a retry is scheduled), usage (the bill is recorded, the
 * answer not yet settled), close (inside the commit that closes the record with its delivery plan), dispatch (inside the
 * commit that marks the reply `sending`), send (the platform call is open).
 */
const MODES = ["before-partial", "retry", "usage", "close", "dispatch", "send"] as const;
type Mode = typeof MODES[number];
const COMPLETED = new Set<Mode>(["close", "dispatch", "send"]);

const child = `
import { createModels, createAssistantMessageEventStream } from ${spec("@earendil-works/pi-ai")};
import { fauxAssistantMessage, fauxProvider } from ${spec("@earendil-works/pi-ai/providers/faux")};
import { defineExtension, GenerationTask, Harness, hook, LiveDoc } from ${spec("@earendil-works/pi-durable")};
import { BACKGROUND_CONTEXT as context } from ${spec("@earendil-works/chord/context")};
import { DurableService } from ${spec("../../src/durable/service.ts")};
import { appLayout } from ${spec("../../src/core/layout.ts")};
import { MemberDirectory } from ${spec("../../src/durable/identity.ts")};
import { recordsOf } from ${spec("../../src/durable/records.ts")};
import { TEST_PROGRESS } from ${spec("../helpers/durable.ts")};
import { recordingOutbound } from ${spec("../helpers/recording-outbound.ts")};
const [root, mode] = process.argv.slice(2);
const phone = ${JSON.stringify(phone)};
const ready = () => console.log('READY ' + mode);
const hang = () => new Promise(() => {});
let observedHarness, answered = false;
const originalOpen = Harness.open.bind(Harness);
Harness.open = async (...args) => {
  const opened = await originalOpen(...args);
  observedHarness = opened;
  if (mode === 'close' || mode === 'dispatch') {
    // Hold the commit open once its writes are made: the kill lands before it is durable.
    const commit = opened.commit.bind(opened);
    opened.commit = (fn, ctx) => commit(async (tx) => {
      const result = await fn(tx);
      if (answered) {
        const record = Object.values((await recordsOf(tx, phone)).requests)[0];
        const hit = mode === 'close' ? record?.closedAt !== undefined : record?.delivery?.parts.some(part => part.state === 'sending');
        if (hit) { ready(); await hang(); }
      }
      return result;
    }, ctx);
  }
  return opened;
};
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
if (mode === 'before-partial') faux.setResponses([async () => { ready(); return await hang(); }]);
else if (mode === 'retry') faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 service unavailable' })]);
else faux.setResponses([complete]);
const out = recordingOutbound();
const send = out.outbound.send;
out.outbound.send = async (target, message, options) => {
  // The lead reply segment mentions the member; the group's status notice does not.
  if (mode === 'send' && message.msgType === 'markdown' && message.content.a?.length) { ready(); return await hang(); }
  const outcome = await send(target, message, options);
  if (out.sent.at(-1)?.kind === 'reply') console.log('UNEXPECTED_REPLY');
  return outcome;
};
const service = new DurableService({ layout: appLayout(root), modules: [], relay: null, materials: false, outbound: out.outbound,
  limits: ${JSON.stringify(limits)},
  selection: { runtime: models, model: models.getModel(ref.provider, ref.modelId), ref, thinkingLevel: 'off',
    harnessSettings: { retry: { maxRetries: 2, baseDelayMs: 1500, maxAgentDelayMs: 1500 },
      ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } },
  extensions: () => [defineExtension({ name: 'kill-boundary', hooks: [hook(GenerationTask, {
    async afterResponse() { answered = true; if (mode === 'usage') { ready(); await hang(); } }
  })] })],
});
await service.admit(out.message(${JSON.stringify(group)}, phone, 'synthetic question'));
if (mode === 'retry') {
  // A second Session does not follow another Session's commits; read through the actual running Harness.
  const read = observedHarness;
  const id = (await read.snapshot(MemberDirectory, phone, context)).conversationId;
  for (;;) {
    const live = await read.snapshot(LiveDoc, id, context);
    if (live?.generation?.retry) { ready(); break; }
    await Bun.sleep(10);
  }
}
await hang();
`;

async function until(probe: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (!await probe()) { if (Date.now() > deadline) throw new Error(`timed out: ${label}`); await Bun.sleep(10); }
}

test.each(MODES)("force-kill in %s preserves the request facts and resumes without a duplicate model call or reply", async (mode) => {
  const root = join(fixture.root, mode), script = join(fixture.root, `child-${mode}.ts`);
  await mkdir(root);
  await writeFile(script, child);
  const processChild = Bun.spawn([process.execPath, script, root, mode], { stdout: "pipe", stderr: "pipe", windowsHide: true });
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

  const completed = COMPLETED.has(mode);
  const session = createSession(await openGroupStorage(databaseOf(root, group)));
  try {
    const conversationId = (await session.snapshot(MemberDirectory, phone, context))!.conversationId as ConversationId;
    const closed = mode === "dispatch" || mode === "send";
    if (mode === "retry") expect((await session.snapshot(LiveDoc, conversationId, context))!.generation!.retry).toBeDefined();
    // Until the close commit, the request is still queued; from then on its record holds the delivery plan.
    expect((await session.snapshot(InboxDoc, conversationId, context))!.items).toHaveLength(closed ? 0 : 1);
    const record = Object.values((await memberRecords(session, phone, context)).requests)[0]!;
    expect(record.delivery?.parts[0]?.state).toBe(mode === "send" ? "sending" : mode === "dispatch" ? "pending" : undefined);
  } finally { await session.close(context); }

  const { faux, models, model } = fauxModels(), out = recordingOutbound();
  faux.setResponses([fauxAssistantMessage("recovered answer")]);
  const service = new DurableService({ layout: appLayout(root), modules: [], relay: null, materials: false, limits, outbound: out.outbound,
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)! as never,
      ref: model, thinkingLevel: "off", harnessSettings: { retry: { maxRetries: 2, baseDelayMs: 5, maxAgentDelayMs: 20 },
        ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } } });
  try {
    expect(await service.start()).toEqual([scopeOf(group)]);
    const answer = completed ? "completed before kill".repeat(20) : "recovered answer";
    if (mode === "send") {
      // The reply may have reached the platform (it does not deduplicate): it counts as sent and is never sent again.
      await until(async () => pendingDeliveries(await service.records(scopeOf(group), phone)).length === 0, "the delivery settled");
      await Bun.sleep(200);
      const records = await service.records(scopeOf(group), phone);
      expect(Object.values(records.requests)[0]!.delivery!.parts[0]!.state).toBe("uncertain");
    } else await until(() => replyTexts(out.sent).includes(answer), "the recovered reply");
    await until(async () => pendingDeliveries(await service.records(scopeOf(group), phone)).length === 0, "the delivery settled");
    expect(replyTexts(out.sent).filter((text) => text === answer)).toHaveLength(mode === "send" ? 0 : 1);
    expect(faux.state.callCount).toBe(completed ? 0 : 1);
    const ledger = openStatsLedger(statsOf(root));
    try {
      const rows = readLedger(ledger);
      expect(rows.asks.reduce((n, row) => n + row.asks, 0)).toBe(1);
      // Only committed responses are in pi.usage: a response cut off before its commit is not counted.
      expect(rows.usage.map((row) => row.bucket)).toEqual(["models"]);
      expect(rows.usage[0]!.totalTokens).toBeGreaterThan(0);
    } finally { ledger.close(); }
  } finally { await service.close(); }
}, 45_000);
