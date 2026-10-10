// Give tests an isolated cwd; never load a developer's data/config or write live state.
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import { release, tmpdir } from "node:os";
const project = fileURLToPath(new URL("../", import.meta.url));
// 工作根目录：MIXIN_TEST_WORK_ROOT 优先；WSL 默认用 Linux 文件系统中的 /tmp/mixin-tests（仓库常在 /mnt/<盘符>，
// DrvFs 上 chmod 是否生效取决于挂载元数据）；Windows 用系统临时目录，避免工作区扫描打开后代目录干扰重命名；其余平台用项目 tmp/。
const wsl = process.platform === "linux" && release().toLowerCase().includes("microsoft");
const requestedRoot = resolve(process.env.MIXIN_TEST_WORK_ROOT || (wsl ? "/tmp/mixin-tests" : process.platform === "win32" ? tmpdir() : join(project, "tmp")));
await mkdir(requestedRoot, { recursive: true });
// Windows TEMP may contain an 8.3 alias (RUNNER~1 on CI). Give cwd and every fixture environment variable
// the same physical spelling used by realpath/native handles, before any test builds a path or an ownership receipt.
const root = process.platform === "win32" ? await realpath(requestedRoot) : requestedRoot;
const cwd = await mkdtemp(join(root, "tests-"));

// 权限测试断言 0600；工作目录不支持 POSIX 权限时这些断言没有意义，运行前就拒绝。
// 读回两种权限，排除挂载参数把所有文件报成同一权限的情况。
if (process.platform !== "win32") {
  const probe = join(cwd, "mode-probe");
  await writeFile(probe, "");
  const readBack = async (mode: number) => { await chmod(probe, mode); return (await stat(probe)).mode & 0o777; };
  const [owner, group] = [await readBack(0o600), await readBack(0o640)];
  if (owner !== 0o600 || group !== 0o640) {
    await rm(cwd, { recursive: true, force: true });
    console.error(`测试工作根目录 ${root} 不支持 POSIX 权限：chmod 0600 后读回 0${owner.toString(8)}，chmod 0640 后读回 0${group.toString(8)}。`
      + "请把 MIXIN_TEST_WORK_ROOT 设为 Linux 文件系统中的目录，例如 /tmp/mixin-tests。");
    process.exit(1);
  }
  await rm(probe);
}

const fixtures = join(cwd, "fixtures");
await mkdir(fixtures);
// 夹具归档到本次工作目录的 trash/，不进项目的 backup/rm：成功后随工作目录删除，失败时作为现场保留。
const trash = join(cwd, "trash");
// 诊断日志总在项目 tmp/，与工作目录同名：工作目录在 WSL 的 /tmp 下时，Windows 侧也能直接打开。
await mkdir(join(project, "tmp"), { recursive: true });
const log = join(project, "tmp", basename(cwd) + ".log");
const logFile = openSync(log, "wx");
const args = process.argv.slice(2);
writeSync(logFile, `工作目录 ${cwd}\n参数 ${JSON.stringify(args)}\n开始 ${new Date().toISOString()}\n\n`);
// 测试文件可以相对项目，也可以是绝对路径；其余参数原样交给 bun test。
const targets = args.filter(arg => !arg.startsWith("-") && existsSync(resolve(project, arg)));
const child = Bun.spawn([process.execPath, "test", ...(targets.length ? [] : [join(project, "tests")]),
  ...args.map(arg => targets.includes(arg) ? resolve(project, arg) : arg)], { cwd, env: { ...process.env, TEMP: fixtures, TMP: fixtures, TMPDIR: fixtures,
  TEST_TEMP_ROOT: fixtures, TEST_TRASH_DIR: trash, GROUP_DATA_ROOT: "data/groups" },
  stdin: "inherit", stdout: "pipe", stderr: "pipe", windowsHide: true });
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
// 输出照常显示，同时写入诊断日志。
let logOpen = true;
async function relay(stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) {
  for await (const chunk of stream) { target.write(chunk); if (logOpen) writeSync(logFile, chunk); }
}
const relayed = Promise.all([relay(child.stdout, process.stdout), relay(child.stderr, process.stderr)]);
const code = await child.exited;
// 测试遗留的子进程可能还占着输出管道：稍等片刻，仍未关闭就不再等待，在日志中注明。
// 定时器无论怎样结束都要清除，否则正常结束的运行也会被它拖满整段等待。
let grace: ReturnType<typeof setTimeout> | undefined;
let drained: boolean;
try {
  drained = await Promise.race([relayed.then(() => true), new Promise<boolean>(done => { grace = setTimeout(done, 5000, false); })]);
} finally { clearTimeout(grace); }
if (!drained) {
  const message = "测试进程已退出，但仍有进程占用输出管道（可能是测试遗留的子进程），不再等待其输出。";
  console.warn(message);
  writeSync(logFile, `\n${message}\n`);
}
writeSync(logFile, `\n退出码 ${code}，结束 ${new Date().toISOString()}\n`);
logOpen = false;
closeSync(logFile);

// 跑通了就删掉本次的隔离工作目录和日志，失败则保留现场并打印路径。
//
// 不删的话这里每跑一次就多一个 tests-xxxxxx，攒到几十个之后 tmp/ 变成一片噪音，
// 而真正要用的东西——上一次失败留下的那个目录——反而找不着了。Windows 上子进程退出后
// 句柄可能还没释放，日志也可能正被别的程序打开查看：重试几次再放弃，保留并提示路径。
// 工作目录和日志各自清理，一个失败不影响另一个，也不改变测试本身的退出码。
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
if (code === 0) {
  await remove(cwd, "测试工作目录");
  await remove(log, "测试日志");
} else {
  console.error(`测试工作目录保留在 ${cwd}`);
  console.error(`诊断日志 ${log}`);
}
// 仍被占用的管道会让进程一直等下去，这时直接退出。
if (drained) process.exitCode = code;
else process.exit(code);
