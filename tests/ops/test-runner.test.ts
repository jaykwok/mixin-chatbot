import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));

async function runTests(root: string | undefined, file: string, overrides: NodeJS.ProcessEnv = {}) {
  const started = performance.now();
  const env = { ...process.env, ...overrides };
  if (root === undefined) delete env.MIXIN_TEST_WORK_ROOT;
  else env.MIXIN_TEST_WORK_ROOT = root;
  const child = Bun.spawn([process.execPath, join(project, "scripts/test.ts"), file], {
    env, stdout: "pipe", stderr: "pipe", windowsHide: true });
  let exitedAt = 0;
  const [code, out, err] = await Promise.all([child.exited.then(code => { exitedAt = Date.now(); return code; }),
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: out + err, ms: performance.now() - started, exitedAt };
}

async function until(file: string) {
  const deadline = Date.now() + 30000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + file);
    await Bun.sleep(20);
  }
}

test.skipIf(process.platform !== "win32")("the Windows default work root uses the system temporary directory and cleans only its own run", async () => {
  const fixture = await tempFixture("test-runner-default-");
  const cwdFile = join(fixture.root, "default-cwd"), sentinel = join(fixture.root, "keep.txt"), file = join(fixture.root, "default.test.ts");
  try {
    await writeFile(sentinel, "keep");
    await writeFile(file, `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("runner-default", () => { writeFileSync(${JSON.stringify(cwdFile)}, process.cwd()); });
`);
    const result = await runTests(undefined, file, { TEMP: fixture.root, TMP: fixture.root });
    expect(result.code, result.output).toBe(0);
    const cwd = await readFile(cwdFile, "utf8");
    expect(dirname(cwd)).toBe(fixture.root);
    expect(basename(cwd)).toMatch(/^tests-/);
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(join(project, "tmp", basename(cwd) + ".log"))).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows normalizes an aliased TEMP or explicit work root before file tools and fixture receipts use it", async () => {
  const fixture = await tempFixture("test-runner-alias-");
  const physical = join(fixture.root, "physical"), alias = join(fixture.root, "alias");
  const file = join(fixture.root, "alias.test.ts"), observed = join(fixture.root, "observed.json");
  await mkdir(physical);
  await symlink(physical, alias, "junction");
  try {
    await writeFile(file, `import { expect, test } from "bun:test";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildLocalTools } from ${JSON.stringify(fileURLToPath(new URL("../../src/agent/local-tools.ts", import.meta.url)))};
test("aliased-root-tools", async () => {
  const root = process.env.TEST_TEMP_ROOT;
  expect(root).toBe(await realpath(root));
  expect(process.cwd()).toBe(await realpath(process.cwd()));
  for (const key of ["TEMP", "TMP", "TMPDIR"]) expect(process.env[key]).toBe(root);
  expect(process.env.TEST_TRASH_DIR).toBe(join(process.cwd(), "trash"));
  const workspace = join(root, "workspace"), own = join(root, "own"), other = join(root, "other");
  await Promise.all([mkdir(workspace), mkdir(own), mkdir(other)]);
  const tools = await buildLocalTools({ workspaceDir: workspace, tempDir: own, phone: "alice", groupId: "g",
    venvDir: join(root, "venv"), materialsIndexPath: join(root, "index", "materials.md") });
  const write = tools.find(tool => tool.name === "write");
  await write.execute("owned", { path: join(own, "result.txt"), content: "owned" }, undefined, undefined, {});
  expect(await readFile(join(own, "result.txt"), "utf8")).toBe("owned");
  for (const forbidden of [workspace, other]) {
    let rejected = false;
    try { await write.execute("forbidden", { path: join(forbidden, "result.txt"), content: "no" }, undefined, undefined, {}); }
    catch { rejected = true; }
    expect(rejected).toBe(true);
  }
  await writeFile(${JSON.stringify(observed)}, JSON.stringify({ cwd: process.cwd(), root }));
});
`);
    for (const explicit of [false, true]) {
      const result = await runTests(explicit ? alias : undefined, file, { TEMP: alias, TMP: alias });
      expect(result.code, result.output).toBe(0);
      const paths = JSON.parse(await readFile(observed, "utf8")) as { cwd: string; root: string };
      expect(dirname(paths.cwd)).toBe(await realpath(physical));
      expect(paths.root).toBe(join(paths.cwd, "fixtures"));
      expect(existsSync(paths.cwd)).toBe(false);
      expect(existsSync(join(project, "tmp", basename(paths.cwd) + ".log"))).toBe(false);
    }
    expect(await readdir(physical)).toEqual([]);
  } finally { await rm(alias, { force: true }); await fixture.cleanup(); }
}, 60000);

test("a forced timeout restores spies before the next test and still fails the timed-out run", async () => {
  const fixture = await tempFixture("test-runner-timeout-");
  let log: string | undefined;
  try {
    const file = join(fixture.root, "timeout.test.ts");
    await writeFile(file, `import { expect, spyOn, test } from "bun:test";
import ${JSON.stringify(fileURLToPath(new URL("../helpers/restore-spies.ts", import.meta.url)))};
const prototype = { acquire() { return "original"; } };
test("deliberate timeout", async () => {
  const acquire = prototype.acquire;
  const spy = spyOn(prototype, "acquire").mockImplementation(() => acquire());
  try { await new Promise(() => {}); } finally { spy.mockRestore(); }
}, 100);
test("next test uses original", () => {
  const acquire = prototype.acquire;
  const spy = spyOn(prototype, "acquire").mockImplementation(() => acquire());
  try { expect(prototype.acquire()).toBe("original"); } finally { spy.mockRestore(); }
});
`);
    const result = await runTests(join(fixture.root, "work"), file);
    log = /诊断日志 (.+)$/m.exec(result.output)?.[1]?.trim();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("timed out after 100ms");
    expect(result.output).toContain("(pass) next test uses original");
    expect(result.output).toContain("1 pass");
    expect(result.output).toContain("1 fail");
    expect(result.output).not.toContain("Maximum call stack");
  } finally { if (log) await rm(log, { force: true }); await fixture.cleanup(); }
}, 30000);

test("the test runner keeps a failed run and its log, removes a passed one and does not wait on a leaked output pipe", async () => {
  const fixture = await tempFixture("test-runner-");
  const root = join(fixture.root, "work"), pidFile = join(fixture.root, "leaked-pid");
  const failedLog: string[] = [];
  try {
    // Passed: the work directory under MIXIN_TEST_WORK_ROOT and the log in the project's tmp/ are both removed,
    // and the runner exits right after the tests instead of sitting out the wait meant for a held output pipe.
    const cwdFile = join(fixture.root, "pass-cwd"), endFile = join(fixture.root, "pass-end");
    await writeFile(join(fixture.root, "pass.test.ts"), `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("runner-pass", () => { writeFileSync(${JSON.stringify(cwdFile)}, process.cwd()); writeFileSync(${JSON.stringify(endFile)}, String(Date.now())); });
`);
    const passed = await runTests(root, join(fixture.root, "pass.test.ts"));
    expect(passed.code, passed.output).toBe(0);
    const passedCwd = await readFile(cwdFile, "utf8");
    expect(dirname(passedCwd)).toBe(root);
    expect(await readdir(root)).toEqual([]);
    expect(existsSync(join(project, "tmp", basename(passedCwd) + ".log"))).toBe(false);
    expect(passed.exitedAt - Number(await readFile(endFile, "utf8"))).toBeLessThan(4000);

    // Failed: absolute paths of the kept work directory and of a log holding the output, both printed.
    await writeFile(join(fixture.root, "fail.test.ts"), `import { expect, test } from "bun:test";
test("runner-fail", () => { console.log("runner-output-marker"); expect(1).toBe(2); });
`);
    const failed = await runTests(root, join(fixture.root, "fail.test.ts"));
    expect(failed.code).toBe(1);
    const kept = /测试工作目录保留在 (.+)$/m.exec(failed.output)?.[1]?.trim() ?? "";
    const log = /诊断日志 (.+)$/m.exec(failed.output)?.[1]?.trim() ?? "";
    if (log) failedLog.push(log);
    expect(dirname(kept), failed.output).toBe(root);
    expect(existsSync(join(kept, "fixtures"))).toBe(true);
    expect(log).toBe(join(project, "tmp", basename(kept) + ".log"));
    const text = await readFile(log, "utf8");
    expect(text).toContain(`工作目录 ${kept}`);
    for (const part of ["runner-fail", "runner-output-marker", "退出码 1"]) expect(text).toContain(part);

    // A process the tests left behind still holds the output pipe: the runner stops waiting and exits with the tests' result.
    await writeFile(join(fixture.root, "leak.test.ts"), `import { test } from "bun:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
test("runner-leak", () => {
  // The helper exits at once; its own detached child keeps the inherited output pipe open for two minutes
  // (on Windows only a detached child keeps it).
  const helper = spawn(process.execPath, ["-e", ${JSON.stringify(`const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"], cwd: ${JSON.stringify(fixture.root)}, windowsHide: true });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref();`)}], { stdio: ["ignore", "inherit", "inherit"], cwd: ${JSON.stringify(fixture.root)}, windowsHide: true });
  return new Promise(done => helper.on("exit", done));
}, 30000);
`);
    const leak = await runTests(root, join(fixture.root, "leak.test.ts"));
    expect(leak.code, leak.output).toBe(0);
    expect(leak.output).toContain("仍有进程占用输出管道");
    expect(leak.ms).toBeLessThan(90000);
    expect(await readdir(root)).toEqual([basename(kept)]);
  } finally {
    // The leaked process is ended even when an assertion above failed.
    if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch { /* already gone */ } }
    for (const log of failedLog) await rm(log, { force: true });
    await fixture.cleanup();
  }
}, 180000);

// Windows only: another process reading the log without delete sharing (a log viewer, a scanner) makes deleting it fail.
test.skipIf(process.platform !== "win32")("a passed run whose log another process holds still exits 0, removes its work directory and keeps the log", async () => {
  const fixture = await tempFixture("test-runner-held-");
  const root = join(fixture.root, "work"), cwdFile = join(fixture.root, "held-cwd");
  const release = join(fixture.root, "release"), ready = join(fixture.root, "ready"), stop = join(fixture.root, "stop");
  const script = join(fixture.root, "hold-log.ps1");
  await writeFile(join(fixture.root, "held.test.ts"), `import { test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
test("runner-held-log", async () => {
  writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());
  const deadline = Date.now() + 30000;
  while (!existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw new Error("not released"); await Bun.sleep(20); }
}, 40000);
`);
  await writeFile(script, "\ufeff" + [
    "param([string]$Path, [string]$Ready, [string]$Stop)",
    "$stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')",
    "try {",
    "    [IO.File]::WriteAllText($Ready, 'ready')",
    "    $clock = [Diagnostics.Stopwatch]::StartNew()",
    "    while (-not [IO.File]::Exists($Stop) -and $clock.ElapsedMilliseconds -lt 60000) { [Threading.Thread]::Sleep(20) }",
    "} finally { $stream.Dispose() }",
  ].join("\r\n") + "\r\n");
  const run = runTests(root, join(fixture.root, "held.test.ts"));
  let holder: ReturnType<typeof Bun.spawn> | undefined;
  let log = "";
  try {
    await until(cwdFile);
    log = join(project, "tmp", basename(await readFile(cwdFile, "utf8")) + ".log");
    holder = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", log, "-Ready", ready, "-Stop", stop],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe", windowsHide: true });
    await until(ready);
    await writeFile(release, "");
    const held = await run;
    expect(held.code, held.output).toBe(0);
    expect(held.output).toContain(`测试日志清理失败，保留 ${log}`);
    expect(await readdir(root)).toEqual([]);
    expect(existsSync(log)).toBe(true);
  } finally {
    // Release the nested run and the holder, and wait for both before removing anything.
    await writeFile(release, ""); await writeFile(stop, "");
    if (holder) {
      const kill = setTimeout(() => holder!.kill(), 20000);
      await holder.exited;
      clearTimeout(kill);
    }
    await run;
    if (log) await rm(log, { force: true });
    await fixture.cleanup();
  }
}, 120000);
