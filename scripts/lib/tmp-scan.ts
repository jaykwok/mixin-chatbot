// 只读临时目录扫描，不加载维护/归档模块；宿主机 TUI 无需安装 npm 依赖。

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { userSegment } from "../../src/agent/paths.ts";
import { assertDataDirectory, dataDirectoryNames, resolveGroupName, type GroupSelection } from "./group-data.ts";

export interface Usage {
  bytes: number;
  files: number;
  /** 整棵子树里最新的修改时间。 */
  newest: number;
}

export interface TmpEntry extends Usage {
  name: string;
  path: string;
}

export interface UserTmp extends Usage {
  group: string;
  user: string;
  dir: string;
  entries: TmpEntry[];
}

/**
 * 用 lstat 而不是 stat：符号链接按它自己算，不跟进去。tmp 里出现一条指向 workspace 的
 * 链接时，统计和归档只处理链接本身，不遍历目标。
 */
export async function measure(path: string): Promise<Usage> {
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

/** 扫描所有群下所有用户的 tmp。找不到目录就是还没人在这个群里用过工具，不是错误。 */
export async function scanTmp(root: string, userFilter?: string, groupFilter?: string, selection: GroupSelection = "auto"): Promise<UserTmp[]> {
  const found: UserTmp[] = [];
  const groups = await dataDirectoryNames(root, root);
  // TUI 传的是已扫描到的目录名：精确匹配优先，不能同时命中其再次编码后的另一个目录。
  const selectedGroup = groupFilter ? await resolveGroupName(groupFilter, root, selection) : undefined;
  for (const group of groups) {
    if (selectedGroup !== undefined && group !== selectedGroup) continue;
    const usersDir = join(root, group, "users");
    const users = await dataDirectoryNames(usersDir, root);
    const selectedUser = userFilter ? (users.includes(userFilter) ? userFilter : userSegment(userFilter)) : undefined;
    for (const user of users) {
      if (selectedUser !== undefined && user !== selectedUser) continue;
      const dir = join(usersDir, user, "tmp");
      // 这里不能只看目录：tmp 里的散落文件（迁过来的 pi-bash-*.log 就是）也要算进来。
      let names: string[];
      try {
        await assertDataDirectory(dir, root);
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        names = (await readdir(dir, { withFileTypes: true })).map((entry) => entry.name);
      } catch {
        continue; // 这个用户还没触发过任何工具，tmp 尚未建立。
      }
      if (names.length === 0) continue;

      const entries: TmpEntry[] = [];
      const total: UserTmp = { group, user, dir, entries, bytes: 0, files: 0, newest: 0 };
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
