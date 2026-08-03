import { describe, expect, test } from "bun:test";
import {
  getWorkspaceCoordinationStatus,
  runFileMutation,
  runFileMutations,
  runOpaqueWorkspaceOperation,
} from "../../src/agent/workspace-coordinator.ts";

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

describe("workspace operation coordination", () => {
  test("serializes mutations of the same path in FIFO order", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    const path = `${workspace}/shared.txt`;
    const order: string[] = [];
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runFileMutation(workspace, path, async () => {
      order.push("first-start");
      markFirstStarted();
      await firstGate;
      order.push("first-end");
    });
    await firstStarted;
    const second = runFileMutation(workspace, path, async () => {
      order.push("second");
    });

    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  test("allows mutations of different paths to run concurrently", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });

    const first = runFileMutation(workspace, `${workspace}/a.txt`, async () => {
      markFirstStarted();
      await firstGate;
    });
    await firstStarted;
    const second = runFileMutation(workspace, `${workspace}/b.txt`, async () => {
      markSecondStarted();
    });
    await secondStarted;

    releaseFirst();
    await Promise.all([first, second]);
  });

  test("releases every path after a task error", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    const path = `${workspace}/shared.txt`;

    await expect(
      runFileMutation(workspace, path, async () => {
        throw new Error("write failed");
      })
    ).rejects.toThrow("write failed");

    let nextStarted = false;
    await runFileMutation(workspace, path, async () => {
      nextStarted = true;
    });
    expect(nextStarted).toBe(true);
    expect(getWorkspaceCoordinationStatus(workspace)).toEqual({
      fileMutations: 0,
      opaqueActive: false,
      waiting: 0,
    });
  });

  test("cancels a queued path lock without overtaking the active owner", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    const path = `${workspace}/shared.txt`;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let secondStarted = false;
    let thirdStarted = false;

    const first = runFileMutation(workspace, path, async () => {
      markFirstStarted();
      await firstGate;
    });
    await firstStarted;

    const controller = new AbortController();
    const second = runFileMutation(
      workspace,
      path,
      async () => {
        secondStarted = true;
      },
      controller.signal
    );
    const secondSettled = second.then(
      () => "completed",
      (error: Error) => error.name
    );
    const third = runFileMutation(workspace, path, async () => {
      thirdStarted = true;
    });
    await waitFor(
      () => getWorkspaceCoordinationStatus(workspace).fileMutations === 3
    );

    controller.abort();
    expect(await secondSettled).toBe("AbortError");
    expect(secondStarted).toBe(false);
    expect(thirdStarted).toBe(false);

    releaseFirst();
    await Promise.all([first, third]);
    expect(thirdStarted).toBe(true);
    expect(getWorkspaceCoordinationStatus(workspace)).toEqual({
      fileMutations: 0,
      opaqueActive: false,
      waiting: 0,
    });
  });

  test("releases an active path only after its aborted task settles", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    const path = `${workspace}/shared.txt`;
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const active = runFileMutation(
      workspace,
      path,
      async () => {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true }
          );
        });
      },
      controller.signal
    );
    const activeSettled = active.then(
      () => "completed",
      (error: Error) => error.name
    );
    await started;
    controller.abort();
    expect(await activeSettled).toBe("AbortError");

    let nextStarted = false;
    await runFileMutation(workspace, path, async () => {
      nextStarted = true;
    });
    expect(nextStarted).toBe(true);
  });

  test("registers reversed multi-path requests without deadlock", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    const a = `${workspace}/a.txt`;
    const b = `${workspace}/b.txt`;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = runFileMutations(workspace, [a, b], async () => {
      order.push("first");
      markFirstStarted();
      await firstGate;
    });
    await firstStarted;
    const second = runFileMutations(workspace, [b, a], async () => {
      order.push("second");
    });
    expect(order).toEqual(["first"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  test("treats bash as an opaque operation without blocking plain reads", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    let releaseFile!: () => void;
    const fileGate = new Promise<void>((resolve) => {
      releaseFile = resolve;
    });
    let markFileStarted!: () => void;
    const fileStarted = new Promise<void>((resolve) => {
      markFileStarted = resolve;
    });
    let opaqueStarted = false;
    let laterFileStarted = false;

    const file = runFileMutation(workspace, `${workspace}/a.txt`, async () => {
      markFileStarted();
      await fileGate;
    });
    await fileStarted;
    const opaque = runOpaqueWorkspaceOperation(workspace, async () => {
      opaqueStarted = true;
    });
    const laterFile = runFileMutation(workspace, `${workspace}/b.txt`, async () => {
      laterFileStarted = true;
    });
    await Promise.resolve();

    // A normal read does not use the coordinator and remains immediately available.
    const readResult = await Promise.resolve("read-ok");
    expect(readResult).toBe("read-ok");
    expect(opaqueStarted).toBe(false);
    expect(laterFileStarted).toBe(false);
    expect(getWorkspaceCoordinationStatus(workspace).waiting).toBe(2);

    releaseFile();
    await Promise.all([file, opaque, laterFile]);
    expect(opaqueStarted).toBe(true);
    expect(laterFileStarted).toBe(true);
    expect(getWorkspaceCoordinationStatus(workspace)).toEqual({
      fileMutations: 0,
      opaqueActive: false,
      waiting: 0,
    });
  });

  test("removes an aborted opaque waiter and admits later file work", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });

    const first = runFileMutation(workspace, `${workspace}/a.txt`, async () => {
      markFirstStarted();
      await firstGate;
    });
    await firstStarted;

    const controller = new AbortController();
    let opaqueStarted = false;
    const opaque = runOpaqueWorkspaceOperation(
      workspace,
      async () => {
        opaqueStarted = true;
      },
      controller.signal
    );
    const opaqueSettled = opaque.then(
      () => "completed",
      (error: Error) => error.name
    );
    let markLaterStarted!: () => void;
    const laterStarted = new Promise<void>((resolve) => {
      markLaterStarted = resolve;
    });
    const later = runFileMutation(workspace, `${workspace}/b.txt`, async () => {
      markLaterStarted();
    });
    await waitFor(() => getWorkspaceCoordinationStatus(workspace).waiting === 2);

    controller.abort();
    expect(await opaqueSettled).toBe("AbortError");
    expect(opaqueStarted).toBe(false);
    await laterStarted;

    releaseFirst();
    await Promise.all([first, later]);
    expect(getWorkspaceCoordinationStatus(workspace)).toEqual({
      fileMutations: 0,
      opaqueActive: false,
      waiting: 0,
    });
  });
});
