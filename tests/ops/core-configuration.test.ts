import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { configurationRequest, runConfiguration } from "../../ops/core/configuration.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "../../ops/core/maintenance-host.ts";
import { runCore } from "../../ops/core/cli.ts";
import { MaintenanceRecord } from "../../ops/core/maintenance-record.ts";
import { acquireDeploymentLock } from "../../ops/core/deployment-lock.ts";
import { recoverMaintenance } from "../../ops/core/maintenance-recovery.ts";
import { ConfigurationDrafts } from "../../ops/core/configuration-drafts.ts";
import { applyConfiguration } from "../../ops/config/configuration-transaction.ts";
import { readConfigurationState, CONFIGURATION_STATE_FILE } from "../../src/core/configuration-state.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { applicationBinding } from "../../src/core/data-version.ts";
import { prepareConsoleDir } from "../../ops/core/console-state.ts";
import { configurationSnapshot } from "../../ops/config/configuration-form.ts";
import { serializeConfigurationStage } from "../../ops/config/configuration-stage.ts";
import { tempFixture } from "../helpers/temp.ts";

const repo = join(import.meta.dir, "../.."), id = "config-" + "a".repeat(32), digest = "b".repeat(64), secret = "synthetic-private-secret";
test("配置入口按动作拒绝多余、错拼、重复和不完整参数，不能误用默认值", async () => {
  expect(configurationRequest("configuration-apply", [id, "--digest", digest])).toEqual({ action: "apply", id, digest });
  expect(configurationRequest("configuration-restore", [id, "--expect", digest])).toEqual({ action: "restore", id, expect: digest });
  // A terminal wizard's stage: the kind comes from the file name the wizards write.
  expect(configurationRequest("configuration-apply", ["--stage", "stage/configuration-models.json"])).toEqual({ action: "apply", stage: resolve("stage/configuration-models.json") });
  for (const args of [["configuration-apply", "--stage", "stage/configuration-runtime.json"], ["configuration-apply", "--stage", "stage/models.json"],
    ["configuration-apply", "--stage", "stage/configuration-app.json", id], ["configuration-apply", "--stage", "stage/configuration-app.json", "--digest", digest],
    ["configuration-apply", "--stage"], ["configuration-restore", "--stage", "stage/configuration-app.json"]]) {
    expect(() => configurationRequest(args[0]!, args.slice(1))).toThrow();
    let executed = false;
    await expect(runCore(["maintenance", ...args, "--project", "."], { configuration: async () => { executed = true; throw new Error(); } })).rejects.toThrow();
    expect(executed).toBe(false);
  }
  for (const args of [["configuration-apply", id], ["configuration-apply", id, "--digests", digest], ["configuration-restore", id, "--digest", digest],
    ["configuration-apply", id, "--digest", digest, "--expect", digest], ["configuration-restore", id, "extra"],
    ["configuration-apply", id, "--digest", digest, "--digest", digest], ["configuration-restore", "../foreign"], ["constructor", id]]) {
    expect(() => configurationRequest(args[0]!, args.slice(1))).toThrow();
    let executed = false;
    await expect(runCore(["maintenance", ...args, "--project", "."], { configuration: async () => { executed = true; throw new Error(); } })).rejects.toThrow();
    expect(executed).toBe(false);
  }
});

async function fixture() {
  const f = await tempFixture("core-configuration-");
  for (const tree of ["console", "ops", "scripts", "src"]) { await mkdir(join(f.root, tree)); await writeFile(join(f.root, tree, "fixture.ts"), "export {};"); }
  await mkdir(join(f.root, "data/state"), { recursive: true });
  await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "fixture", transaction: "deploy-fixture", application: applicationBinding({ appId: "fixture", environment: "production" }) }));
  prepareConsoleDir(join(f.root, ".console"));
  const drafts = new ConfigurationDrafts(f.root), view = drafts.create("app", "test");
  drafts.edit(view.id, "test", 0, { appId: "fixture", environment: "production", secret: { mode: "set", value: secret } });
  const input = drafts.validationInput(view.id, "test", 1); drafts.validated(view.id, "test", 1, input.digest, ["通过"]);
  const prepared = drafts.prepare(view.id, "test"), selected = configurationRequest("configuration-apply", [view.id, "--digest", prepared.digest]);
  const facts = { identity: "a".repeat(64), owned: true, state: "running" as "running" | "stopped" };
  const effects: string[] = [], readiness = { okay: true, failFirst: false, starts: 0, stream: true, streamFailFirst: false };
  const ready = { service: "mixin-bot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ...ready, stream: readiness.stream ? { connected: true, reconnects: 0 }
    : { connected: false, reconnects: 0, lastDisconnect: { at: 1, reason: "换取 token 失败：HTTP 401 token=fixture-hidden" } } }, { status: readiness.okay ? 200 : 503 }) });
  await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
  const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 80, streamTimeoutMs: 80, verify: async () => {}, finish: async () => {}, output: () => {},
    platform: async () => ({ inspect: async () => facts, stop: async () => { effects.push("stop"); facts.state = "stopped"; },
      start: async () => { effects.push("start"); facts.state = "running"; const first = ++readiness.starts === 1;
        readiness.okay = !readiness.failFirst || !first; readiness.stream = !readiness.streamFailFirst || !first; } }) };
  return { ...f, facts, effects, readiness, options, drafts, selected, async close() { server.stop(true); await f.cleanup(); } };
}

test("配置核心：预检失败不停机，动作失败先恢复，就绪失败回退，确认完成后收尾", async () => {
  for (const failure of ["none", "check", "apply", "restore", "finish", "ready", "stream", "protocol"]) {
    const f = await fixture(), steps: string[] = [];
    try {
      if (failure === "ready") f.readiness.failFirst = true;
      // Wrong app credentials pass the format check and the bot's readiness, but never connect the Stream.
      if (failure === "stream") f.readiness.streamFailFirst = true;
      const result = await runConfiguration(f.selected, f.options, undefined, (options, operation) => {
        const context = createMaintenanceHost(options, operation);
        return { ...context, data: async step => {
          const action = step.args[0]!; steps.push(action);
          expect(() => acquireDeploymentLock(f.root)).toThrow();
          expect(step.currentCode).toBe(true); expect(step.args.join(" ")).not.toContain(secret);
          expect(JSON.stringify(readOpsMaintenanceRecord(f.root))).not.toContain(secret);
          expect(step.input !== undefined).toBe(["check", "apply"].includes(action));
          expect(f.facts.state).toBe(["check", "finish"].includes(action) ? "running" : "stopped");
          const failed = failure === action || failure === "restore" && action === "apply";
          return { code: failed ? 1 : 0, stdout: failure === "protocol" && action === "apply" ? "{" : JSON.stringify({
            protocol: "mixin-maintenance", version: 1, command: action, outcome: failed ? "failed" : "success", result: null }) };
        } };
      });
      expect(result.outcome, JSON.stringify(result)).toBe(failure === "none" ? "success" : failure === "check" ? "refused" : "failed");
      if (failure === "check") { expect(f.effects).toEqual([]); expect(steps).toEqual(["check"]); }
      else if (failure === "restore") { expect(f.facts.state).toBe("stopped"); expect(steps).toEqual(["check", "apply", "restore"]); }
      else {
        expect(f.facts.state).toBe("running"); expect(steps.at(-1)).toBe("finish");
        if (["apply", "ready", "stream", "protocol"].includes(failure)) expect(steps).toContain("restore");
        if (["ready", "stream"].includes(failure)) expect(f.effects).toEqual(["stop", "start", "stop", "start"]);
        if (failure === "stream") {
          expect(result.message).toContain("没有连上事件 Stream（换取 token 失败：HTTP 401 token=***）；恢复原配置");
          expect(result.finalState).toBe("running");
        }
      }
    } finally { await f.close(); }
  }
  // Each case checks the .console ACL through PowerShell on Windows, a few seconds apiece on a busy CI runner.
}, 120_000);

test.skipIf(process.platform !== "win32")("Windows 实际配置发布与健康失败回退：秘密只走输入管道，完成后删除恢复材料", async () => {
  for (const mode of ["running", "stopped", "ready-failed"]) {
    const f = await fixture();
    try {
      await symlink(join(repo, "node_modules"), join(f.root, "node_modules"), "junction");
      if (mode === "stopped") f.facts.state = "stopped";
      if (mode === "ready-failed") f.readiness.failFirst = true;
      const result = await runConfiguration(f.selected, { ...f.options, source: repo });
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: mode === "ready-failed" ? "failed" : "success", finalState: mode === "stopped" ? "stopped" : "running" });
      expect(readConfigurationState(f.root)).toBeNull();
      const file = Bun.file(join(f.root, "data/config/app-bot.json"));
      if (mode === "ready-failed") expect(await file.exists()).toBe(false); else expect(await file.text()).toContain(secret);
      expect(JSON.stringify(readOpsMaintenanceRecord(f.root))).not.toContain(secret);
      expect(readOpsMaintenanceRecord(f.root)?.writer?.phase).toBe("reaped");
    } finally { await f.close(); }
  }
}, 90_000);

// model-configure, configure-app-bot and relay-configure hand over the stage their wizard wrote; the core publishes it like a draft.
test.skipIf(process.platform !== "win32")("Windows 实际发布终端向导的暂存：与网页草稿同一流程；暂存损坏或基准已变时停机前拒绝", async () => {
  for (const mode of ["published", "corrupt", "changed"]) {
    const f = await fixture();
    try {
      await symlink(join(repo, "node_modules"), join(f.root, "node_modules"), "junction");
      const base = configurationSnapshot(f.root, "app"), stage = join(f.root, "tmp/configure-stage-fixture/configuration-app.json");
      await mkdir(join(stage, ".."), { recursive: true });
      await writeFile(stage, mode === "corrupt" ? "{" : serializeConfigurationStage({ version: 1, base,
        next: { ...base, files: { app: JSON.stringify({ environment: "production", appId: "fixture", appSecret: secret }, null, 2) + "\n" } } }));
      if (mode === "changed") { await mkdir(join(f.root, "data/config")); await writeFile(join(f.root, "data/config/app-bot.json"), "{}"); }
      const result = await runConfiguration(configurationRequest("configuration-apply", ["--stage", stage]), { ...f.options, source: repo });
      expect(result, JSON.stringify(result)).toMatchObject(mode === "published" ? { outcome: "success", finalState: "running" } : { outcome: "refused", finalState: "running" });
      expect(f.effects).toEqual(mode === "published" ? ["stop", "start"] : []);
      expect(readConfigurationState(f.root)).toBeNull();
      const file = Bun.file(join(f.root, "data/config/app-bot.json"));
      if (mode === "published") expect(await file.text()).toContain(secret);
      else expect(mode === "changed" ? await file.text() : await file.exists()).toBe(mode === "changed" ? "{}" : false);
      expect(JSON.stringify(readOpsMaintenanceRecord(f.root))).not.toContain(secret);
    } finally { await f.close(); }
  }
}, 45_000);

test.skipIf(process.platform !== "win32")("Windows 配置中断恢复：未提交回退，已提交只收尾，陌生值保留且不启动；无需原草稿", async () => {
  for (const mode of ["publishing", "ready", "committed", "foreign"]) {
    const f = await fixture();
    try {
      await symlink(join(repo, "node_modules"), join(f.root, "node_modules"), "junction");
      const operation = { ...maintenanceRequest(repo, { command: "configuration-apply", intent: "configuration", label: "应用配置" }), configuration: f.selected.id };
      const lock = acquireDeploymentLock(f.root), store = new MaintenanceRecord(f.root, operation.id, () => lock.assertHeld());
      try {
        const cp = { version: 1 as const, request: operation, original: { ...f.facts, ready: true, pending: false }, phase: "prepared" as const };
        await store.checkpoint(cp); await store.checkpoint({ ...cp, phase: "acting" });
      } finally { lock.close(); }
      const draft = f.drafts.read(f.selected.id!);
      await applyConfiguration(f.root, draft.id, draft.base, draft.next, async point => { if (mode === "publishing" && point === "prepared") throw new Error("synthetic crash"); }).catch(error => { if (mode !== "publishing") throw error; });
      if (mode === "committed") await writeFile(join(f.root, CONFIGURATION_STATE_FILE), JSON.stringify({ ...readConfigurationState(f.root), phase: "committed" }));
      const path = join(f.root, "data/config/app-bot.json");
      if (mode === "foreign") await writeFile(path, "{\"foreign\":true}");
      // No recovery action may need to reread the secret draft or repeat apply.
      await writeFile(f.drafts.path(draft.id), "unusable draft"); f.facts.state = "stopped";
      const result = await recoverMaintenance({ ...f.options, source: repo });
      if (mode === "foreign") {
        expect(result.outcome).toBe("failed"); expect(f.effects).toEqual([]); expect(await readFile(path, "utf8")).toBe("{\"foreign\":true}");
        expect(readConfigurationState(f.root)?.phase).toBe("restoring"); expect(readOpsMaintenanceRecord(f.root)?.result).toBeUndefined();
      } else {
        expect(result, JSON.stringify(result)).toMatchObject({ outcome: "success", finalState: "running" });
        expect(readConfigurationState(f.root)).toBeNull(); expect(f.effects).toEqual(["start"]);
        if (mode === "committed") expect(await readFile(path, "utf8")).toContain(secret); else expect(await Bun.file(path).exists()).toBe(false);
        expect(readOpsMaintenanceRecord(f.root)?.result?.outcome).toBe("failed");
      }
    } finally { await f.close(); }
  }
}, 60_000);
