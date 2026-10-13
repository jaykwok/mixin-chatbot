import { expect, test } from "bun:test";
import type { Receipt } from "../../src/contracts/task-receipt.ts";
import * as phases from "../../src/core/task-runtime/phases.ts";

const evidence = { dev: "1", ino: "2", uid: 0, fingerprint: "f".repeat(64), bytes: 0, files: 1, newest: 0 };
const base = { version: 2 as const, id: "00000000-0000-4000-8000-000000000000", nonce: "n".repeat(64), manager: "m", daemon: "d", image: "i",
  temp: "/t", createdAt: 1, pid: 2, ownerEpoch: "e" };
const fresh = (): Receipt => phases.reserved(base, "results", "1-result");
const active = () => {
  const receipt = fresh();
  phases.entityRegistered(receipt, { dev: 1n, ino: 2n }, { dev: 1n, ino: 3n });
  phases.allocationStep(receipt, "marker-written"); phases.allocationStep(receipt, "work-created"); phases.activated(receipt);
  return receipt;
};

test("a reserved receipt keeps the saved payload's field order", () => {
  expect(Object.keys(fresh())).toEqual(["version", "id", "nonce", "manager", "daemon", "image", "temp", "createdAt", "pid", "ownerEpoch",
    "phase", "allocation", "containers", "pendingNames", "mounts", "role", "resultName"]);
  expect(Object.keys(phases.reserved(base, "worker"))).not.toContain("resultName");
});

test("allocation steps run in order and a worker may start only after work exists", () => {
  const receipt = fresh();
  expect(() => phases.activated(receipt)).toThrow("启动");
  expect(() => phases.allocationStep(receipt, "marker-written")).toThrow("分配步骤 marker-written");
  phases.entityRegistered(receipt, { dev: 1n, ino: 2n }, { dev: 1n, ino: 3n });
  expect([receipt.parentIdentity, receipt.identity, receipt.allocation]).toEqual([{ dev: "1", ino: "2" }, { dev: "1", ino: "3" }, { step: "entity-registered" }]);
  expect(() => phases.allocationStep(receipt, "work-created")).toThrow("分配步骤 work-created");
  phases.allocationStep(receipt, "marker-written"); phases.allocationStep(receipt, "work-created"); phases.activated(receipt);
  expect(receipt.phase).toBe("active");
  expect(() => phases.allocationStep(receipt, "work-created")).toThrow();
});

test("an allocation failure is recorded from allocating or an unsaved activation only", () => {
  const allocating = fresh();
  phases.allocationFailed(allocating, new Error("x".repeat(5000)));
  expect([allocating.phase, allocating.allocation!.error!.length]).toEqual(["allocation-failed", 4096]);
  const activating = active();
  phases.allocationFailed(activating, "active-save");
  expect(activating.phase).toBe("allocation-failed");
  const stopped = active(); phases.stopping(stopped);
  expect(() => phases.allocationFailed(stopped, "late")).toThrow("记录分配失败");
});

test("writer retirement never downgrades a saved deletion or archive intent", () => {
  const receipt = active();
  expect(() => phases.reclaiming(receipt)).toThrow("开始回收");
  phases.stopping(receipt); expect(receipt.phase).toBe("stopping");
  expect(() => phases.reclaiming(receipt)).toThrow("开始回收");
  phases.writersReaped(receipt); phases.reclaiming(receipt);
  phases.stopping(receipt); phases.writersReaped(receipt);
  expect(receipt.phase).toBe("reclaiming");
  phases.reclaiming(receipt); phases.removed(receipt);
  expect(() => phases.removed(receipt)).toThrow("确认回收");

  const archive = active();
  phases.stopping(archive); phases.writersReaped(archive);
  expect(() => phases.archived(archive)).toThrow("确认归档");
  phases.archiving(archive, "/a", evidence);
  expect(() => phases.archiving(archive, "/b", evidence)).toThrow("开始归档");
  phases.stopping(archive); phases.writersReaped(archive);
  expect([archive.phase, archive.archive]).toEqual(["archiving", { destination: "/a", evidence }]);
  expect(() => phases.reclaiming(archive)).toThrow("开始回收");
  phases.archived(archive);
  expect(archive.phase).toBe("archived");
});

test("a deferred sweep attempt waits one minute", () => {
  const receipt = active();
  phases.retryLater(receipt, "task-owner-live", 1000);
  expect(receipt.reclamation).toEqual({ attemptedAt: 1000, nextAttemptAt: 61_000, reason: "task-owner-live" });
});
