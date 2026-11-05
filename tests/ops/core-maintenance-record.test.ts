import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { acquireDeploymentLock } from "../../scripts/ops/core/deployment-lock.ts";
import { MaintenanceRecord } from "../../scripts/ops/core/maintenance-record.ts";
import { newDockerTask } from "../../scripts/ops/core/docker-task.ts";
import type { MaintenanceCheckpoint } from "../../scripts/ops/core/maintenance.ts";
import type { OpsResult } from "../../scripts/ops/core/result.ts";
import { OPS_MAINTENANCE_FILE, readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { assessMaintenanceAction, readMaintenanceState, MAINTENANCE_INTENTS } from "../../src/core/maintenance-state.ts";

const fixture = await tempFixture("core-maintenance-record-"); afterAll(() => fixture.cleanup()); let seq = 0;
function setup() {
  const project = join(fixture.root, String(++seq)); mkdirSync(project, { recursive: true });
  const lock = acquireDeploymentLock(project), id = "a".repeat(32), store = new MaintenanceRecord(project, id, () => lock.assertHeld());
  const checkpoint: MaintenanceCheckpoint = { version: 1, request: { id, runtime: "d".repeat(64), command: "history-clear", label: "清空会话", intent: "conversation-write" },
    phase: "prepared", original: { identity: "c".repeat(64), state: "running", ready: true, owned: true, pending: false } };
  const result: OpsResult = { protocol: "mixin-ops", version: 1, command: "history-clear", wasRunning: true, finalState: "running", exitCode: 0, outcome: "success", message: "完成" };
  const writer = newDockerTask({ daemon: "fixture", endpoint: "unix:///var/run/docker.sock", image: "sha256:" + "e".repeat(64), user: "1001:1001",
    data: join(project, "data"), backup: join(project, "backup"), network: "none" }, ["run", "fixture.ts"]);
  return { project, lock, store, checkpoint, writer, result };
}

test("维护记录在锁内持久发布；未收尾禁止新维护和启动，写入者回收后才可授权恢复启动", async () => {
  const f = setup();
  try {
    f.store.assertAvailable(); await f.store.checkpoint(f.checkpoint);
    expect(() => f.store.assertAvailable()).toThrow("上次运维");
    const permitted = (intent: typeof MAINTENANCE_INTENTS[number]) => assessMaintenanceAction(readMaintenanceState(f.project), intent).allowed;
    for (const intent of ["service", "verify", "release"] as const) expect(permitted(intent)).toBe(false);
    expect(permitted("conversation-write")).toBe(true); // The storage child still holds its own service lease.
    await f.store.checkpoint({ ...f.checkpoint, phase: "acting" }); await f.store.writer(f.writer);
    await expect(f.store.checkpoint({ ...f.checkpoint, phase: "starting" })).rejects.toThrow("写入者尚未回收");
    await expect(f.store.finish(f.result)).rejects.toThrow("写入者尚未回收");
    expect(readOpsMaintenanceRecord(f.project)?.writer?.phase).toBe("prepared");
    // A new instance of the store is recovery after a process/host restart; no in-memory completion flags survive.
    const recovered = new MaintenanceRecord(f.project, f.checkpoint.request.id, () => f.lock.assertHeld());
    await recovered.writer({ ...f.writer, phase: "reaped" });
    expect(permitted("service")).toBe(false);
    await recovered.checkpoint({ ...f.checkpoint, phase: "starting" }); expect(permitted("service")).toBe(true);
    await recovered.finish(f.result); expect(readOpsMaintenanceRecord(f.project)?.result).toEqual(f.result);
    recovered.assertAvailable();
    await expect(recovered.finish(f.result)).rejects.toThrow("已经发布");
    f.lock.close(); expect(() => recovered.read()).toThrow("已经释放");
  } finally { f.lock.close(); }
});

test("新任务拒绝不覆盖旧记录，身份或原状态变化不写盘，坏记录和未知格式阻止全部受保护动作", async () => {
  const f = setup();
  try {
    await f.store.checkpoint(f.checkpoint); const bytes = readFileSync(join(f.project, OPS_MAINTENANCE_FILE));
    const other = new MaintenanceRecord(f.project, "b".repeat(32), () => f.lock.assertHeld());
    await other.finish({ ...f.result, outcome: "refused", exitCode: 1 });
    await expect(other.checkpoint({ ...f.checkpoint, request: { ...f.checkpoint.request, id: "b".repeat(32) } })).rejects.toThrow("另一份");
    await expect(f.store.checkpoint({ ...f.checkpoint, original: { ...f.checkpoint.original, state: "stopped" } })).rejects.toThrow("发生变化");
    expect(readFileSync(join(f.project, OPS_MAINTENANCE_FILE))).toEqual(bytes);
    for (const bad of ["{", { version: 2 }, { version: 1, checkpoint: { ...f.checkpoint, phase: "done" } },
      { version: 1, checkpoint: f.checkpoint, result: { ...f.result, exitCode: 1 } },
      { version: 1, checkpoint: f.checkpoint, writer: { ...f.writer, phase: "done" } },
      { version: 1, checkpoint: f.checkpoint, writer: { ...f.writer, phase: "starting" } },
      { version: 1, checkpoint: f.checkpoint, writer: false }, { version: 1, checkpoint: f.checkpoint, result: false },
      { version: 1, checkpoint: f.checkpoint, result: { ...f.result, finalState: "unknown" } }]) {
      writeFileSync(join(f.project, OPS_MAINTENANCE_FILE), typeof bad === "string" ? bad : JSON.stringify(bad));
      expect(() => f.store.read()).toThrow("无法读取或格式不支持");
      for (const intent of MAINTENANCE_INTENTS) expect(assessMaintenanceAction(readMaintenanceState(f.project), intent).allowed).toBe(false);
    }
  } finally { f.lock.close(); }
});
