// 查看用户 tmp 占用，停机后将选中的内容归档到 backup/rm。
// tmp 包含缓存、完整工具输出及生成的交付物，不能假设全部可以重建。
// 目录边界由共享解析器验证；扫描和归档均不跟随目录链接。
import { formatSize } from "@earendil-works/pi-coding-agent";
import { GROUP_DATA_ROOT } from "../../src/core/config.ts";
import { archiveFile, withMaintenance } from "../../src/core/maintenance.ts";
import { assertDataDirectory, type GroupSelection } from "../lib/group-data.ts";
import { scanTmp, type UserTmp } from "../lib/tmp-scan.ts";

const DAY = 24 * 60 * 60_000;

function usage(): void {
  console.log("用法：bun run tmp <命令>");
  console.log("");
  console.log("  list                     列出每个用户临时目录的占用（大的排在前面）");
  console.log("  purge --days <天数>      只清理这些天内没有改动过的条目");
  console.log("  purge --all              清空全部用户临时目录（等价于 --days 0）");
  console.log("");
  console.log("  list/purge 可加 --user <手机号> 和 --group <群号>，限定成员与群。");
  console.log("  --group-id / --storage-segment 明确群参数是原始群号或存储目录段，两者互斥。");
  console.log("  停机后将选中内容移入 backup/rm；tmp 目录、workspace 和 session.jsonl 保留。");
}

function describeAge(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 扫描本身在 scripts/lib/tmp-scan.ts，宿主机上的运维界面直接调那一份。
 *
 * root 显式传入而不是直接用 GROUP_DATA_ROOT：那个常量在模块加载时就定死了，测试没法
 * 在导入之后再改环境变量，而这个命令删文件，必须能在真实目录树上测。
 */
export async function collect(
  userFilter?: string,
  root: string = GROUP_DATA_ROOT,
  groupFilter?: string,
  selection: GroupSelection = "auto"
): Promise<UserTmp[]> {
  return scanTmp(root, userFilter, groupFilter, selection);
}

async function list(userFilter?: string, groupFilter?: string, selection: GroupSelection = "auto"): Promise<number> {
  const users = await collect(userFilter, GROUP_DATA_ROOT, groupFilter, selection);
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
  console.log("包含缓存、完整工具输出和用户生成的交付物；清理会移入 backup/rm，可按原路径恢复。");
  return 0;
}

export async function purge(
  days: number,
  userFilter?: string,
  root: string = GROUP_DATA_ROOT,
  groupFilter?: string,
  selection: GroupSelection = "auto"
): Promise<number> {
  const cutoff = Date.now() - days * DAY;
  const users = await collect(userFilter, root, groupFilter, selection);
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
        await assertDataDirectory(user.dir, root);
        await archiveFile(entry.path);
        freed += entry.bytes;
        removed++;
        console.log(`已移入 backup/rm：${entry.path}（${formatSize(entry.bytes)}）`);
      } catch (error) {
        failed++;
        console.error(`归档失败 ${entry.path}：${String(error)}`);
      }
    }
  }

  console.log("");
  if (removed === 0 && failed === 0) {
    console.log(`没有符合条件的条目（${days} 天内改动过的都保留了）。`);
  } else {
    console.log(`已归档 ${removed} 个条目、${formatSize(freed)} 到 backup/rm（尚未释放磁盘空间）。`);
  }
  if (keptEntries > 0) {
    console.log(`保留 ${keptEntries} 个条目（${formatSize(keptBytes)}）：它们在 ${days} 天内有改动。`);
  }
  if (failed > 0) {
    console.log(`${failed} 个条目归档失败；检查文件占用及目录权限后重试。`);
    return 1;
  }
  return 0;
}

async function main(args: string[]): Promise<number> {
  const command = args[0];
  let days: number | undefined;
  let userFilter: string | undefined;
  let groupFilter: string | undefined;
  let selection: GroupSelection = "auto";
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
    } else if (flag === "--group") {
      groupFilter = args[++i];
      if (!groupFilter) {
        console.error("--group 需要一个群号");
        return 1;
      }
    } else if (flag === "--storage-segment" || flag === "--group-id") {
      if (selection !== "auto") throw new Error("群目录选择参数不能重复");
      selection = flag === "--storage-segment" ? "segment" : "id";
    } else {
      console.error(`无法识别的参数：${flag}`);
      return 1;
    }
  }

  switch (command) {
    case "list":
    case "ls":
      return list(userFilter, groupFilter, selection);
    case "purge":
      // 跟 relay purge 一样，范围必须显式给出：一条不带参数的 purge 太容易在手滑时
      // 把某个正在跑的任务的中间产物一起端掉。
      if (days === undefined) {
        console.error("purge 需要 --days <天数>，或用 --all 表示不看时间全部清理。");
        return 1;
      }
      if (days === 0) {
        console.log("准备将所选范围的全部临时内容移入回收区；运行中的机器人会阻止本操作。");
      }
      return withMaintenance(() => purge(days, userFilter, GROUP_DATA_ROOT, groupFilter, selection));
    default:
      usage();
      return command ? 1 : 0;
  }
}

// 直接运行时才执行；测试要 import 这些函数，不能顺带把整个 CLI 跑起来。
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
