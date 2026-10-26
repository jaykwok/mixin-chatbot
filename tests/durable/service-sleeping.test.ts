// The message service on Durable 1.4.0's sleeping and parked tasks (src/durable/service.ts): a retry backoff or a
// deferred poll is no model idleness and survives a restart; /stop during a backoff sends nothing more; a crash loop
// parks the run, /status says so and /stop ends it; a failed run keeps the member's next message, which runs once.
// Each actual model call has exactly one start record. Faux models and a recording outbound; no network, no platform.
import { afterAll, describe, expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai";
import { createSession, type ConversationId, type HarnessSettings, type ModelRef } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { appLayout } from "../../src/core/layout.ts";
import { MemberDirectory } from "../../src/durable/identity.ts";
import type { ModelSelection } from "../../src/durable/models.ts";
import { DurableService, type DurableServiceOptions } from "../../src/durable/service.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { databaseOf, statsOf } from "../helpers/layout.ts";
import { recordingOutbound, replyTexts, type Sent } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-service-sleeping-");
afterAll(() => fixture.cleanup());
const GROUP = "100";
const ALICE = "13800000001";
let counter = 0;
const RETRYABLE = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" });

function selection(models: Models, ref: ModelRef, settings: HarnessSettings): ModelSelection {
  return {
    runtime: models as never, settings: undefined as never, model: models.getModel(ref.provider, ref.modelId)! as never, ref, thinkingLevel: "off",
    harnessSettings: { ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }), ...settings },
  };
}

/** A service whose model idle limit (300 ms) is far below its backoffs and polls; heartbeats every 100 ms. */
function open(root: string, models: Models, ref: ModelRef, settings: HarnessSettings, out: ReturnType<typeof recordingOutbound>,
  options: Partial<DurableServiceOptions> = {}) {
  const reports: string[] = [], logs: string[] = [];
  const service = new DurableService({
    layout: appLayout(root), selection: selection(models, ref, settings), modules: [], relay: null, materials: false,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 300, modelResponseMs: 60_000, tickMs: 20, heartbeatMs: 100 },
    outbound: out.outbound, onReport: (error) => reports.push(String(error)), onLog: (line) => logs.push(line), ...options,
  });
  return { service, reports, logs };
}

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

/** A response that answers only when the request is aborted (a close or /stop); `started` counts its requests. */
function hanging() {
  const state = { started: 0 };
  const step: FauxResponseFactory = (_transcript, options) => new Promise<AssistantMessage>((done) => {
    state.started++;
    if (options?.signal?.aborted) return done(fauxAssistantMessage("", { stopReason: "aborted" }));
    options?.signal?.addEventListener("abort", () => done(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
  });
  return { step, state };
}

const replies = (sent: Sent[]) => replyTexts(sent).filter((text) => !text.startsWith("⚠️"));
const failures = (sent: Sent[]) => replyTexts(sent).filter((text) => text.startsWith("⚠️"));

/** Alice's conversation in the closed group database: its live tasks. */
async function stored(root: string) {
  const session = createSession(await openGroupStorage(databaseOf(root, GROUP)));
  try {
    const conversationId = (await session.snapshot(MemberDirectory, ALICE, context))!.conversationId as ConversationId;
    const tasks = [];
    for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
      for (const task of (await session.commit((tx) => tx.scanTasks({ status, conversationId }, 100), context)).items) {
        tasks.push({ kind: task.kind, status: task.state.status, restarts: task.restarts });
      }
    }
    return { tasks };
  } finally { await session.close(context); }
}

/** The member's asks and which usage buckets got tokens; requests themselves are not counted (src/agent/stats-ledger.ts). */
function usage(root: string) {
  const ledger = openStatsLedger(statsOf(root));
  try {
    const rows = readLedger(ledger);
    return { asks: rows.asks.reduce((sum, row) => sum + row.asks, 0),
      buckets: [...new Set(rows.usage.filter(row => row.totalTokens > 0).map(row => row.bucket))] };
  } finally { ledger.close(); }
}

/** The committed state of the group database now, as a crash would leave it; `restore()` puts it in place after a close. */
function crashImage(root: string): { restore(): void } {
  const path = databaseOf(root, GROUP), image = `${path}.crash-${++counter}`;
  const db = new Database(path, { readonly: true });
  try { db.query("VACUUM INTO ?").run(image); } finally { db.close(); }
  return { restore: () => renameSync(image, path) };
}

describe("durable service: sleeping tasks", () => {
  test("a retry backoff is no model idleness, survives a close uncounted, and its next attempt runs once after the restart", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    const { faux, models, model } = fauxModels();
    const settings: HarnessSettings = { retry: { maxRetries: 2, baseDelayMs: 1500, maxAgentDelayMs: 1500 } };
    const out = recordingOutbound();
    faux.setResponses([RETRYABLE()]);
    let opened = open(root, models, model, settings, out);
    await opened.service.admit(out.message(GROUP, ALICE, "问题"));
    await until(() => opened.logs.some((line) => line.startsWith("任务仍在运行") && line.endsWith("阶段: 等待重试")), "a heartbeat in the backoff");
    // Well past the model idle limit inside the backoff: nothing is aborted.
    await Bun.sleep(700);
    expect(opened.logs.filter((line) => line.includes("取消原因"))).toEqual([]);
    expect(failures(out.sent)).toEqual([]);
    await opened.service.close();
    expect(faux.state.callCount).toBe(1);
    expect(opened.reports).toEqual([]);
    const asleep = await stored(root);
    expect(asleep.tasks).toEqual([{ kind: expect.any(String), status: "sleeping", restarts: undefined }]);

    faux.setResponses([fauxAssistantMessage("重启后的回答")]);
    opened = open(root, models, model, settings, out);
    try {
      await opened.service.start();
      await until(() => replies(out.sent).length === 1, "the answer");
      expect(replies(out.sent)).toEqual(["重启后的回答"]);
      expect(faux.state.callCount).toBe(2);
      expect(opened.reports).toEqual([]);
    } finally { await opened.service.close(); }
    expect((await stored(root)).tasks).toEqual([]);
    // One ask; the answer's usage is counted, the failed request had none.
    expect(usage(root)).toEqual({ asks: 1, buckets: ["models"] });
  });

  test("/stop during a retry backoff ends the run: no further request, a receipt, and the next message runs once", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    const { faux, models, model } = fauxModels();
    const out = recordingOutbound();
    faux.setResponses([RETRYABLE(), fauxAssistantMessage("新的回答")]);
    const { service, logs, reports } = open(root, models, model, { retry: { maxRetries: 2, baseDelayMs: 1000, maxAgentDelayMs: 1000 } }, out);
    try {
      await service.admit(out.message(GROUP, ALICE, "会失败的问题"));
      await until(() => logs.some((line) => line.endsWith("阶段: 等待重试")), "the backoff");
      expect(await service.control(out.message(GROUP, ALICE, "/stop"))).toContain("⏹ 已停止你在本群的当前任务");
      // Past the backoff: the stopped run sends nothing more.
      await Bun.sleep(1300);
      expect(faux.state.callCount).toBe(1);
      await service.admit(out.message(GROUP, ALICE, "停止之后"));
      await until(() => replies(out.sent).length === 1, "the next answer");
      expect(replies(out.sent)).toEqual(["新的回答"]);
      expect(faux.state.callCount).toBe(2);
      expect(failures(out.sent)).toEqual([]);
      expect(reports).toEqual([]);
    } finally { await service.close(); }
    expect((await stored(root)).tasks).toEqual([]);
    // Both messages are asks; the /stop is a command and is not.
    expect(usage(root)).toEqual({ asks: 2, buckets: ["models"] });
  });

  test("a deferred response's polls are no model idleness: one request, one start, polled until ready", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    // The production policy offers no deferred mode (durable.stream accepts no `deferred`); this pins the watchdog's rule.
    const faux = fauxProvider({ tokenSize: { min: 50, max: 50 }, deferred: { pendingFetches: 3, pollAfterMs: 250 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
    const out = recordingOutbound();
    faux.setResponses([fauxAssistantMessage("轮询后的回答")]);
    const { service, logs, reports } = open(root, models, model, { stream: { deferred: true } }, out);
    try {
      await service.admit(out.message(GROUP, ALICE, "问题"));
      await until(() => replies(out.sent).length === 1, "the answer");
      expect(replies(out.sent)).toEqual(["轮询后的回答"]);
      expect({ calls: faux.state.callCount, fetches: faux.state.deferredFetchCount }).toEqual({ calls: 1, fetches: 4 });
      expect(logs.filter((line) => line.includes("取消原因"))).toEqual([]);
      expect(reports).toEqual([]);
    } finally { await service.close(); }
    expect((await stored(root)).tasks).toEqual([]);
    expect(usage(root)).toEqual({ asks: 1, buckets: ["models"] });
  });
});

describe("durable service: failed runs and parked tasks", () => {
  test("a failed run is answered with its failure and keeps the queued message, which runs once", async () => {
    const root = join(fixture.root, `root-${++counter}`);
    const { faux, models, model } = fauxModels();
    const out = recordingOutbound();
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid request" }), fauxAssistantMessage("第二条的回答")]);
    const { service, reports } = open(root, models, model, { retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } }, out);
    try {
      await service.admit(out.message(GROUP, ALICE, "第一条"));
      await service.admit(out.message(GROUP, ALICE, "第二条"));
      await until(() => replyTexts(out.sent).length === 2, "both outcomes");
      expect(failures(out.sent)).toHaveLength(1);
      expect(replies(out.sent)).toEqual(["第二条的回答"]);
      await Bun.sleep(100);
      expect(faux.state.callCount).toBe(2);
      expect(reports).toEqual([]);
    } finally { await service.close(); }
    expect((await stored(root)).tasks).toEqual([]);
    expect(usage(root)).toEqual({ asks: 2, buckets: ["models"] });
  });

  for (const [command, receipt] of [["/stop", "⏹ 已停止你在本群的当前任务"], ["/clear", "🧹 已为你在本群开启新会话"]] as const)
  test(`a run cut off by crashes restartLimit times is parked: reported, explained by /status, no request, and ${command} ends it`, async () => {
    const root = join(fixture.root, `root-${++counter}`);
    const { faux, models, model } = fauxModels();
    const settings: HarnessSettings = { restartLimit: 2 };
    const out = recordingOutbound();
    let first = hanging();
    faux.setResponses([first.step]);
    let opened = open(root, models, model, settings, out);
    await opened.service.admit(out.message(GROUP, ALICE, "会崩溃的问题"));
    await until(() => first.state.started === 1, "the request");
    // A close is no crash: the run goes back to pending, uncounted, and runs again.
    await opened.service.close();
    expect((await stored(root)).tasks).toEqual([{ kind: expect.any(String), status: "pending", restarts: undefined }]);
    for (let crash = 1; crash <= 2; crash++) {
      const round = hanging();
      faux.setResponses([round.step]);
      opened = open(root, models, model, settings, out);
      await opened.service.start();
      await until(() => round.state.started === 1, `the request after restart ${crash}`);
      const image = crashImage(root);
      await opened.service.close();
      image.restore();
      expect((await stored(root)).tasks).toEqual([{ kind: expect.any(String), status: "running", restarts: crash === 1 ? undefined : 1 }]);
      first = round;
    }
    expect(faux.state.callCount).toBe(3);

    faux.setResponses([fauxAssistantMessage("停止之后的回答")]);
    opened = open(root, models, model, settings, out);
    try {
      await opened.service.start();
      await until(() => opened.reports.some((line) => line.includes("task_parked")), "the parked report");
      expect(opened.reports.filter((line) => line.includes("task_parked"))).toHaveLength(1);
      expect(opened.reports[0]).toContain("/stop 或 /clear");
      expect(opened.service.attention().parked).toEqual({ count: 1, lastAt: expect.any(Number), space: `群 ${GROUP}` });
      const status = await opened.service.control(out.message(GROUP, ALICE, "/status"));
      expect(status).toContain("状态：已停放");
      expect(status).toMatch(/停放的任务：.+运行中连续 2 次被异常中断且没有进展，已停止自动重跑；发送 \/stop/);
      await Bun.sleep(200);
      expect(faux.state.callCount).toBe(3);
      expect(await opened.service.control(out.message(GROUP, ALICE, command))).toContain(receipt);
      await opened.service.admit(out.message(GROUP, ALICE, "停止之后"));
      await until(() => replies(out.sent).length === 1, "the next answer");
      expect(replies(out.sent)).toEqual(["停止之后的回答"]);
      expect(faux.state.callCount).toBe(4);
      expect(await opened.service.control(out.message(GROUP, ALICE, "/status"))).not.toContain("停放");
    } finally { await opened.service.close(); }
    expect((await stored(root)).tasks).toEqual([]);
    // The crashed message counts once however often it ran; the cut-off requests returned no usage.
    expect(usage(root)).toEqual({ asks: 2, buckets: ["models"] });
  });
});
