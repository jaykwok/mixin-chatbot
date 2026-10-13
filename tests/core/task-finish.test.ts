import { expect, test } from "bun:test";
import type { IsolatedTask, RootlessTasks } from "../../src/core/rootless-tasks.ts";
import { finishTask } from "../../src/core/task-backend.ts";
import { expectAsync } from "../helpers/async-expect.ts";

function fixture(sealError?: Error) {
  const calls: string[] = [];
  const task = { id: "task-1", async seal(options?: { discardScratch: boolean }) {
    calls.push("seal:" + (options?.discardScratch ? "discard-scratch" : "keep-scratch"));
    if (sealError) throw sealError;
  } } as unknown as IsolatedTask;
  const backend = { async reclaim(id: string) { calls.push("reclaim:" + id); } } as unknown as RootlessTasks;
  return { task, backend, calls };
}

test("finishTask seals every task and reclaims only what delivers nothing", async () => {
  for (const [outcome, expected] of [
    ["keep", ["seal:keep-scratch"]],
    ["keep-outputs", ["seal:discard-scratch"]],
    ["discard", ["seal:keep-scratch", "reclaim:task-1"]],
  ] as const) {
    const { task, backend, calls } = fixture();
    await finishTask(backend, task, outcome);
    expect(calls).toEqual([...expected]);
  }
});

test("a task that cannot be sealed is never reclaimed", async () => {
  const { task, backend, calls } = fixture(new Error("writers still running"));
  await expectAsync(finishTask(backend, task, "discard")).rejects.toThrow("writers still running");
  expect(calls).toEqual(["seal:keep-scratch"]);
});
