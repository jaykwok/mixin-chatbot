// 只读会话扫描，不加载维护/归档模块；宿主机 TUI 无需安装 npm 依赖。
// 调用方显式提供群数据根，扫描器不读取部署配置。
//
// 数据版本 3 起对话在每群的 Durable 群库（durable.sqlite）里，这里只看它的文件大小和修改时间，不读库内结构；
// 成员明细来自升级前的旧会话文件（已导入群库，原地保留供统计补账）。

import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertDataDirectory, byName, dataDirectoryNames } from "./group-data.ts";
import { mapConcurrent } from "./concurrent.ts";

import { SESSION_FILE } from "../../src/agent/paths.ts";

interface UserHistory {
  user: string;
  path: string;
  bytes: number;
  modified: number;
}

interface DatabaseFiles {
  /** durable.sqlite 及其 -wal、-shm、-journal 的总大小。 */
  bytes: number;
  modified: number;
}

export interface GroupHistory {
  group: string;
  dir: string;
  /** 旧会话文件。 */
  users: UserHistory[];
  /** 群库；还没有群库的群（升级前、尚无对话）没有这一项。 */
  database?: DatabaseFiles;
  /** 旧会话文件与群库合计。 */
  bytes: number;
}

const DATABASE = "durable.sqlite";

/** 群的最后活动：群库或旧会话文件中最新的修改时间。 */
export function lastActivity(group: GroupHistory): number {
  return Math.max(group.database?.modified ?? 0, ...group.users.map((user) => user.modified));
}

/** 群库文件（不跟随链接）；没有主库文件时为 undefined。 */
async function databaseFiles(dir: string): Promise<DatabaseFiles | undefined> {
  let bytes = 0;
  let modified = 0;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const info = await lstat(join(dir, DATABASE + suffix));
      if (!info.isFile()) continue;
      bytes += info.size;
      modified = Math.max(modified, info.mtimeMs);
    } catch {
      if (suffix === "") return undefined;
    }
  }
  return { bytes, modified };
}

/** 按占用从大到小列出各群的会话历史；没说过话的成员不出现，既没有群库也没有旧会话文件的群不出现。 */
export async function scanHistory(root: string): Promise<GroupHistory[]> {
  const groups: GroupHistory[] = [];
  for (const group of await dataDirectoryNames(root, root)) {
    const dir = join(root, group);
    const entries = await mapConcurrent(await dataDirectoryNames(join(dir, "users"), root), async user => {
      const path = join(dir, "users", user, SESSION_FILE);
      try {
        await assertDataDirectory(dirname(path), root);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) return null;
        return { user, path, bytes: info.size, modified: info.mtimeMs };
      } catch {
        return null; // 这位成员还没说过话。
      }
    });
    const users = entries.filter((entry): entry is UserHistory => entry !== null);
    const database = await databaseFiles(dir);
    if (users.length === 0 && database === undefined) continue;
    const bytes = users.reduce((total, user) => total + user.bytes, database?.bytes ?? 0);
    users.sort((a, b) => b.bytes - a.bytes || byName(a.user, b.user));
    groups.push({ group, dir, users, ...(database ? { database } : {}), bytes });
  }
  return groups.sort((a, b) => b.bytes - a.bytes || byName(a.group, b.group));
}
