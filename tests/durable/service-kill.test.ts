// D5 recovery: the message service's process is force-killed while a model response streams. A child process runs the
// real DurableService (faux model streaming slowly, synthetic data, no network) and is killed after partial output was
// committed; this process then starts a new service on the same group database.
import { afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { MemberDirectory } from "../../src/durable/identity.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { pendingDeliveries } from "../../src/durable/records.ts";
import { DurableService } from "../../src/durable/service.ts";
import { openGroupDatabase, openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";
import { databaseOf, scopeOf, statsOf } from "../helpers/layout.ts";
import { appLayout } from "../../src/core/layout.ts";

const fixture = await tempFixture("durable-service-kill-");
afterAll(() => fixture.cleanup());
const resolve = (specifier: string) => JSON.stringify(import.meta.resolve(specifier));
const GROUP = "100";
const ALICE = "13800000001";
const LIMITS = { runTimeoutMs: 600_000, modelIdleMs: 600_000, modelResponseMs: 600_000, tickMs: 20 };

// The child admits one message; its answer streams at 20 one-character tokens a second, so it never finishes. Once the
// request has streamed for a while it prints READY with the time and waits to be killed.
const child = `
import { createModels } from ${resolve("@earendil-works/pi-ai")};
import { fauxAssistantMessage, fauxProvider } from ${resolve("@earendil-works/pi-ai/providers/faux")};
import { DurableService } from ${resolve("../../src/durable/service.ts")};
import { appLayout } from ${resolve("../../src/core/layout.ts")};
import { TEST_PROGRESS } from ${resolve("../helpers/durable.ts")};
import { recordingOutbound } from ${resolve("../helpers/recording-outbound.ts")};
const [root] = process.argv.slice(2);
const faux = fauxProvider({ tokenSize: { min: 1, max: 1 }, tokensPerSecond: 20 });
const models = createModels();
models.setProvider(faux.provider);
const ref = { provider: faux.getModel().provider, modelId: faux.getModel().id };
faux.setResponses([fauxAssistantMessage("部分输出".repeat(10000))]);
const out = recordingOutbound();
const send = out.outbound.send;
out.outbound.send = async (target, message, options) => {
  const outcome = await send(target, message, options);
  const item = out.sent.at(-1);
  console.log(item.kind.toUpperCase() + " " + JSON.stringify(item.text));
  return outcome;
};
const service = new DurableService({
  layout: appLayout(root), modules: [], relay: null, materials: false, outbound: out.outbound,
  selection: { runtime: models, settings: undefined, model: models.getModel(ref.provider, ref.modelId), ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } },
  limits: ${JSON.stringify(LIMITS)},
});
await service.admit(out.message(${JSON.stringify(GROUP)}, ${JSON.stringify(ALICE)}, "问题"));
while (faux.state.callCount < 1) await Bun.sleep(10);
await Bun.sleep(1500);
console.log("READY " + Date.now());
await new Promise(() => {});
`;

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

test("a service killed while the answer streams: after restart the run resumes with its start time and its own start record, the partial answer is kept as aborted and not resent", async () => {
  const script = join(fixture.root, "service-child.ts");
  await writeFile(script, child);
  const root = join(fixture.root, "groups");
  const killed = Bun.spawn([process.execPath, script, root], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  let output = "";
  const decoder = new TextDecoder();
  const reader = killed.stdout.getReader();
  while (!/^READY \d+$/m.test(output)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("service child exited early:\n" + output + await new Response(killed.stderr).text());
    output += decoder.decode(value, { stream: true });
  }
  killed.kill("SIGKILL");
  await killed.exited;
  reader.releaseLock();
  expect(killed.signalCode ?? killed.exitCode).not.toBe(0);
  // Only the status notice went out before the kill.
  expect(output.split("\n").filter((line) => line.startsWith("REPLY "))).toEqual([]);

  const db = await openGroupDatabase(databaseOf(root, GROUP));
  try { expect(await db.get("PRAGMA integrity_check")).toEqual({ integrity_check: "ok" }); }
  finally { await db.close(); }

  const { faux, models, model } = fauxModels();
  const { promise: answer, resolve: release } = Promise.withResolvers<void>();
  const transcripts: Message[][] = [];
  const resumed: FauxResponseFactory = async (transcript) => {
    transcripts.push(transcript.messages as Message[]);
    await answer;
    return fauxAssistantMessage("恢复后的回答") as AssistantMessage;
  };
  faux.setResponses([resumed]);
  const out = recordingOutbound();
  const service = new DurableService({
    layout: appLayout(root), modules: [], relay: null, materials: false, outbound: out.outbound, limits: LIMITS,
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)! as never, ref: model,
      thinkingLevel: "off",
      harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } },
  });
  try {
    expect(await service.start()).toEqual([scopeOf(GROUP)]);
    await until(() => transcripts.length === 1, "the resumed request");
    // The task keeps its first start: the elapsed time counts the killed process's part.
    const status = await service.control(out.message(GROUP, ALICE, "/status"));
    expect(status).toContain("状态：执行中");
    expect(Number(/已用时间：(\d+) 秒/.exec(status)![1])).toBeGreaterThanOrEqual(1);
    // The request asks again from the member's question; the interrupted partial answer is not sent back.
    const resent = transcripts[0]!;
    expect(resent.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("问题"))).toHaveLength(1);
    expect(resent.filter((message) => message.role === "assistant")).toEqual([]);
    release();
    // The reply goes to the message it answers: its reply context was stored at admission.
    await until(() => replyTexts(out.sent).includes("恢复后的回答"), "the reply");
    await until(async () => pendingDeliveries(await service.records(scopeOf(GROUP), ALICE)).length === 0, "the delivery settled");
    // A message that had started before the kill gets its answer and nothing else (besides the /status receipt above).
    expect(out.sent.filter((item) => item.kind === "notice" && !item.text.startsWith("状态："))).toEqual([]);
    const ledger = openStatsLedger(statsOf(root));
    try {
      const rows = readLedger(ledger);
      expect(rows.asks.map(({ asks }) => asks)).toEqual([1]);
      // The killed request committed nothing; the recovered answer is the conversation's only usage.
      expect(rows.usage.map(({ bucket }) => bucket)).toEqual(["models"]);
    } finally { ledger.close(); }
  } finally {
    await service.close();
  }
  const storage = await openGroupStorage(databaseOf(root, GROUP));
  const session = createSession(storage);
  try {
    const conversationId = (await session.snapshot(MemberDirectory, ALICE, context))!.conversationId as ConversationId;
    expect((await session.snapshot(InboxDoc, conversationId, context))?.items).toEqual([]);
    // The partial answer stays in the conversation, marked aborted, before the recovered answer.
    const entries = (await storage.scanEntries({ conversationId }, 100, undefined, context)).items
      .filter((entry) => (entry as unknown as { kind: string }).kind === "pi.assistant")
      .map((entry) => (entry as unknown as { model: AssistantMessage[] }).model[0]!)
      .reverse();
    expect(entries.map((message) => message.stopReason)).toEqual(["aborted", "stop"]);
    const partial = (entries[0]!.content[0] as { text: string }).text;
    expect(partial.length).toBeGreaterThan(0);
    expect("部分输出".repeat(10000).startsWith(partial)).toBe(true);
  } finally { await session.close(context); }
}, 90_000);
