// 会话历史运维命令：查看与清空 <群数据总根>/<群>/users/<用户>/session.jsonl。
//
// 群里的 /clear 只能清自己那一份，而且没人会主动去点——历史因此只增不减，一路把上下文
// 顶到压缩阈值，里面还沉着几个月前提取的旧价格。这条命令按群一次性清空全部成员。
//
// 之所以是 bun 脚本而不是写进 ops.sh / ops.ps1：目录布局、群/用户目录段的 sha256 兜底
// 规则都在 src/ 里，抄进两个 shell 等于维护三份；而「只删 session.jsonl」这条边界更是
// 只能有一个定义——workspace、tmp、资料索引就在隔壁，一个写歪的 rm 代价太大。
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { groupSegment, isPathInside } from "../../src/agent/paths.ts";
import { GROUP_DATA_ROOT, PORT } from "../../src/core/config.ts";
import { BOT_PORT_FILE } from "../../src/core/storage.ts";

const HISTORY_FILE = "session.jsonl";

interface UserHistory {
  user: string;
  path: string;
  bytes: number;
  modified: number;
}

interface GroupHistory {
  group: string;
  dir: string;
  users: UserHistory[];
  bytes: number;
}

function usage(): void {
  console.log("用法：bun run history <命令>");
  console.log("");
  console.log("  list                 列出各群的会话历史（成员数、占用、最后活动）");
  console.log("  clear <群号>         清空该群全部成员的会话历史");
  console.log("  clear <群号> --force 机器人仍在运行时也执行（见下）");
  console.log("");
  console.log("  只删除 session.jsonl；workspace、用户 tmp、资料索引和 venv 都不动。");
  console.log("  清空后每位成员的下一条消息都会开启全新会话。");
}

function describeAge(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

async function readDirNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function collect(root: string = GROUP_DATA_ROOT): Promise<GroupHistory[]> {
  const groups: GroupHistory[] = [];
  for (const group of await readDirNames(root)) {
    const dir = join(root, group);
    const users: UserHistory[] = [];
    let bytes = 0;
    for (const user of await readDirNames(join(dir, "users"))) {
      const path = join(dir, "users", user, HISTORY_FILE);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        users.push({ user, path, bytes: info.size, modified: info.mtimeMs });
        bytes += info.size;
      } catch {
        continue; // 这位成员还没说过话。
      }
    }
    if (users.length === 0) continue;
    users.sort((a, b) => b.bytes - a.bytes);
    groups.push({ group, dir, users, bytes });
  }
  return groups.sort((a, b) => b.bytes - a.bytes);
}

/**
 * 群号 → 目录。外部群号不适合做目录名时会落成 sha256 摘要（见 paths.ts），所以先按
 * 规则换算；换算不出来再把参数当目录名本身试一次，方便直接从 ls 的结果里复制。
 * 后一条路径必须重新校验边界，否则 `..` 这类输入会走出群数据根。
 */
function resolveGroupDir(groupId: string, root: string): string | null {
  const bySegment = join(root, groupSegment(groupId));
  if (existsSync(bySegment)) return bySegment;
  const raw = join(root, groupId);
  if (existsSync(raw) && isPathInside(resolve(raw), resolve(root))) return raw;
  return null;
}

/**
 * 机器人是否在跑。开着的时候删历史只清掉了磁盘那一份：内存里已经建好的 AgentSession
 * 仍然握着完整的消息列表，接着聊会把旧内容重新写回去，等于白清一次。
 */
async function botIsRunning(): Promise<boolean> {
  let port = PORT;
  try {
    const configured = Number((await Bun.file(BOT_PORT_FILE).text()).trim());
    if (Number.isInteger(configured) && configured > 0) port = configured;
  } catch {
    // 没有部署状态文件就用配置里的端口。
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/favicon.svg`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function clearGroup(
  groupId: string,
  options: { force?: boolean; skipRunningCheck?: boolean } = {},
  root: string = GROUP_DATA_ROOT
): Promise<number> {
  const dir = resolveGroupDir(groupId, root);
  if (!dir) {
    console.error(`在 ${root} 下找不到群 ${groupId}。用 list 查看现有的群。`);
    return 1;
  }

  const groups = await collect(root);
  const target = groups.find((group) => join(root, group.group) === dir);
  if (!target || target.users.length === 0) {
    console.log(`群 ${groupId} 下没有任何会话历史，无需清理。`);
    return 0;
  }

  if (!options.skipRunningCheck && !options.force && (await botIsRunning())) {
    console.error("机器人正在运行，已中止。");
    console.error(
      "内存里已建立的会话仍持有完整历史，此时删文件只会清掉磁盘那一份，聊下去又会写回来。"
    );
    console.error("请先停止机器人再执行（ops.sh stop / ops.ps1 stop），或加 --force 自行承担。");
    return 1;
  }

  console.log(`群 ${target.group}：即将清空 ${target.users.length} 位成员的会话历史（${formatSize(target.bytes)}）。`);
  let removed = 0;
  let freed = 0;
  let failed = 0;
  for (const user of target.users) {
    try {
      await rm(user.path, { force: true });
      removed++;
      freed += user.bytes;
      console.log(`已清空 ${user.user}（${formatSize(user.bytes)}，最后活动于 ${describeAge(user.modified)}）`);
    } catch (error) {
      failed++;
      console.error(`清空失败 ${user.path}：${String(error)}`);
    }
  }

  console.log("");
  console.log(`已清空 ${removed} 位成员的会话历史，释放 ${formatSize(freed)}。`);
  console.log("每位成员的下一条消息都会开启全新会话；workspace、tmp、资料索引均未改动。");
  if (failed > 0) {
    console.log(`${failed} 位成员清空失败，常见原因是机器人仍在占用该文件——停下来再试一次。`);
    return 1;
  }
  return 0;
}

async function list(root: string = GROUP_DATA_ROOT): Promise<number> {
  const groups = await collect(root);
  if (groups.length === 0) {
    console.log(`没有找到任何会话历史（群数据总根：${root}）。`);
    return 0;
  }
  for (const group of groups) {
    const newest = Math.max(...group.users.map((user) => user.modified));
    console.log(
      `群 ${group.group}：${group.users.length} 位成员，${formatSize(group.bytes)}，最后活动于 ${describeAge(newest)}`
    );
    for (const user of group.users.slice(0, 5)) {
      console.log(`  ${user.user}  ${formatSize(user.bytes)}（${describeAge(user.modified)}）`);
    }
    if (group.users.length > 5) {
      console.log(`  …… 另有 ${group.users.length - 5} 位成员`);
    }
  }
  console.log("");
  console.log("清空某个群：bun run history clear <群号>");
  return 0;
}

async function main(args: string[]): Promise<number> {
  const command = args[0];
  switch (command) {
    case "list":
    case "ls":
      return list();
    case "clear": {
      const groupId = args[1];
      // 群号必须显式给出：没有「清空全部群」这个入口，它只会在手滑时出现。
      if (!groupId || groupId.startsWith("--")) {
        console.error("clear 需要群号：bun run history clear <群号>");
        return 1;
      }
      const force = args.slice(2).includes("--force");
      const unknown = args.slice(2).find((flag) => flag !== "--force");
      if (unknown) {
        console.error(`无法识别的参数：${unknown}`);
        return 1;
      }
      return clearGroup(groupId, { force });
    }
    default:
      usage();
      return command ? 1 : 0;
  }
}

// 直接运行时才执行；测试要 import 这些函数，不能顺带把整个 CLI 跑起来。
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
