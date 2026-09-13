// Give tests an isolated cwd; never load a developer's data/config or write live state.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
const project = fileURLToPath(new URL("../", import.meta.url));
const parent = join(project, "tmp");
await mkdir(parent, { recursive: true });
const cwd = await mkdtemp(join(parent, "tests-"));
const fixtures = join(cwd, "fixtures");
await mkdir(fixtures);
const args = process.argv.slice(2);
const targets = args.filter(arg => !arg.startsWith("-") && existsSync(join(project, arg)));
const child = Bun.spawn([process.execPath, "test", ...(targets.length ? [] : [join(project, "tests")]),
  ...args.map(arg => targets.includes(arg) ? join(project, arg) : arg)], { cwd, env: { ...process.env, TEMP: fixtures, TMP: fixtures, TMPDIR: fixtures,
  TEST_TEMP_ROOT: fixtures, TEST_TRASH_DIR: join(project, "backup/rm"), GROUP_DATA_ROOT: "data/groups" },
  stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
const code = await child.exited;

// 跑通了就删掉本次的隔离工作目录，失败则保留现场并打印路径。
//
// 不删的话这里每跑一次就多一个 tests-xxxxxx，攒到几十个之后 tmp/ 变成一片噪音，
// 而真正要用的东西——上一次失败留下的那个目录——反而找不着了。Windows 上子进程退出后
// 句柄可能还没释放，重试几次再放弃。
if (code === 0) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(cwd, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) { console.warn(`测试工作目录清理失败，保留 ${cwd}: ${String(error)}`); break; }
      await Bun.sleep(50);
    }
  }
} else {
  console.error(`测试工作目录保留在 ${cwd}`);
}
process.exitCode = code;
