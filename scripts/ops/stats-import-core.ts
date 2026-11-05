// 一次性导入旧版（webhook 版，统计 schema 2）的统计账本：只取新统计用到的字段——按天、按成员的提问数，
// 和按天、按成员、按模型的 input／output／cacheRead／cacheWrite token；费用、请求次数、回复数、工具次数、
// 附件数等一律不导入。旧账本没有 totalTokens，导入行按四项相加补出。
//
// 读旧账本的只读快照（连同未 checkpoint 的 -wal 复制到私有临时目录，再整库序列化进内存；不改动原文件和它所在的目录），在新账本里标为导入来源，与服务实时写入的行分开存放、
// 合并展示。同一份旧账本重复执行不会重复计入；新账本已导入过另一份时拒绝。要求机器人已停止（维护租约）。
//
// 新部署是全新的，旧账本可以在任意位置：控制台统计页可上传或填写路径，Windows 的 ops.ps1 stat-import 不带路径时弹出
// 系统“打开文件”对话框，Linux 的 ops.sh 把所选文件临时复制进一次性容器能读到的 backup/ 再导入。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { importedDigests, importRows, openExistingStatsLedger, openStatsLedger, type ImportRows } from "../../src/agent/stats-ledger.ts";
import { appLayout } from "../../src/core/layout.ts";
import { fileSnapshot } from "../../src/core/sqlite-snapshot.ts";
import { DATA_DIR } from "../../src/core/storage.ts";
import { readLedger } from "../../src/agent/stats-ledger.ts";
import { assertExpectedScope, statsFileScope } from "../lib/operation-scope.ts";

const LEGACY_SCHEMA = 2;

/** Schema 2 imports model totals; schema 3 preserves both model and tool totals for a fresh deployment. */
export function readImport(path: string, expected?: string): { schema: number; rows: ImportRows } {
  if (!existsSync(path)) throw new Error(`找不到旧统计账本：${path}`);
  // The old release kept its ledger in WAL mode; the snapshot also reads a -wal that was never checkpointed.
  if (expected !== undefined) assertExpectedScope(expected, statsFileScope(path));
  const snapshot = fileSnapshot(path);
  try {
    if (expected !== undefined) assertExpectedScope(expected, statsFileScope(path));
    const schema = snapshot.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stats_schema'").get()
      ? (snapshot.query("SELECT version FROM stats_schema WHERE id = 1").get() as { version: number } | null)?.version : undefined;
    if (schema === 3) {
      const rows = readLedger(snapshot);
      return { schema, rows: { asks: rows.asks.map(({ group, ...row }) => ({ ...row, space: group })),
        usage: rows.usage.map(({ group, ...row }) => ({ ...row, space: group })) } };
    }
    if (schema !== LEGACY_SCHEMA) throw new Error(`统计账本版本为 ${schema ?? "未知"}；导入工具只接受 schema ${LEGACY_SCHEMA} 或 3`);
    const asks = snapshot.query(`SELECT a.day, s.group_segment AS space, s.user_segment AS user, SUM(a.asks) AS asks,
        MIN(a.first_at) AS firstAt, MAX(a.last_at) AS lastAt
      FROM activity a JOIN sources s ON s.id = a.source WHERE a.asks > 0
      GROUP BY a.day, s.group_segment, s.user_segment ORDER BY a.day, s.group_segment, s.user_segment`).all() as ImportRows["asks"];
    const usage = (snapshot.query(`SELECT u.day, s.group_segment AS space, s.user_segment AS user,
        (CASE WHEN u.provider = '' THEN 'unknown' ELSE u.provider END) || '/' || (CASE WHEN u.model = '' THEN 'unknown' ELSE u.model END) AS key,
        SUM(u.input) AS input, SUM(u.output) AS output, SUM(u.cache_read) AS cacheRead, SUM(u.cache_write) AS cacheWrite
      FROM usage_totals u JOIN sources s ON s.id = u.source
      GROUP BY u.day, s.group_segment, s.user_segment, key ORDER BY u.day, s.group_segment, s.user_segment, key`).all() as
      Omit<ImportRows["usage"][number], "totalTokens">[])
      .filter(row => row.input + row.output + row.cacheRead + row.cacheWrite > 0)
      .map(row => ({ ...row, totalTokens: row.input + row.output + row.cacheRead + row.cacheWrite }));
    return { schema, rows: { asks, usage } };
  } finally { snapshot.close(); }
}

/** Digest of the rows themselves: the same old ledger reads the same, whatever its file pages look like. */
export function importDigest(rows: ImportRows): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** What importing `legacy` into data directory `root` would add, and whether it would (read-only; for the confirmation preview). */
export interface ImportPreview {
  asks: number;
  memberDays: number;
  usageRows: number;
  totalTokens: number;
  firstDay?: string;
  lastDay?: string;
  /** new: will import; already: this ledger was imported (nothing added); other: another one was, the import is refused. */
  status: "new" | "already" | "other";
}

export function previewLegacyStats(legacy: string, root: string = DATA_DIR): ImportPreview {
  const target = resolve(appLayout(root).stats);
  if (resolve(legacy) === target) throw new Error("旧统计账本不能是当前数据目录的统计账本");
  const { rows, schema } = readImport(legacy);
  const days = [...rows.asks, ...rows.usage].map(row => row.day).sort();
  const db = openExistingStatsLedger(target);
  let done: string[] = [];
  try {
    if (db) {
      done = importedDigests(db);
      if (schema === 3 && !done.length && (db.query("SELECT 1 FROM asks_daily LIMIT 1").get() || db.query("SELECT 1 FROM usage_daily LIMIT 1").get())) {
        throw new Error("同版本统计仅可恢复到空账本；当前已有统计，拒绝导入以免重复计数");
      }
    }
  } finally { db?.close(); }
  return {
    asks: rows.asks.reduce((sum, row) => sum + row.asks, 0), memberDays: rows.asks.length, usageRows: rows.usage.length,
    totalTokens: rows.usage.reduce((sum, row) => sum + row.totalTokens, 0),
    ...(days.length ? { firstDay: days[0]!, lastDay: days.at(-1)! } : {}),
    status: done.includes(importDigest(rows)) ? "already" : done.length ? "other" : "new",
  };
}

/** Import `legacy` into the ledger of data directory `root`. The caller holds the maintenance lease. */
export function importLegacyStats(legacy: string, root: string = DATA_DIR, expected?: string): { result: "imported" | "already"; rows: ImportRows } {
  const target = resolve(appLayout(root).stats);
  if (resolve(legacy) === target) throw new Error("旧统计账本不能是当前数据目录的统计账本");
  const { rows, schema } = readImport(legacy, expected);
  const db = openStatsLedger(target);
  try { return { result: importRows(db, importDigest(rows), rows, Date.now(), schema === 3), rows }; } finally { db.close(); }
}

