// Data version 5: Pi 1.2.0's official Durable code mode replaces the project's own. Frozen: everything it writes goes
// through lib/durable.ts.
//
// Scripts' `store()` values move from the project's conversation document (`mixin.codemode-store`) to the official
// one (`pi.codemode.store`), as they are; the old document stays for a rollback to the old code.
//
// History boundary: the old document kept only its current value (history `latest`, a fork started empty); the official
// one keeps its history (`rewindable`) and a fork starts with the value as of its fork entry (`asOf`). The past values
// are not known, so none is made up: the copy is the official store's first value, and the same commit records the
// conversation's newest entry at that time (`mixin.codemode-store-boundary`, `through`). Read as of an entry up to
// `through`, or forked at one, the official store is empty, as an old fork was; from the first later entry it holds
// the copied values and what scripts store afterwards. A reset (/clear) changes no document, before or after the copy:
// scripts keep their values. Nothing else is
// rewritten: a codemode call a stop interrupted was recorded with replay `unsafe`, and Durable reruns a call only when
// the recorded and the current policy are both `safe`, so after the upgrade it ends `interrupted` as before, never
// rerun by the new code. Statistics read old codemode results by their own details (src/durable/projection.ts).
import { join } from "node:path";
import { info, ordinaryPath } from "./lib/io.ts";
import type { Context, Migration } from "./lib/types.ts";

const DATABASE = "durable.sqlite";

/** Group directories (never the lease directory or other dot directories), by a lister of directories. */
async function groups(directories: (path: string) => Promise<string[]>): Promise<string[]> {
  return (await directories(".")).filter((name) => !name.startsWith(".")).sort();
}

/** The group databases present, relative to the group root. */
async function databases(context: Context): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const present: string[] = [];
  const list = async (path: string) => (await readdir(join(context.groups, path), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const group of await groups(list)) {
    const path = join(context.groups, group, DATABASE);
    await ordinaryPath(context.groups, path);
    if (await info(path)) present.push(group);
  }
  return present;
}

export const v5: Migration = {
  to: 5,
  async preview(context) {
    const found = await groups((path) => context.groups.directories(path));
    return {
      // Backed up before apply; a group without a database lists files that are not there.
      files: found.flatMap((group) => ["", "-wal", "-shm", "-journal"].map((suffix) => ({ root: "groups" as const, path: `${group}/${DATABASE}${suffix}` }))),
      decisions: [],
      steps: [
        "升级到 Pi 1.2.0 官方 Durable codemode：把各群 Durable 数据库里脚本 store() 保存的值（mixin.codemode-store）原样复制到官方文档"
          + "（pi.codemode.store），同一提交登记复制时会话的最后一条记录作为历史边界：边界及之前按时间点读取或分叉时官方 store 为空（与旧版分叉一致），"
          + "不把当前值当成过去的值；旧文档保留，回滚到旧代码时仍可读。停机时中断的旧 codemode 调用按原 unsafe 策略结束为 interrupted，不会被新代码重跑；"
          + "不执行工具、不发消息，历史会话和费用不重写",
        "完整校验配置与账本，登记项目和群根版本 5；旧代码禁止直接使用新版本数据",
      ],
    };
  },
  async apply(context) {
    const { copyCodemodeStores } = await import("./lib/durable.ts");
    for (const group of await databases(context)) {
      const copies = await copyCodemodeStores(join(context.groups, group, DATABASE));
      const copied = copies.filter((copy) => copy.outcome === "copied").length;
      context.report?.("codemode-store", `group=${group}; copied=${copied}; already=${copies.length - copied}`);
    }
  },
  async validate(context) {
    const { uncopiedCodemodeStores } = await import("./lib/durable.ts");
    for (const group of await databases(context)) {
      const missing = await uncopiedCodemodeStores(join(context.groups, group, DATABASE));
      if (missing.length) throw new Error(`v5 迁移校验失败：${group} 有 ${missing.length} 个会话的脚本 store 未复制到官方文档或缺少历史边界记录`);
    }
  },
};
