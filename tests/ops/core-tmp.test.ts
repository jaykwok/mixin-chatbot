import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpRequest, runTmp, TMP_ACTIONS } from "../../ops/core/tmp.ts";
import { runCore } from "../../ops/core/cli.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "../../ops/core/maintenance-host.ts";
import { MaintenanceRecord } from "../../ops/core/maintenance-record.ts";
import { recoverMaintenance } from "../../ops/core/maintenance-recovery.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { acquireDeploymentLock } from "../../ops/core/deployment-lock.ts";
import { readTmpPlan, readRemovalPlan } from "../../ops/lib/tmp-plan.ts";
import { tempFixture } from "../helpers/temp.ts";

const plan = "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12), digest = "b".repeat(64);
test("临时文件范围在取锁前完整校验；拼错参数、范围冲突和特权回收不会落入默认全选", async () => {
  expect(tmpRequest("tmp-preview", ["--days", "30", "--group=-option", "--group-id"]).args)
    .toEqual(["preview", "--days=30", "--group=-option", "--group-id"]);
  expect(tmpRequest("tmp-reclaim", ["--all"]).mutating).toBe(false);
  expect(tmpRequest("tmp-reclaim", ["--plan", plan, "--digest", digest]).mutating).toBe(true);
  for (const [action, ...args] of [["tmp-purge"], ["tmp-purge", "--alls"], ["tmp-purge", "--all", "--days", "2"], ["tmp-preview", "--all", "--group", "-option"],
    ["tmp-ls", "--all"], ["tmp-discard", "--days", "2"], ["tmp-preview", "--plan", plan, "--digest", digest],
    ["tmp-reclaim", "--legacy", "--all"], ["tmp-reclaim", "--all", "--journal", "/journal"], ["tmp-reclaim", "--all", "--archive", "/archive"],
    ["tmp-purge", "--days", "-2"], ["tmp-purge", "--plan", plan, "--digest", "bad"], ["tmp-purge", "--all", "extra"],
    ["tmp-purge", "--all", "--group", "g", "--group-id", "--storage-segment"], ["tmp-purge", "--all", "--all"]]) {
    expect(() => tmpRequest(action!, args), [action, ...args].join(" ")).toThrow();
    let executed = false;
    await expect(runCore(["maintenance", action!, ...args, "--project", "."], { tmp: async () => { executed = true; throw new Error("unexpected"); } })).rejects.toThrow();
    expect(executed).toBe(false);
  }
});

async function fixture() {
  const f = await tempFixture("core-tmp-");
  for (const dir of ["console", "ops", "scripts", "src", "data/state"]) await mkdir(join(f.root, dir), { recursive: true });
  for (const dir of ["console", "ops", "scripts", "src"]) await writeFile(join(f.root, dir, "fixture.ts"), "export {};\n");
  await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
  const ready = { service: "mixin-bot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(ready) });
  await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
  const facts = { identity: "a".repeat(64), owned: true, state: "running" as "running" | "stopped" }, effects: string[] = [];
  const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 100, verify: async () => {}, finish: async () => {}, output: () => {},
    platform: async () => ({ inspect: async () => facts,
      stop: async () => { effects.push("stop"); facts.state = "stopped"; }, start: async () => { effects.push("start"); facts.state = "running"; } }) };
  return { ...f, facts, effects, options, async close() { server.stop(true); await f.cleanup(); } };
}

test("真实共用宿主：查询不停止，执行清单才停止并恢复；任务 daemon 预检失败不停止", async () => {
  const f = await fixture();
  try {
    for (const action of TMP_ACTIONS) for (const confirming of [false, true]) {
      if (confirming && ["tmp-ls", "tmp-preview"].includes(action)) continue;
      const request = tmpRequest(action, confirming ? ["--plan", plan, "--digest", digest] : action === "tmp-ls" || action === "tmp-discard" ? [] : ["--all"]);
      for (const running of [true, false]) {
        f.facts.state = running ? "running" : "stopped"; f.effects.length = 0;
        const result = await runTmp(request, f.options, undefined, (options, operation) => {
          const context = createMaintenanceHost(options, operation);
          return { ...context, data: async step => {
            expect(() => acquireDeploymentLock(f.root)).toThrow();
            expect(step).toEqual({ script: "ops/tools/tmp-admin.ts", args: request.args, readOnly: !request.mutating });
            expect(f.facts.state).toBe(running && !request.mutating ? "running" : "stopped");
            expect(readOpsMaintenanceRecord(f.root)?.checkpoint.phase).toBe("acting");
            return { code: 17, stdout: "" };
          } };
        });
        expect(result).toMatchObject({ outcome: "failed", exitCode: 17, wasRunning: running, finalState: running ? "running" : "stopped" });
        expect(f.effects).toEqual(running && request.mutating ? ["stop", "start"] : []);
      }
    }
    f.facts.state = "running"; f.effects.length = 0;
    const refused = await runTmp(tmpRequest("tmp-purge", ["--all"]), f.options, undefined, (options, operation) => {
      const context = createMaintenanceHost(options, operation);
      return { ...context, prepareTaskAccess: async () => { throw new Error("task daemon mismatch"); }, data: async () => { throw new Error("must not execute"); } };
    });
    expect(refused).toMatchObject({ outcome: "failed", finalState: "running" }); expect(f.effects).toEqual([]);
  } finally { await f.close(); }
});

test("临时文件中断恢复保留原清单，只恢复原运行状态；不会重做归档或永久删除", async () => {
  const f = await fixture();
  try {
    for (const action of ["tmp-purge", "tmp-reclaim", "tmp-discard"]) {
      const operation = maintenanceRequest(f.root, { command: action, label: "临时文件维护", intent: "service" });
      const lock = acquireDeploymentLock(f.root), store = new MaintenanceRecord(f.root, operation.id, () => lock.assertHeld());
      try {
        const cp = { version: 1 as const, request: operation, original: { ...f.facts, state: "running" as const, ready: true, pending: false }, phase: "prepared" as const };
        await store.checkpoint(cp); await store.checkpoint({ ...cp, phase: "acting" });
      } finally { lock.close(); }
      await writeFile(join(f.root, "data/untouched-plan.json"), "original item outcomes");
      f.facts.state = "stopped"; f.effects.length = 0;
      expect(await recoverMaintenance(f.options)).toMatchObject({ outcome: "success", finalState: "running" });
      expect(f.effects).toEqual(["start"]); expect(readOpsMaintenanceRecord(f.root)?.result?.outcome).toBe("failed");
      expect(await readFile(join(f.root, "data/untouched-plan.json"), "utf8")).toBe("original item outcomes");
    }
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "win32")("Windows 真实临时文件清单：在线预览、停机归档、按同一清单删除；固定代码和 Job 正常收尾", async () => {
  const f = await fixture(), repo = join(import.meta.dir, "../..");
  try {
    await symlink(join(repo, "node_modules"), join(f.root, "node_modules"), "junction");
    const member = join(f.root, "data/tmp/groups/g1/u1"); await mkdir(member, { recursive: true }); await writeFile(join(member, "sample.txt"), "synthetic content");
    const options = { ...f.options, source: repo };
    expect(await runTmp(tmpRequest("tmp-preview", ["--all"]), options)).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual([]);
    const plans = join(f.root, "data/state/reclamation/backup/rm/.tmp-plans");
    const id = (await readdir(plans)).find(file => /^[a-f0-9-]{36}\.json$/.test(file))!.slice(0, -5);
    const preview = await readTmpPlan(join(f.root, "data"), id);
    expect(await runTmp(tmpRequest("tmp-purge", ["--plan", id, "--digest", preview.digest]), options)).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual(["stop", "start"]); expect(await readdir(member)).toEqual([]);
    f.effects.length = 0;
    expect(await runTmp(tmpRequest("tmp-discard", []), options)).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual([]);
    const removalId = (await readdir(plans)).find(file => file.endsWith(".removal.json"))!.replace(".removal.json", "");
    const removal = await readRemovalPlan(join(f.root, "data"), removalId);
    expect(await runTmp(tmpRequest("tmp-discard", ["--plan", removalId, "--digest", removal.digest]), options)).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual(["stop", "start"]);
    expect(readOpsMaintenanceRecord(f.root)).toMatchObject({ writer: { kind: "windows-job", phase: "reaped" }, result: { outcome: "success" } });
  } finally { await f.close(); }
}, 60_000);
