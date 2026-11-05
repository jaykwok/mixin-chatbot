// Configuration publication is separate from database maintenance, but a half-published set must block startup too.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const CONFIGURATION_STATE_FILE = "data/state/configuration-change.json";
export type ConfigurationPhase = "publishing" | "ready" | "restoring" | "committed" | "rolled-back";
export interface ConfigurationState {
  version: 1; id: string; kind: "models" | "app" | "relay" | "runtime"; phase: ConfigurationPhase; binding: string | null;
  rows: { key: "models" | "settings" | "catalog" | "app" | "relay" | "runtime"; before: string | null; after: string | null }[];
}
/** Stable read-set token, shared with the lock-held CLI recheck. No secret bytes are in this state. */
export function configurationStateDigest(value: ConfigurationState): string {
  return createHash("sha256").update(JSON.stringify([value.version, value.id, value.kind, value.phase, value.binding,
    [...value.rows].sort((a, b) => a.key.localeCompare(b.key)).map(row => [row.key, row.before, row.after])])).digest("hex");
}
export function readConfigurationState(project: string): ConfigurationState | null {
  const path = join(project, CONFIGURATION_STATE_FILE);
  try {
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) throw new Error();
    const value = JSON.parse(readFileSync(path, "utf8")) as ConfigurationState;
    const keys = value.kind === "models" ? ["models", "settings", "catalog"] : value.kind === "app" ? ["app"] : value.kind === "relay" ? ["relay"] : value.kind === "runtime" ? ["runtime"] : [];
    const digest = (value: unknown) => value === null || typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (value.version !== 1 || !/^config-[a-f0-9]{32}$/.test(value.id) || !["publishing", "ready", "restoring", "committed", "rolled-back"].includes(value.phase)
      || !keys.length || !digest(value.binding) || !Array.isArray(value.rows) || value.rows.length !== keys.length
      || new Set(value.rows.map(row => row.key)).size !== keys.length
      || value.rows.some(row => !keys.includes(row.key) || !digest(row.before) || !digest(row.after))) throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("配置发布状态无法读取或格式不支持；请保留现场并先恢复配置");
  }
}
