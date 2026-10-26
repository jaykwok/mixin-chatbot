// 只读临时目录扫描，不加载维护/归档模块；宿主机 TUI 无需安装 npm 依赖。

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { userSegment } from "../../src/core/layout.ts";
import { assertDataDirectory, byName, dataDirectoryNames, resolveGroupName, type GroupSelection } from "./group-data.ts";
import { mapConcurrent } from "./concurrent.ts";

interface Usage {
  bytes: number;
  files: number;
  /** 整棵子树里最新的修改时间。 */
  newest: number;
}

interface TmpEntry extends Usage {
  name: string;
  path: string;
}

export interface UserTmp extends Usage {
  /** `direct` or `groups/<segment>` (src/core/layout.ts `spacePath`). */
  space: string;
  user: string;
  dir: string;
  entries: TmpEntry[];
}

/**
 * 用 lstat 而不是 stat：符号链接按它自己算，不跟进去。tmp 里出现一条指向 workspace 的
 * 链接时，统计和归档只处理链接本身，不遍历目标。
 */
async function measure(path: string): Promise<Usage> {
  const total: Usage = { bytes: 0, files: 0, newest: 0 };
  const queue = [path];
  const read = async (entry: string): Promise<void> => {
    let info;
    try { info = await lstat(entry); }
    catch { return; } // 正在运行的任务可能删除自己的中间文件。
    total.newest = Math.max(total.newest, info.mtimeMs);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      total.bytes += info.size;
      total.files++;
      return;
    }
    try { for (const name of await readdir(entry)) queue.push(join(entry, name)); }
    catch { /* 扫描期间消失或不可读的目录保留自身时间。 */ }
  };
  // A single bounded queue avoids serial traversal and unbounded recursive fan-out.
  while (queue.length) await Promise.all(queue.splice(-16).map(read));
  return total;
}

/** 一个成员 tmp 的顶层条目；tasks/ 下每个请求目录单独成为一个条目，按各自的时间归档。 */
async function topEntries(dir: string, root: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name !== "tasks" || !entry.isDirectory() || entry.isSymbolicLink()) { names.push(entry.name); continue; }
    const tasks = join(dir, "tasks");
    await assertDataDirectory(tasks, root);
    names.push(...(await readdir(tasks)).map(name => "tasks/" + name));
  }
  return names;
}

/**
 * 扫描数据目录（root）下 tmp/ 里所有空间的成员 tmp：单聊空间 tmp/direct/<用户>，群 tmp/groups/<群>/<用户>。
 * 找不到目录就是还没人用过工具，不是错误。spaceFilter 为 direct（单聊空间；明确选择群参数含义时按群处理），或群号/群目录名。
 */
export async function scanTmp(root: string, userFilter?: string, spaceFilter?: string, selection: GroupSelection = "auto"): Promise<UserTmp[]> {
  const found: UserTmp[] = [];
  const tmp = join(root, "tmp"), groupsDir = join(tmp, "groups");
  let spaces: string[];
  if (spaceFilter === "direct" && selection === "auto") spaces = ["direct"];
  else if (spaceFilter) {
    // TUI 传的是已扫描到的目录名：精确匹配优先，不能同时命中其再次编码后的另一个目录。
    const group = await resolveGroupName(spaceFilter, groupsDir, selection, root);
    spaces = group === null ? [] : ["groups/" + group];
  } else spaces = ["direct", ...(await dataDirectoryNames(groupsDir, root)).map(group => "groups/" + group)];
  for (const space of spaces) {
    const usersDir = join(tmp, ...space.split("/"));
    const users = await dataDirectoryNames(usersDir, root);
    const selectedUser = userFilter ? (users.includes(userFilter) ? userFilter : userSegment(userFilter)) : undefined;
    const results = await mapConcurrent(users.filter(user => selectedUser === undefined || user === selectedUser), async user => {
      const dir = join(usersDir, user);
      // 这里不能只看目录：tmp 里的散落文件（迁过来的 pi-bash-*.log 就是）也要算进来。
      let names: string[];
      try {
        await assertDataDirectory(dir, root);
        const info = await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) return null;
        names = await topEntries(dir, root);
      } catch {
        return null; // 这个用户还没触发过任何工具，tmp 尚未建立。
      }
      if (names.length === 0) return null;

      const entries: TmpEntry[] = [];
      const total: UserTmp = { space, user, dir, entries, bytes: 0, files: 0, newest: 0 };
      for (const name of names) {
        const path = join(dir, name);
        const measured = await measure(path);
        entries.push({ name, path, ...measured });
        total.bytes += measured.bytes;
        total.files += measured.files;
        total.newest = Math.max(total.newest, measured.newest);
      }
      entries.sort((a, b) => b.bytes - a.bytes || byName(a.name, b.name));
      return total;
    });
    found.push(...results.filter((entry): entry is UserTmp => entry !== null));
  }
  return found.sort((a, b) => b.bytes - a.bytes || byName(a.space, b.space) || byName(a.user, b.user));
}
