// 未完成的部署/升级事务：读取指针和快照中的 transaction 记录，供维护页和恢复菜单展示。
// 只读；继续和回滚都交给 ops 脚本，脚本会再次校验记录。

import { readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { MIGRATION_FILE, migrationCommitted, readMetadata, type MigrationState } from "../../../src/core/data-version.ts";
import { PROJECT_DIR, type Platform } from "./platform.ts";

const KEYS = ["format", "operation", "snapshot", "target_sha", "original_sha", "original_branch", "original_group_root",
  "target_group_root", "was_running", "bot_port", "deploy_mode", "bot_domain", "domain_action", "unmanaged_tunnel", "platform_ip", "reconfigure_ai"] as const;
export type TransactionRecord = Record<(typeof KEYS)[number], string>;

export interface PendingTransaction {
  operation: "deploy" | "upgrade";
  /** Linux 升级在调用部署脚本前中断时还没有快照。 */
  snapshot: string | null;
  /** 旧版事务没有记录：Windows 按已保存设置合成；Linux 已有快照时继续前在终端逐项确认并补录一次。 */
  record: TransactionRecord | null;
  targetSha: string | null;
  /** 数据已经提交时只能继续完成新实例启动。 */
  committed: boolean;
  /** Linux 升级的数据、配置和容器已经回滚，只剩代码待恢复：只能完成回滚。 */
  codeRestorePending: boolean;
}

const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})?$/;
const SNAPSHOT = /^deploy-[A-Za-z0-9]+$/;
/** 直连防火墙放行的来源：IPv4 或 IPv6，可带前缀长度。 */
const PLATFORM_IP = /^(([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9A-Fa-f]*:[0-9A-Fa-f:.]*)(\/[0-9]{1,3})?$/;

function validHostname(value: string): boolean {
  return value.length <= 253 && value === value.toLowerCase() &&
    value.split(".").every(label => label.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label));
}

const absolute = (value: string) => posix.isAbsolute(value) || win32.isAbsolute(value);

/** 与 transaction.sh / deployment.ps1 相同的逐键规则。 */
export function transactionValueValid(key: string, value: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  switch (key) {
    case "format": return value === "1";
    case "operation": return value === "deploy" || value === "upgrade";
    case "snapshot": return SNAPSHOT.test(value);
    case "target_sha": case "original_sha": return SHA.test(value);
    case "original_branch": return /^[^\s~^:?*[\\]*$/.test(value);
    case "original_group_root": case "target_group_root": return absolute(value);
    case "was_running": case "reconfigure_ai": return value === "0" || value === "1";
    case "bot_port": return /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;
    case "deploy_mode": return value === "direct" || value === "cloudflare";
    case "bot_domain": return value === "" || validHostname(value);
    case "domain_action": return ["keep", "persist", "clear"].includes(value);
    case "unmanaged_tunnel": return ["", "direct", "cloudflare"].includes(value);
    case "platform_ip": return value.length <= 64 && PLATFORM_IP.test(value);
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

function readText(path: string): string | null {
  try { return readFileSync(path, "utf8").replace(/^\uFEFF/, ""); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function readSnapshotName(path: string): string | null {
  const name = readText(path)?.trim();
  if (name === undefined) return null;
  if (!SNAPSHOT.test(name)) throw new Error("事务快照名称无效");
  return name;
}

function snapshotCommitted(project: string, snapshot: string | null): boolean {
  if (!snapshot) return false;
  const journal = readMetadata(join(project, "data/state", MIGRATION_FILE)) as (MigrationState & { deployment?: string }) | null;
  return !!journal && journal.deployment === snapshot && migrationCommitted(project, journal);
}

/** 读取未完成的事务；没有时返回 null，指针或记录无效时抛出。 */
export function loadPendingTransaction(project = PROJECT_DIR): PendingTransaction | null {
  const state = join(project, "data/state");
  const deploySnapshot = readSnapshotName(join(state, "deploy-transaction"));
  // Windows 升级有独立指针；Linux 升级是停机记录加部署事务。
  const windowsUpgrade = readSnapshotName(join(state, "upgrade-transaction"));
  const linuxUpgrade = readText(join(state, "update-transaction"));
  const snapshot = windowsUpgrade ?? deploySnapshot;
  if (!snapshot && linuxUpgrade === null) return null;
  const directory = snapshot ? join(project, "backup/snapshots", snapshot) : null;
  const text = directory ? readText(join(directory, "transaction")) : null;
  const record = text === null ? null : parseTransactionRecord(text);
  if (record && record.snapshot !== snapshot) throw new Error("事务记录与快照不一致");
  let targetSha = record?.target_sha || null;
  if (!record && linuxUpgrade !== null) targetSha = linuxUpgrade.split("\n")[3]?.trim() || null;
  else if (!record && directory) {
    targetSha = readText(join(directory, "target-sha"))?.trim()
      // 旧版 Windows 升级只在 Clixml 快照里保存目标提交。
      || /<S N="UpgradeTarget">([0-9a-f]{40})<\/S>/.exec(readText(join(directory, "deployment.xml")) ?? "")?.[1] || null;
  }
  if (targetSha && !SHA.test(targetSha)) throw new Error("事务目标提交无效");
  const operation = windowsUpgrade || linuxUpgrade !== null || record?.operation === "upgrade" ? "upgrade" : "deploy";
  // Linux 升级的部署事务结束后只剩提交回执：已提交就只能继续收尾。
  const receipt = linuxUpgrade !== null && !deploySnapshot && readText(join(state, "update-commit"))?.trim() === "committed";
  const codeRestorePending = !!deploySnapshot && readText(join(project, "backup/snapshots", deploySnapshot, "code-restore")) !== null;
  return { operation, snapshot, record, targetSha, committed: receipt || snapshotCommitted(project, snapshot), codeRestorePending };
}

const shortSha = (sha: string | null) => sha ? sha.slice(0, 7) : "（非 git 部署）";

/** 维护页确认框和恢复菜单共用的摘要：标题一行，记录内容逐行。 */
export function describePendingTransaction(pending: PendingTransaction,
  platform: Platform = process.platform === "win32" ? "windows" : "linux"): { subject: string; record: string[] } {
  const kind = pending.operation === "upgrade" ? "升级" : "部署";
  const record = pending.record;
  return {
    subject: `未完成的${kind}：目标提交 ${shortSha(pending.targetSha)}`,
    record: record ? [
      `群数据总根：${record.target_group_root}${record.original_group_root !== record.target_group_root ? `（原 ${record.original_group_root}）` : ""}`,
      `端口 ${record.bot_port} · 入口 ${record.deploy_mode === "cloudflare" ? "Cloudflare" : `直连（来源 ${record.platform_ip}）`}${record.bot_domain ? ` · ${record.bot_domain}` : ""}`,
      `原运行状态：${record.was_running === "1" ? "运行" : "停止"}`,
    ] : [platform === "linux" && pending.snapshot && !pending.codeRestorePending ? "旧版事务没有记录：继续前需在终端逐项确认并补录一次，回滚不需要" : "旧版事务：继续时按已保存设置处理"],
  };
}
