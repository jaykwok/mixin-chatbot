import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDeploymentLock, DeploymentBusy, withDeploymentLock } from "../../ops/core/deployment-lock.ts";
import { tempFixture } from "../helpers/temp.ts";

const modulePath = fileURLToPath(new URL("../../ops/core/deployment-lock.ts", import.meta.url));
const source = fileURLToPath(new URL("../../", import.meta.url));
async function readReady(child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>) {
  const reader = child.stdout.getReader(); let result = "";
  try {
    while (!result.includes("\n")) {
      const item = await reader.read();
      if (item.done) throw new Error("lock helper exited before READY: " + result);
      result += new TextDecoder().decode(item.value);
    }
    expect(result.trim()).toBe("READY");
  } finally { reader.releaseLock(); }
}

// macOS has no flock command or second lock implementation: its entries take the same TS lock.
test.skipIf(process.platform === "darwin")("TS 部署锁与现有平台锁双向互斥，释放不删除或截断锁文件", async () => {
  const f = await tempFixture("core-native-lock-");
  const project = join(f.root, "含空格 项目"), path = join(project, "data/state/deploy.lock");
  await mkdir(join(project, "data/state"), { recursive: true });
  await writeFile(path, "retained-lock-file\n");
  const script = join(f.root, process.platform === "win32" ? "native.ps1" : "native.sh");
  await writeFile(script, process.platform === "win32" ? [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "try { $handle=[IO.File]::Open($env:LOCK_FILE,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch [IO.IOException] { exit 17 }",
    "try { [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $handle.Dispose() }",
  ].join("\r\n") : [
    "set -euo pipefail", 'exec 9<>"$LOCK_FILE"', "flock -n 9 || exit 17", "printf 'READY\\n'", "IFS= read -r _ || :",
  ].join("\n"));
  const argv = process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["bash", script];
  const launch = () => Bun.spawn(argv, { env: { ...process.env, LOCK_FILE: path }, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  let lock: ReturnType<typeof acquireDeploymentLock> | undefined;
  let child: ReturnType<typeof launch> | undefined;
  try {
    lock = acquireDeploymentLock(project); lock.assertHeld();
    expect(() => acquireDeploymentLock(project)).toThrow(DeploymentBusy);
    child = launch(); child.stdin.end();
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output, error }).toEqual({ code: 17, output: "", error: "" });
    lock.close(); lock.close(); expect(() => lock!.assertHeld()).toThrow("已经释放"); lock = undefined;
    child = launch(); const stderr = new Response(child.stderr).text(); await readReady(child);
    expect(() => acquireDeploymentLock(project)).toThrow(DeploymentBusy);
    child.stdin.end(); expect(await child.exited).toBe(0); expect(await stderr).toBe(""); child = undefined;
    lock = acquireDeploymentLock(project); lock.assertHeld(); lock.close(); lock = undefined;
    expect(readFileSync(path, "utf8")).toBe("retained-lock-file\n");
  } finally { lock?.close(); if (child) { child.kill(); await child.exited; } await f.cleanup(); }
}, 30_000);

test("持锁进程被强杀后由系统释放；文件保留，新核心可继续取同一把锁", async () => {
  const f = await tempFixture("core-lock-death-");
  const helper = join(f.root, "hold.ts");
  await writeFile(helper, `import { acquireDeploymentLock } from ${JSON.stringify(modulePath)};
const lock = acquireDeploymentLock(process.argv[2]);
lock.assertHeld(); console.log("READY"); setInterval(() => {}, 1000);
`);
  const child = Bun.spawn([process.execPath, "--no-env-file", helper, f.root], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const stderr = new Response(child.stderr).text();
  try {
    await readReady(child); expect(() => acquireDeploymentLock(f.root)).toThrow(DeploymentBusy);
    child.kill("SIGKILL"); await child.exited;
    const lock = acquireDeploymentLock(f.root); try { lock.assertHeld(); } finally { lock.close(); }
    expect(existsSync(join(f.root, "data/state/deploy.lock"))).toBe(true); expect(await stderr).toBe("");
  } finally { child.kill(); await child.exited; await f.cleanup(); }
}, 20_000);

test.skipIf(process.platform !== "linux")("Bash 父进程经 fd 9 持锁并导出路径时子核心沿用它；没有同一描述符的进程被拒绝，子进程结束不释放父进程的锁", async () => {
  const f = await tempFixture("core-lock-inherit-");
  const project = join(f.root, "含空格 项目"), helper = join(f.root, "adopt.ts"), script = join(f.root, "parent.sh");
  await mkdir(project, { recursive: true });
  await writeFile(helper, `import { DeploymentBusy, withDeploymentLock } from ${JSON.stringify(modulePath)};
try { await withDeploymentLock(process.argv[2], async lock => { lock.assertHeld(); }); console.log("adopted"); }
catch (error) { console.log(error instanceof DeploymentBusy ? "busy" : "error " + error); }
`);
  // acquire_deploy_lock is what ops.sh and upgrade.sh run; the cases differ only in the export and descriptor 9.
  await writeFile(script, [
    "set -uo pipefail", 'PROJECT_DIR="$1"; BUN="$2"; HELPER="$3"', `. ${JSON.stringify(join(source, "scripts/lib/common.sh"))}`,
    "acquire_deploy_lock || exit 20",
    'printf "inherited=%s\\n" "$("$BUN" --no-env-file "$HELPER" "$PROJECT_DIR")"',
    'printf "again=%s\\n" "$("$BUN" --no-env-file "$HELPER" "$PROJECT_DIR")"',
    'printf "no-export=%s\\n" "$(env -u BOT_DEPLOY_LOCK_HELD "$BUN" --no-env-file "$HELPER" "$PROJECT_DIR")"',
    'printf "no-descriptor=%s\\n" "$("$BUN" --no-env-file "$HELPER" "$PROJECT_DIR" 9>&-)"',
    'printf "other-file=%s\\n" "$("$BUN" --no-env-file "$HELPER" "$PROJECT_DIR" 9>"$PROJECT_DIR/other")"',
    'if flock -n "$BOT_DEPLOY_LOCK_HELD" true; then echo released; else echo still-held; fi',
  ].join("\n") + "\n");
  try {
    const child = Bun.spawn(["bash", script, project, process.execPath, helper], { env: { ...process.env, BOT_DEPLOY_LOCK_HELD: "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output, error }).toEqual({ code: 0, error: "",
      output: "inherited=adopted\nagain=adopted\nno-export=busy\nno-descriptor=busy\nother-file=busy\nstill-held\n" });
    // The parent's exit closes the last descriptor of that open file description.
    const lock = acquireDeploymentLock(project); try { lock.assertHeld(); } finally { lock.close(); }
  } finally { await f.cleanup(); }
}, 30_000);

// rootful deployments hand data/state to the service identity; root must not write through a lock it planted (A3-18).
test.skipIf(process.platform !== "linux")("Bash 入口不经链接写入或创建、不截断、遇 FIFO 不挂起；被占用返回 1，异常返回 2 并给出说明", async () => {
  const f = await tempFixture("core-lock-shell-");
  const project = join(f.root, "含空格 项目"), state = join(project, "data/state"), lock = join(state, "deploy.lock");
  const target = join(f.root, "target"), script = join(f.root, "acquire.sh");
  await mkdir(state, { recursive: true });
  await writeFile(script, [
    "set -uo pipefail", 'PROJECT_DIR="$1"', `. ${JSON.stringify(join(source, "scripts/lib/common.sh"))}`,
    'code=0; acquire_deploy_lock || code=$?',
    '[ "$code" != 0 ] || exec 9<&-',
    'busy=0; deploy_lock_busy "$(realpath "$PROJECT_DIR/data/state")/deploy.lock" && busy=1',
    'deploy_lock_busy "$PROJECT_DIR/data/state/absent.lock" && busy=absent',
    'printf "code=%s busy=%s refusal=%s\\n" "$code" "$busy" "${DEPLOY_LOCK_REFUSAL:-}"',
  ].join("\n") + "\n");
  const run = async () => {
    const child = Bun.spawn(["timeout", "10", "bash", script, project], { env: { ...process.env, BOT_DEPLOY_LOCK_HELD: "", MIXIN_OPS_TASK_ID: "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output, error };
  };
  const reset = async () => { await rm(lock, { force: true, recursive: true }); await rm(target, { force: true }); };
  try {
    // Missing: created as a private regular file; the probe neither creates nor reports a lock this process released.
    expect((await run()).output).toBe("code=0 busy=0 refusal=\n");
    expect((await lstat(lock)).isFile()).toBe(true); expect((await lstat(lock)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(state, "absent.lock"))).toBe(false);
    await writeFile(lock, "kept\n");
    expect((await run()).output).toBe("code=0 busy=0 refusal=\n");
    expect(readFileSync(lock, "utf8")).toBe("kept\n");
    for (const plant of ["existing link", "dangling link", "fifo", "directory"] as const) {
      await reset();
      if (plant === "existing link") { await writeFile(target, "victim\n"); await symlink(target, lock); }
      else if (plant === "dangling link") await symlink(target, lock);
      else if (plant === "fifo") expect(Bun.spawnSync(["mkfifo", lock]).exitCode).toBe(0);
      else await mkdir(lock);
      const result = await run();
      expect(result.code, plant).toBe(0);
      expect(result.output, plant).toBe("code=2 busy=1 refusal=部署锁文件异常，未执行操作（原因见任务输出）\n");
      expect(result.error, plant).toContain("不是普通文件");
      if (plant === "existing link") expect(readFileSync(target, "utf8")).toBe("victim\n");
      else expect(existsSync(target), plant).toBe(false);
    }
    await reset();
    const holder = Bun.spawn(["bash", "-c", 'exec 9<>"$1"; flock -n 9 || exit 17; printf "READY\\n"; IFS= read -r _ || :', "holder", lock],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      await readReady(holder);
      const result = await run();
      expect(result.output).toBe("code=1 busy=1 refusal=部署、升级或另一个维护操作正在进行；未执行操作\n");
      expect(result.error).toBe("");
    } finally { holder.stdin.end(); await holder.exited; }
  } finally { await f.cleanup(); }
}, 60_000);

test("维护异常同样释放锁；目录、链接及被替换的锁均不被当成有效独占", async () => {
  const f = await tempFixture("core-lock-path-");
  const path = join(f.root, "data/state/deploy.lock");
  try {
    await expect(withDeploymentLock(f.root, async lock => { lock.assertHeld(); throw new Error("fixture action failed"); })).rejects.toThrow("fixture action failed");
    await withDeploymentLock(f.root, async lock => { lock.assertHeld(); });
    await rename(path, path + ".saved"); await mkdir(path);
    expect(() => acquireDeploymentLock(f.root)).toThrow();
    await rename(path, path + ".directory");
    // Linux needs no symlink privilege. Windows native reparse-point refusal is covered by elevated platform acceptance.
    if (process.platform === "linux") {
      await symlink(path + ".saved", path);
      expect(() => acquireDeploymentLock(f.root)).toThrow();
      await rename(path, path + ".symlink"); await rename(path + ".saved", path);
      const lock = acquireDeploymentLock(f.root);
      try { await rename(path, path + ".moved"); await writeFile(path, "replacement"); expect(() => lock.assertHeld()).toThrow("已被替换"); }
      finally { lock.close(); }
    }
  } finally { await f.cleanup(); }
});
