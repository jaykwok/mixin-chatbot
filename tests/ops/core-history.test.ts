import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { historyRequest, runHistory } from "../../scripts/ops/core/history.ts";
import { runCore } from "../../scripts/ops/core/cli.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { recoverMaintenance } from "../../scripts/ops/core/maintenance-recovery.ts";
import { maintenanceRequest, type MaintenanceHostOptions } from "../../scripts/ops/core/maintenance-host.ts";
import { MaintenanceRecord } from "../../scripts/ops/core/maintenance-record.ts";
import { acquireDeploymentLock } from "../../scripts/ops/core/deployment-lock.ts";
import { tempFixture } from "../helpers/temp.ts";
import { freezeRuntime } from "../../scripts/ops/console/runtime.ts";
import { prepareConsoleDir, consoleDir } from "../../scripts/ops/console/state.ts";
import { operationScope } from "../../scripts/ops/console/operations.ts";

test("会话维护在停机前严格校验范围；CLI 不吞拼错参数，也不隐式变成全部空间", async () => {
  expect(historyRequest("history-clear", ["--all"])).toEqual({ action: "history-clear", args: ["--all"] });
  expect(historyRequest("history-compact", ["--direct", "+123456789", "--expect", "f".repeat(64)])).toEqual({
    action: "history-compact", args: ["--direct", "+123456789"], expected: "f".repeat(64) });
  for (const [action, ...args] of [["history-clear"], ["history-clear", "--al"], ["history-clear", "--all", "g1"], ["history-clear", "--direct", "--group-id"],
    ["history-clear", "g1", "--group-id", "--storage-segment"], ["history-clear", "g1", "--expect", "x"], ["history-compact", "--all", "12345"],
    ["history-compact", "--direct"], ["history-clear", "--direct", "--direct"], ["history-compact", "g1", "12345", "more"]]) {
    expect(() => historyRequest(action!, args)).toThrow();
    let executed = false;
    await expect(runCore(["maintenance", action!, ...args, "--project", "."], { history: async () => { executed = true; throw new Error("should not run"); } })).rejects.toThrow();
    expect(executed).toBe(false);
  }
});

async function fixture() {
  const f = await tempFixture("core-history-");
  for (const dir of ["scripts/ops", "src", "ui", "data/state"]) await mkdir(join(f.root, dir), { recursive: true });
  await writeFile(join(f.root, "src/fixture.ts"), "export {};\n"); await writeFile(join(f.root, "ui/fixture.ts"), "export {};\n");
  await writeFile(join(f.root, "scripts/ops/history-admin.ts"), `import {writeFileSync} from "node:fs";
writeFileSync("data/action.json",JSON.stringify(process.argv.slice(2))); console.log("会话维护合成步骤完成");`);
  await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 1, appVersion: "1.0.1", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
  const body = { service: "mixin-chatbot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body) });
  await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...body, port: server.port }));
  const facts = { identity: "a".repeat(64), state: "running" as "running" | "stopped", owned: true }, effects: string[] = [];
  const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 100,
    verify: async () => { expect(() => acquireDeploymentLock(f.root)).toThrow(); },
    finish: async () => { expect(() => acquireDeploymentLock(f.root)).toThrow(); }, output: () => {},
    platform: async () => ({ inspect: async () => facts, start: async () => { effects.push("start"); facts.state = "running"; },
      stop: async () => { effects.push("stop"); facts.state = "stopped"; } }),
  };
  return { ...f, facts, effects, options, async close() { server.stop(true); await f.cleanup(); } };
}

test.skipIf(process.platform !== "win32")("Windows 会话维护实际接共享锁、固定运行包、Job 和恢复记录，执行后恢复原运行状态", async () => {
  const f = await fixture();
  try {
    const result = await runHistory(historyRequest("history-clear", ["--direct"]), f.options);
    expect(result).toMatchObject({ outcome: "success", wasRunning: true, finalState: "running" });
    expect(f.effects).toEqual(["stop", "start"]);
    expect(JSON.parse(await readFile(join(f.root, "data/action.json"), "utf8"))).toEqual(["clear", "--direct"]);
    expect(readOpsMaintenanceRecord(f.root)).toMatchObject({ checkpoint: { phase: "starting" }, writer: { kind: "windows-job", phase: "reaped" }, result: { outcome: "success" } });
    f.facts.state = "stopped"; f.effects.length = 0;
    const compact = await runHistory(historyRequest("history-compact", ["--direct", "+123456789"]), f.options);
    expect(compact).toMatchObject({ outcome: "success", wasRunning: false, finalState: "stopped" }); expect(f.effects).toEqual([]);
    expect(JSON.parse(await readFile(join(f.root, "data/action.json"), "utf8"))).toEqual(["compact", "--direct", "+123456789"]);
    expect(JSON.stringify(readOpsMaintenanceRecord(f.root))).not.toContain("123456789");
  } finally { await f.close(); }
}, 30_000);

test("中断恢复只恢复运行状态，不重跑原数据动作；版本或身份变化时保留记录", async () => {
  const f = await fixture();
  try {
    const request = maintenanceRequest(f.root, { command: "history-clear", intent: "conversation-write", label: "清空会话" });
    const lock = acquireDeploymentLock(f.root), record = new MaintenanceRecord(f.root, request.id, () => lock.assertHeld());
    try {
      const checkpoint = { version: 1 as const, request, phase: "prepared" as const, original: { ...f.facts, ready: true, pending: false } };
      await record.checkpoint(checkpoint); await record.checkpoint({ ...checkpoint, phase: "acting" });
    } finally { lock.close(); }
    f.facts.state = "stopped";
    const preview = await operationScope(f.root, "maintenance-recover", {});
    expect(preview.summary.join()).toContain("不重复原数据操作");
    expect(preview.summary.join()).not.toContain(request.id);
    const same = f.facts.identity; f.facts.identity = "b".repeat(64);
    expect((await recoverMaintenance(f.options)).outcome).toBe("refused"); expect(readOpsMaintenanceRecord(f.root)?.result).toBeUndefined(); expect(f.effects).toEqual([]);
    f.facts.identity = same;
    await writeFile(join(f.root, "src/fixture.ts"), "export const changed = true;\n");
    expect((await recoverMaintenance(f.options)).message).toContain("原固定版本"); expect(f.effects).toEqual([]);
    await writeFile(join(f.root, "src/fixture.ts"), "export {};\n");
    expect(await recoverMaintenance(f.options)).toMatchObject({ outcome: "success", wasRunning: true, finalState: "running" });
    expect(f.effects).toEqual(["start"]); expect(readOpsMaintenanceRecord(f.root)?.result?.outcome).toBe("failed");
    await expect(operationScope(f.root, "maintenance-recover", {})).rejects.toThrow("没有需要恢复");
    await expect(readFile(join(f.root, "data/action.json"))).rejects.toThrow();
    await recoverMaintenance(f.options); expect(f.effects).toEqual(["start"]);
  } finally { await f.close(); }
}, 15_000);

test("维护期间代码变化后，恢复按磁盘记录选择原固定运行包", async () => {
  const f = await fixture(), repo = join(import.meta.dir, "../..");
  try {
    prepareConsoleDir(consoleDir(f.root));
    const pinned = freezeRuntime(consoleDir(f.root), repo);
    const request = maintenanceRequest(repo, { command: "history-clear", intent: "conversation-write", label: "清空会话" });
    expect(request.runtime).toBe(pinned.digest);
    const lock = acquireDeploymentLock(f.root), record = new MaintenanceRecord(f.root, request.id, () => lock.assertHeld());
    try {
      await record.checkpoint({ version: 1, request, phase: "prepared", original: { ...f.facts, ready: true, pending: false } });
    } finally { lock.close(); }
    f.facts.state = "stopped";
    // The fixture's current tree is deliberately different from the real, complete original package.
    expect(await recoverMaintenance(f.options)).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.effects).toEqual(["start"]); expect(readOpsMaintenanceRecord(f.root)?.result?.outcome).toBe("failed");
  } finally { await f.close(); }
}, 30_000);
