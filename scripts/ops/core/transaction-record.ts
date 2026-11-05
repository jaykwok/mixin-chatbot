// Host-only deployment choices. UI and orchestration share these rules; no configuration or data stores are loaded.
import { posix, win32 } from "node:path";

export const TRANSACTION_KEYS = ["format", "operation", "snapshot", "target_sha", "original_sha", "original_branch",
  "original_workspace_root", "target_workspace_root", "was_running", "bot_port", "reconfigure_ai"] as const;
export type TransactionRecord = Record<(typeof TRANSACTION_KEYS)[number], string>;
export const TRANSACTION_NAME = /^deploy-[A-Za-z0-9]+$/;

export function transactionValueValid(key: string, value: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  switch (key) {
    case "format": return value === "2";
    case "operation": return value === "deploy" || value === "upgrade";
    case "snapshot": return TRANSACTION_NAME.test(value);
    case "target_sha": case "original_sha": return /^([0-9a-f]{40}|[0-9a-f]{64})?$/.test(value);
    case "original_branch": return /^[^\s~^:?*[\\]*$/.test(value);
    case "original_workspace_root": case "target_workspace_root": return !value || posix.isAbsolute(value) || win32.isAbsolute(value);
    case "was_running": case "reconfigure_ai": return value === "0" || value === "1";
    case "bot_port": return /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;
    default: return false;
  }
}

/** No unknown/duplicate/missing keys, partial records or guessed legacy defaults. */
export function parseTransactionRecord(text: string): TransactionRecord {
  const record: Partial<Record<string, string>> = {};
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const index = line.indexOf("=");
    if (index < 1) throw new Error("事务记录无效");
    const key = line.slice(0, index), value = line.slice(index + 1);
    if (Object.hasOwn(record, key) || !transactionValueValid(key, value)) throw new Error(`事务记录无效：${key}`);
    record[key] = value;
  }
  for (const key of TRANSACTION_KEYS) if (record[key] === undefined) throw new Error(`事务记录缺少：${key}`);
  return record as TransactionRecord;
}

export function serializeTransactionRecord(record: TransactionRecord): string {
  if (Object.keys(record).length !== TRANSACTION_KEYS.length || Object.keys(record).some(key => !(TRANSACTION_KEYS as readonly string[]).includes(key)))
    throw new Error("事务记录包含未知或缺少的字段");
  const text = TRANSACTION_KEYS.map(key => {
    if (typeof record[key] !== "string" || !transactionValueValid(key, record[key])) throw new Error(`事务记录无效：${key}`);
    return key + "=" + record[key];
  }).join("\n") + "\n";
  parseTransactionRecord(text);
  return text;
}
