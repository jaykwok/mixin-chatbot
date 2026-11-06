import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { byName, dataDirectoryNames } from "./group-data.ts";


interface DatabaseFiles {
  /** durable.sqlite 及其 -wal、-shm、-journal 的总大小。 */
  bytes: number;
  modified: number;
}

export interface SpaceHistory {
  /** `direct` or `groups/<segment>` (src/core/layout.ts `spacePath`). */
  space: string;
  dir: string;
  /** 会话库；尚无对话时没有这一项。 */
  database?: DatabaseFiles;
  /** 会话库及日志合计。 */
  bytes: number;
}

export const DATABASE = "durable.sqlite";

/** 空间的最后活动：会话库最新的修改时间。 */
export function lastActivity(space: SpaceHistory): number {
  return space.database?.modified ?? 0;
}

/** 会话库文件（不跟随链接）；没有主库文件时为 undefined。 */
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

/** 数据目录（root）下一个空间的会话历史；没有会话库时为 null。 */
export async function scanSpaceHistory(root: string, space: string): Promise<SpaceHistory | null> {
  const dir = join(root, "conversations", ...space.split("/"));
  const database = await databaseFiles(dir);
  if (database === undefined) return null;
  return { space, dir, database, bytes: database.bytes };
}

/** 有会话库的空间：单聊空间 conversations/direct，群 conversations/groups/<群>；不跟随链接。 */
export async function historySpaces(root: string): Promise<string[]> {
  const conversations = join(root, "conversations");
  const top = await dataDirectoryNames(conversations, root);
  return [...(top.includes("direct") ? ["direct"] : []),
    ...(await dataDirectoryNames(join(conversations, "groups"), root)).map(group => "groups/" + group)];
}

/** 按占用从大到小列出各空间的会话历史；没有会话库的空间不出现。 */
export async function scanHistory(root: string): Promise<SpaceHistory[]> {
  const spaces: SpaceHistory[] = [];
  for (const space of await historySpaces(root)) {
    const history = await scanSpaceHistory(root, space);
    if (history) spaces.push(history);
  }
  return spaces.sort((a, b) => b.bytes - a.bytes || byName(a.space, b.space));
}

/** 显示用：单聊空间与群（目录段）。 */
export function spaceName(space: string): string {
  return space === "direct" ? "单聊" : `群 ${space.slice("groups/".length)}`;
}
