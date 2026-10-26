// 未完成的部署/升级事务：读取指针和快照中的 transaction 记录，供维护页和恢复菜单展示。
// 只读；继续和回滚都交给 ops 脚本，脚本会再次校验记录。

import { join, posix, resolve, win32 } from "node:path";
import { RELEASE_FILE, type ReleaseState } from "../../../src/core/data-version.ts";
import { PROJECT_DIR, type Platform } from "./platform.ts";
import { readTransaction, type TransactionReadSet } from "../../lib/confirmed-transaction.ts";

const KEYS = ["format", "operation", "snapshot", "target_sha", "original_sha", "original_branch", "original_workspace_root",
  "target_workspace_root", "was_running", "bot_port", "reconfigure_ai"] as const;
export type TransactionRecord = Record<(typeof KEYS)[number], string>;

export interface PendingTransaction {
  confirmation: TransactionReadSet;
  operation: "deploy" | "upgrade";
  /** Linux 升级在调用部署脚本前中断时还没有快照。 */
  snapshot: string | null;
  /** Preparing a Linux upgrade before its deployment snapshot has no record yet. */
  record: TransactionRecord | null;
  targetSha: string | null;
  /** 数据已经提交时只能继续完成新实例启动。 */
  committed: boolean;
  /** Linux 升级的数据、配置和容器已经回滚，只剩代码待恢复：只能完成回滚。 */
  codeRestorePending: boolean;
}

const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})?$/;
const SNAPSHOT = /^deploy-[A-Za-z0-9]+$/;

const absolute = (value: string) => posix.isAbsolute(value) || win32.isAbsolute(value);

/** 与 transaction.sh / deployment.ps1 相同的逐键规则。 */
export function transactionValueValid(key: string, value: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  switch (key) {
    case "format": return value === "2";
    case "operation": return value === "deploy" || value === "upgrade";
    case "snapshot": return SNAPSHOT.test(value);
    case "target_sha": case "original_sha": return SHA.test(value);
    case "original_branch": return /^[^\s~^:?*[\\]*$/.test(value);
    case "original_workspace_root": case "target_workspace_root": return !value || absolute(value);
    case "was_running": case "reconfigure_ai": return value === "0" || value === "1";
    case "bot_port": return /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;
    default: return false;
  }
}

/** 重复、未知、缺失或非法的键都拒绝整份记录。 */
export function parseTransactionRecord(text: string): TransactionRecord {
  const record: Partial<Record<string, string>> = {};
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const index = line.indexOf("=");
    if (index < 1) throw new Error("事务记录无效");
    const key = line.slice(0, index), value = line.slice(index + 1);
    if (key in record || !transactionValueValid(key, value)) throw new Error(`事务记录无效：${key}`);
    record[key] = value;
  }
  for (const key of KEYS) if (record[key] === undefined) throw new Error(`事务记录缺少：${key}`);
  return record as TransactionRecord;
}

function snapshotCommitted(read: TransactionReadSet, snapshot: string | null): boolean {
  if (!snapshot) return false;
  const release = JSON.parse(read.text("data/state/" + RELEASE_FILE) ?? "null") as ReleaseState | null;
  return release?.format === 1 && release.deployment === snapshot && release.phase === "committed";
}

/** 读取未完成的事务；没有时返回 null，指针或记录无效时抛出。 */
export function loadPendingTransaction(project = PROJECT_DIR): PendingTransaction | null {
  project = resolve(project);
  const confirmation = readTransaction(project);
  if (!confirmation) return null;
  // Use exactly the captured bytes for both the preview and the confirmation fingerprint.
  const readText = (path: string) => confirmation.text(path.slice(project.length + 1).replaceAll("\\", "/"));
  const readSnapshotName = (path: string) => {
    const name = readText(path)?.trim();
    if (name === undefined) return null;
    if (!SNAPSHOT.test(name)) throw new Error("事务快照名称无效");
    return name;
  };
  const state = join(project, "data/state");
  const deploySnapshot = readSnapshotName(join(state, "deploy-transaction"));
  // Windows 升级有独立指针；Linux 升级是停机记录加部署事务。
  const windowsUpgrade = readSnapshotName(join(state, "upgrade-transaction"));
  const snapshot = windowsUpgrade ?? deploySnapshot;
  if (!snapshot) return null;
  const directory = snapshot ? join(project, "backup/snapshots", snapshot) : null;
  const text = directory ? readText(join(directory, "transaction")) : null;
  const record = text === null ? null : parseTransactionRecord(text);
  if (record && record.snapshot !== snapshot) throw new Error("事务记录与快照不一致");
  let targetSha = record?.target_sha || null;
  if (directory && record === null) throw new Error("事务格式不匹配，请用对应版本完成原操作");
  if (targetSha && !SHA.test(targetSha)) throw new Error("事务目标提交无效");
  const operation = windowsUpgrade || record?.operation === "upgrade" ? "upgrade" : "deploy";
  const codeRestorePending = !!deploySnapshot && readText(join(project, "backup/snapshots", deploySnapshot, "code-restore")) !== null;
  return { confirmation, operation, snapshot, record, targetSha, committed: snapshotCommitted(confirmation, snapshot), codeRestorePending };
}

const shortSha = (sha: string | null) => sha ? sha.slice(0, 7) : "（非 git 部署）";
const workspace = (root: string) => root || "data/workspace";

/** 维护页确认框和恢复菜单共用的摘要：标题一行，记录内容逐行。 */
export function describePendingTransaction(pending: PendingTransaction,
  _platform: Platform = process.platform === "win32" ? "windows" : "linux"): { subject: string; record: string[] } {
  const kind = pending.operation === "upgrade" ? "升级" : "部署";
  const record = pending.record;
  return {
    subject: `未完成的${kind}：目标提交 ${shortSha(pending.targetSha)}`,
    record: record ? [
      `共享资料目录：${workspace(record.target_workspace_root)}${record.original_workspace_root !== record.target_workspace_root ? `（原 ${workspace(record.original_workspace_root)}）` : ""}`,
      `本机端口 ${record.bot_port}`,
      `原运行状态：${record.was_running === "1" ? "运行" : "停止"}`,
    ] : ["升级正在准备当前发布记录"],
  };
}
