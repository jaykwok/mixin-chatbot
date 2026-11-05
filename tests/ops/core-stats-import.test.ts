import { expect, test } from "bun:test";
import { link, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openStatsLedger, readLedger, recordAsks } from "../../src/agent/stats-ledger.ts";
import { statsFileScope } from "../../scripts/lib/operation-scope.ts";
import { prepareStatsStage, removeStatsStage, statsStagePath, validateStatsSource, type StatsStageRecord } from "../../scripts/ops/core/stats-stage.ts";
import { runStatsImport, statsImportRequest } from "../../scripts/ops/core/stats-import.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "../../scripts/ops/core/maintenance-host.ts";
import { acquireDeploymentLock } from "../../scripts/ops/core/deployment-lock.ts";
import { MaintenanceRecord } from "../../scripts/ops/core/maintenance-record.ts";
import { recoverMaintenance } from "../../scripts/ops/core/maintenance-recovery.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { runCore } from "../../scripts/ops/core/cli.ts";
import { tempFixture } from "../helpers/temp.ts";

async function stageFixture() {
  const f = await tempFixture("core-stats-stage-"); await mkdir(join(f.root, "backup"));
  const source = join(f.root, "old.sqlite"); await writeFile(source, "synthetic ledger"); await writeFile(source + "-wal", "synthetic wal");
  const record: StatsStageRecord = { version: 1, kind: "stats-import", id: randomUUID().replaceAll("-", ""),
    phase: "prepared", owner: { uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0 } };
  let saved: StatsStageRecord | undefined;
  const save = async (value: StatsStageRecord) => { saved = structuredClone(value); };
  return { ...f, source, record, save, saved: () => saved!, path: statsStagePath(f.root, record) };
}

test("统计导入严格参数；未知选项、重复摘要或多文件在宿主初始化前拒绝", async () => {
  for (const args of [[], ["--all"], ["one", "two"], ["one", "--expects", "a"], ["one", "--expect", "bad"],
    ["one", "--expect", "a".repeat(64), "--expect", "b".repeat(64)]]) {
    expect(() => statsImportRequest(args)).toThrow();
    let called = false;
    await expect(runCore(["maintenance", "stat-import", ...args, "--project", "."], { stats: async () => { called = true; throw new Error(); } })).rejects.toThrow();
    expect(called).toBe(false);
  }
});

test("统计暂存逐字复制账本和 WAL，目录私有，删除仅影响本次副本并保留原件", async () => {
  const f = await stageFixture();
  try {
    const digest = validateStatsSource(f.root, f.source);
    const staged = await prepareStatsStage(f.root, f.record, f.source, digest, f.save);
    expect(staged).toMatchObject({ phase: "ready", digest }); expect(staged.directory).toBeDefined();
    expect(statsFileScope(join(f.path, "stats.sqlite"))).toBe(digest);
    if (process.platform !== "win32") {
      expect((await lstat(f.path)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(f.path, "stats.sqlite"))).mode & 0o777).toBe(0o600);
    }
    await removeStatsStage(f.root, staged, f.save); expect(f.saved().phase).toBe("removed");
    expect(await readdir(join(f.root, "backup"))).toEqual([]); expect(statsFileScope(f.source)).toBe(digest);
    await removeStatsStage(f.root, f.saved(), f.save); expect(f.saved().phase).toBe("removed");
  } finally { await f.cleanup(); }
});

test("当前统计库及其硬链接拒绝；复制期间源文件改变时不能导入，副本仍可按记录清理", async () => {
  const f = await stageFixture();
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true });
    const current = join(f.root, "data/state/stats.sqlite"); await link(f.source, current);
    expect(() => validateStatsSource(f.root, current)).toThrow("当前部署");
    expect(() => validateStatsSource(f.root, f.source)).toThrow("别名");
    // A different selected file is valid, but changing it while copying invalidates the original confirmation.
    const independent = join(f.root, "another.sqlite"); await writeFile(independent, "original");
    const digest = validateStatsSource(f.root, independent);
    await expect(prepareStatsStage(f.root, f.record, independent, digest, async record => {
      await f.save(record); if (record.phase === "created") await writeFile(independent, "changed");
    })).rejects.toThrow("操作范围已变化");
    expect(f.saved().phase).toBe("created");
    await removeStatsStage(f.root, f.saved(), f.save); expect(await readdir(join(f.root, "backup"))).toEqual([]);
    expect(await readFile(independent, "utf8")).toBe("changed");
  } finally { await f.cleanup(); }
});

test.each(["prepared", "created", "ready", "removed"] as const)("统计副本在 %s 落盘失败后依照最后持久记录收尾", async point => {
  const f = await stageFixture();
  try {
    const save = async (record: StatsStageRecord) => { if (record.phase === point) throw new Error("synthetic disk failure"); await f.save(record); };
    if (point === "removed") {
      const staged = await prepareStatsStage(f.root, f.record, f.source, statsFileScope(f.source), save);
      await expect(removeStatsStage(f.root, staged, save)).rejects.toThrow("synthetic disk");
    } else await expect(prepareStatsStage(f.root, f.record, f.source, statsFileScope(f.source), save)).rejects.toThrow("synthetic disk");
    if (f.saved()) await removeStatsStage(f.root, f.saved(), f.save);
    expect(await readdir(join(f.root, "backup"))).toEqual([]);
    expect(await readFile(f.source, "utf8")).toBe("synthetic ledger");
  } finally { await f.cleanup(); }
});

test("目录替换或夹入其他文件时拒绝清理，保留原副本和新内容", async () => {
  for (const mode of ["replaced", "foreign"]) {
    const f = await stageFixture();
    try {
      const record = await prepareStatsStage(f.root, f.record, f.source, statsFileScope(f.source), f.save);
      if (mode === "replaced") { await rename(f.path, f.path + ".kept"); await mkdir(f.path, { mode: 0o700 }); }
      else await writeFile(join(f.path, "unrelated"), "keep me");
      await expect(removeStatsStage(f.root, record, f.save)).rejects.toThrow(mode === "replaced" ? "被替换" : "不属于本次");
      expect(f.saved().phase).toBe("ready");
      expect((await readdir(f.path)).sort()).toEqual(mode === "replaced" ? [] : ["stats.sqlite", "stats.sqlite-wal", "unrelated"]);
      if (mode === "replaced") expect(await readFile(join(f.path + ".kept", "stats.sqlite"), "utf8")).toBe("synthetic ledger");
    } finally { await f.cleanup(); }
  }
});

async function hostFixture() {
  const f = await stageFixture();
  for (const tree of ["src", "scripts", "ui"]) { await mkdir(join(f.root, tree)); await writeFile(join(f.root, tree, "fixture.ts"), "export {};\n"); }
  await mkdir(join(f.root, "data/state"), { recursive: true });
  await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 1, appVersion: "1.0.1", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
  const ready = { service: "mixin-chatbot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(ready) });
  await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
  const facts = { state: "running" as "running" | "stopped", identity: "a".repeat(64), owned: true }, effects: string[] = [];
  const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 100, verify: async () => {}, finish: async () => {}, output: () => {},
    platform: async () => ({ inspect: async () => facts, stop: async () => { effects.push("stop"); facts.state = "stopped"; },
      start: async () => { effects.push("start"); facts.state = "running"; } }),
  };
  return { ...f, facts, effects, options, async close() { server.stop(true); await f.cleanup(); } };
}

test("统计导入失败后仍恢复原运行状态并删副本；未完成事务、缺失文件和链接在停机前拒绝", async () => {
  for (const mode of ["failed", "guarded", "missing", ...(process.platform === "win32" ? [] : ["link"])]) {
    const f = await hostFixture();
    try {
      let source = f.source, calls = 0;
      if (mode === "missing") source = join(f.root, "missing.sqlite");
      if (mode === "link") { source = join(f.root, "link.sqlite"); await symlink(f.source, source); }
      if (mode === "guarded") await writeFile(join(f.root, "data/state/deploy-transaction"), "deploy-fixture\n");
      const result = await runStatsImport(statsImportRequest([source]), f.options, undefined, (options, request) => {
        const host = createMaintenanceHost(options, request);
        return { ...host, data: async input => {
          calls++; expect(f.facts.state).toBe("stopped");
          expect(statsFileScope(input.args[0]!)).toBe(statsFileScope(f.source));
          expect(input.args.slice(1)).toEqual(["--expect", statsFileScope(f.source)]);
          return { code: 17, stdout: "" };
        } };
      });
      expect(result.exitCode).not.toBe(0); expect(result.finalState).toBe("running");
      expect(calls).toBe(mode === "failed" ? 1 : 0); expect(f.effects).toEqual(mode === "failed" ? ["stop", "start"] : []);
      expect(await readdir(join(f.root, "backup"))).toEqual([]);
      expect(await readFile(f.source, "utf8")).toBe("synthetic ledger");
    } finally { await f.close(); }
  }
});

test("运维恢复先清理有记录的统计副本，再恢复运行，不重跑导入；记录未删除前不能报告完成", async () => {
  const f = await hostFixture();
  try {
    const request = maintenanceRequest(f.root, { command: "stat-import", intent: "service", label: "导入统计" });
    const lock = acquireDeploymentLock(f.root), store = new MaintenanceRecord(f.root, request.id, () => lock.assertHeld());
    try {
      const cp = { version: 1 as const, request, phase: "prepared" as const, original: { ...f.facts, ready: true, pending: false } };
      await store.checkpoint(cp);
      const record = await prepareStatsStage(f.root, { ...f.record, id: request.id }, f.source, statsFileScope(f.source), value => store.staging(value));
      await store.checkpoint({ ...cp, phase: "acting" }); expect(store.read()?.staging).toEqual(record);
      await expect(store.finish({ protocol: "mixin-ops", version: 1, command: "stat-import", outcome: "success", exitCode: 0,
        wasRunning: true, finalState: "running", message: "not yet" })).rejects.toThrow();
    } finally { lock.close(); }
    f.facts.state = "stopped";
    expect(await recoverMaintenance(f.options)).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual(["start"]); expect(await readdir(join(f.root, "backup"))).toEqual([]);
    expect(readOpsMaintenanceRecord(f.root)).toMatchObject({ staging: { phase: "removed" }, result: { outcome: "failed" } });
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "win32")("Windows 真实统计导入：未 checkpoint 的 schema 3 快照、原账本不动、重复不计数、临时副本删除", async () => {
  const f = await hostFixture(), repo = join(import.meta.dir, "../..");
  const ledgerPath = join(f.root, "selected.sqlite"), ledger = openStatsLedger(ledgerPath);
  try {
    await symlink(join(repo, "node_modules"), join(f.root, "node_modules"), "junction");
    recordAsks(ledger, [{ requestId: "synthetic-ask", at: 1_700_000_000_000, space: "direct", user: "synthetic-member" }]);
    const expected = statsFileScope(ledgerPath), selected = statsImportRequest([ledgerPath, "--expect", expected]);
    expect(await runStatsImport(selected, { ...f.options, source: repo })).toMatchObject({ outcome: "success", wasRunning: true, finalState: "running" });
    expect(f.effects).toEqual(["stop", "start"]); expect(statsFileScope(ledgerPath)).toBe(expected);
    const target = openStatsLedger(join(f.root, "data/state/stats.sqlite"));
    const rows = readLedger(target); target.close(); expect(rows.asks.reduce((n, row) => n + row.asks, 0)).toBe(1);
    expect(await readdir(join(f.root, "backup"))).toEqual([]);
    expect(readOpsMaintenanceRecord(f.root)).toMatchObject({ staging: { phase: "removed" }, writer: { kind: "windows-job", phase: "reaped" } });
    f.facts.state = "stopped"; f.effects.length = 0;
    expect(await runStatsImport(selected, { ...f.options, source: repo })).toMatchObject({ outcome: "success", wasRunning: false, finalState: "stopped" });
    expect(f.effects).toEqual([]); expect(await readdir(join(f.root, "backup"))).toEqual([]);
    const again = openStatsLedger(join(f.root, "data/state/stats.sqlite"));
    try { expect(readLedger(again).asks).toEqual(rows.asks); } finally { again.close(); }
    expect(JSON.stringify(readOpsMaintenanceRecord(f.root))).not.toContain("synthetic-member");
    expect(JSON.stringify(readOpsMaintenanceRecord(f.root))).not.toContain("selected.sqlite");
  } finally { ledger.close(); await f.close(); }
}, 45_000);
