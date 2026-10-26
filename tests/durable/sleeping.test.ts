// Durable 1.4.0 `sleeping` tasks (a retry backoff, a deferred poll) are unfinished work that holds no invocation. A
// space whose only live work is such a task must be found at startup, must not be closed as idle before it is due, and
// stays protected from reclamation; at its time it runs once. Faux models, no network.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type HarnessSettings, type TaskId } from "@earendil-works/pi-durable";
import { appLayout, groupScope as g, scopeKey, spaceDatabase } from "../../src/core/layout.ts";
import { idleSpaceReferences } from "../../src/durable/conversations.ts";
import { withSpaceSnapshot } from "../../src/durable/diagnostics.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { SpaceHarnesses } from "../../src/durable/spaces.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { LIVE_TASK_STATES } from "../../src/durable/task-states.ts";
import { fauxModels } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-sleeping-");
afterAll(() => fixture.cleanup());

// Manual compaction ignores `enabled`; keep-recent 1 leaves the earlier turns to summarise. The backoff is long enough
// to close, reopen and check before it is due.
const settings = (delayMs: number): HarnessSettings => ({ retry: { maxRetries: 2, baseDelayMs: delayMs, maxAgentDelayMs: delayMs }, compaction: { enabled: false, keepRecentTokens: 1 } });
const spaces = (root: string, models: Models, options: { maxIdle?: number; delayMs?: number } = {}) => new SpaceHarnesses({
  layout: appLayout(root), harnessOptions: () => ({ models, registry: createRegistry(), settings: settings(options.delayMs ?? 1500) }),
  ...(options.maxIdle === undefined ? {} : { maxIdle: options.maxIdle }),
});

/** A group whose only live work is a manual compaction asleep in its retry backoff; its task ID. */
async function sleepingCompaction(root: string, delayMs?: number): Promise<TaskId> {
  const { faux, models, model } = fauxModels();
  const groups = spaces(root, models, { delayMs });
  try {
    const handle = await groups.acquire(g("sleepy"));
    const { conversation } = await memberConversation(handle.harness, g("sleepy"), "m1", { model }, context);
    faux.setResponses([fauxAssistantMessage("第一轮回答"), fauxAssistantMessage("第二轮回答"),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" })]);
    for (const content of ["第一轮", "第二轮"]) expect((await (await conversation.submit({ type: "input", content }, context)).wait(context)).status).toBe("done");
    const taskId = await conversation.compact(undefined, context);
    for (let deadline = Date.now() + 5000; (await handle.harness.getTask(taskId, context))?.state.status !== "sleeping";) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the backoff");
      await Bun.sleep(5);
    }
    handle.release();
    return taskId;
  } finally { await groups.closeAll(); }
}

async function liveStates(path: string): Promise<string[]> {
  const storage = await openGroupStorage(path);
  try {
    const states: string[] = [];
    for (const status of LIVE_TASK_STATES) for (const task of (await storage.scanTasks({ status }, 100, undefined, context)).items) states.push(task.state.status);
    for (const status of ["queued", "placed"] as const) if ((await storage.scanSubmissions({ status }, 1, undefined, context)).items.length) states.push(`submission ${status}`);
    return states;
  } finally { await storage.close(context); }
}

test("the live task states include sleeping", () => {
  expect(LIVE_TASK_STATES).toContain("sleeping");
});

test("a space whose only work sleeps is discovered, kept open while idle, and its task runs once when due", async () => {
  const root = join(fixture.root, "discovery");
  mkdirSync(root, { recursive: true });
  const taskId = await sleepingCompaction(root);
  const path = spaceDatabase(appLayout(root), g("sleepy"));
  expect(await liveStates(path)).toEqual(["sleeping"]);

  const { faux, models } = fauxModels();
  faux.setResponses([fauxAssistantMessage("恢复后的摘要")]);
  // No idle space may stay open: only work keeps one.
  const groups = spaces(root, models, { maxIdle: 0 });
  try {
    expect((await groups.discover()).map(scopeKey)).toEqual(["group:sleepy"]);
    const handle = await groups.acquire(g("sleepy"));
    handle.harness.resume();
    handle.release();
    // Another space comes and goes: the sweep closes it, not the sleeping one.
    (await groups.acquire(g("other"))).release();
    for (let deadline = Date.now() + 2000; groups.openSpaces.includes("group:other");) {
      if (Date.now() > deadline) throw new Error("the idle space stayed open");
      await Bun.sleep(5);
    }
    expect(groups.openSpaces).toEqual(["group:sleepy"]);
    const again = await groups.acquire(g("sleepy"));
    try {
      expect((await again.harness.waitForTask(taskId, context)).state.outcome.status).toBe("completed");
      expect(faux.state.callCount).toBe(1);
    } finally { again.release(); }
  } finally { await groups.closeAll(); }
  expect(await liveStates(path)).toEqual([]);
});

test("reclamation and maintenance views treat a sleeping task as live work", async () => {
  const root = join(fixture.root, "maintenance");
  mkdirSync(root, { recursive: true });
  // A minute: certainly still asleep at every check below.
  await sleepingCompaction(root, 60_000);
  const path = spaceDatabase(appLayout(root), g("sleepy"));
  expect(await withSpaceSnapshot(path, async (_harness, _storage, liveWork) => liveWork)).toBe(true);
  const { models } = fauxModels();
  const groups = spaces(root, models, { delayMs: 60_000 });
  try {
    const handle = await groups.acquire(g("sleepy"));
    try { expect(await idleSpaceReferences(handle.harness, context)).toBeUndefined(); }
    finally { handle.release(); }
  } finally { await groups.closeAll(); }
  expect(await liveStates(path)).toEqual(["sleeping"]);
});
