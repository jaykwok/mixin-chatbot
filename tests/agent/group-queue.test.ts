import { describe, expect, test } from "bun:test";
import { getGroupQueueStatus, runInGroupQueue } from "../../src/agent/group-queue.ts";

describe("group workspace queue", () => {
  test("runs turns for one group in FIFO order", async () => {
    const groupId = `queue-${crypto.randomUUID()}`;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runInGroupQueue(groupId, () => {}, async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    });
    await Promise.resolve();

    let ahead = 0;
    const second = runInGroupQueue(
      groupId,
      (value) => {
        ahead = value;
      },
      async () => {
        order.push("second");
      }
    );
    await Promise.resolve();

    expect(ahead).toBe(1);
    expect(getGroupQueueStatus(groupId)).toEqual({ active: true, waiting: 1 });
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(getGroupQueueStatus(groupId)).toEqual({ active: false, waiting: 0 });
  });

  test("does not serialize different groups", async () => {
    const running: string[] = [];
    const one = runInGroupQueue(`a-${crypto.randomUUID()}`, () => {}, async () => {
      running.push("a");
    });
    const two = runInGroupQueue(`b-${crypto.randomUUID()}`, () => {}, async () => {
      running.push("b");
    });
    await Promise.all([one, two]);
    expect(running.sort()).toEqual(["a", "b"]);
  });

  test("releases its queue slot when the queued notification fails", async () => {
    const groupId = `queue-notice-${crypto.randomUUID()}`;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runInGroupQueue(groupId, () => {}, () => firstGate);
    await Promise.resolve();
    const failed = runInGroupQueue(
      groupId,
      () => {
        throw new Error("notice failed");
      },
      async () => {
        throw new Error("task must not run");
      }
    );
    await expect(failed).rejects.toThrow("notice failed");
    expect(getGroupQueueStatus(groupId)).toEqual({ active: true, waiting: 0 });

    releaseFirst();
    await first;
    await runInGroupQueue(groupId, () => {}, async () => {});
    expect(getGroupQueueStatus(groupId)).toEqual({ active: false, waiting: 0 });
  });
});
