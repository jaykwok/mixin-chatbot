import { expect, test } from "bun:test";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { CodemodeWorkers } from "../../src/durable/codemode/workers.ts";

test("synchronous shared reservations survive cancellation until exit; release is idempotent; shutdown fences admission", async () => {
  const workers = new CodemodeWorkers(2);
  const first = workers.acquireWorker(), second = workers.acquireWorker();
  const exit = Promise.withResolvers<void>(); workers.onWorkerStarted(exit.promise);
  expect(workers.reserved).toBe(2); expect(workers.alive).toBe(1);
  expect(() => workers.acquireWorker()).toThrow("容量已满");
  second(); second(); expect(workers.reserved).toBe(1);
  workers.stop(); expect(() => workers.acquireWorker()).toThrow("关闭");
  let drained = false; const pending = workers.drain().then(() => { drained = true; });
  await Promise.resolve(); expect(drained).toBe(false);
  first(); exit.resolve(); await pending; expect(workers.reserved).toBe(0);
});

test("two independent group sandboxes share official admission and release on real exit, including worker construction failure", async () => {
  const workers = new CodemodeWorkers(1);
  const options = { acquireWorker: workers.acquireWorker, onWorkerStarted: workers.onWorkerStarted };
  const a = new CodemodeSandbox(options), b = new CodemodeSandbox(options);
  const called = Promise.withResolvers<void>();
  const first = a.start("await tools.wait({}); return 1;", { startedAt: Date.now(), seed: 1,
    tools: [{ name: "wait" }], onCall: () => called.resolve() });
  await called.promise;
  const denied = await b.start("return 2;", { startedAt: Date.now(), seed: 2, onCall: () => {} }).result;
  expect(denied.ok).toBe(false); expect(JSON.stringify(denied)).toContain("容量已满");
  await a.close(); await first.result; await workers.drain(); expect(workers.reserved).toBe(0);
  const failed = new CodemodeSandbox({ ...options, workerUrl: "missing-worker-for-admission-test.ts" });
  expect((await failed.start("return 1;", { startedAt: Date.now(), seed: 1, onCall: () => {} }).result).ok).toBe(false);
  await workers.drain(); expect(workers.reserved).toBe(0);
  await Promise.all([b.close(), failed.close()]);
}, 20000);

test("a non-interruptible builtin returns timeout promptly and cannot dispatch late tools or over-admit on repeated cancellation", async () => {
  const workers = new CodemodeWorkers(1);
  const sandbox = new CodemodeSandbox({ acquireWorker: workers.acquireWorker, onWorkerStarted: workers.onWorkerStarted });
  let calls = 0;
  const entered = Promise.withResolvers<void>();
  const run = sandbox.start("await tools.started({}); /^(a+)+$/.test('a'.repeat(27) + '!'); await tools.late({});", {
    startedAt: Date.now(), seed: 1, timeoutMs: 200, tools: [{ name: "started" }, { name: "late" }],
    onCall: call => { calls++; run.deliver(1, Date.now(), call.id, { ok: true, value: null }); entered.resolve(); },
  });
  await entered.promise;
  // Let the worker receive the tool result and enter the synchronous builtin.
  await Bun.sleep(50);
  const started = performance.now();
  expect((await run.result).ok).toBe(false);
  expect(performance.now() - started).toBeLessThan(2000);
  for (let i = 0; i < 3; i++) {
    const other = new CodemodeSandbox({ acquireWorker: workers.acquireWorker, onWorkerStarted: workers.onWorkerStarted });
    const occupied = workers.reserved === 1;
    const attempt = await other.start("return 2;", { startedAt: Date.now(), seed: i, onCall: () => {} }).result;
    if (occupied) { expect(attempt.ok).toBe(false); expect(JSON.stringify(attempt)).toContain("容量已满"); }
    await other.close(); expect(workers.reserved).toBeLessThanOrEqual(1);
  }
  await sandbox.close(); await workers.drain(); expect(calls).toBe(1); expect(workers.reserved).toBe(0);
}, 30000);
