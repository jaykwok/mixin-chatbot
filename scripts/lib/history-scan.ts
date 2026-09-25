// 只读会话扫描，不加载维护/归档模块；宿主机 TUI 无需安装 npm 依赖。
// 调用方显式提供群数据根，扫描器不读取部署配置。

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
    if (users.length === 0) continue;
    const bytes = users.reduce((total, user) => total + user.bytes, 0);
    users.sort((a, b) => b.bytes - a.bytes || byName(a.user, b.user));
    groups.push({ group, dir, users, bytes });
  }
  return groups.sort((a, b) => b.bytes - a.bytes || byName(a.group, b.group));
}
