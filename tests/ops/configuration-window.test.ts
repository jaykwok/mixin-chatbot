import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigurationDrafts } from "../../ops/core/configuration-drafts.ts";
import { prepareConsoleDir } from "../../ops/core/console-state.ts";
import { createMaintenanceHost, type MaintenanceHostOptions } from "../../ops/core/maintenance-host.ts";
import { runConfiguration, configurationRequest } from "../../ops/core/configuration.ts";
import { runNative } from "../../ops/core/native-process.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { applicationBinding } from "../../src/core/data-version.ts";
import { assessMaintenanceAction, readMaintenanceState } from "../../src/core/maintenance-state.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = join(import.meta.dir, "../.."), oldKey = "old-private-fixture", newKey = "new-private-fixture";
const scenarios = ["running", "stopped", "unready", "restore-refused"] as const;

// Migrated from the two script policy harnesses. Preserve all original four scenarios and actual data commands;
// only service effects are synthetic. Linux maps the container boundary to a supervised local data command here.
test("共用配置窗口使用实际草稿、校验、发布及恢复工具；就绪失败恢复原配置，外部改动时保持停止", async () => {
  for (const scenario of scenarios) {
    const f = await tempFixture("configuration-window-" + scenario + "-");
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const config = join(f.root, "data/config/app-bot.json"), resultPath = join(f.root, "result.json");
      for (const tree of ["data/config", "data/state"]) await mkdir(join(f.root, tree), { recursive: true });
      await writeFile(config, JSON.stringify({ appId: "fixture", environment: "production", appSecret: oldKey }));
      const original = await readFile(config, "utf8");
      await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "fixture",
        transaction: "deploy-fixture", application: applicationBinding({ appId: "fixture", environment: "production" }) }));
      prepareConsoleDir(join(f.root, ".console"));
      await symlink(join(project, "node_modules"), join(f.root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const drafts = new ConfigurationDrafts(f.root), opened = drafts.create("app", "fixture");
      drafts.edit(opened.id, "fixture", 0, { appId: "fixture", environment: "production", secret: { mode: "set", value: newKey } });
      const input = drafts.validationInput(opened.id, "fixture", 1); drafts.validated(opened.id, "fixture", 1, input.digest, ["通过"]);
      const params = drafts.prepare(opened.id, "fixture");
      let state: "running" | "stopped" = scenario === "stopped" ? "stopped" : "running", starts = 0, output = "";
      const ready = { service: "mixin-bot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        const failing = starts === 1 && ["unready", "restore-refused"].includes(scenario);
        if (failing && scenario === "restore-refused") writeFileSync(config, "{}");
        return Response.json({ ...ready, stream: { connected: true, reconnects: 0 } }, { status: failing ? 503 : 200 });
      } });
      await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...ready, port: server.port }));
      const options: MaintenanceHostOptions = { project: f.root, source: project, readyTimeoutMs: 80, streamTimeoutMs: 80, verify: async () => {},
        finish: result => writeFile(resultPath, JSON.stringify(result)), output: text => { output += text; },
        platform: async () => ({ inspect: async () => ({ identity: "a".repeat(64), owned: true, state }),
          stop: async () => { state = "stopped"; }, start: async () => { starts++; state = "running"; } }) };
      const result = await runConfiguration(configurationRequest("configuration-apply", [params.draft, "--digest", params.digest]), options, undefined,
        (options, operation) => {
          const context = createMaintenanceHost(options, operation);
          if (process.platform === "win32") return context;
          return { ...context, data: step => runNative({ command: process.execPath, args: ["--no-env-file",
            join(f.root, ".console/runtime/source-" + operation.runtime, step.script), ...step.args], cwd: f.root, input: step.input, protocol: true,
            timeoutMs: 20_000 }, text => { output += text; }) };
        });
      const success = scenario === "running" || scenario === "stopped";
      expect(result.exitCode, output + JSON.stringify(result)).toBe(success ? 0 : 1);
      expect(output).not.toContain(oldKey); expect(output).not.toContain(newKey);
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toMatchObject({ outcome: success ? "success" : "failed", wasRunning: scenario !== "stopped", exitCode: success ? 0 : 1 });
      expect(state).toBe(scenario === "stopped" || scenario === "restore-refused" ? "stopped" : "running");
      if (success) { expect(await readFile(config, "utf8")).toContain(newKey); expect(readConfigurationState(f.root)).toBeNull(); }
      else if (scenario === "unready") { expect(await readFile(config, "utf8")).toBe(original); expect(readConfigurationState(f.root)).toBeNull(); }
      else { expect(await readFile(config, "utf8")).toBe("{}"); expect(readConfigurationState(f.root)?.phase).toBe("restoring");
        expect(assessMaintenanceAction(readMaintenanceState(f.root), "service").allowed).toBe(false); }
    } finally { server?.stop(true); await f.cleanup(); }
  }
}, 120_000);
