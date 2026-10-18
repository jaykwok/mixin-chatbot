import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";
import { defaultJobs, measuredWeights, mergeJunit, parseOptions, partition, recordWeights, summarize, testFiles, timingKey } from "../../scripts/test.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const gitBash = process.platform === "win32" ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
  .filter((path): path is string => !!path).map(path => join(path, "Git", "bin", "bash.exe")).find(existsSync) : undefined;

async function runTests(root: string | undefined, file: string | string[], overrides: NodeJS.ProcessEnv = {}) {
  const started = performance.now();
  const env = { ...process.env, ...overrides };
  if (root === undefined) delete env.MIXIN_TEST_WORK_ROOT;
  else env.MIXIN_TEST_WORK_ROOT = root;
  // Bun's agent mode (set by coding agents) leaves out the "(pass)" lines these tests read.
  delete env.CLAUDECODE; delete env.AI_AGENT;
  const child = Bun.spawn([process.execPath, join(project, "scripts/test.ts"), ...(Array.isArray(file) ? file : [file])], {
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

test.skipIf(!gitBash)("Git Bash /tmp survives retirement of another live shell's temporary fixture", async () => {
  const fixture = await tempFixture("test-runner-msys-");
  const firstTemp = join(fixture.root, "first"), nextTemp = join(fixture.root, "next");
  await mkdir(firstTemp); await mkdir(nextTemp);
  const environment = (tmp: string) => ({ ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp });
  const first = Bun.spawn([gitBash!, "--noprofile", "--norc", "-c", 'printf "ready\\n"; read -r'], {
    cwd: fixture.root, env: environment(firstTemp), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const reader = first.stdout.getReader();
  const deadline = setTimeout(() => first.kill(), 25000);
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    // With no runner anchor, this first shell can pin /tmp to firstTemp for
    // other MSYS processes, even though their TMP points at nextTemp.
    await rename(firstTemp, join(fixture.root, "retired"));
    const next = Bun.spawn([gitBash!, "--noprofile", "--norc", "-c", "cygpath -w /tmp; test -d /tmp"], {
      cwd: fixture.root, env: environment(nextTemp), stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [code, out, err] = await Promise.all([next.exited, new Response(next.stdout).text(), new Response(next.stderr).text()]);
    expect(code, err).toBe(0);
    expect(err).toBe("");
    expect(existsSync(out.trim())).toBe(true);
    expect(resolve(out.trim())).not.toBe(firstTemp);
  } finally {
    first.stdin.end(); await first.exited;
    clearTimeout(deadline); reader.releaseLock();
    expect(await new Response(first.stderr).text()).toBe("");
    await fixture.cleanup();
  }
}, 30000);

test.skipIf(process.platform !== "win32")("the Windows default work root uses the system temporary directory and cleans only its own run", async () => {
  const fixture = await tempFixture("test-runner-default-");
  const cwdFile = join(fixture.root, "default-cwd"), sentinel = join(fixture.root, "keep.txt"), file = join(fixture.root, "default.test.ts");
  const holderFile = join(fixture.root, "holder-pid");
  try {
    await writeFile(sentinel, "keep");
    await writeFile(file, `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("runner-default", () => {
  writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());
  writeFileSync(${JSON.stringify(holderFile)}, process.env.MIXIN_TEST_MSYS_HOLDER_PID ?? "");
});
`);
    const result = await runTests(undefined, file, { TEMP: fixture.root, TMP: fixture.root });
    expect(result.code, result.output).toBe(0);
    const cwd = await readFile(cwdFile, "utf8");
    expect(dirname(cwd)).toBe(fixture.root);
    expect(basename(cwd)).toMatch(/^tests-/);
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(join(project, "tmp", basename(cwd) + ".log"))).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    const holder = process.env.MIXIN_TEST_MSYS_HOLDER_PID ?? "";
    if (gitBash) expect(holder).toMatch(/^[1-9]\d*$/);
    // Even with an outside Git Bash fixing /tmp, starting another holder here
    // changes the PID. This checks reuse independently of the mount probe.
    expect(await readFile(holderFile, "utf8")).toBe(holder);
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
import { buildLocalTools } from ${JSON.stringify(fileURLToPath(new URL("../helpers/native-tools.ts", import.meta.url)))};
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
    const timings = join(fixture.root, "timings.json"), old = { version: 1, files: { [timingKey(file)]: 17 } };
    await writeFile(timings, JSON.stringify(old));
    const result = await runTests(join(fixture.root, "work"), [file, `--record-timings=${timings}`]);
    log = /诊断日志 (.+)$/m.exec(result.output)?.[1]?.trim();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("timed out after 100ms");
    expect(result.output).toContain("(pass) next test uses original");
    expect(result.output).toContain("1 pass");
    expect(result.output).toContain("1 fail");
    expect(result.output).not.toContain("Maximum call stack");
    expect(JSON.parse(await readFile(timings, "utf8"))).toEqual(old);
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

test("several files run as parallel groups, each its own isolated run; a failed group is kept, reports and times are merged", async () => {
  const fixture = await tempFixture("test-runner-jobs-");
  const root = join(fixture.root, "work"), failedLog: string[] = [];
  const marker = (name: string) => join(fixture.root, `${name}-cwd`), file = (name: string) => join(fixture.root, `${name}.test.ts`);
  try {
    for (const name of ["a", "b", "c"]) {
      await writeFile(file(name), `import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
test("runner-${name}", () => { writeFileSync(${JSON.stringify(marker(name))}, process.cwd()); expect(${JSON.stringify(name)}).not.toBe("c"); });
`);
    }
    const junit = join(fixture.root, "reports", "junit.xml"), timings = join(fixture.root, "timings.json");
    const result = await runTests(root, [...["a", "b", "c"].map(file), "--jobs=2", "--reporter=junit", `--reporter-outfile=${junit}`, `--record-timings=${timings}`]);
    expect(result.code, result.output).toBe(1);
    // No recorded times: equal weights, by name onto the least loaded group, so a and c share the first group.
    const [a, b, c] = await Promise.all(["a", "b", "c"].map(name => readFile(marker(name), "utf8")));
    expect(a).toBe(c!); expect(b).not.toBe(a!);
    for (const cwd of [a!, b!]) expect(dirname(cwd)).toBe(root);
    expect(result.output).toContain("测试分 2 组并行");
    expect(result.output).toContain("2 通过、0 跳过、1 失败（3 个测试，3 个文件）");
    expect(result.output).toContain("失败的组：第 1 组（退出码 1）");
    const kept = /测试工作目录保留在 (.+)$/m.exec(result.output)?.[1]?.trim() ?? "";
    const log = /诊断日志 (.+)$/m.exec(result.output)?.[1]?.trim() ?? "";
    if (log) failedLog.push(log);
    expect(kept).toBe(a!);
    expect(existsSync(join(kept, "fixtures"))).toBe(true);
    expect(await readdir(root)).toEqual([basename(kept)]);
    expect(log).toBe(join(project, "tmp", basename(kept) + ".log"));
    // Without a --timeout of the caller's, tests that set none get 20 s instead of bun's 5 s.
    for (const part of ["runner-c", "--timeout=20000"]) expect(await readFile(log, "utf8")).toContain(part);
    expect(existsSync(join(project, "tmp", basename(b!) + ".log"))).toBe(false);
    const report = await readFile(junit, "utf8");
    expect(report).toMatch(/<testsuites name="bun test" tests="3" assertions="\d+" failures="1" skipped="0"/);
    for (const name of ["runner-a", "runner-b", "runner-c"]) expect(report).toContain(`name="${name}"`);
    const recorded = JSON.parse(await readFile(timings, "utf8")) as { version: number; files: Record<string, number> };
    expect(recorded.version).toBe(1);
    expect(Object.keys(recorded.files).sort()).toEqual(["a", "b"].map(name => timingKey(file(name))).sort());
  } finally { for (const log of failedLog) await rm(log, { force: true }); await fixture.cleanup(); }
}, 120000);

test("the runner's options: groups, recorded times, and bun test's own distribution refused", () => {
  const cwd = resolve("/work");
  expect(parseOptions(["tests/x.test.ts", "--jobs=3", "-t", "name", "--record-timings", "out.json", "--timeout=9"], cwd))
    .toEqual({ jobs: 3, record: join(cwd, "out.json"), args: ["tests/x.test.ts", "-t", "name", "--timeout=9"] });
  expect(parseOptions(["--jobs", "1"], cwd)).toEqual({ jobs: 1, args: [] });
  for (const bad of [["--jobs=0"], ["--jobs=2.5"], ["--jobs"], ["--record-timings"]]) expect(() => parseOptions(bad, cwd)).toThrow();
  for (const owned of ["--parallel=4", "--shard=1/2", "--timings=x.json", "--update-timings"]) expect(() => parseOptions([owned], cwd)).toThrow("--jobs");
  expect([1, 2, 4, 12, 64].map(cores => defaultJobs(cores, "win32"))).toEqual([1, 1, 3, 4, 4]);
  for (const platform of ["linux", "darwin"] as const) expect([1, 2, 4, 12, 64].map(cores => defaultJobs(cores, platform))).toEqual([1, 1, 3, 6, 6]);
});

test("recording with dots keeps its output and only passing files, including XML-escaped paths", async () => {
  const fixture = await tempFixture("test-runner-record-");
  let log: string | undefined;
  try {
    const good = join(fixture.root, "good & 中文.test.ts"), skipped = join(fixture.root, "skipped.test.ts"), broken = join(fixture.root, "broken.test.ts");
    await writeFile(good, 'import { describe, expect, test } from "bun:test"; describe("nested & suite", () => { test("pass", () => expect(1).toBe(1)); });');
    await writeFile(skipped, 'import { test } from "bun:test"; test.skip("not run", () => {});');
    await writeFile(broken, 'throw new Error("deliberate import failure");');
    const timings = join(fixture.root, "timings.json");
    const result = await runTests(join(fixture.root, "work"), [good, skipped, broken, "--jobs=1", "--reporter=dots", `--record-timings=${timings}`]);
    log = /诊断日志 (.+)$/m.exec(result.output)?.[1]?.trim();
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("deliberate import failure");
    expect(result.output).not.toContain("(pass)");
    const recorded = JSON.parse(await readFile(timings, "utf8")) as { files: Record<string, number> };
    expect(Object.keys(recorded.files)).toEqual([timingKey(good)]);
    expect(Number.isInteger(recorded.files[timingKey(good)])).toBe(true);
  } finally { if (log) await rm(log, { force: true }); await fixture.cleanup(); }
}, 30000);

test("groups balance recorded times, give unrecorded files the median, and hold every file exactly once", () => {
  const base = resolve("/project"), path = (name: string) => join(base, "tests", `${name}.test.ts`);
  const files = ["a", "b", "c", "d", "e"].map(path);
  const weights = { "tests/a.test.ts": 50, "tests/b.test.ts": 40, "tests/c.test.ts": 30, "tests/d.test.ts": 20 };
  // e weighs the median, 40. Longest first onto the least loaded group: a | b, e | c onto a | d onto the first of two equal.
  expect(partition(files, weights, 2, base)).toEqual([["a", "c", "d"].map(path), ["b", "e"].map(path)]);
  expect(partition(files, weights, 9, base)).toHaveLength(5);
  expect(partition([...files].reverse(), {}, 3, base).flat().sort()).toEqual(files);
  expect(timingKey(path("a"), base)).toBe("tests/a.test.ts");
  expect(timingKey(resolve("/elsewhere/x.test.ts"), base)).toBe(resolve("/elsewhere/x.test.ts").replaceAll("\\", "/"));
});

test("test files, times and reports: Bun's file names, cwd-relative times recorded per project file, merged JUnit", async () => {
  const fixture = await tempFixture("test-runner-parts-");
  try {
    const tests = join(fixture.root, "project", "tests");
    for (const name of ["a.test.ts", "deep/b_spec.ts", "helper.ts", "node_modules/c.test.ts"]) {
      await mkdir(dirname(join(tests, name)), { recursive: true }); await writeFile(join(tests, name), "");
    }
    expect(testFiles(["tests"], join(fixture.root, "project"))).toEqual([join(tests, "a.test.ts"), join(tests, "deep", "b_spec.ts")]);
    expect(testFiles([join(tests, "helper.ts")])).toEqual([join(tests, "helper.ts")]);

    // bun test --timings writes keys relative to its cwd, or absolute on another drive.
    const base = join(fixture.root, "project"), cwd = join(fixture.root, "run"), outside = join(fixture.root, "other.test.ts");
    const output = join(fixture.root, "bun-timings.json");
    await writeFile(output, JSON.stringify({ version: 1, files: { "../project/tests/a.test.ts": 1234.4, [outside]: 10, "../project/tests/bad.test.ts": "x" } }));
    const report = `<testsuites><testsuite file="../project/tests/a.test.ts" tests="1" failures="0"/><testsuite file="${outside}" tests="1" failures="0"/></testsuites>`;
    const measured = await measuredWeights(output, cwd, report, base);
    expect(measured).toEqual({ "tests/a.test.ts": 1234, [timingKey(outside, base)]: 10 });
    const table = join(fixture.root, "table", "linux.json");
    await mkdir(dirname(table)); await writeFile(table, JSON.stringify({ version: 1, files: { "tests/old.test.ts": 5, "tests/a.test.ts": 1 } }));
    await recordWeights(table, measured);
    const recorded = JSON.parse(await readFile(table, "utf8"));
    expect(recorded).toEqual({ version: 1, files: { [timingKey(outside, base)]: 10, "tests/a.test.ts": 1234, "tests/old.test.ts": 5 } });
    expect(Object.keys(recorded.files)).toEqual(Object.keys(recorded.files).sort());
    expect(await readdir(dirname(table))).toEqual(["linux.json"]);
    for (const invalid of ["", report.replace("</testsuites>", ""), report.replaceAll('failures="0"', 'failures="1"'),
      report.replaceAll('tests="1"', 'tests="1" skipped="1"'), report.replaceAll('tests="1"', 'tests="1" errors="1"')]) {
      expect(await measuredWeights(output, cwd, invalid, base)).toEqual({});
    }
    // A nested passing suite cannot erase a failure in the enclosing suite for the same file.
    const nested = report.replace('<testsuite file="../project/tests/a.test.ts" tests="1" failures="0"/>',
      '<testsuite file="../project/tests/a.test.ts" tests="2" failures="1"><testsuite file="../project/tests/a.test.ts" tests="1" failures="0"/></testsuite>');
    expect(await measuredWeights(output, cwd, nested, base)).toEqual({ [timingKey(outside, base)]: 10 });

    const suite = (name: string, failures: number) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="3" failures="${failures}" skipped="1" time="1.5">
  <testsuite name="${name}" tests="2" assertions="3" failures="${failures}" skipped="1" time="1.5">
    <testcase name="${name}-case" classname="" time="0.1" />
  </testsuite>
</testsuites>
`;
    const merged = mergeJunit([suite("first", 0), suite("second", 1)], 2.25);
    expect(merged).toContain('<testsuites name="bun test" tests="4" assertions="6" failures="1" skipped="2" time="2.25">');
    expect(merged.match(/<testsuite /g)).toHaveLength(2);
    expect(merged.trimEnd().endsWith("</testsuites>")).toBe(true);
    expect(() => mergeJunit(["not a report"], 1)).toThrow();

    expect(summarize("\x1b[32m 5 pass\x1b[0m\n 2 skip\n 1 fail\n 9 expect() calls\nRan 8 tests across 3 files. [1.00s]\n"))
      .toEqual({ pass: 5, skip: 2, fail: 1, tests: 8, files: 3 });
    expect(summarize("crashed before any summary")).toBeUndefined();
  } finally { await fixture.cleanup(); }
});

test("the committed timing tables name project test files with whole milliseconds", () => {
  for (const platform of ["linux", "win32"]) {
    const table = JSON.parse(readFileSync(join(project, "tests", "timings", `${platform}.json`), "utf8")) as { version: number; files: Record<string, unknown> };
    expect(table.version).toBe(1);
    for (const [key, ms] of Object.entries(table.files)) {
      expect(key).toMatch(/^tests\/[\w./-]+\.test\.ts$/);
      expect(Number.isInteger(ms) && (ms as number) >= 0, key).toBe(true);
    }
  }
});
