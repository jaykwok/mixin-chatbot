// Bootstrap contract: built-ins only. Must remain usable before runtime.json is valid.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_VERSION } from "./version.ts";

export const VERSION_FILE = "data-version.json";
export const RELEASE_FILE = "release-data.json";
/**
 * The deployment record (data/state/data-version.json): the data format, the program version and build that last
 * committed a deployment of this data, and the application the whole data directory belongs to. It is written only when
 * a deployment commits, so it names what is actually deployed, never what a newer checkout would install.
 */
export interface DataVersion { dataVersion: number; appVersion: string; build: string; transaction: string; application: string }

/**
 * The application the data belongs to: a digest of the platform environment and AppID (not the AppSecret, which may be
 * rotated). Conversations, member identities and pending deliveries are only meaningful for that application.
 */
export function applicationBinding(app: { readonly environment: string; readonly appId: string }): string {
  return createHash("sha256").update(`${app.environment}\0${app.appId}`).digest("hex");
}
/** A release in progress; `previous` is the deployment record from before it (null for a fresh install), restored by rollback. */
export interface ReleaseState { format: 1; deployment: string; phase: "prepared" | "committed"; previous: DataVersion | null }

const FRESH_DIRECTORY = "请在新目录全新部署（参见 docs/data-migrations.md）；现场已保留";
/** A complete program version (major.minor.patch, optional pre-release/build), as package.json gives it. */
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function readRelease(project: string): ReleaseState | null {
  const value = readMetadata(join(project, "data/state", RELEASE_FILE)) as ReleaseState | null;
  if (value && (value.format !== 1 || !/^deploy-[A-Za-z0-9]+$/.test(value.deployment) || !["prepared", "committed"].includes(value.phase) ||
    (value.previous !== null && (typeof value.previous !== "object" || typeof value.previous.appVersion !== "string")))) throw new Error("发布状态格式不匹配");
  return value;
}
export function verificationPending(project: string): boolean {
  return readRelease(project)?.phase === "prepared";
}

/**
 * A deployment record whose base version fields (data format, transaction, program version and build) are valid, of a
 * data format this program does not support. Unlike a damaged or legacy record, only an upgrader of the target version
 * can say whether it takes the data over; the application binding is that version's to check as well.
 */
export class UnsupportedDataFormat extends Error {}

export function readMetadata(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`无法读取版本状态：${path}`, { cause: error }); }
}

/**
 * The deployment record, or null when there is none. A damaged record, one with missing fields (legacy webhook releases
 * recorded no program version) or an unsupported data format is an error: nothing is initialised over it.
 */
export function readDataVersion(path: string): DataVersion | null {
  const value = readMetadata(path) as Partial<DataVersion> | null;
  if (value === null) return null;
  if (typeof value !== "object" || !Number.isSafeInteger(value.dataVersion) || typeof value.transaction !== "string" || !value.transaction)
    throw new Error(`版本标记损坏：${path}；${FRESH_DIRECTORY}`);
  if (typeof value.appVersion !== "string" || !SEMVER.test(value.appVersion) || typeof value.build !== "string")
    throw new Error(`版本标记没有程序版本（旧版 webhook 数据或标记损坏），不支持原地安装或升级；${FRESH_DIRECTORY}`);
  // A format this program does not know may name its application differently: the format decides first.
  if (value.dataVersion !== DATA_VERSION)
    throw new UnsupportedDataFormat(`数据格式 ${value.dataVersion}（程序 ${value.appVersion}）不受当前程序支持（数据格式 ${DATA_VERSION}）；现场已保留`);
  if (typeof value.application !== "string" || !/^[0-9a-f]{64}$/.test(value.application))
    throw new Error(`版本标记没有应用绑定（未发布的测试数据或标记损坏），不支持原地安装或升级；${FRESH_DIRECTORY}`);
  return value as DataVersion;
}

/**
 * Stores a deployment of this program would own, found in a data directory without a deployment record: any of them means
 * data of another (typically the legacy webhook) release. Configuration written before the first deployment and
 * operator materials under workspace/ are not data in this sense.
 */
export function unrecordedData(project: string): string[] {
  const data = join(project, "data"), found: string[] = [];
  for (const name of ["groups", "conversations", "tmp", "index"]) if (existsSync(join(data, name))) found.push(`data/${name}`);
  for (const name of ["group-data-root", "deploy-mode"]) if (existsSync(join(data, "state", name))) found.push(`data/state/${name}`);
  let state: string[] = [];
  try { state = readdirSync(join(data, "state")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const name of state) if (/\.sqlite(?:-wal|-shm|-journal)?$/.test(name)) found.push(`data/state/${name}`);
  return found;
}

/**
 * New install or upgrade: no record and no data → a fresh install (`null`); a valid record → that deployment; data without
 * a valid record, or a damaged or unsupported record → an error, leaving everything as it is.
 */
export function deploymentRecord(project: string): DataVersion | null {
  const record = readDataVersion(join(project, "data/state", VERSION_FILE));
  if (record) return record;
  const found = unrecordedData(project);
  if (found.length) throw new Error(`目录中已有数据但没有有效的版本标记（${found.slice(0, 4).join("、")}${found.length > 4 ? " 等" : ""}），不支持原地安装或升级；${FRESH_DIRECTORY}`);
  return null;
}

export function inspectDataVersion(project: string): { current: boolean; detail: string } {
  try {
    const record = readDataVersion(join(project, "data/state", VERSION_FILE));
    if (!record) return { current: false, detail: "数据尚未登记，请先部署" };
    return { current: true, detail: `数据格式 ${DATA_VERSION}` };
  } catch (error) { return { current: false, detail: (error as Error).message }; }
}

export function assertDataVersion(project = process.cwd()): void {
  const state = inspectDataVersion(project);
  if (!state.current) throw new Error(state.detail);
}

/** Refuses data registered to another application or environment, before anything opens or rewrites it. */
export function assertApplication(record: DataVersion | null, app: { readonly environment: string; readonly appId: string }): void {
  if (record && record.application !== applicationBinding(app))
    throw new Error("数据目录登记的应用或平台环境与 data/config/app-bot.json 不一致；会话、成员身份和待交付消息不能跨应用沿用。" +
      "如需改用另一个应用，请在新目录全新部署；现场已保留");
}
