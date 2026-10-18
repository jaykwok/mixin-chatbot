import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { byName, dataDirectoryNames } from "./group-data.ts";


interface DatabaseFiles {
  /** durable.sqlite 及其 -wal、-shm、-journal 的总大小。 */
  bytes: number;
  modified: number;
}

export interface GroupHistory {
  group: string;
  dir: string;
  /** 群库；尚无对话时没有这一项。 */
  database?: DatabaseFiles;
  /** 群库及日志合计。 */
  bytes: number;
}

const DATABASE = "durable.sqlite";

/** 群的最后活动：群库最新的修改时间。 */
export function lastActivity(group: GroupHistory): number {
  return group.database?.modified ?? 0;
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

/**
 * 一个群（实际目录段）的会话历史；没有群库时为 null。
 */
export async function scanGroupHistory(root: string, group: string): Promise<GroupHistory | null> {
  const dir = join(root, group);
  const database = await databaseFiles(dir);
  if (database === undefined) return null;
  return { group, dir, database, bytes: database.bytes };
}

/** 按占用从大到小列出各群的会话历史；没有群库的群不出现。 */
export async function scanHistory(root: string): Promise<GroupHistory[]> {
  const groups: GroupHistory[] = [];
  for (const group of await dataDirectoryNames(root, root)) {
    const history = await scanGroupHistory(root, group);
    if (history) groups.push(history);
  }
  return groups.sort((a, b) => b.bytes - a.bytes || byName(a.group, b.group));
}
