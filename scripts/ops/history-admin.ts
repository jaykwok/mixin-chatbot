// 查看各群会话占用，停机后将指定群的 session.jsonl 归档到 backup/rm。
// 未交付记录独立保留；目录遍历使用实际存储段并拒绝链接。
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { groupSegment } from "../../src/agent/paths.ts";
import { GROUP_DATA_ROOT } from "../../src/core/config.ts";
import { archiveFile, withMaintenance } from "../../src/core/maintenance.ts";
import { assertDataDirectory, dataDirectoryNames } from "../lib/group-data.ts";

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
  console.log("");
  console.log("  停机后执行；session.jsonl 移入 backup/rm，未交付消息另行保留。");
  console.log("  清空后每位成员的下一条消息都会开启全新会话。");
}

function describeAge(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export async function collect(root: string = GROUP_DATA_ROOT): Promise<GroupHistory[]> {
  const groups: GroupHistory[] = [];
  for (const group of await dataDirectoryNames(root, root)) {
    const dir = join(root, group);
    const users: UserHistory[] = [];
    let bytes = 0;
    for (const user of await dataDirectoryNames(join(dir, "users"), root)) {
      const path = join(dir, "users", user, HISTORY_FILE);
      try {
        await assertDataDirectory(dirname(path), root);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) continue;
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
 * 接受外部群号或 list 输出的存储段，但只匹配已经验证的实际目录名。
 */
async function resolveGroupDir(groupId: string, root: string): Promise<string | null> {
  const names = await dataDirectoryNames(root, root);
  const name = names.find(name => name === groupSegment(groupId)) ?? names.find(name => name === groupId);
  return name ? join(root, name) : null;
}

/**
 * 归档本群历史；CLI 调用方须先持有维护租约，防止内存会话重新写回旧历史。
 */
export async function clearGroup(
  groupId: string,
  root: string = GROUP_DATA_ROOT
): Promise<number> {
  const dir = await resolveGroupDir(groupId, root);
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

  console.log(`群 ${target.group}：即将清空 ${target.users.length} 位成员的会话历史（${formatSize(target.bytes)}）。`);
  let removed = 0;
  let freed = 0;
  let failed = 0;
  for (const user of target.users) {
    try {
      await assertDataDirectory(dirname(user.path), root);
      const info = await lstat(user.path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("历史文件已改变或是链接");
      await archiveFile(user.path);
      removed++;
      freed += user.bytes;
      console.log(`已清空 ${user.user}（${formatSize(user.bytes)}，最后活动于 ${describeAge(user.modified)}）`);
    } catch (error) {
      failed++;
      console.error(`清空失败 ${user.path}：${String(error)}`);
    }
  }

  console.log("");
  console.log(`已清空 ${removed} 位成员的会话历史，归档 ${formatSize(freed)} 到 backup/rm。`);
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
      const unknown = args[2];
      if (unknown) {
        console.error(`无法识别的参数：${unknown}`);
        return 1;
      }
      return withMaintenance(() => clearGroup(groupId));
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
