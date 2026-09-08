import { describe, expect, test } from "bun:test";
import { SessionQueue } from "../../src/agent/session-queue.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}

describe("session lifecycle queue", () => {
  test("a rejection with no reason is not reported as a successful task", async () => {
    const queue = new SessionQueue();
    const outcome = await queue.enqueue(() => Promise.reject()).then(() => "success", () => "failure");
    expect(outcome).toBe("failure");
    expect(queue.busy).toBe(false);
  });
  test("a message arriving during final delivery executes as the next task", async () => {
    const queue = new SessionQueue();
    const delivery = gate();
    const started = gate();
    const seen: string[] = [];
    const first = queue.enqueue(async () => { seen.push("first"); queue.phase = "交付中"; started.release(); await delivery.promise; });
    await started.promise;
    const second = queue.enqueue(async () => { seen.push("second"); });
    expect(queue.waiting).toBe(1);
    delivery.release();
    await Promise.all([first, second]);
    expect(seen).toEqual(["first", "second"]);
  });

  test("two messages arriving during cancellation never overlap", async () => {
    const queue = new SessionQueue();
    const cleanup = gate();
    const started = gate();
    let active = 0;
    let peak = 0;
    const first = queue.enqueue(async (signal) => {
      active++; peak = Math.max(active, peak); started.release();
      await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      await cleanup.promise; active--;
    });
    await started.promise;
    const stop = queue.cancel();
    const run = async () => { active++; peak = Math.max(active, peak); await Bun.sleep(1); active--; };
    const afterA = queue.enqueue(run);
    const afterB = queue.enqueue(run);
    cleanup.release();
    await Promise.all([first, stop, afterA, afterB]);
    expect(peak).toBe(1);
  });

  test("stop rejects pending messages and clear is a barrier before new work", async () => {
    const queue = new SessionQueue();
    const held = gate();
    const started = gate();
    const seen: string[] = [];
    const first = queue.enqueue(async () => { started.release(); await held.promise; });
    await started.promise;
    const cancelled = queue.enqueue(async () => { seen.push("must not execute"); });
    const rejected = cancelled.catch((error: Error) => error.message);
    queue.cancel();
    const clear = queue.enqueue(async () => { seen.push("clear"); });
    const next = queue.enqueue(async () => { seen.push("new"); });
    held.release();
    await Promise.all([first, clear, next]);
    expect(await rejected).toBe("任务已取消");
    expect(seen).toEqual(["clear", "new"]);
  });
});
