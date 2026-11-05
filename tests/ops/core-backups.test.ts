import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCore } from "../../scripts/ops/core/cli.ts";
import { backupRequest, runBackups } from "../../scripts/ops/core/backups.ts";
import { checkReports, inspectReports, prepareReports, reportsPath } from "../../scripts/ops/core/reports.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "../../scripts/ops/core/maintenance-host.ts";
import { acquireDeploymentLock } from "../../scripts/ops/core/deployment-lock.ts";
import { MaintenanceRecord } from "../../scripts/ops/core/maintenance-record.ts";
import { recoverMaintenance } from "../../scripts/ops/core/maintenance-recovery.ts";
import { newWindowsTask } from "../../scripts/ops/core/windows-task.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { apply, scan } from "../../scripts/ops/backup-cleanup.ts";
import { tempFixture } from "../helpers/temp.ts";

const report = "20261031T000000Z-abcdef", confirmation = "a".repeat(16), repo = join(import.meta.dir, "../..");
test("备份入口在取锁前核对动作、报告和确认码，不接受未知或跨动作参数", async () => {
  expect(backupRequest("backup-clean", [report, "--confirm", confirmation]).args).toEqual(["apply", report, "--confirm", confirmation]);
  for (const [action, ...args] of [["backup-scan", report], ["backup-scan", "--confirm", confirmation], ["backup-clean"], ["backup-clean", "../outside"],
    ["backup-clean", report, "extra"], ["backup-clean", report, "--confirm", ""], ["backup-clean", report, "--confirms", confirmation],
    ["backup-clean", report, "--confirm", confirmation, "--confirm", confirmation], ["backup-clean", report, "--all"], ["backup-clean", report, "--confirm", "x"], ["constructor"]]) {
    let called = false;
    expect(() => backupRequest(action!, args)).toThrow();
    await expect(runCore(["maintenance", action!, ...args, "--project", "."], { backups: async () => { called = true; throw new Error(); } })).rejects.toThrow();
    expect(called).toBe(false);
  }
});

test("报告目录固定在项目 tmp 下，拒绝父目录链接、替换和跨身份，不擅自改现有权限", async () => {
  const f = await tempFixture("core-backup-reports-");
  try {
    const owner = { uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0 }, found = prepareReports(f.root, owner);
    expect(() => checkReports(f.root, found)).not.toThrow();
    await rename(reportsPath(f.root), join(f.root, "tmp/old")); await mkdir(reportsPath(f.root));
    expect(() => checkReports(f.root, found)).toThrow("替换");
    if (process.platform !== "win32") {
      expect(() => prepareReports(f.root, { ...owner, uid: owner.uid + 1 })).toThrow("属主");
      expect(inspectReports(f.root).uid).toBe(owner.uid);
      await chmod(reportsPath(f.root), 0o777);
      expect(() => prepareReports(f.root, owner)).toThrow("其他身份写入");
      await chmod(reportsPath(f.root), 0o700);
    }
    await rename(join(f.root, "tmp"), join(f.root, "original-tmp"));
    await symlink(join(f.root, "original-tmp"), join(f.root, "tmp"), process.platform === "win32" ? "junction" : "dir");
    expect(() => prepareReports(f.root, owner)).toThrow("普通目录");
  } finally { await f.cleanup(); }
});

async function fixture() {
  const f = await tempFixture("core-backups-");
  for (const tree of ["scripts", "src", "ui", "data/state"]) await mkdir(join(f.root, tree), { recursive: true });
  for (const tree of ["scripts", "src", "ui"]) await writeFile(join(f.root, tree, "fixture.ts"), "export {};\n");
  await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 1, appVersion: "1.0.1", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
  const ready = { service: "mixin-chatbot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(ready) });
  await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
  const facts = { identity: "a".repeat(64), owned: true, state: "running" as "running" | "stopped" }, effects: string[] = [];
  const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 100, verify: async () => {}, finish: async () => {}, output: () => {},
    platform: async () => ({ inspect: async () => facts, stop: async () => { effects.push("stop"); facts.state = "stopped"; }, start: async () => { effects.push("start"); facts.state = "running"; } }) };
  return { ...f, facts, effects, options, async close() { server.stop(true); await f.cleanup(); } };
}

test("备份扫描、预演和确认删除始终持同一锁且不停止机器人，拒绝和数据失败保留原运行状态", async () => {
  const f = await fixture();
  try {
    for (const running of [true, false]) for (const request of [backupRequest("backup-scan", []), backupRequest("backup-clean", [report]), backupRequest("backup-clean", [report, "--confirm", confirmation])]) {
      f.facts.state = running ? "running" : "stopped";
      const result = await runBackups(request, f.options, undefined, (options, operation) => {
        const context = createMaintenanceHost(options, operation);
        return { ...context, data: async step => {
          expect(() => acquireDeploymentLock(f.root)).toThrow();
          expect(step).toEqual({ script: "scripts/ops/backup-cleanup.ts", args: request.args, online: true, currentCode: true, reports: true });
          expect(f.facts.state).toBe(running ? "running" : "stopped"); expect(inspectReports(f.root)).toBeDefined();
          return { code: 17, stdout: "" };
        } };
      });
      expect(result).toMatchObject({ outcome: "failed", exitCode: 17, wasRunning: running, finalState: running ? "running" : "stopped" });
    }
    expect(f.effects).toEqual([]);
    const refusal = await runBackups(backupRequest("backup-scan", []), f.options, undefined, (options, operation) => ({ ...createMaintenanceHost(options, operation),
      prepareReports: async () => { throw new Error("reports belong to another identity"); }, data: async () => { throw new Error("must not execute"); } }));
    expect(refusal.exitCode).not.toBe(0); expect(f.effects).toEqual([]);
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "win32")("真实备份数据工具从固定包扫描、预演、确认删除；只删除清单中的测试条目，运行实例不停机", async () => {
  const f = await fixture();
  try {
    const name = `filler-Ab12Cd-${randomUUID()}`, path = join(f.root, "backup/rm", name);
    await mkdir(path, { recursive: true }); await writeFile(join(path, "filler.bin"), Buffer.alloc(1024 * 1024));
    await mkdir(join(f.root, "backup/rm/business")); await writeFile(join(f.root, "backup/rm/business/state.txt"), "business-value");
    const options = { ...f.options, source: repo };
    const scanned = await runBackups(backupRequest("backup-scan", []), options);
    expect(scanned, scanned.message).toMatchObject({ outcome: "success", finalState: "running" });
    const reports = await readdir(reportsPath(f.root)); expect(reports).toHaveLength(1);
    const preview = apply(f.root, reports[0]!);
    expect(preview.results.find(entry => entry.path.endsWith(name))?.outcome).toBe("would-delete");
    const invalid = await runBackups(backupRequest("backup-clean", [reports[0]!, "--confirm", "0".repeat(16)]), options);
    expect(invalid.exitCode).toBe(1); expect(await readdir(path)).toEqual(["filler.bin"]);
    const result = await runBackups(backupRequest("backup-clean", [reports[0]!, "--confirm", preview.code]), options);
    expect(result, result.message).toMatchObject({ outcome: "success", finalState: "running" });
    expect(await readdir(join(f.root, "backup/rm"))).toEqual(["business"]);
    expect(await readFile(join(f.root, "backup/rm/business/state.txt"), "utf8")).toBe("business-value");
    expect(f.effects).toEqual([]); expect(readOpsMaintenanceRecord(f.root)?.writer?.phase).toBe("reaped");
  } finally { await f.close(); }
}, 30_000);

test.skipIf(process.platform !== "win32")("中断的在线清理只回收自己的写入者，恢复不停止服务、不重复删除，原操作仍记失败", async () => {
  const f = await fixture();
  try {
    const request = maintenanceRequest(f.root, { command: "backup-clean", intent: "service", online: true, label: "fixture" });
    const store = new MaintenanceRecord(f.root, request.id, () => {});
    await store.checkpoint({ version: 1, request, original: { ...f.facts, pending: false, ready: true }, phase: "prepared" });
    const command = { command: process.execPath, args: [], cwd: f.root }, writer = newWindowsTask(command);
    await store.writer(writer);
    const name = `keep-Ab12Cd-${randomUUID()}`; await mkdir(join(f.root, "backup/rm", name), { recursive: true });
    const before = scan(f.root); const result = await recoverMaintenance(f.options);
    expect(result, result.message).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual([]); expect(scan(f.root).entries).toEqual(before.entries);
    expect(readOpsMaintenanceRecord(f.root)).toMatchObject({ writer: { phase: "reaped" }, result: { outcome: "failed", command: "backup-clean" } });
  } finally { await f.close(); }
});
