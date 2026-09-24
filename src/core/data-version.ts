// Bootstrap contract: built-ins only. Must remain usable before runtime.json is valid.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DATA_VERSION = 1;
export const VERSION_FILE = "data-version.json";
export const MIGRATION_FILE = "migration.json";
export interface DataVersion { dataVersion: number; transaction: string }
export interface MigrationState { id: string; target: number; phase: string; groups: string; kind?: "migration" | "verification" | "registration" }

/** The project marker is the commit point; the group marker is not a rollback permit. */
export function migrationCommitted(project: string, journal: MigrationState): boolean {
  if (journal.phase === "committed") return true;
  if (journal.kind === "verification") return false;
  const local = readDataVersion(join(project, "data/state", VERSION_FILE));
  return local?.dataVersion === journal.target && local.transaction === journal.id;
}

export function verificationPending(project: string, groups: string): boolean {
  const journal = readMetadata(join(project, "data/state", MIGRATION_FILE)) as MigrationState | null;
  return !!journal && journal.phase === "validated" && journal.target === DATA_VERSION && journal.groups === groups && !migrationCommitted(project, journal);
}

export function readMetadata(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`无法读取版本状态：${path}`, { cause: error }); }
}

export function readDataVersion(path: string): DataVersion | null {
  const value = readMetadata(path) as DataVersion | null;
  if (value === null) return null;
  if (!Number.isSafeInteger(value?.dataVersion) || value.dataVersion < 1 || typeof value.transaction !== "string" || !value.transaction) {
    throw new Error(`无法识别版本文件：${path}`);
  }
  return value;
}

/** Service paths use runtime.json; host tools pass their independently mounted group root. */
export function serviceGroupRoot(project = process.cwd()): string {
  const config = readMetadata(join(project, "data/config/runtime.json")) as Record<string, unknown> | null;
  const value = process.env.GROUP_DATA_ROOT?.trim() || config?.GROUP_DATA_ROOT || "data/groups";
  if (typeof value !== "string") throw new Error("GROUP_DATA_ROOT 必须是路径字符串");
  return resolve(project, value);
}

export function inspectDataVersion(project: string, groups: string): { current: boolean; detail: string } {
  try {
    const local = readDataVersion(join(project, "data/state", VERSION_FILE));
    const group = readDataVersion(join(groups, VERSION_FILE));
    const pending = readMetadata(join(project, "data/state", MIGRATION_FILE)) as MigrationState | null;
    if (local?.dataVersion && local.dataVersion > DATA_VERSION || group?.dataVersion && group.dataVersion > DATA_VERSION) {
      return { current: false, detail: "数据版本比代码新，请使用匹配的代码；禁止降级启动" };
    }
    if (pending && !migrationCommitted(project, pending)) {
      return { current: false, detail: "迁移尚未提交，请通过升级继续或恢复备份" };
    }
    if (!local && !group) return { current: false, detail: "数据尚未登记，请通过升级完成迁移和校验" };
    if (!local || !group || local.dataVersion !== DATA_VERSION || group.dataVersion !== DATA_VERSION || local.transaction !== group.transaction) {
      return { current: false, detail: "项目和群根标记不成对或版本不匹配，请通过升级重新校验并登记；已提交迁移不能回滚" };
    }
    return { current: true, detail: `数据版本 ${DATA_VERSION}` };
  } catch (error) { return { current: false, detail: (error as Error).message }; }
}

export function assertDataVersion(project = process.cwd(), groups = serviceGroupRoot(project)): void {
  const state = inspectDataVersion(project, groups);
  if (!state.current) throw new Error(state.detail);
}
