// 会话历史占用的扫描。只读，不依赖 npm 包。
//
// 从 history-admin.ts 拆出来，是为了让宿主机上的运维界面能直接调用它。
// history-admin.ts 还要做归档，因而在模块一级就导入了 proper-lockfile 和 fs-extra；Linux
// 生产机上宿主机没有 node_modules（依赖只装在镜像里），那些 import 会让整个模块加载失败。
// 扫描本身一个 npm 包都不需要，所以它属于这里，不属于那边。
//
// root 是必填的：调用方各自知道自己的群数据根从哪来（部署状态文件、环境变量、测试目录），
// 这里不替谁决定，也就不必导入那个按 cwd 解析的配置模块。

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
