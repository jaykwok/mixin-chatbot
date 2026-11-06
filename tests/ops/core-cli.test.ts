import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runCore } from "../../ops/core/cli.ts";
import type { ServiceHostOptions } from "../../ops/core/service-host.ts";
import type { ServiceControlHost } from "../../ops/core/service.ts";
import { tempFixture } from "../helpers/temp.ts";

test("核心 CLI 只接受当前动作参数；未知参数和拼错的动作在平台初始化前拒绝", async () => {
  let calls = 0;
  const dependencies = { host() { calls++; throw new Error("must not initialize"); } };
  for (const args of [["service", "start", "--projects", "fixture"], ["service", "stop", "--project", "a", "--no-backup"],
    ["service", "restart", "--project", "a", "--project", "b"], ["service", "stops", "--project", "a"],
    ["service", "start"], ["service", "start", "--project", "a", "extra"]]) {
    await expect(runCore(args, dependencies)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("CLI 沿用结果协议，磁盘结果在部署锁内发布；没有控制台接单记录时拒绝", async () => {
  const f = await tempFixture("core-cli-");
  try {
    const result = join(f.root, "ops-result.json"); let locked = false, stopped = false;
    const host = (options: ServiceHostOptions): ServiceControlHost => ({
      async locked(body) { locked = true; try { return await body(); } finally { locked = false; } },
      async verify() { expect(locked).toBe(true); await options.verify(); },
      async inspect() { return { identity: "fixture", owned: true, state: stopped ? "stopped" : "running", ready: !stopped, pending: false }; },
      async assess() {}, async stop() { stopped = true; }, async start() { stopped = false; }, async waitReady() { return true; },
      async finish(value) { expect(locked).toBe(true); await options.finish(value); },
    });
    const done = await runCore(["service", "stop", "--project", f.root, "--json"], { host, env: { MIXIN_OPS_RESULT_FILE: result } });
    expect(done).toMatchObject({ json: true, result: { command: "stop", outcome: "success", exitCode: 0, finalState: "stopped" } });
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual(done.result);
    const refused = await runCore(["service", "start", "--project", f.root], { host, env: { MIXIN_OPS_CONSOLE: "1" } });
    expect(refused.result.outcome).toBe("refused"); expect(stopped).toBe(true);
    expect(locked).toBe(false);
    const repaired = await runCore(["service", "repair", "--project", f.root], { host, env: {} });
    expect(repaired.result).toMatchObject({ command: "repair", outcome: "success", wasRunning: false, finalState: "running" }); expect(stopped).toBe(false);
    const failed = await runCore(["service", "stop", "--project", f.root], { host, env: { MIXIN_OPS_RESULT_FILE: f.root } });
    expect(failed.result.outcome).toBe("failed"); expect(failed.result.exitCode).not.toBe(0);
  } finally { await f.cleanup(); }
});

const repo = resolve(import.meta.dir, "../..");
/** The relative modules a file loads at import time, whichever module lies between. */
async function staticClosure(entry: string): Promise<{ modules: Set<string>; packages: Set<string> }> {
  const loaders = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
  const modules = new Set<string>(), packages = new Set<string>(), queue = [resolve(repo, entry)];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (modules.has(file)) continue; modules.add(file);
    const source = (await readFile(file, "utf8")).replace(/^#!.*/, "");
    for (const item of loaders[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(source)) {
      if (item.kind !== "import-statement") continue;
      if (item.path.startsWith(".")) { if (/\.tsx?$/.test(item.path)) queue.push(resolve(dirname(file), item.path)); }
      else if (!item.path.startsWith("node:") && !item.path.startsWith("bun")) packages.add(item.path);
    }
  }
  return { modules, packages };
}

test("恢复路径不依赖服务配置：核心和事务中途运行的工具不在导入时读 runtime.json，也不校验终端变量", async () => {
  for (const entry of ["ops/core/cli.ts", "ops/tools/data-current.ts", "ops/config/runtime-settings.ts",
    "ops/config/runtime-apply.ts", "ops/config/configuration-apply.ts", "ops/config/configuration-install.ts", "ops/config/directory-scope.ts", "ops/config/directory-query.ts"])
    expect((await staticClosure(entry)).modules.has(resolve(repo, "src/core/config.ts")), entry).toBe(false);
  const f = await tempFixture("core-cli-damaged-");
  try {
    const snapshot = "deploy-damaged", project = join(f.root, "含空格 项目"), core = join(repo, "ops/core/cli.ts");
    await mkdir(join(project, "data/state"), { recursive: true }); await mkdir(join(project, "data/config"), { recursive: true });
    await mkdir(join(project, "backup/snapshots", snapshot), { recursive: true });
    await writeFile(join(project, "data/state/upgrade-transaction"), snapshot + "\n");
    await writeFile(join(project, "backup/snapshots", snapshot, "transaction"), ["format=2", "operation=upgrade", "snapshot=" + snapshot, "target_sha=" + "a".repeat(40),
      "original_sha=" + "b".repeat(40), "original_branch=main", "original_workspace_root=", "target_workspace_root=", "was_running=1", "bot_port=2022", "reconfigure_ai=0"].join("\n") + "\n");
    const run = async (name: "rollback" | "resume" | "uninstall", env: Record<string, string>) => {
      const upgrade = ["deployment", "upgrade", "--project", project, "--original", "b".repeat(40), "--target", "a".repeat(40), "--branch", "main", "--json"];
      const args = name === "uninstall" ? ["uninstall-check", "--project", project, "--json"] : name === "rollback" ? [...upgrade, "--rollback"] : upgrade;
      // From the project directory, as the upgrade entries run it: that is where the relative runtime.json would be found.
      const child = Bun.spawn([process.execPath, "--no-env-file", core, ...args], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, ...env } });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, err, value: out ? JSON.parse(out) : null };
    };
    for (const [config, env] of [["{", {}], ['{"BOT_UNKNOWN":"1"}', {}], ["{}", { BOT_PORT: "99999", BOT_MAX_ACTIVE_REQUESTS: "abc" }]] as const) {
      await writeFile(join(project, "data/config/runtime.json"), config);
      // The core answers for itself. This synthetic transaction has no pinned runtime, which is the refusal it reaches.
      for (const name of ["rollback", "resume"] as const) {
        const value = await run(name, env);
        expect(value.err, config).toBe("");
        expect(value.value, config).toMatchObject({ protocol: "mixin-ops", command: name, outcome: "refused", message: expect.stringContaining("固定运维运行包") });
      }
      expect((await run("uninstall", env)).value).toMatchObject({ command: "uninstall", outcome: "refused", message: expect.stringContaining("有未完成的部署或升级") });
    }
  } finally { await f.cleanup(); }
}, 60_000);

test("应用机器人和外链配置的工具不在导入时加载 Pi；只有模型配置和模型目录才加载", async () => {
  for (const entry of ["ops/config/configuration-check.ts", "ops/config/configuration-apply.ts", "ops/config/configuration-install.ts"]) {
    const { packages, modules } = await staticClosure(entry);
    expect([...packages].filter(name => name.startsWith("@earendil-works/")), entry).toEqual([]);
    expect(modules.has(resolve(repo, "src/core/model-config.ts")), entry).toBe(false);
  }
});
