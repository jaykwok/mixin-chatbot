import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runRuntime } from "../../ops/core/runtime-configure.ts";
import { createMaintenanceHost, type MaintenanceHostOptions } from "../../ops/core/maintenance-host.ts";
import { acquireDeploymentLock, type DeploymentLock } from "../../ops/core/deployment-lock.ts";
import { configurationSnapshot } from "../../ops/config/configuration-form.ts";
import { applyConfiguration, restoreConfiguration, finishConfiguration } from "../../ops/config/configuration-transaction.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { prepareConsoleDir } from "../../ops/core/console-state.ts";
import { nextRuntimeDraft, readRuntimeSettings, writeRuntimeDraft } from "../../ops/config/runtime-draft.ts";
import { tempFixture } from "../helpers/temp.ts";

// All prior Shell/PowerShell lifecycle cases now exercise the one host policy. Thin-wrapper argv/exit codes are
// checked separately in core-wrapper; actual runtime commands and native writer recovery are in core-runtime.
test("共用运行参数窗口：预检后停机，保留原状态，拒绝陌生/前台实例，失败恢复配置与服务", async () => {
  for (const scenario of ["running", "stopped", "missing", "precheck-fail", "apply-fail", "stop-fail", "health-fail", "rollback-fail",
    "foreign", "guarded", "locked", "foreground", "foreground-task", "paused"]) {
    const f = await tempFixture("runtime-window-" + scenario + "-");
    let server: ReturnType<typeof Bun.serve> | undefined, lock: DeploymentLock | undefined;
    try {
      for (const tree of ["console", "ops", "scripts", "src"]) { await mkdir(join(f.root, tree)); await writeFile(join(f.root, tree, "fixture.ts"), "export {};"); }
      for (const dir of ["data/state", "data/config"]) await mkdir(join(f.root, dir), { recursive: true });
      await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
      prepareConsoleDir(join(f.root, ".console"));
      const config = join(f.root, "data/config/runtime.json"), original = '{ "BOT_MAX_ACTIVE_REQUESTS": "32" }\n';
      await writeFile(config, original);
      const draft = await writeRuntimeDraft(await readRuntimeSettings(config), { BOT_MAX_ACTIVE_REQUESTS: "64" }, config);
      const initial = scenario === "stopped" ? "stopped" : scenario === "missing" ? "absent" : ["foreground", "foreground-task", "paused"].includes(scenario) ? "unsupported" : "running";
      let state: "running" | "stopped" | "absent" | "unsupported" = initial;
      let current = original, starts = 0; const events: string[] = [];
      const ready = { service: "mixin-bot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(ready, { status: starts === 1 && ["health-fail", "rollback-fail"].includes(scenario) ? 503 : 200 }) });
      await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
      if (scenario === "guarded") await writeFile(join(f.root, "data/state/deploy-transaction"), "fixture\n");
      if (scenario === "locked") lock = acquireDeploymentLock(f.root);
      const options: MaintenanceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 50, verify: async () => {}, finish: async () => {},
        platform: async () => ({ inspect: async () => ({ identity: "a".repeat(64), owned: scenario !== "foreign", state }),
          stop: async () => { events.push("stop"); if (scenario === "stop-fail") throw new Error("stop failed"); state = "stopped"; },
          start: async () => { events.push("start"); starts++; state = "running"; } }) };
      const result = await runRuntime(basename(draft), options, undefined, (options, operation) => {
        const context = createMaintenanceHost(options, operation);
        return { ...context, data: async step => {
          const action = step.args[0]!; let code = 0; events.push(action + ":" + state);
          if (action === "check") { if (scenario === "precheck-fail") code = 1; }
          else if (action === "apply") {
            const base = configurationSnapshot(f.root, "runtime");
            current = nextRuntimeDraft(base.files.runtime!, JSON.parse(Buffer.from(step.input!).toString()), {});
            await applyConfiguration(f.root, operation.configuration!, base, { ...base, files: { runtime: current } });
            if (scenario === "apply-fail") code = 1;
          } else if (action === "restore") {
            if (scenario === "rollback-fail") code = 1;
            else { await restoreConfiguration(f.root, operation.configuration!); current = original; }
          } else if (action === "finish") await finishConfiguration(f.root, operation.configuration!);
          else throw new Error("unexpected data step");
          return { code, stdout: JSON.stringify({ protocol: "mixin-maintenance", version: 1, command: action, outcome: code ? "failed" : "success", result: null }) };
        } };
      });
      const success = ["running", "stopped", "missing"].includes(scenario), early = ["foreign", "guarded", "locked", "foreground", "foreground-task", "paused"].includes(scenario);
      expect(result.outcome, scenario + JSON.stringify(result)).toBe(success ? "success" : early || scenario === "precheck-fail" ? "refused" : "failed");
      expect(result.exitCode, scenario).toBe(success ? 0 : 1);
      const expected = early ? [] : scenario === "precheck-fail" ? ["check:running"]
        : scenario === "stop-fail" ? ["check:running", "stop", "start"]
        : ["stopped", "missing"].includes(scenario) ? [`check:${initial}`, `apply:${initial}`, `finish:${initial}`]
        : scenario === "apply-fail" ? ["check:running", "stop", "apply:stopped", "restore:stopped", "start", "finish:running"]
        : ["health-fail", "rollback-fail"].includes(scenario) ? ["check:running", "stop", "apply:stopped", "start", "stop", "restore:stopped", ...(scenario === "health-fail" ? ["start", "finish:running"] : [])]
        : ["check:running", "stop", "apply:stopped", "start", "finish:running"];
      expect(events, scenario).toEqual(expected);
      expect(state, scenario).toBe(scenario === "rollback-fail" ? "stopped" : initial);
      expect(await readFile(config, "utf8"), scenario).toBe(success || scenario === "rollback-fail" ? current : original);
      // Refusals before capture retain an unowned draft; confirmed recovery failure retains both draft and transaction.
      expect(await Bun.file(draft).exists(), scenario).toBe(early || scenario === "rollback-fail");
      expect(readConfigurationState(f.root) !== null, scenario).toBe(scenario === "rollback-fail");
      if (scenario === "rollback-fail") expect(readOpsMaintenanceRecord(f.root)?.result).toBeUndefined();
      expect(result.finalState, scenario).toBe(["foreign", "locked", "foreground", "foreground-task", "paused"].includes(scenario) ? "unknown"
        : state === "running" ? "running" : "stopped");
    } finally { lock?.close(); server?.stop(true); await f.cleanup(); }
  }
}, 60_000);
