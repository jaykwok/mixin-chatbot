// 只读会话扫描，不加载维护/归档模块；宿主机 TUI 无需安装 npm 依赖。
// 调用方显式提供群数据根，扫描器不读取部署配置。

import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertDataDirectory, dataDirectoryNames } from "./group-data.ts";

export const HISTORY_FILE = "session.jsonl";

export interface UserHistory {
  user: string;
  path: string;
  bytes: number;
  modified: number;
}

export interface GroupHistory {
  group: string;
  dir: string;
  users: UserHistory[];
  bytes: number;
}

/** 按占用从大到小列出各群的会话历史；没说过话的成员不出现。 */
export async function scanHistory(root: string): Promise<GroupHistory[]> {
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
