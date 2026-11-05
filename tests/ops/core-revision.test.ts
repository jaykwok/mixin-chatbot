import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { runCore } from "../../scripts/ops/core/cli.ts";
import { maintenanceResult as revisionResult } from "../../scripts/ops/core/data-result.ts";
import { revisionRequest, runRevision } from "../../scripts/ops/core/revision.ts";
import { createMaintenanceHost, maintenanceRequest, type DataStep, type MaintenanceHostOptions } from "../../scripts/ops/core/maintenance-host.ts";
import { MaintenanceRecord } from "../../scripts/ops/core/maintenance-record.ts";
import { acquireDeploymentLock } from "../../scripts/ops/core/deployment-lock.ts";
import { recoverMaintenance } from "../../scripts/ops/core/maintenance-recovery.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { readJournal } from "../../src/durable/revision-cleanup/journal.ts";
import { writeLongChains, chainState } from "../helpers/revision-chains.ts";
import { tempFixture } from "../helpers/temp.ts";

const response = (action: string, code = 0, result: unknown = null) => ({ code, stderr: "", stdout: JSON.stringify({
  protocol: "mixin-maintenance", version: 1, command: action,
  outcome: code === 0 ? "success" : code === 3 ? "stopped" : code === 4 ? "not-enough-space" : "refused", result,
}) });

test("修订核心和 CLI 严格区分各动作参数，拼错选择不会变成全部库，只有 shrink 允许多个 --space", async () => {
  const selected = ["--space", "direct", "--space", "groups/g1"];
  expect(revisionRequest("shrink", selected)).toEqual({ action: "shrink", args: selected, intent: "shrink" });
  const accepted = await runCore(["revision-cleanup", "shrink", "--project", ".", ...selected, "--json"], {
    revision: async input => {
      expect(input).toEqual(revisionRequest("shrink", selected));
      return { protocol: "mixin-ops", version: 1, command: "revision-cleanup", outcome: "success", exitCode: 0, wasRunning: false, finalState: "stopped", message: "fixture" };
    },
  });
  expect(accepted.json).toBe(true);
  for (const args of [["apply", "--no-backup"], ["shrink", "--spaces", "groups/g1"], ["skip", "--space", "direct"],
    ["restore"], ["restore", ...selected], ["shrink", "--space", "../direct"], ["shrink", "--space", "groups/../direct"],
    ["apply", "--project", "different"], ["apply", "--transaction", "a", "--transaction", "b"], ["shrunk"], ["preview"],
    ["shrink", "--yes"], ["apply", "--shell"], ["apply", "--expect", "f".repeat(64)], ["apply", "--all"]]) {
    expect(() => revisionRequest(args[0]!, args.slice(1)), args.join(" ")).toThrow();
    let called = false;
    await expect(runCore(["revision-cleanup", ...args, "--project", "."], { revision: async () => { called = true; throw new Error("unexpected"); } })).rejects.toThrow();
    expect(called).toBe(false);
  }
  for (const args of [["maintenance", "history-clear", "--all", "--space", "direct"], ["service", "start", "--transaction", "x"]]) {
    await expect(runCore([...args, "--project", "."])).rejects.toThrow();
  }
});

test("修订工具协议与真实退出码必须一致；截断、未知版本、错误动作、成功却缺结果均失败", () => {
  expect(revisionResult(response("skip"), "skip")).toEqual({ code: 0, data: null });
  expect(revisionResult(response("shrink", 3), "shrink").code).toBe(3);
  for (const change of [{ stdout: "" }, { stdout: "{}" }, { code: 3 },
    { stdout: response("apply").stdout }, { stdout: response("skip").stdout.replace('"version":1', '"version":2') },
    { stdout: response("skip").stdout.replace(',"result":null', "") }, { stdout: response("skip", 1).stdout }]) {
    expect(() => revisionResult({ ...response("skip"), ...change }, "skip")).toThrow();
  }
});

async function fixture() {
  const f = await tempFixture("core-revision-");
  for (const dir of ["scripts", "src", "ui", "data/state"]) await mkdir(join(f.root, dir), { recursive: true });
  for (const dir of ["scripts", "src", "ui"]) await writeFile(join(f.root, dir, "fixture.ts"), "export {};\n");
  await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 1, appVersion: "1.0.1", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
  const ready = { service: "mixin-chatbot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  let healthy = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ...ready, status: healthy ? "ready" : "starting" }) });
  await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
  const facts = { identity: "a".repeat(64), state: "running" as "running" | "stopped", owned: true }, events: string[] = [];
  const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 25, output: () => {},
    verify: async () => { expect(() => acquireDeploymentLock(f.root)).toThrow(); }, finish: async () => {},
    platform: async () => ({ inspect: async () => facts, start: async () => { events.push("start"); facts.state = "running"; },
      stop: async () => { events.push("stop"); facts.state = "stopped"; } }),
  };
  const run = (action: string, args: string[] = [], step?: (action: string, input: DataStep) => Promise<ReturnType<typeof response>>) =>
    runRevision(revisionRequest(action, args), options, undefined, (options, request) => {
      const context = createMaintenanceHost(options, request);
      return { ...context, async data(input) {
        expect(() => acquireDeploymentLock(f.root)).toThrow();
        const action = input.args[0]!;
        expect(readOpsMaintenanceRecord(f.root)?.checkpoint.phase).toBe(input.readOnly ? "prepared" : "acting");
        expect(facts.state).toBe(input.readOnly ? "running" : "stopped");
        expect(input.protocol).toBe(true); expect(input.args.slice(-1)).toEqual(["--json"]);
        events.push("data:" + action);
        if (step) return step(action, input);
        return response(action, 0, action === "preview" ? { backupBytes: 123, walBytes: 45 } : null);
      } };
    });
  return { ...f, facts, events, options, run, unhealthy: () => { healthy = false; }, async close() { server.stop(true); await f.cleanup(); } };
}

test("整理预览和空间检查都在停机前；成功后按真实就绪恢复，备份目录和结果已持久记录", async () => {
  const f = await fixture();
  try {
    const result = await f.run("apply", [], async (action, input) => {
      if (action === "space") expect(input.args).toEqual(["space", "--project", f.root, "--backup-bytes", "123", "--wal-bytes", "45", "--json"]);
      return response(action, 0, action === "preview" ? { backupBytes: 123, walBytes: 45 } : null);
    });
    expect(result).toMatchObject({ outcome: "success", exitCode: 0, wasRunning: true, finalState: "running" });
    expect(f.events).toEqual(["data:preview", "data:space", "stop", "data:apply", "start"]);
    expect(readOpsMaintenanceRecord(f.root)?.result).toEqual(result);
  } finally { await f.close(); }
});

test("空间不足在停机前拒绝并保持退出码 4，不自动跳过、不执行整理", async () => {
  const f = await fixture();
  try {
    expect(await f.run("apply", [], async action => response(action, action === "space" ? 4 : 0,
      action === "preview" ? { backupBytes: 123, walBytes: 45 } : null))).toMatchObject({ outcome: "refused", exitCode: 4, finalState: "running" });
    expect(f.events).toEqual(["data:preview", "data:space"]);
    expect(readOpsMaintenanceRecord(f.root)?.result?.message).toContain("显式跳过");
  } finally { await f.close(); }
});

test.each(["skip", "abandon", "shrink"])("%s 失败但磁盘状态允许时恢复原运行状态，失败退出码不改成成功", async action => {
  const f = await fixture();
  try {
    expect(await f.run(action, [], async action => response(action, 3))).toMatchObject({ outcome: "failed", exitCode: 3, finalState: "running" });
    expect(f.events).toEqual(["stop", "data:" + action, "start"]);
  } finally { await f.close(); }
});

test("动作报告成功但新写入的维护日志损坏时不启动；只发启动请求未就绪也不能报告成功", async () => {
  for (const mode of ["blocked", "not-ready"] as const) {
    const f = await fixture();
    try {
      const result = await f.run("shrink", [], async action => {
        if (mode === "blocked") await writeFile(join(f.root, "data/state/revision-cleanup.json"), "{}");
        else f.unhealthy();
        return response(action);
      });
      expect(result.outcome).toBe("failed"); expect(result.exitCode).not.toBe(0);
      expect(result.finalState).toBe(mode === "blocked" ? "stopped" : "start-requested");
      expect(f.events.includes("start")).toBe(mode === "not-ready");
    } finally { await f.close(); }
  }
});

test("运行中无恢复事项时拒绝 restore，整理预检读不到状态时也不停止机器人", async () => {
  for (const mode of ["restore", "unreadable"] as const) {
    const f = await fixture();
    try {
      if (mode === "unreadable") await writeFile(join(f.root, "data/state/revision-cleanup.json"), "{}");
      const result = await f.run(mode === "restore" ? "restore" : "skip", mode === "restore" ? ["--space", "direct"] : []);
      expect(result).toMatchObject({ outcome: "refused", finalState: "running" });
      expect(f.events).toEqual([]);
    } finally { await f.close(); }
  }
});

test("未完成部署、陌生身份或备份链接在停机前拒绝；原来停止时整理后仍停止", async () => {
  for (const mode of ["transaction", "foreign", "stopped", ...(process.platform === "win32" ? [] : ["link"])]) {
    const f = await fixture();
    try {
      if (mode === "transaction") await writeFile(join(f.root, "data/state/deploy-transaction"), "deploy-fixture\n");
      if (mode === "foreign") f.facts.owned = false;
      if (mode === "link") {
        await mkdir(join(f.root, "backup")); await mkdir(join(f.root, "elsewhere"));
        await symlink(join(f.root, "elsewhere"), join(f.root, "backup/revision-cleanup"));
      }
      if (mode === "stopped") f.facts.state = "stopped";
      // skip has no read-only preflight and is valid when there is no cleanup journal.
      const result = await f.run("skip");
      expect(result.outcome, mode).toBe(mode === "stopped" ? "success" : "refused");
      expect(f.events, mode).toEqual(mode === "stopped" ? ["data:skip"] : []);
      expect(result.finalState, mode).toBe(mode === "foreign" ? "unknown" : mode === "stopped" ? "stopped" : "running");
    } finally { await f.close(); }
  }
});

test("修订维护中断后只收尾宿主；磁盘日志阻止启动时保留数据阻止项，允许之后显式续做", async () => {
  const f = await fixture();
  try {
    const request = maintenanceRequest(f.root, { command: "revision-cleanup", intent: "cleanup", label: "revision-cleanup apply" });
    const lock = acquireDeploymentLock(f.root), record = new MaintenanceRecord(f.root, request.id, () => lock.assertHeld());
    try {
      await record.checkpoint({ version: 1, request, phase: "prepared", original: { ...f.facts, ready: true, pending: false } });
    } finally { lock.close(); }
    f.facts.state = "stopped";
    await writeFile(join(f.root, "data/state/revision-cleanup.json"), "{}");
    expect(await recoverMaintenance(f.options)).toMatchObject({ outcome: "failed", wasRunning: true, finalState: "stopped" });
    expect(f.events).toEqual([]);
    expect(readOpsMaintenanceRecord(f.root)?.result?.outcome).toBe("failed");
    expect(await readFile(join(f.root, "data/state/revision-cleanup.json"), "utf8")).toBe("{}");
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "win32")("Windows 核心实际运行冻结版本的整理工具：预检、空间、备份、值不变和 Job 收尾", async () => {
  const f = await fixture(), repo = join(import.meta.dir, "../..");
  try {
    await symlink(join(repo, "node_modules"), join(f.root, "node_modules"), "junction");
    const file = join(f.root, "data/conversations/direct/durable.sqlite");
    await writeLongChains(file, 70);
    const read = () => { const db = new Database(file, { readonly: true }); try { return chainState(db); } finally { db.close(); } };
    const before = read();
    const result = await runRevision(revisionRequest("apply", []), { ...f.options, source: repo });
    expect(result).toMatchObject({ outcome: "success", exitCode: 0, wasRunning: true, finalState: "running" });
    expect(f.events).toEqual(["stop", "start"]);
    const after = read(); expect(after.values).toEqual(before.values);
    expect(Object.values(after.chains).filter(count => count === 1).length).toBeGreaterThan(1);
    expect(readJournal(join(f.root, "data"))?.state).toBe("finished");
    expect(readOpsMaintenanceRecord(f.root)).toMatchObject({ writer: { kind: "windows-job", phase: "reaped" }, result: { outcome: "success" } });
    f.facts.state = "stopped"; f.events.length = 0;
    expect(await runRevision(revisionRequest("apply", []), { ...f.options, source: repo })).toMatchObject({ outcome: "success", finalState: "stopped", wasRunning: false });
    expect(f.events).toEqual([]); expect(read().values).toEqual(before.values);
  } finally { await f.close(); }
}, 45_000);
