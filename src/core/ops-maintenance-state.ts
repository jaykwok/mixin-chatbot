// Public, non-secret recovery metadata for host orchestration. The service reads this without importing any host API.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpsResult } from "../contracts/ops-result.ts";
import type { MaintenanceIntent } from "./maintenance-state.ts";
import { validateOpsRuntimeDraft, type OpsRuntimeDraft } from "../contracts/ops-runtime-draft.ts";
import { validateOpsWriter, type DockerTaskRecord, type WindowsTaskRecord } from "../contracts/ops-writer.ts";

export const OPS_MAINTENANCE_FILE = "data/state/ops-maintenance.json";
export interface ServiceFacts {
  /** Stable deployment identity (container or task plus project); must not contain a changing PID or health state. */
  identity: string;
  state: "running" | "stopped" | "absent" | "unsupported";
  owned: boolean;
  ready: boolean;
  pending: boolean;
}
export interface MaintenanceRequest {
  id: string;
  runtime: string;
  command: string;
  intent: MaintenanceIntent;
  label: string;
  /** Read/preview or explicitly online-safe work still holds the same lock and tracks its process across interruption. */
  online?: true;
  /** Identifier only. Configuration bytes never enter the host journal. */
  configuration?: string;
}
export interface MaintenanceCheckpoint {
  version: 1;
  request: MaintenanceRequest;
  original: ServiceFacts;
  phase: "prepared" | "stopping" | "acting" | "recovering" | "starting" | "completing";
}
export interface StatsStageRecord {
  version: 1;
  kind: "stats-import";
  id: string;
  owner: { uid: number; gid: number };
  phase: "prepared" | "created" | "ready" | "removed";
  directory?: { dev: string; ino: string };
  digest?: string;
}
export interface OpsMaintenanceRecord {
  version: 1;
  checkpoint: MaintenanceCheckpoint;
  /** No document keys, action argv, credentials or message bodies. */
  writer?: DockerTaskRecord | WindowsTaskRecord;
  staging?: StatsStageRecord;
  runtimeDraft?: OpsRuntimeDraft;
  result?: OpsResult;
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const text = (value: unknown, max = 1024): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);

/** Validate the small control record completely; malformed fields must never turn an unfinished write into success. */
export function validateOpsMaintenanceRecord(value: unknown): OpsMaintenanceRecord {
  const record = value as OpsMaintenanceRecord, c = record?.checkpoint, request = c?.request, original = c?.original, writer = record?.writer;
  if (!record || typeof record !== "object" || Array.isArray(record)
    || Object.hasOwn(record, "writer") && (!writer || typeof writer !== "object" || Array.isArray(writer))
    || Object.hasOwn(record, "staging") && (!record.staging || typeof record.staging !== "object" || Array.isArray(record.staging))
    || Object.hasOwn(record, "result") && (!record.result || typeof record.result !== "object" || Array.isArray(record.result))) throw new Error("运维恢复记录类型无效");
  if (record?.version !== 1 || c?.version !== 1 || !id(request?.id) || !hash(request.runtime)
    || !text(request.command, 80) || !/^[a-z][a-z0-9-]*$/.test(request.command) || !text(request.label, 160)
    || Object.hasOwn(request, "online") && request.online !== true
    || (["configuration-apply", "configuration-restore", "runtime-configure"].includes(request.command)
      ? typeof request.configuration !== "string" || !/^config-[a-f0-9]{32}$/.test(request.configuration)
      : request.configuration !== undefined)
    || !["service", "conversation-write", "configuration", "configuration-restore"].includes(request.intent)
    || !["prepared", "stopping", "acting", "recovering", "starting", "completing"].includes(c.phase)
    || !hash(original?.identity) || !["running", "stopped", "absent"].includes(original.state) || original.owned !== true
    || original.pending !== false || typeof original.ready !== "boolean") throw new Error("运维恢复记录格式不支持或不完整");
  if (writer) validateOpsWriter(writer, request.runtime);
  const staging = record.staging;
  if (Object.hasOwn(record, "runtimeDraft")) {
    if (request.command !== "runtime-configure") throw new Error("运行参数草稿不属于此维护");
    validateOpsRuntimeDraft(record.runtimeDraft);
  }
  if (staging && (request.command !== "stat-import" || staging.kind !== "stats-import" || staging.version !== 1 || staging.id !== request.id
    || !["prepared", "created", "ready", "removed"].includes(staging.phase)
    || !staging.owner || ![staging.owner.uid, staging.owner.gid].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff)
    || staging.directory !== undefined && (!staging.directory || typeof staging.directory.dev !== "string" || typeof staging.directory.ino !== "string"
      || !/^\d+$/.test(staging.directory.dev) || !/^\d+$/.test(staging.directory.ino))
    || ["created", "ready"].includes(staging.phase) && !staging.directory || staging.phase === "ready" && !hash(staging.digest)
    || staging.digest !== undefined && !hash(staging.digest))) throw new Error("统计副本恢复记录不完整");
  if (record.result) {
    const r = record.result;
    if (r.protocol !== "mixin-ops" || r.version !== 1 || r.command !== request.command || !["success", "failed", "refused"].includes(r.outcome)
      || r.wasRunning !== (original.state === "running") || !["running", "stopped", "start-requested", "unknown"].includes(r.finalState)
      || !Number.isInteger(r.exitCode) || r.exitCode < 0 || r.exitCode > 255 || typeof r.message !== "string" || r.message.length > 8192
      || (r.outcome === "success") !== (r.exitCode === 0) || writer && writer.phase !== "reaped" || staging && staging.phase !== "removed"
      || record.runtimeDraft && record.runtimeDraft.phase !== "removed"
      || r.outcome === "success" && r.finalState !== (r.wasRunning ? "running" : "stopped")) throw new Error("运维结果不完整或写入者尚未回收");
  }
  return record;
}

export function readOpsMaintenanceRecord(project: string): OpsMaintenanceRecord | null {
  const path = join(project, OPS_MAINTENANCE_FILE);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error();
    return validateOpsMaintenanceRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("运维恢复记录无法读取或格式不支持；保留现场，先运行 ops maintenance-recover");
  }
}

/** The host explicitly authorizes startup only after its writer was reaped and disk state was reassessed. */
export function opsBlocksStartup(record: OpsMaintenanceRecord): boolean {
  return !record.result && (!!record.writer && record.writer.phase !== "reaped" || !["starting", "completing"].includes(record.checkpoint.phase));
}
