import { expect, test } from "bun:test";
import { chmod, link, mkdir, readFile, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { runRuntime, runtimeRequest } from "../../ops/core/runtime-configure.ts";
import { captureRuntimeInput, removeRuntimeInput } from "../../ops/core/runtime-input.ts";
import { runtimeEnvironment, runtimeEnvironmentDigest } from "../../ops/core/runtime-environment.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "../../ops/core/maintenance-host.ts";
import { runCore } from "../../ops/core/cli.ts";
import { readRuntimeSettings, writeRuntimeDraft, sweepRuntimeDrafts } from "../../ops/config/runtime-draft.ts";
import { applyConfiguration } from "../../ops/config/configuration-transaction.ts";
import { configurationSnapshot } from "../../ops/config/configuration-form.ts";
import { readConfigurationState, CONFIGURATION_STATE_FILE } from "../../src/core/configuration-state.ts";
import { MaintenanceRecord } from "../../ops/core/maintenance-record.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { acquireDeploymentLock } from "../../ops/core/deployment-lock.ts";
import { recoverMaintenance } from "../../ops/core/maintenance-recovery.ts";
import { prepareConsoleDir } from "../../ops/core/console-state.ts";
import { tempFixture } from "../helpers/temp.ts";
import type { OpsRuntimeDraft } from "../../src/contracts/ops-runtime-draft.ts";

const repo = join(import.meta.dir, "../.."), name = ".runtime-draft-11111111-1111-1111-1111-111111111111.json", original = '{ "BOT_MAX_ACTIVE_REQUESTS": "32" }\n';
test("运行参数入口严格拒绝额外参数；仅选择原服务受支持的环境，不拷贝凭据", async () => {
  expect(runtimeRequest([name])).toBe(name);
  for (const args of [[], ["../foreign.json"], [name, "extra"], [name, "--digest", "a".repeat(64)]]) {
    expect(() => runtimeRequest(args)).toThrow(); let executed = false;
    await expect(runCore(["maintenance", "runtime-configure", ...args, "--project", "."], { runtime: async () => { executed = true; throw new Error(); } })).rejects.toThrow();
    expect(executed).toBe(false);
  }
  expect(runtimeEnvironment(["BOT_BASH_TIMEOUT=120", "BOT_DOCUMENT_WORK_ENABLED=0", "API_KEY=private-credential", "BOT_HOST=0.0.0.0"]))
    .toEqual(["BOT_BASH_TIMEOUT=120", "BOT_DOCUMENT_WORK_ENABLED=0"]);
  expect(() => runtimeEnvironment(["BOT_BASH_TIMEOUT=120", "BOT_BASH_TIMEOUT=30"])).toThrow();
  expect(runtimeEnvironmentDigest(["BOT_BASH_TIMEOUT=120"])).not.toContain("120");
});

async function fixture() {
  const f = await tempFixture("core-runtime-");
  for (const tree of ["console", "ops", "scripts", "src"]) { await mkdir(join(f.root, tree)); await writeFile(join(f.root, tree, "fixture.ts"), "export {};"); }
  for (const dir of ["data/config", "data/state"]) await mkdir(join(f.root, dir), { recursive: true });
  await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
  const config = join(f.root, "data/config/runtime.json"); await writeFile(config, original);
  const draft = await writeRuntimeDraft(await readRuntimeSettings(config), { BOT_MAX_ACTIVE_REQUESTS: "64" }, config);
  prepareConsoleDir(join(f.root, ".console"));
  const effects: string[] = [], facts = { identity: "a".repeat(64), owned: true, state: "running" as "running" | "stopped" | "absent" | "unsupported" };
  const ready = { service: "mixin-bot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const readiness = { failFirst: false, okay: true, starts: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(ready, { status: readiness.okay ? 200 : 503 }) });
  await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
  const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 80, verify: async () => {}, finish: async () => {}, output: () => {},
    platform: async () => ({ inspect: async () => facts, stop: async () => { effects.push("stop"); facts.state = "stopped"; },
      start: async () => { effects.push("start"); facts.state = "running"; readiness.okay = !readiness.failFirst || ++readiness.starts > 1; } }) };
  return { ...f, options, draft, config, facts, readiness, effects, async close() { server.stop(true); await f.cleanup(); } };
}

test("无效运行参数草稿不把键名或 JSON 片段带入错误，不保存接单身份或删除输入", async () => {
  const f = await tempFixture("core-runtime-invalid-");
  const directory = join(f.root, "data/config"), draft = join(directory, name);
  const secret = "private-credential-秘密";
  try {
    await mkdir(directory, { recursive: true });
    for (const bytes of [secret, JSON.stringify({ expectedHash: null, changes: { [secret]: "1" } }),
      JSON.stringify({ expectedHash: null, changes: { BOT_MAX_ACTIVE_REQUESTS: secret } })]) {
      await writeFile(draft, bytes, { mode: 0o600 });
      const records: OpsRuntimeDraft[] = [];
      await expect(captureRuntimeInput(f.root, name, async value => { records.push(value); }))
        .rejects.toThrow("运行参数草稿无效，请重新打开设置");
      expect(records).toEqual([]);
      expect(await readFile(draft, "utf8")).toBe(bytes);
    }
  } finally { await f.cleanup(); }
});

test("草稿先记身份与摘要，未知文件、链接及修改后的输入不会被清理", async () => {
  for (const mode of ["normal", "modified", "replaced", "hardlink", "world-readable"]) {
    if (mode === "world-readable" && process.platform === "win32") continue;
    const f = await fixture(), records: OpsRuntimeDraft[] = [];
    try {
      const save = async (value: OpsRuntimeDraft) => { records.push(value); };
      if (mode === "hardlink") await link(f.draft, f.draft + ".foreign");
      if (mode === "world-readable") await chmod(f.draft, 0o644);
      if (["hardlink", "world-readable"].includes(mode)) {
        await expect(captureRuntimeInput(f.root, basename(f.draft), save)).rejects.toThrow(); expect(records).toEqual([]); continue;
      }
      const value = await captureRuntimeInput(f.root, basename(f.draft), save);
      expect(JSON.parse(Buffer.from(value.input).toString()).changes).toEqual({ BOT_MAX_ACTIVE_REQUESTS: "64" });
      if (mode === "modified") await writeFile(f.draft, "modified");
      if (mode === "replaced") { await rename(f.draft, f.draft + ".original"); await writeFile(f.draft, value.input, { mode: 0o600 }); }
      if (mode !== "normal") {
        await expect(removeRuntimeInput(f.root, records[0]!, "config-" + "c".repeat(32), save)).rejects.toThrow(); expect(await Bun.file(f.draft).exists()).toBe(true);
      } else {
        await removeRuntimeInput(f.root, records[0]!, "config-" + "c".repeat(32), save); expect(await Bun.file(f.draft).exists()).toBe(false); expect(records.at(-1)?.phase).toBe("removed");
      }
    } finally { await f.close(); }
  }
});

test.skipIf(process.platform !== "win32")("运行参数实际发布：运行/停止/缺实例、显式环境冲突、就绪失败与外来写入", async () => {
  for (const mode of ["running", "stopped", "absent", "env", "ready", "foreign"]) {
    const f = await fixture();
    try {
      await symlink(join(repo, "node_modules"), join(f.root, "node_modules"), "junction");
      if (mode === "stopped" || mode === "absent") f.facts.state = mode;
      if (mode === "ready" || mode === "foreign") f.readiness.failFirst = true;
      const result = await runRuntime(basename(f.draft), { ...f.options, source: repo }, undefined, (options, operation) => {
        const context = createMaintenanceHost(options, operation);
        return { ...context, data: async (step, signal) => {
          if (mode === "env" && step.script.endsWith("runtime-apply.ts")) {
            const { runNative } = await import("../../ops/core/native-process.ts");
            return runNative({ command: process.execPath, args: ["--no-env-file", join(repo, step.script), ...step.args], cwd: f.root, protocol: true,
              input: step.input, env: { ...process.env, BOT_MAX_ACTIVE_REQUESTS: "8" } }, () => {});
          }
          if (mode === "foreign" && step.args[0] === "restore") await writeFile(f.config, '{"BOT_MAX_ACTIVE_REQUESTS":"99"}');
          return context.data(step, signal);
        } };
      });
      const success = ["running", "stopped", "absent"].includes(mode);
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: success ? "success" : mode === "env" ? "refused" : "failed",
        finalState: ["stopped", "absent", "foreign"].includes(mode) ? "stopped" : "running" });
      if (success) expect((await readRuntimeSettings(f.config)).values.BOT_MAX_ACTIVE_REQUESTS).toBe("64");
      else if (mode === "foreign") expect((await readRuntimeSettings(f.config)).values.BOT_MAX_ACTIVE_REQUESTS).toBe("99");
      else expect(await readFile(f.config, "utf8")).toBe(original);
      if (mode === "env") expect(f.effects).toEqual([]);
      expect(readConfigurationState(f.root)?.phase).toBe(mode === "foreign" ? "restoring" : undefined);
      expect(await Bun.file(f.draft).exists()).toBe(mode === "foreign");
      if (mode === "foreign") {
        // Even a day-old draft stays while the unfinished maintenance record owns it.
        const old = new Date(Date.now() - 25 * 3600_000); await utimes(f.draft, old, old);
        await sweepRuntimeDrafts(f.config); expect(await Bun.file(f.draft).exists()).toBe(true); expect(readOpsMaintenanceRecord(f.root)?.result).toBeUndefined();
      }
    } finally { await f.close(); }
  }
}, 70_000);

test.skipIf(process.platform !== "win32")("运行参数强制中断后复用配置恢复：准备、发布、提交三阶段；输入清理按已记录归属", async () => {
  for (const mode of ["prepared", "ready", "committed"]) {
    const f = await fixture();
    try {
      await symlink(join(repo, "node_modules"), join(f.root, "node_modules"), "junction");
      const operation = maintenanceRequest(repo, { command: "runtime-configure", intent: "configuration", label: "运行参数" }); operation.configuration = "config-" + operation.id;
      const lock = acquireDeploymentLock(f.root), store = new MaintenanceRecord(f.root, operation.id, () => lock.assertHeld());
      try {
        const checkpoint = { version: 1 as const, request: operation, original: { ...f.facts, state: "running" as const, pending: false, ready: true }, phase: "prepared" as const };
        await store.checkpoint(checkpoint); await captureRuntimeInput(f.root, basename(f.draft), value => store.runtimeDraft(value));
        await store.checkpoint({ ...checkpoint, phase: "acting" });
      } finally { lock.close(); }
      if (mode !== "prepared") {
        const base = configurationSnapshot(f.root, "runtime");
        await applyConfiguration(f.root, operation.configuration, base, { ...base, files: { runtime: '{"BOT_MAX_ACTIVE_REQUESTS":"64"}' } });
        if (mode === "committed") await writeFile(join(f.root, CONFIGURATION_STATE_FILE), JSON.stringify({ ...readConfigurationState(f.root), phase: "committed" }));
      }
      f.facts.state = "stopped";
      expect(await recoverMaintenance({ ...f.options, source: repo })).toMatchObject({ outcome: "success", finalState: "running" });
      expect((await readRuntimeSettings(f.config)).values.BOT_MAX_ACTIVE_REQUESTS).toBe(mode === "committed" ? "64" : "32");
      expect(await Bun.file(f.draft).exists()).toBe(false); expect(readConfigurationState(f.root)).toBeNull();
      expect(readOpsMaintenanceRecord(f.root)).toMatchObject({ runtimeDraft: { phase: "removed" }, result: { outcome: "failed" } });
    } finally { await f.close(); }
  }
}, 45_000);
