// 把已保存的统计账本（当前 schema）恢复到全新部署的空账本：提问数和模型、工具用量汇总，标为导入来源，与服务记下的数合并
// 展示。读账本的只读快照（连同未 checkpoint 的 -wal 复制到私有临时目录，再整库序列化进内存；不改动原文件和它所在的目录）。
// 同一份账本重复执行不会重复计入；已导入过另一份或已有统计时拒绝。要求机器人已停止（维护租约）。
//
// 账本可以在任意位置：控制台统计页可上传或填写路径，Windows 的 ops.ps1 stat-import 不带路径时弹出系统“打开文件”对话框，
// Linux 的 ops.sh 把所选文件临时复制进一次性容器能读到的 backup/ 再导入。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { importedDigests, importRows, openExistingStatsLedger, openStatsLedger, readLedger, SCHEMA_VERSION, type ImportRows } from "../../src/agent/stats-ledger.ts";
import { appLayout } from "../../src/core/layout.ts";
import { fileSnapshot } from "../../src/core/sqlite-snapshot.ts";
import { DATA_DIR } from "../../src/core/storage.ts";
import { assertExpectedScope, statsFileScope } from "../../src/lib/operation-scope.ts";

export function readImport(path: string, expected?: string): ImportRows {
  if (!existsSync(path)) throw new Error(`找不到统计账本：${path}`);
  // A ledger in WAL mode: the snapshot also reads a -wal that was never checkpointed.
  if (expected !== undefined) assertExpectedScope(expected, statsFileScope(path));
  const snapshot = fileSnapshot(path);
  try {
    if (expected !== undefined) assertExpectedScope(expected, statsFileScope(path));
    const schema = snapshot.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stats_schema'").get()
      ? (snapshot.query("SELECT version FROM stats_schema WHERE id = 1").get() as { version: number } | null)?.version : undefined;
    if (schema !== SCHEMA_VERSION) throw new Error(`统计账本版本为 ${schema ?? "未知"}；导入工具只接受 schema ${SCHEMA_VERSION}`);
    const rows = readLedger(snapshot);
    return { asks: rows.asks.map(({ group, ...row }) => ({ ...row, space: group })), usage: rows.usage.map(({ group, ...row }) => ({ ...row, space: group })) };
  } finally { snapshot.close(); }
}

/** Digest of the rows themselves: the same ledger reads the same, whatever its file pages look like. */
export function importDigest(rows: ImportRows): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

/** What importing `source` into data directory `root` would add, and whether it would (read-only; for the confirmation preview). */
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

export function previewStatsImport(source: string, root: string = DATA_DIR): ImportPreview {
  const target = resolve(appLayout(root).stats);
  if (resolve(source) === target) throw new Error("统计账本不能是当前数据目录的统计账本");
  const rows = readImport(source);
  const days = [...rows.asks, ...rows.usage].map(row => row.day).sort();
  const db = openExistingStatsLedger(target);
  let done: string[] = [];
  try {
    if (db) {
      done = importedDigests(db);
      if (!done.length && (db.query("SELECT 1 FROM asks_daily LIMIT 1").get() || db.query("SELECT 1 FROM usage_daily LIMIT 1").get())) {
        throw new Error("统计仅可恢复到空账本；当前已有统计，拒绝导入以免重复计数");
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

/** Import `source` into the ledger of data directory `root`. The caller holds the maintenance lease. */
export function importStats(source: string, root: string = DATA_DIR, expected?: string): { result: "imported" | "already"; rows: ImportRows } {
  const target = resolve(appLayout(root).stats);
  if (resolve(source) === target) throw new Error("统计账本不能是当前数据目录的统计账本");
  const rows = readImport(source, expected);
  const db = openStatsLedger(target);
  try { return { result: importRows(db, importDigest(rows), rows), rows }; } finally { db.close(); }
}

