// Give tests an isolated cwd; never load a developer's data/config or write live state.
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, existsSync, openSync, statSync, writeSync } from "node:fs";
import { availableParallelism, release, tmpdir } from "node:os";
const project = fileURLToPath(new URL("../", import.meta.url));

// 分组并行：测试文件按耗时分成几组，每组都是一次完整的隔离运行（各自的工作目录、夹具、TEMP 和诊断日志），各组同时进行。
// 不用 bun test --parallel：它的 worker 共用一个 cwd，而 data/groups、logs/ 等路径相对 cwd，会互相干扰。
// 耗时表只影响各组是否均衡，不影响运行哪些测试：仓库里的 tests/timings/<平台>.json 是基础，
// 本机多组运行实测的耗时记在 tmp/test-timings-<平台>.json，优先使用。

/** Bun's default test file names. */
const TEST_FILES = "**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}";
/** bun test options that may take their value as the next argument (`--timeout 5000`). */
const VALUE_OPTIONS = new Set(["-t", "--test-name-pattern", "--timeout", "--rerun-each", "--retry", "--seed", "--max-concurrency",
  "--reporter", "--reporter-outfile", "--coverage-reporter", "--coverage-dir", "--path-ignore-patterns", "--preload", "-r"]);
/** Runs of only part of each file, or cut short: their durations would mislead the balance. */
const PARTIAL_OPTIONS = ["-t", "--test-name-pattern", "--only", "--todo", "--rerun-each", "--bail"];
/** bun test's own distribution and timing options; this runner distributes and records instead. */
const OWNED_OPTIONS = ["--parallel", "--shard", "--timings", "--update-timings"];
// 未写超时的测试默认 5 秒即判失败。启动 Bun 子进程的测试在有安全软件扫描的 Windows 上本来就要 3 秒以上，
// 与其他组同时启动进程时更慢；默认改为 20 秒，只放宽挂死时的看门狗，不影响通过的测试。调用者给了 --timeout 时照用。
const DEFAULT_TIMEOUT = "--timeout=20000";

export type Weights = Record<string, number>;
export interface Options { jobs?: number; record?: string; args: string[] }

/** --jobs and --record-timings belong to this runner; everything else goes to bun test. */
export function parseOptions(argv: string[], cwd = process.cwd()): Options {
  const options: Options = { args: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!, equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals > 0 ? arg.slice(0, equals) : arg;
    if (name === "--jobs" || name === "--record-timings") {
      const value = equals > 0 ? arg.slice(equals + 1) : argv[++i];
      if (!value) throw new Error(`${name} 需要取值`);
      if (name === "--jobs") options.jobs = jobCount(value, "--jobs");
      else options.record = resolve(cwd, value);
    } else if (OWNED_OPTIONS.includes(name)) {
      throw new Error(`${name} 由 scripts/test.ts 接管：用 --jobs=<组数> 分组并行，用 --record-timings=<文件> 记录逐文件耗时。`);
    } else options.args.push(arg);
  }
  return options;
}

function jobCount(value: string, source: string): number {
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`${source} 应为正整数：${value}`);
  return jobs;
}

/** Tests spawn many processes: leave one core free, with a lower Windows cap. Explicit --jobs still wins. */
export function defaultJobs(cores = availableParallelism(), platform: NodeJS.Platform = process.platform): number {
  return Math.max(1, Math.min(platform === "win32" ? 4 : 6, cores - 1));
}

/** Project-relative POSIX key of a test file inside the project; its absolute POSIX path otherwise. */
export function timingKey(file: string, base = project): string {
  const path = resolve(file), inside = relative(base, path);
  return (inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path).replaceAll("\\", "/");
}

/** Test files under the targets (files as given, directories expanded with Bun's file names), sorted and unique. */
export function testFiles(targets: string[], base = project): string[] {
  const found = new Set<string>();
  for (const target of targets) {
    const path = resolve(base, target);
    if (!statSync(path).isDirectory()) { found.add(path); continue; }
    for (const file of new Bun.Glob(TEST_FILES).scanSync({ cwd: path, absolute: true, onlyFiles: true })) {
      if (!file.split(/[\\/]/).includes("node_modules")) found.add(resolve(file));
    }
  }
  return [...found].sort();
}

/** Longest first onto the least loaded group; a file without a recorded time weighs the median. Deterministic. */
export function partition(files: string[], weights: Weights, jobs: number, base = project): string[][] {
  const weight = (file: string) => { const ms = weights[timingKey(file, base)]; return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined; };
  const known = files.map(weight).filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)]! : 1;
  const items = files.map(file => ({ file, ms: weight(file) ?? fallback })).sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : 1));
  const groups = Array.from({ length: Math.max(1, Math.min(jobs, files.length)) }, () => ({ files: [] as string[], ms: 0 }));
  for (const item of items) {
    let target = groups[0]!;
    for (const group of groups) if (group.ms < target.ms) target = group;
    target.files.push(item.file); target.ms += item.ms;
  }
  return groups.map(group => group.files.sort());
}

/** Merged per-file times; later files override earlier ones. A missing file is skipped, a damaged one only warned about. */
export async function readWeights(paths: string[]): Promise<Weights> {
  const weights: Weights = {};
  for (const path of paths) {
    let parsed: { files?: Record<string, unknown> };
    try { parsed = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`耗时表 ${path} 无法读取，不影响测试，只影响分组均衡：${String(error)}`);
      continue;
    }
    for (const [key, ms] of Object.entries(parsed?.files ?? {})) if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) weights[key] = ms;
  }
  return weights;
}

/** Bun JUnit repeats file attributes for nested suites. Any failing suite rejects the whole file. */
function passedFiles(report: string, cwd: string, base: string): Set<string> {
  const passed = new Set<string>(), rejected = new Set<string>();
  // A missing or interrupted report cannot confirm that any file finished successfully.
  if (!/<testsuites\b/.test(report) || !report.trimEnd().endsWith("</testsuites>")) return passed;
  const decode = (value: string) => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(entity[1] === "x" ? 2 : 1), entity[1] === "x" ? 16 : 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity]!;
  });
  for (const suite of report.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attributes = Object.fromEntries([...suite[1]!.matchAll(/\b([\w-]+)="([^"]*)"/g)].map(match => [match[1]!, match[2]!]));
    if (!attributes.file) continue;
    const key = timingKey(resolve(cwd, decode(attributes.file)), base);
    if (attributes.failures !== "0" || Number(attributes.errors ?? 0) !== 0) rejected.add(key);
    else if (Number(attributes.tests) > Number(attributes.skipped ?? 0)) passed.add(key);
  }
  return passed.difference(rejected);
}

/** Record only completed passing files; failed/skipped/unreported files retain their previous weights. */
export async function measuredWeights(path: string, cwd: string, report: string, base = project): Promise<Weights> {
  const passed = passedFiles(report, cwd, base);
  const measured: Weights = {};
  for (const [key, ms] of Object.entries((await readWeights([path])))) {
    const normalized = timingKey(resolve(cwd, key), base);
    if (passed.has(normalized)) measured[normalized] = Math.round(ms);
  }
  return measured;
}

/** Merge measured times into a timing table and replace it whole. */
export async function recordWeights(path: string, measured: Weights): Promise<void> {
  const merged = { ...await readWeights([path]), ...measured };
  const files = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, files }, null, 2) + "\n");
  try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** One <testsuites> for the groups' Bun JUnit reports: counts summed, time is the whole run's wall time. */
export function mergeJunit(reports: string[], seconds: number): string {
  const totals = { tests: 0, assertions: 0, failures: 0, skipped: 0 };
  const suites: string[] = [];
  for (const report of reports) {
    const open = /<testsuites\b([^>]*)>/.exec(report), close = report.lastIndexOf("</testsuites>");
    if (!open || close < open.index) throw new Error("JUnit 报告格式无法识别");
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += Number(new RegExp(`\\b${key}="(\\d+)"`).exec(open[1]!)?.[1] ?? 0);
    const body = report.slice(open.index + open[0].length, close).replace(/^\s*\n|\s+$/g, "");
    if (body) suites.push(body);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${totals.tests}" assertions="${totals.assertions}"`
    + ` failures="${totals.failures}" skipped="${totals.skipped}" time="${seconds}">\n${suites.join("\n")}\n</testsuites>\n`;
}

export interface Summary { pass: number; skip: number; fail: number; tests?: number; files?: number }
/** Counts from bun test's closing summary, if it printed one. */
export function summarize(output: string): Summary | undefined {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const count = (word: string) => { const match = [...text.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "gm"))].at(-1); return match ? Number(match[1]) : undefined; };
  const ran = [...text.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gm)].at(-1);
  const pass = count("pass"), fail = count("fail");
  if (pass === undefined && fail === undefined && !ran) return undefined;
  return { pass: pass ?? 0, skip: count("skip") ?? 0, fail: fail ?? 0,
    ...(ran ? { tests: Number(ran[1]), files: Number(ran[2]) } : {}) };
}

interface Run { cwd: string; log: string; logFile: number }
interface Finished { code: number; drained: boolean; output: [NodeJS.WriteStream, Uint8Array][]; seconds: number }

/** A run's own work directory under the root, its fixtures and its diagnostic log in the project's tmp/. */
async function prepare(root: string, probe: boolean): Promise<Run> {
  const cwd = await mkdtemp(join(root, "tests-"));
  // 权限测试断言 0600；工作目录不支持 POSIX 权限时这些断言没有意义，运行前就拒绝。
  // 读回两种权限，排除挂载参数把所有文件报成同一权限的情况。各组共用同一个工作根目录，只在第一组检查。
  if (probe && process.platform !== "win32") {
    const path = join(cwd, "mode-probe");
    await writeFile(path, "");
    const readBack = async (mode: number) => { await chmod(path, mode); return (await stat(path)).mode & 0o777; };
    const [owner, group] = [await readBack(0o600), await readBack(0o640)];
    if (owner !== 0o600 || group !== 0o640) {
      await rm(cwd, { recursive: true, force: true });
      console.error(`测试工作根目录 ${root} 不支持 POSIX 权限：chmod 0600 后读回 0${owner.toString(8)}，chmod 0640 后读回 0${group.toString(8)}。`
        + "请把 MIXIN_TEST_WORK_ROOT 设为 Linux 文件系统中的目录，例如 /tmp/mixin-tests。");
      process.exit(1);
    }
    await rm(path);
  }
  await mkdir(join(cwd, "fixtures"));
  // 诊断日志总在项目 tmp/，与工作目录同名：工作目录在 WSL 的 /tmp 下时，Windows 侧也能直接打开。
  await mkdir(join(project, "tmp"), { recursive: true });
  const log = join(project, "tmp", basename(cwd) + ".log");
  return { cwd, log, logFile: openSync(log, "wx") };
}

/** bun test in the run's cwd. Live output goes straight to the console; otherwise it is kept for printing afterwards. */
async function execute(run: Run, args: string[], live: boolean, children: Set<ReturnType<typeof Bun.spawn>>): Promise<Finished> {
  const started = performance.now();
  // 夹具归档到本次工作目录的 trash/，不进项目的 backup/rm：成功后随工作目录删除，失败时作为现场保留。
  const fixtures = join(run.cwd, "fixtures"), trash = join(run.cwd, "trash");
  writeSync(run.logFile, `工作目录 ${run.cwd}\n参数 ${JSON.stringify(args)}\n开始 ${new Date().toISOString()}\n\n`);
  const child = Bun.spawn([process.execPath, "test", ...args], { cwd: run.cwd, env: { ...process.env, TEMP: fixtures, TMP: fixtures,
    TMPDIR: fixtures, TEST_TEMP_ROOT: fixtures, TEST_TRASH_DIR: trash, GROUP_DATA_ROOT: "data/groups" },
    stdin: "inherit", stdout: "pipe", stderr: "pipe", windowsHide: true });
  children.add(child);
  // 输出照常显示（或留待该组结束后整体显示），同时写入诊断日志。
  const output: [NodeJS.WriteStream, Uint8Array][] = [];
  let logOpen = true;
  async function relay(stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) {
    for await (const chunk of stream) {
      if (live) target.write(chunk); else output.push([target, chunk]);
      if (logOpen) writeSync(run.logFile, chunk);
    }
  }
  const relayed = Promise.all([relay(child.stdout, process.stdout), relay(child.stderr, process.stderr)]);
  const code = await child.exited;
  children.delete(child);
  // 测试遗留的子进程可能还占着输出管道：稍等片刻，仍未关闭就不再等待，在日志中注明。
  // 定时器无论怎样结束都要清除，否则正常结束的运行也会被它拖满整段等待。
  let grace: ReturnType<typeof setTimeout> | undefined;
  let drained: boolean;
  try {
    drained = await Promise.race([relayed.then(() => true), new Promise<boolean>(done => { grace = setTimeout(done, 5000, false); })]);
  } finally { clearTimeout(grace); }
  if (!drained) {
    const message = "测试进程已退出，但仍有进程占用输出管道（可能是测试遗留的子进程），不再等待其输出。";
    if (live) console.warn(message); else output.push([process.stderr, new TextEncoder().encode(message + "\n")]);
    writeSync(run.logFile, `\n${message}\n`);
  }
  writeSync(run.logFile, `\n退出码 ${code}，结束 ${new Date().toISOString()}\n`);
  logOpen = false;
  closeSync(run.logFile);
  return { code, drained, output, seconds: (performance.now() - started) / 1000 };
}

// 跑通了就删掉本次的隔离工作目录和日志，失败则保留现场并返回要打印的路径。
//
// 不删的话这里每跑一次就多一个 tests-xxxxxx，攒到几十个之后 tmp/ 变成一片噪音，
// 而真正要用的东西——上一次失败留下的那个目录——反而找不着了。Windows 上子进程退出后
// 句柄可能还没释放，日志也可能正被别的程序打开查看：重试几次再放弃，保留并提示路径。
// 工作目录和日志各自清理，一个失败不影响另一个，也不改变测试本身的退出码。
async function settle(run: Run, code: number): Promise<string[]> {
  if (code !== 0) return [`测试工作目录保留在 ${run.cwd}`, `诊断日志 ${run.log}`];
  await remove(run.cwd, "测试工作目录");
  await remove(run.log, "测试日志");
  return [];
}
async function remove(path: string, label: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) { console.warn(`${label}清理失败，保留 ${path}: ${String(error)}`); return; }
      await Bun.sleep(50);
    }
  }
}

/** Git Bash shares its usertemp mount between live MSYS processes. Keep the
 * runner's TEMP mounted before any short-lived fixture can become /tmp. */
async function holdWindowsTemp(): Promise<(() => Promise<void>) | undefined> {
  if (process.platform !== "win32") return;
  const marker = "MIXIN_TEST_MSYS_HOLDER_PID", inherited = process.env[marker];
  // The outer runner holds the mount through all of its children, including
  // nested runners. Reuse its live holder instead of starting one per runner.
  if (inherited && /^[1-9]\d*$/.test(inherited)) {
    try { process.kill(Number(inherited), 0); return; } catch { /* stale marker: start our own */ }
  }
  const bash = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter((path): path is string => !!path).map(path => join(path, "Git", "bin", "bash.exe")).find(existsSync);
  // This is specific to Git for Windows; other shells do not use its usertemp mount.
  if (!bash) return;
  const child = Bun.spawn([bash, "--noprofile", "--norc", "-c", 'printf "ready\\n"; read -r'], {
    cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = async () => {
    child.stdin.end();
    try {
      await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error("Git Bash 临时目录保持进程未退出")); }, 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const reader = child.stdout.getReader();
  try {
    const ready = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Git Bash 临时目录保持进程启动超时")), 15000);
    })]);
    if (new TextDecoder().decode(ready.value) !== "ready\n") throw new Error("Git Bash 临时目录保持进程未就绪");
  } catch (error) {
    child.kill(); await child.exited;
    throw new Error(`${String(error)}\n${await stderr}`);
  } finally { clearTimeout(timer); reader.releaseLock(); }
  // Publish only after readiness; execute() passes this environment to every group.
  process.env[marker] = String(child.pid);
  return async () => {
    try {
      await stop();
      const warning = await stderr;
      if (warning) console.warn(warning.trimEnd());
    } finally {
      if (inherited === undefined) delete process.env[marker];
      else process.env[marker] = inherited;
    }
  };
}

/** --reporter-outfile's position and value (inline or the next argument). */
function outfileAt(args: string[]): { index: number; inline: boolean } | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--reporter-outfile=")) return { index: i, inline: true };
    if (args[i] === "--reporter-outfile" && i + 1 < args.length) return { index: i + 1, inline: false };
  }
  return undefined;
}

async function main() {
  // 工作根目录：MIXIN_TEST_WORK_ROOT 优先；WSL 默认用 Linux 文件系统中的 /tmp/mixin-tests（仓库常在 /mnt/<盘符>，
  // DrvFs 上 chmod 是否生效取决于挂载元数据）；Windows 用系统临时目录，避免工作区扫描打开后代目录干扰重命名；其余平台用项目 tmp/。
  const wsl = process.platform === "linux" && release().toLowerCase().includes("microsoft");
  const requestedRoot = resolve(process.env.MIXIN_TEST_WORK_ROOT || (wsl ? "/tmp/mixin-tests" : process.platform === "win32" ? tmpdir() : join(project, "tmp")));
  let options: Options, jobs: number;
  try {
    options = parseOptions(process.argv.slice(2));
    jobs = options.jobs ?? (process.env.MIXIN_TEST_JOBS ? jobCount(process.env.MIXIN_TEST_JOBS, "MIXIN_TEST_JOBS") : defaultJobs());
  } catch (error) { console.error((error as Error).message); process.exit(2); }
  await mkdir(requestedRoot, { recursive: true });
  // Windows TEMP may contain an 8.3 alias (RUNNER~1 on CI). Give cwd and every fixture environment variable
  // the same physical spelling used by realpath/native handles, before any test builds a path or an ownership receipt.
  const root = process.platform === "win32" ? await realpath(requestedRoot) : requestedRoot;

  // 测试文件可以相对项目，也可以是绝对路径；其余参数原样交给 bun test。
  // 既不是路径也不是选项取值的参数是 bun test 的文件名筛选，这时不分组。
  const args = [...options.args], targets = new Set<number>();
  let filtered = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("-")) { if (VALUE_OPTIONS.has(args[i]!)) i++; continue; }
    if (existsSync(resolve(project, args[i]!))) targets.add(i); else filtered = true;
  }
  const outfile = outfileAt(args);
  let junit: string | undefined;
  if (outfile) {
    // 相对路径按调用者的目录解析，而不是各组的临时工作目录。
    const value = outfile.inline ? args[outfile.index]!.slice("--reporter-outfile=".length) : args[outfile.index]!;
    junit = resolve(value);
    args[outfile.index] = outfile.inline ? `--reporter-outfile=${junit}` : junit;
  }
  if (!args.some(arg => arg.split("=")[0] === "--timeout")) args.push(DEFAULT_TIMEOUT);
  const partial = args.some(arg => PARTIAL_OPTIONS.includes(arg.split("=")[0]!));
  const files = filtered ? [] : testFiles(targets.size ? [...targets].map(i => args[i]!) : ["tests"]);
  const local = join(project, "tmp", `test-timings-${process.platform}.json`);
  const groups = jobs > 1 && files.length > 1
    ? partition(files, await readWeights([join(project, "tests", "timings", `${process.platform}.json`), local]), jobs) : undefined;
  const record = options.record !== undefined || (groups !== undefined && !partial);

  const children = new Set<ReturnType<typeof Bun.spawn>>();
  process.once("SIGINT", () => { for (const child of children) child.kill("SIGINT"); });
  process.once("SIGTERM", () => { for (const child of children) child.kill("SIGTERM"); });
  const dots = args.some((arg, i) => arg === "--reporter=dots" || arg === "--reporter" && args[i + 1] === "dots");
  const timingFlags = (run: Run) => record ? [`--timings=${join(run.cwd, "timings.json")}`, "--update-timings",
    ...(!junit ? [...(dots ? ["--dots"] : []), "--reporter=junit", `--reporter-outfile=${join(run.cwd, "junit.xml")}`] : [])] : [];
  const measured: Weights = {};
  const collect = async (run: Run) => {
    if (record) {
      try {
        const report = await readFile(!groups && junit ? junit : join(run.cwd, "junit.xml"), "utf8");
        Object.assign(measured, await measuredWeights(join(run.cwd, "timings.json"), run.cwd, report));
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`本组耗时未能读取：${String(error)}`); }
    }
  };
  const saveTimings = async () => {
    // 本机耗时表只记项目里的测试文件；项目外的（例如测试运行器自己的夹具）只写进明确指定的文件。
    const own = Object.fromEntries(Object.entries(measured).filter(([key]) => !isAbsolute(key)));
    const targets: [string, Weights][] = [...(groups && !partial ? [[local, own] as [string, Weights]] : []),
      ...(options.record ? [[options.record, measured] as [string, Weights]] : [])];
    for (const [path, weights] of targets) {
      if (!Object.keys(weights).length) continue;
      try { await recordWeights(path, weights); } catch (error) { console.warn(`耗时表 ${path} 未能更新：${String(error)}`); }
    }
  };

  if (!groups) {
    // 一组：与分组之前完全相同，输出实时显示。
    const run = await prepare(root, true);
    const bunArgs = [...(targets.size ? [] : [join(project, "tests")]), ...args.map((arg, i) => targets.has(i) ? resolve(project, arg) : arg), ...timingFlags(run)];
    const result = await execute(run, bunArgs, true, children);
    await collect(run);
    for (const line of await settle(run, result.code)) console.error(line);
    await saveTimings();
    // 仍被占用的管道会让进程一直等下去，这时直接退出。
    if (result.drained) process.exitCode = result.code;
    else process.exit(result.code);
    return;
  }

  const started = performance.now();
  const runs: Run[] = [];
  for (let i = 0; i < groups.length; i++) runs.push(await prepare(root, i === 0));
  // 其余参数照传；文件由分组给出，JUnit 报告先写到各组目录，最后合并。
  const shared = args.filter((_, i) => !targets.has(i) && !(outfile && (i === outfile.index || (!outfile.inline && i === outfile.index - 1))));
  console.log(`测试分 ${groups.length} 组并行（共 ${files.length} 个文件；--jobs=1 改为串行）。各组结束时依次输出，运行中的内容见各组诊断日志：`);
  runs.forEach((run, i) => console.log(`  第 ${i + 1} 组 ${groups[i]!.length} 个文件  ${run.log}`));
  const kept: string[] = [], reports: string[] = [];
  const results = await Promise.all(runs.map(async (run, i) => {
    const groupArgs = [...groups[i]!, ...shared, ...(junit ? [`--reporter-outfile=${join(run.cwd, "junit.xml")}`] : []), ...timingFlags(run)];
    const result = await execute(run, groupArgs, false, children);
    await collect(run);
    if (junit) {
      try { reports[i] = await readFile(join(run.cwd, "junit.xml"), "utf8"); }
      catch (error) { console.warn(`第 ${i + 1} 组没有 JUnit 报告：${String(error)}`); }
    }
    const lines = await settle(run, result.code);
    if (lines.length) kept.push(`第 ${i + 1} 组：`, ...lines);
    console.log(`\n────── 第 ${i + 1}/${groups.length} 组结束（${groups[i]!.length} 个文件）：退出码 ${result.code}，用时 ${result.seconds.toFixed(1)} 秒 ──────`);
    for (const [target, chunk] of result.output) target.write(chunk);
    return result;
  }));
  const seconds = (performance.now() - started) / 1000;
  if (junit) {
    try {
      await mkdir(dirname(junit), { recursive: true });
      await writeFile(junit, mergeJunit(reports.filter((report): report is string => report !== undefined), Number(seconds.toFixed(3))));
    } catch (error) { console.error(`JUnit 报告 ${junit} 未能写出：${String(error)}`); }
  }
  await saveTimings();
  const totals = { pass: 0, skip: 0, fail: 0, tests: 0, files: 0 };
  const missing: number[] = [];
  results.forEach((result, i) => {
    const summary = summarize(result.output.map(([, chunk]) => new TextDecoder().decode(chunk)).join(""));
    if (!summary) { missing.push(i + 1); return; }
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += summary[key] ?? 0;
  });
  const failed = results.flatMap((result, i) => result.code === 0 ? [] : [`第 ${i + 1} 组（退出码 ${result.code}）`]);
  console.log(`\n全部 ${groups.length} 组结束，用时 ${seconds.toFixed(1)} 秒：${totals.pass} 通过、${totals.skip} 跳过、${totals.fail} 失败`
    + `（${totals.tests} 个测试，${totals.files} 个文件）。`);
  if (missing.length) console.log(`没有测试汇总的组：${missing.map(n => `第 ${n} 组`).join("、")}。`);
  if (failed.length) console.log(`失败的组：${failed.join("、")}。`);
  for (const line of kept) console.error(line);
  const code = results.find(result => result.code !== 0)?.code ?? 0;
  if (results.every(result => result.drained)) process.exitCode = code;
  else process.exit(code);
}

if (import.meta.main) {
  const release = await holdWindowsTemp();
  try { await main(); } finally { await release?.(); }
}
