// D5 recovery: the message service's process is force-killed while a model response streams. A child process runs the
// real DurableService (faux model streaming slowly, synthetic data, no network) and is killed after partial output was
// committed; this process then starts a new service on the same group database and state database.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, createSession } from "@earendil-works/pi-durable";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { AttemptsDoc } from "../../src/durable/attempts.ts";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { MemberDirectory } from "../../src/durable/identity.ts";
import { InboxDoc } from "../../src/durable/inbox.ts";
import { DurableService, type Outbound } from "../../src/durable/service.ts";
import { openGroupDatabase, openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-service-kill-");
afterAll(() => fixture.cleanup());
const resolve = (specifier: string) => JSON.stringify(import.meta.resolve(specifier));
const GROUP = "group-a";
const ALICE = "13800000001";
const URL = "https://example.invalid/callback?key=synthetic";
const LIMITS = { runTimeoutMs: 600_000, modelIdleMs: 600_000, modelResponseMs: 600_000, tickMs: 20 };

// The child admits one message; its answer streams at 20 one-character tokens a second, so it never finishes. Once the
// request has streamed for a while it prints READY with the time and waits to be killed.
const child = `
import { Database } from "bun:sqlite";
import { createModels } from ${resolve("@earendil-works/pi-ai")};
import { fauxAssistantMessage, fauxProvider } from ${resolve("@earendil-works/pi-ai/providers/faux")};
import { DeliveryStore } from ${resolve("../../src/agent/delivery-store.ts")};
import { DurableService } from ${resolve("../../src/durable/service.ts")};
import { TEST_PROGRESS } from ${resolve("../helpers/durable.ts")};
const [root, statePath] = process.argv.slice(2);
const faux = fauxProvider({ tokenSize: { min: 1, max: 1 }, tokensPerSecond: 20 });
const models = createModels();
models.setProvider(faux.provider);
const ref = { provider: faux.getModel().provider, modelId: faux.getModel().id };
faux.setResponses([fauxAssistantMessage("部分输出".repeat(10000))]);
const stateDb = new Database(statePath);
const outbound = {
  sendText: async (text) => { console.log("SENT " + JSON.stringify(text)); return true; },
  sendReply: async (text) => { console.log("REPLY " + JSON.stringify(text)); return true; },
  rate: () => ({ used: 0, limit: 20 }),
  refresh: async (item) => item.text,
};
const service = new DurableService({
  root, modules: [], relay: null, materials: false, outbound, stateDb, deliveries: new DeliveryStore(stateDb),
  selection: { runtime: models, settings: undefined, model: models.getModel(ref.provider, ref.modelId), ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
    notices: [] },
  limits: ${JSON.stringify(LIMITS)},
});
await service.admit(${JSON.stringify(ALICE)}, ${JSON.stringify(GROUP)}, "问题", ${JSON.stringify(URL)});
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
  const statePath = join(fixture.root, "state.sqlite");
  const killed = Bun.spawn([process.execPath, script, root, statePath], { stdout: "pipe", stderr: "pipe", windowsHide: true });
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

  const db = await openGroupDatabase(groupDatabasePath(root, GROUP));
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
  const stateDb = new Database(statePath);
  const deliveries = new DeliveryStore(stateDb);
  const sent: string[] = [];
  const outbound: Outbound = {
    sendText: async (text) => { sent.push(text); return true; },
    sendReply: async (text) => { sent.push(text); return true; },
    rate: () => ({ used: 0, limit: 20 }),
    refresh: async (item) => item.text,
  };
  const service = new DurableService({
    root, modules: [], relay: null, materials: false, outbound, stateDb, deliveries, limits: LIMITS,
    selection: { runtime: models as never, settings: undefined as never, model: models.getModel(model.provider, model.modelId)! as never, ref: model,
      thinkingLevel: "off", notices: [],
      harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } },
  });
  try {
    expect(await service.start()).toEqual([GROUP]);
    await until(() => transcripts.length === 1, "the resumed request");
    // The task keeps its first start: the elapsed time counts the killed process's part.
    const status = await service.control(ALICE, GROUP, "/status", URL);
    expect(status).toContain("状态：执行中");
    expect(Number(/已用时间：(\d+) 秒/.exec(status)![1])).toBeGreaterThanOrEqual(1);
    // The request asks again from the member's question; the interrupted partial answer is not sent back.
    const resent = transcripts[0]!;
    expect(resent.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("问题"))).toHaveLength(1);
    expect(resent.filter((message) => message.role === "assistant")).toEqual([]);
    release();
    // The /status above gave this process the member's callback URL, so the reply goes out (without it, it would wait
    // in the outbox: the restart test in service.test.ts).
    await until(() => sent.includes("恢复后的回答"), "the reply");
    expect(deliveries.pending(JSON.stringify([GROUP, ALICE]))).toEqual([]);
    const ledger = openStatsLedger(root);
    try {
      const rows = readLedger(ledger);
      expect(rows.activity.map(({ asks, replies }) => ({ asks, replies }))).toEqual([{ asks: 1, replies: 1 }]);
      expect(rows.usage.map(({ kind, requests, missingUsage, unknownCost }) => ({ kind, requests, missingUsage, unknownCost })))
        .toEqual([{ kind: "assistant", requests: 1, missingUsage: 0, unknownCost: 0 },
          { kind: "interrupted", requests: 1, missingUsage: 1, unknownCost: 1 }]);
    } finally { ledger.close(); }
  } finally {
    await service.close();
    stateDb.close();
  }
  const storage = await openGroupStorage(groupDatabasePath(root, GROUP));
  const session = createSession(storage);
  try {
    const conversationId = (await session.snapshot(MemberDirectory, ALICE, context))!.conversationId as ConversationId;
    // Both processes committed a start before their request: the killed one's is on record.
    const starts = Object.values((await session.snapshot(AttemptsDoc, conversationId, context))?.starts ?? {});
    expect(starts.map(({ attempt, k, kind, withdrawn }) => ({ attempt, k, kind, withdrawn }))
      .sort((a, b) => a.k - b.k)).toEqual([{ attempt: 1, k: 1, kind: undefined, withdrawn: undefined }, { attempt: 1, k: 2, kind: undefined, withdrawn: undefined }]);
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
