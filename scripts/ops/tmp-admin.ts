// 用户临时目录运维命令：查看与清理 <群数据总根>/<群>/users/<用户>/tmp。
//
// 之所以是一个 bun 脚本而不是写在 ops.sh / ops.ps1 里：目录布局、群/用户目录段的 sha256
// 兜底规则、GROUP_DATA_ROOT 的解析全在 src/ 里，在两个 shell 里各抄一遍等于维护三份。
// 更要紧的是「什么不能删」这条边界只能有一个定义——workspace 和 session.jsonl 是长期
// 资产，它们就在 tmp 的隔壁，一个写歪的 rm -rf 代价太大。
//
// tmp 里堆积的主要是：Pi 输出被截断时迁过来的完整日志 pi-bash-*.log、uv/pip/npm 缓存、
// 解压和格式转换的中间产物。全都可以重建，删了只是下次慢一点。
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { GROUP_DATA_ROOT } from "../../src/core/config.ts";

const DAY = 24 * 60 * 60_000;

interface Usage {
  bytes: number;
  files: number;
  /** 整棵子树里最新的修改时间。 */
  newest: number;
}

interface TmpEntry extends Usage {
  name: string;
  path: string;
}

interface UserTmp extends Usage {
  group: string;
  user: string;
  dir: string;
  entries: TmpEntry[];
}

function usage(): void {
  console.log("用法：bun run tmp <命令>");
  console.log("");
  console.log("  list                     列出每个用户临时目录的占用（大的排在前面）");
  console.log("  purge --days <天数>      只清理这些天内没有改动过的条目");
  console.log("  purge --all              清空全部用户临时目录（等价于 --days 0）");
  console.log("");
  console.log("  两条 purge 都可加 --user <手机号> 只处理一个用户。");
  console.log("  只删除 tmp 里面的内容，tmp 目录本身、workspace 和 session.jsonl 都不动。");
}

function describeAge(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 用 lstat 而不是 stat：符号链接按它自己算，不跟进去。tmp 里出现一条指向 workspace 的
 * 链接时，既不该把 workspace 的体积算进来，更不该让它进入删除范围——rm 删的是链接本身。
 */
async function measure(path: string): Promise<Usage> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    // 正在跑的任务随时可能删掉自己的中间文件，扫描期间消失属于正常。
    return { bytes: 0, files: 0, newest: 0 };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return { bytes: info.size, files: 1, newest: info.mtimeMs };
  }

  let children: string[] = [];
  try {
    children = (await readdir(path, { withFileTypes: true })).map((child) => child.name);
  } catch {
    return { bytes: 0, files: 0, newest: info.mtimeMs };
  }
  const total: Usage = { bytes: 0, files: 0, newest: info.mtimeMs };
  for (const name of children) {
    const child = await measure(join(path, name));
    total.bytes += child.bytes;
    total.files += child.files;
    total.newest = Math.max(total.newest, child.newest);
  }
  return total;
}

async function readDirNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 扫描所有群下所有用户的 tmp。找不到目录就是还没人在这个群里用过工具，不是错误。
 *
 * root 显式传入而不是直接用 GROUP_DATA_ROOT：那个常量在模块加载时就定死了，测试没法
 * 在导入之后再改环境变量，而这个命令删文件，必须能在真实目录树上测。
 */
export async function collect(
  userFilter?: string,
  root: string = GROUP_DATA_ROOT
): Promise<UserTmp[]> {
  const found: UserTmp[] = [];
  for (const group of await readDirNames(root)) {
    const usersDir = join(root, group, "users");
    for (const user of await readDirNames(usersDir)) {
      if (userFilter && user !== userFilter) continue;
      const dir = join(usersDir, user, "tmp");
      // 这里不能只看目录：tmp 里的散落文件（迁过来的 pi-bash-*.log 就是）也要算进来。
      let names: string[];
      try {
        names = (await readdir(dir, { withFileTypes: true })).map((entry) => entry.name);
      } catch {
        continue; // 这个用户还没触发过任何工具，tmp 尚未建立。
      }
      if (names.length === 0) continue;

      const entries: TmpEntry[] = [];
      const total: UserTmp = {
        group, user, dir, entries, bytes: 0, files: 0, newest: 0,
      };
      for (const name of names) {
        const path = join(dir, name);
        const measured = await measure(path);
        entries.push({ name, path, ...measured });
        total.bytes += measured.bytes;
        total.files += measured.files;
        total.newest = Math.max(total.newest, measured.newest);
      }
      entries.sort((a, b) => b.bytes - a.bytes);
      found.push(total);
    }
  }
  return found.sort((a, b) => b.bytes - a.bytes);
}

async function list(userFilter?: string): Promise<number> {
  const users = await collect(userFilter);
  if (users.length === 0) {
    console.log(`没有找到任何用户临时目录（群数据总根：${GROUP_DATA_ROOT}）。`);
    return 0;
  }
  let bytes = 0;
  for (const user of users) {
    bytes += user.bytes;
    console.log(
      `${user.user}（群 ${user.group}）：${formatSize(user.bytes)}，${user.files} 个文件，最后改动于 ${describeAge(user.newest)}`
    );
    // 只列最大的几个，一个 uv 缓存能有上千个条目，全打出来没人看得完。
    for (const entry of user.entries.slice(0, 3)) {
      console.log(`  ${entry.name}  ${formatSize(entry.bytes)}（${describeAge(entry.newest)}）`);
    }
    if (user.entries.length > 3) {
      console.log(`  …… 另有 ${user.entries.length - 3} 个条目`);
    }
  }
  console.log("");
  console.log(`共 ${users.length} 个用户，合计 ${formatSize(bytes)}。`);
  console.log("这些内容都可以重建（缓存、中间产物、被截断的完整输出日志），删除只影响下次的速度。");
  return 0;
}

export async function purge(
  days: number,
  userFilter?: string,
  root: string = GROUP_DATA_ROOT
): Promise<number> {
  const cutoff = Date.now() - days * DAY;
  const users = await collect(userFilter, root);
  if (users.length === 0) {
    console.log(`没有找到任何用户临时目录（群数据总根：${root}）。`);
    return 0;
  }

  let freed = 0;
  let removed = 0;
  let keptEntries = 0;
  let keptBytes = 0;
  let failed = 0;
  for (const user of users) {
    for (const entry of user.entries) {
      // 用整棵子树里最新的修改时间判断新旧，而不是目录自己的 mtime：目录 mtime 只反映
      // 直接子项的增删，一个几分钟前还在往深处写文件的 .cache 看上去可能是几个月前的。
      if (entry.newest > cutoff) {
        keptEntries++;
        keptBytes += entry.bytes;
        continue;
      }
      try {
        await rm(entry.path, { recursive: true, force: true });
        freed += entry.bytes;
        removed++;
        console.log(`已删除 ${entry.path}（${formatSize(entry.bytes)}）`);
      } catch (error) {
        failed++;
        console.error(`删除失败 ${entry.path}：${String(error)}`);
      }
    }
  }

  console.log("");
  if (removed === 0 && failed === 0) {
    console.log(`没有符合条件的条目（${days} 天内改动过的都保留了）。`);
  } else {
    console.log(`已删除 ${removed} 个条目，释放 ${formatSize(freed)}。`);
  }
  if (keptEntries > 0) {
    console.log(`保留 ${keptEntries} 个条目（${formatSize(keptBytes)}）：它们在 ${days} 天内有改动。`);
  }
  if (failed > 0) {
    console.log(`${failed} 个条目删除失败，常见原因是有进程正占用其中的文件——机器人停下来再试一次。`);
    return 1;
  }
  return 0;
}

async function main(args: string[]): Promise<number> {
  const command = args[0];
  let days: number | undefined;
  let userFilter: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--all") {
      days = 0;
    } else if (flag === "--days") {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value < 0) {
        console.error("--days 需要一个不小于 0 的天数");
        return 1;
      }
      days = value;
    } else if (flag === "--user") {
      userFilter = args[++i];
      if (!userFilter) {
        console.error("--user 需要一个手机号");
        return 1;
      }
    } else {
      console.error(`无法识别的参数：${flag}`);
      return 1;
    }
  }

  switch (command) {
    case "list":
    case "ls":
      return list(userFilter);
    case "purge":
      // 跟 relay purge 一样，范围必须显式给出：一条不带参数的 purge 太容易在手滑时
      // 把某个正在跑的任务的中间产物一起端掉。
      if (days === undefined) {
        console.error("purge 需要 --days <天数>，或用 --all 表示不看时间全部清理。");
        return 1;
      }
      if (days === 0) {
        console.log("正在清空全部用户临时目录；正在执行中的任务会丢失中间产物。");
      }
      return purge(days, userFilter);
    default:
      usage();
      return command ? 1 : 0;
  }
}

// 直接运行时才执行；测试要 import 这些函数，不能顺带把整个 CLI 跑起来。
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
