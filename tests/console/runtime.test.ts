import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDeploymentLock } from "../../ops/core/deployment-lock.ts";
import { CodeFence, codeDigest, freezeRuntime, pruneRuntimes } from "../../ops/core/source-runtime.ts";
import { pruneUnusedRuntimes } from "../../console/server/task-host.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { tempFixture } from "../helpers/temp.ts";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareConsoleDir } from "../../ops/core/console-state.ts";

test("固定运行包只包含代码，代码替换后固定副本不变；校验失配后不会因回滚解锁旧入口", async () => {
  const f = await tempFixture("console-runtime-");
  try {
    for (const dir of ["console", "ops", "scripts", "src", "data", "node_modules"]) mkdirSync(join(f.root, dir));
    writeFileSync(join(f.root, "scripts/main.ts"), 'export const value = "first"');
    writeFileSync(join(f.root, "ops/tool.ts"), "export {};");
    writeFileSync(join(f.root, "src/version.ts"), 'export const value = 1');
    writeFileSync(join(f.root, "console/icon.svg"), "<svg/>");
    writeFileSync(join(f.root, "pyproject.toml"), "[project]\nname='fixture'\n");
    writeFileSync(join(f.root, "uv.lock"), "fixture lock\n");
    writeFileSync(join(f.root, ".python-version"), "3.12\n");
    writeFileSync(join(f.root, "scripts/helper.py"), "print('fixture')\n");
    writeFileSync(join(f.root, "scripts/.env"), "PRIVATE_KEY=fixture-private");
    writeFileSync(join(f.root, ".env"), "PRIVATE_KEY=fixture-private");
    writeFileSync(join(f.root, "data/chat.json"), '{"body":"private-fixture"}');
    const runtime = freezeRuntime(join(f.root, ".console"), f.root); let changed = 0;
    const fence = new CodeFence(f.root, runtime.digest, () => changed++);
    expect(fence.current()).toBe(true); expect(codeDigest(runtime.root)).toBe(runtime.digest);
    for (const file of [".env", "scripts/.env", "data/chat.json", "node_modules"]) expect(() => readFileSync(join(runtime.root, file))).toThrow();
    expect(freezeRuntime(join(f.root, ".console"), f.root)).toEqual(runtime);
    for (const name of ["pyproject.toml", "uv.lock", ".python-version", "scripts/helper.py"]) expect(readFileSync(join(runtime.root, name), "utf8")).toBe(readFileSync(join(f.root, name), "utf8"));
    writeFileSync(join(f.root, "src/version.ts"), 'export const value = 2');
    expect(fence.current()).toBe(false); expect(readFileSync(join(runtime.root, "src/version.ts"), "utf8")).toContain("= 1");
    writeFileSync(join(f.root, "src/version.ts"), 'export const value = 1');
    expect(fence.current()).toBe(false); expect(changed).toBe(1);
    writeFileSync(join(runtime.root, "src/version.ts"), "corrupted");
    expect(() => freezeRuntime(join(f.root, ".console"), f.root)).toThrow("摘要不符");
  } finally { await f.cleanup(); }
});

test("源码被替换后，固定查询 worker/host 仍能新建并回收查询进程；不依赖原始脚本路径", async () => {
  const f = await tempFixture("console-fixed-workers-");
  try {
    const project = fileURLToPath(new URL("../..", import.meta.url));
    for (const name of ["console", "ops", "scripts", "src", "package.json", "pyproject.toml", "uv.lock", ".python-version"]) await cp(join(project, name), join(f.root, name), { recursive: true });
    prepareConsoleDir(join(f.root, ".console"));
    const runtime = freezeRuntime(join(f.root, ".console"), f.root);
    await rm(join(f.root, "console"), { recursive: true });
    await rm(join(f.root, "pyproject.toml"));
    const runner = join(f.root, "worker-check.ts");
    writeFileSync(runner, [
      "const { QueryPool } = await import(" + JSON.stringify(pathToFileURL(join(runtime.root, "console/server/exec-client.ts")).href) + ");",
      "const pool = new QueryPool();",
      "try { const result = await pool.capture(process.execPath, ['--no-env-file', '-e', 'console.log(\"fixed-query\")'], { timeout: 10000 });",
      "const configured = await pool.capture(process.execPath, ['--no-env-file', '-e', " + JSON.stringify("const { DOCUMENT_TOOLCHAIN_PACKAGES } = await import(" + JSON.stringify(pathToFileURL(join(runtime.root, "src/core/config.ts")).href) + "); if(!DOCUMENT_TOOLCHAIN_PACKAGES.length)throw Error('empty manifest'); console.log('fixed-manifest');") + "], { timeout: 10000 });",
      "if(configured.code!==0||configured.stdout.trim()!=='fixed-manifest')throw Error(configured.stderr); console.log(JSON.stringify(result)); } finally { await pool.stop(); }",
    ].join("\n"));
    const child = Bun.spawn([process.execPath, "--no-env-file", runner], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, MIXIN_CONSOLE_PROJECT_ROOT: f.root, MIXIN_CONSOLE_SOURCE_ROOT: runtime.root } });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, err).toBe(0); expect(JSON.parse(out)).toMatchObject({ code: 0, stdout: "fixed-query\n", timedOut: false });
  } finally { await f.cleanup(); }
}, 30_000);

test.skipIf(process.platform === "win32")("固定代码可供容器身份只读挂载，外层和敏感状态仍私有，不受 umask 077 影响", async () => {
  const f = await tempFixture("console-runtime-modes-");
  const previous = process.umask(0o077);
  try {
    for (const dir of ["console", "ops", "scripts/lib", "src"]) mkdirSync(join(f.root, dir), { recursive: true });
    writeFileSync(join(f.root, "scripts/lib/test.ts"), "export const value = 1");
    writeFileSync(join(f.root, "src/version.ts"), "export const value = 1");
    writeFileSync(join(f.root, "console/icon.svg"), "<svg/>");
    writeFileSync(join(f.root, "ops/tool.ts"), "export {};");
    const directory = join(f.root, ".console"), runtime = freezeRuntime(directory, f.root);
    for (const path of [directory, join(directory, "runtime")]) expect(statSync(path).mode & 0o777).toBe(0o700);
    for (const path of [runtime.root, join(runtime.root, "scripts"), join(runtime.root, "scripts/lib")]) expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(statSync(join(runtime.root, "scripts/lib/test.ts")).mode & 0o777).toBe(0o644);
  } finally { process.umask(previous); await f.cleanup(); }
});

const DAY = 86_400_000;
/** A frozen version under .console/runtime whose last use was `days` ago. */
function version(parent: string, name: string, days: number, now = Date.now()): string {
  mkdirSync(join(parent, name, "scripts"), { recursive: true }); writeFileSync(join(parent, name, "scripts/a.ts"), "x");
  const at = new Date(now - days * DAY); utimesSync(join(parent, name), at, at);
  return name;
}

test("旧版本运行包按保留集合和 7 天内的使用清理：先移开再删除，链接和其他名称不动", async () => {
  const f = await tempFixture("console-runtime-prune-");
  try {
    const dir = join(f.root, ".console"), parent = join(dir, "runtime"), now = Date.now();
    const [a, b, c, d, e, link] = ["a", "b", "c", "d", "e", "f"].map(letter => letter.repeat(64)) as [string, string, string, string, string, string];
    const kept = [version(parent, "source-" + a, 30, now), version(parent, "source-" + c, 6, now), version(parent, e, 30, now), version(parent, "notes", 30, now)];
    const old = [version(parent, "source-" + b, 30, now), version(parent, d, 30, now), version(parent, ".source-" + randomUUID(), 30, now)];
    version(parent, ".removed-" + randomUUID(), 0, now);
    symlinkSync(join(parent, "source-" + a), join(parent, "source-" + link), "junction");
    expect(pruneRuntimes(dir, new Set([a, e]), now).sort()).toEqual(old.sort());
    expect(readdirSync(parent).sort()).toEqual([...kept, "source-" + link].sort());
    expect(readFileSync(join(parent, "source-" + link, "scripts/a.ts"), "utf8")).toBe("x");
    rmSync(join(parent, "source-" + link), { recursive: true });
  } finally { await f.cleanup(); }
});

test("复用已有的运行包算作使用，刷新清理的计时", async () => {
  const f = await tempFixture("console-runtime-reuse-");
  try {
    for (const dir of ["console", "ops", "scripts", "src"]) { mkdirSync(join(f.root, dir)); writeFileSync(join(f.root, dir, "main.ts"), "export const value = 1"); }
    const dir = join(f.root, ".console"), runtime = freezeRuntime(dir, f.root), month = new Date(Date.now() - 30 * DAY);
    utimesSync(runtime.root, month, month);
    expect(freezeRuntime(dir, f.root)).toEqual(runtime);
    expect(Date.now() - statSync(runtime.root).mtimeMs).toBeLessThan(DAY);
    expect(pruneRuntimes(dir, new Set())).toEqual([]);
  } finally { await f.cleanup(); }
});

test("启动控制台时只在任务都已结束、部署锁空闲、没有未完成的事务和维护时清理旧版本", async () => {
  const f = await tempFixture("console-runtime-guard-");
  try {
    const project = f.root, old = "b".repeat(64), path = join(project, ".console/runtime", version(join(project, ".console/runtime"), "source-" + old, 30));
    mkdirSync(join(project, "data/state"), { recursive: true });
    let at = Date.now();
    const tasks = new TaskStore(join(project, ".console"), () => at), observers = { hosting: async () => ({ state: "ended" as const }), needsRecovery: async () => false };
    // A task still waiting for its executor.
    tasks.create({ project, operation: "stop", params: {}, planId: "plan-fixture", mechanism: process.platform === "win32" ? "windows-task" : "systemd-system" }, "queued");
    expect(await pruneUnusedRuntimes(project, tasks, observers, [])).toEqual([]);
    at += 60_000; // never accepted: final
    // A deployment or maintenance holds deploy.lock.
    const lock = acquireDeploymentLock(project);
    try { expect(await pruneUnusedRuntimes(project, tasks, observers, [])).toEqual([]); } finally { lock.close(); }
    // Unfinished maintenance (it pinned this version).
    const record = join(project, "data/state/ops-maintenance.json");
    writeFileSync(record, JSON.stringify({ version: 1, checkpoint: { version: 1, phase: "acting",
      request: { id: "1".repeat(32), runtime: old, command: "history-clear", label: "清空会话", intent: "conversation-write" },
      original: { identity: "2".repeat(64), state: "stopped", owned: true, pending: false, ready: false } } }));
    expect(await pruneUnusedRuntimes(project, tasks, observers, [])).toEqual([]);
    rmSync(record);
    // An open transaction whose record cannot be read.
    const pointer = join(project, "data/state/deploy-transaction");
    writeFileSync(pointer, `deploy-${"3".repeat(32)}\n`);
    await expect(pruneUnusedRuntimes(project, tasks, observers, [])).rejects.toThrow();
    rmSync(pointer);
    expect(existsSync(path)).toBe(true);
    expect(await pruneUnusedRuntimes(project, tasks, observers, [])).toEqual(["source-" + old]);
    expect(existsSync(path)).toBe(false);
  } finally { await f.cleanup(); }
});
