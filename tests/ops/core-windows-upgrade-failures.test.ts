// The former PowerShell upgrade-flow matrix now executes the shared host and its disk journal.
// Terminal-only preview/choice failures are in windows-upgrade-entry.test.ts; Git collision and concurrent-edit cases use real repositories.
import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { windowsUpgradeFixture } from "../helpers/windows-upgrade.ts";
import { loadDeploymentState } from "../../ops/core/deployment-state.ts";
import { acquireDeploymentLock, DeploymentBusy } from "../../ops/core/deployment-lock.ts";

const modes = ["none", "main-missing", "diverged", "task-missing", "switch", "switch-late", "code", "install", "scope-install", "apply", "health", "commit", "postcommit"] as const;
for (const mode of modes) test.skipIf(process.platform !== "win32")(`Windows shared upgrade failure matrix: ${mode}`, async () => {
  for (const reuse of [true, false]) for (const running of [true, false]) {
    if (mode === "install" && reuse || mode === "postcommit" && !running) continue;
    const f = await windowsUpgradeFixture(running, { reuse, directory: true, ...(mode !== "none" ? { failure: mode } : {}) });
    try {
      const result = await f.run(), events = f.events, label = `${mode} reuse=${reuse} running=${running}: ${result.message}`;
      expect(result.exitCode === 0, label).toBe(mode === "none");
      const preflight = ["main-missing", "diverged", "task-missing", "switch", "switch-late"].includes(mode);
      if (preflight) {
        expect(events, label).not.toContain("effect:stop"); expect(events, label).not.toContain("dependencies:install");
        expect(events.some(value => value.startsWith("data:")), label).toBe(false); expect(f.running).toBe(running);
        expect(result.outcome, label).toBe("refused"); expect(result.message, label).toMatch(/旧服务尚未停止|本次升级没有停止服务/);
        if (mode.startsWith("switch")) expect(result.message, label).toContain("\n  - 未提交的改动： M version.txt\n");
      } else if (mode === "code") {
        expect(events).not.toContain("dependencies:install"); expect(events).not.toContain("data:apply");
        expect(events).not.toContain("git:reset"); expect(events).not.toContain("effect:restore-configuration");
        expect(loadDeploymentState(f.project)).not.toBeNull(); expect(f.running).toBe(false);
      } else if (mode === "none" || mode === "postcommit") {
        expect(events.filter(value => value === "dependencies:install")).toHaveLength(reuse ? 0 : 1);
        expect(events.filter(value => value === "effect:save-dependencies")).toHaveLength(reuse ? 0 : 1);
        expect(events).not.toContain("data:rollback"); expect(events).not.toContain("effect:restore-configuration");
        expect(events.indexOf("directory-scope:install")).toBeLessThan(events.indexOf("data:apply"));
        expect(events.indexOf("data:apply")).toBeLessThan(events.indexOf("start:verify"));
        expect(events.indexOf("start:verify")).toBeLessThan(events.indexOf("data:commit"));
        expect(events.includes("start:target")).toBe(running);
        expect(loadDeploymentState(f.project)?.committed ?? mode === "none").toBe(true);
      } else {
        expect(events, label).toContain("data:rollback"); expect(events, label).toContain("effect:restore-configuration");
        expect(events.indexOf("data:rollback")).toBeLessThan(events.indexOf("git:reset"));
        expect(events.indexOf("git:reset")).toBeLessThan(events.indexOf("effect:restore-configuration"));
        if (running) expect(events.indexOf("effect:restore-configuration")).toBeLessThan(events.indexOf("start:original"));
        expect(f.running, label).toBe(running); expect(loadDeploymentState(f.project), label).toBeNull();
        expect(existsSync(join(f.project, "data/config/directory.json"))).toBe(false);
      }
      expect(events.includes("effect:cleanup"), label).toBe(mode === "none");
    } finally { await f.cleanup(); }
  }
}, 60_000);

test.skipIf(process.platform !== "win32")("Windows 升级预检只读：与锁内同一套拒绝，不发布快照、不停止、不碰数据", async () => {
  const expected = { none: "停机前检查通过", "main-missing": "本地 main 分支不存在；旧服务尚未停止", diverged: "无法快进到目标提交",
    "task-missing": "未安装计划任务，请先部署；旧服务尚未停止", switch: "\n  - 未提交的改动： M version.txt\n" } as const;
  for (const mode of Object.keys(expected) as (keyof typeof expected)[]) {
    const f = await windowsUpgradeFixture(true, mode === "none" ? {} : { failure: mode });
    try {
      const result = await f.preflight(), label = `${mode}: ${result.message}`;
      expect(result, label).toMatchObject({ outcome: mode === "none" ? "success" : "refused", exitCode: mode === "none" ? 0 : 1, wasRunning: mode === "none" });
      expect(result.message, label).toContain(expected[mode]);
      expect(f.events, label).toEqual([]); expect(f.running).toBe(true);
      expect(loadDeploymentState(f.project)).toBeNull(); expect(existsSync(join(f.project, "backup")), label).toBe(false);
    } finally { await f.cleanup(); }
  }
  // An open transaction or another holder of deploy.lock refuses before any Git or task read.
  const f = await windowsUpgradeFixture(true);
  try {
    await f.pending(); const count = f.events.length;
    expect(await f.preflight()).toMatchObject({ outcome: "refused", exitCode: 1, message: "有未完成的部署或升级，请先继续或回滚；旧服务尚未停止" });
    rmSync(join(f.project, "data/state/upgrade-transaction"));
    const lock = acquireDeploymentLock(f.project);
    try { expect(await f.preflight()).toMatchObject({ outcome: "refused", exitCode: 1, message: new DeploymentBusy().message }); }
    finally { lock.close(); }
    expect(f.events).toHaveLength(count);
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows 显式回滚使用原记录，已提交或手工改动时不停止、不恢复、不重选", async () => {
  for (const mode of ["prepared", "committed", "manual"] as const) {
    const f = await windowsUpgradeFixture(true);
    try {
      await f.pending(mode === "committed" ? "committed" : "prepared"); if (mode === "manual") f.dirty();
      const result = await f.run({ ...f.input, rollback: true, command: "rollback" });
      expect(result.exitCode === 0, result.message).toBe(mode === "prepared");
      for (const event of ["effect:capture", "dependencies:install", "directory-scope:install", "data:apply", "effect:cleanup"]) expect(f.events).not.toContain(event);
      if (mode === "prepared") {
        expect(f.events).toContain("data:rollback"); expect(f.events).toContain("git:reset"); expect(f.events).toContain("start:original");
        expect(loadDeploymentState(f.project)).toBeNull(); expect(f.running).toBe(true);
      } else {
        expect(f.events).not.toContain("effect:stop"); expect(f.events).not.toContain("data:rollback"); expect(f.events).not.toContain("git:reset");
        expect(loadDeploymentState(f.project)).not.toBeNull();
      }
    } finally { await f.cleanup(); }
  }
}, 30_000);

test.skipIf(process.platform !== "win32")("Windows 自动恢复先回退数据，保留手工改动的代码并等待明确回滚", async () => {
  const f = await windowsUpgradeFixture(true, { failure: "dirty-on-apply" });
  try {
    const result = await f.run(); expect(result.exitCode).toBe(1); expect(result.message).toContain("未提交的改动");
    expect(f.events).toContain("data:rollback"); expect(f.events).not.toContain("git:reset"); expect(f.events).not.toContain("effect:restore-configuration");
    expect(f.running).toBe(false); expect(loadDeploymentState(f.project)?.dataPhase).toBe("unprepared");
    expect(loadDeploymentState(f.project)?.rollbackPending).toBe(true);
  } finally { await f.cleanup(); }
}, 30_000);
