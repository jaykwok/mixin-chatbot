import { expect, test } from "bun:test";
import { AsyncSemaphore } from "../../src/core/async-semaphore.ts";
test("attachment budget retains FIFO while removing cancelled waiters and ignoring double release", async () => {
  const slots = new AsyncSemaphore(1), first = await slots.acquire(), order: number[] = [];
  const abort = new AbortController();
  const cancelled = slots.acquire(abort.signal).then(() => { throw new Error("cancelled waiter acquired"); }, error => error);
  const second = slots.acquire().then(release => { order.push(2); return release; });
  const third = slots.acquire().then(release => { order.push(3); return release; });
  abort.abort(new Error("cancel"));
  expect((await cancelled).message).toBe("cancel");
  first(); first();
  const releaseSecond = await second;
  expect(order).toEqual([2]);
  releaseSecond();
  (await third)();
  expect(order).toEqual([2, 3]);
  (await slots.acquire())();
});
