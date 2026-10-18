// Bootstrap contract: built-ins only. Must remain usable before runtime.json is valid.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const DATA_VERSION = 6;
export const VERSION_FILE = "data-version.json";
export const RELEASE_FILE = "release-data.json";
/** The group root lease's directory inside the group root (src/core/maintenance.ts); group and user segments never start with a dot. */
export const GROUP_ROOT_LEASE = ".mixin-lease.lock";
export interface DataVersion { dataVersion: number; transaction: string }
export interface ReleaseState { format: 1; deployment: string; groups: string; phase: "prepared" | "committed" }

export function readRelease(project: string): ReleaseState | null {
  const value = readMetadata(join(project, "data/state", RELEASE_FILE)) as ReleaseState | null;
  if (value && (value.format !== 1 || !/^deploy-[A-Za-z0-9]+$/.test(value.deployment)
    || typeof value.groups !== "string" || !["prepared", "committed"].includes(value.phase))) throw new Error("发布状态格式不匹配");
  return value;
}
export function verificationPending(project: string, groups: string): boolean {
  const release = readRelease(project);
  return release?.phase === "prepared" && resolve(release.groups) === resolve(groups);
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
    if (!local && !group) return { current: false, detail: "数据尚未登记，请按 docs/data-migrations.md 准备当前格式，再部署" };
    if (!local || !group || local.dataVersion !== group.dataVersion || local.transaction !== group.transaction) {
      return { current: false, detail: "项目和群根的数据版本标记不成对，请先恢复一致状态。参见 docs/data-migrations.md" };
    }
    if (local.dataVersion < DATA_VERSION) return { current: false, detail: `数据版本 ${local.dataVersion}，当前程序要求 ${DATA_VERSION}；请通过 update 确认保留现有统计账本并重置旧会话。参见 docs/data-migrations.md` };
    if (local.dataVersion > DATA_VERSION) return { current: false, detail: `数据版本 ${local.dataVersion} 高于当前程序 ${DATA_VERSION}，禁止降级清理。参见 docs/data-migrations.md` };
    return { current: true, detail: `数据版本 ${DATA_VERSION}` };
  } catch (error) { return { current: false, detail: (error as Error).message }; }
}

export function assertDataVersion(project = process.cwd(), groups = serviceGroupRoot(project)): void {
  const state = inspectDataVersion(project, groups);
  if (!state.current) throw new Error(state.detail);
}
