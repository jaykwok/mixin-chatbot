// Saved maintenance documents: archive plans, removal lists, physical reclamation plans, their progress files and the
// platform deletion journals. Pure decoders over parsed JSON, loadable by the host TUI: no file system, SQLite, FFI or
// service code. The rules are those of the readers they replaced; a failure keeps the reader's message and names the
// first rule that failed. Digests cover the saved fields in their saved order — nothing is sorted, added or dropped.
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { isPathInside } from "./paths.ts";

export class ContractError extends Error {}

export interface TreeEvidence { dev: string; ino: string; uid: number; fingerprint: string; bytes: number; files: number; newest: number; }

export function validTreeEvidence(value: unknown): value is TreeEvidence {
  if (!value || typeof value !== "object") return false;
  const v = value as TreeEvidence;
  return /^\d+$/.test(v.dev) && /^\d+$/.test(v.ino) && /^[a-f\d]{64}$/.test(v.fingerprint)
    && Number.isSafeInteger(v.uid) && v.uid >= 0
    && Number.isSafeInteger(v.bytes) && v.bytes >= 0 && v.bytes <= 4 * 1024 ** 3
    && Number.isSafeInteger(v.files) && v.files >= 0 && v.files <= 100_000 && Number.isFinite(v.newest);
}

/** A result's owner as the space's results document and the maintenance plans record it. */
export type ResultOwnership = { phone: string; createdAt: number; isolatedTask?: string; expiryRequestedAt?: number; expiredAt?: number;
  reclamation?: { status: "deferred" | "refused"; reason?: string; identity?: { dev: string; ino: string }; attemptedAt: number; nextAttemptAt: number } };

/** One ownership rule for online and offline maintenance: the same member, registration time and isolated task.
 * Expiry and reclamation bookkeeping never make two records different owners. */
export function sameOwnership(a: Pick<ResultOwnership, "phone" | "createdAt" | "isolatedTask">, b: Pick<ResultOwnership, "phone" | "createdAt" | "isolatedTask">): boolean {
  return a.phone === b.phone && a.createdAt === b.createdAt && a.isolatedTask === b.isolatedTask;
}

export const ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export const DIGEST_PATTERN = /^[a-f\d]{64}$/;
export const RESULT_NAME = /^\d+-[A-Za-z0-9_.-]+$/;
const SEGMENT = /^[A-Za-z0-9_+\-]{1,100}$/;
const INDEX_KEY = /^(0|[1-9]\d*)$/;
const MAX_ITEMS = 100_000;
const PLAN_STATUSES = ["ready", "kept", "deferred"] as const;
type PlanStatus = typeof PLAN_STATUSES[number];

/** sha256 over every saved field except `digest`, in saved key order. */
export function planDigest(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);
const isSegment = (value: unknown): value is string => typeof value === "string" && SEGMENT.test(value);
/** A space's storage path below tmp/ and conversations/: `direct` or `groups/<segment>` (src/core/layout.ts `spacePath`). */
export const isSpacePath = (value: unknown): value is string =>
  value === "direct" || (typeof value === "string" && value.startsWith("groups/") && isSegment(value.slice("groups/".length)));
/** A member's tmp below the data root (src/core/layout.ts `userTmp`). */
export function memberTmpDir(root: string, space: string, user: string): string {
  return join(root, "tmp", ...space.split("/"), user);
}
const isDigits = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.includes(value as T);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Check = (ok: boolean, field: string) => asserts ok;
/** Throws `message：field` for the first failed rule. */
function checker(message: string): Check {
  return (ok, field) => { if (!ok) throw new ContractError(`${message}：${field}`); };
}

/** The saved digest equals the expected one and still covers the other fields. */
function digested(value: Fields, expected: string): boolean {
  const { digest, ...rest } = value;
  return digest === expected && planDigest(rest) === expected;
}

// ---- Archive plans (backup/rm/.tmp-plans/<id>.json) and their progress ----

export type ArchiveItem = { space: string; user: string; source: string; destination: string; task?: string; evidence?: TreeEvidence;
  owners: Record<string, ResultOwnership>; status: PlanStatus; reason?: string };
export interface TmpArchivePlan { version: 1; id: string; root: string; rootIdentity: string; archive: string; recordedRoot: string;
  createdAt: number; before: number; items: ArchiveItem[]; digest: string; }
export interface TmpArchiveProgress { version: 1; digest: string; started: number[];
  outcomes: Record<string, { status: "archived" | "kept" | "deferred" | "failed"; bytes: number; reason?: string }>; }

/** The names the plan must carry. `recordedRoot` is compared only when given. The root's identity needs the
 * file system and stays with the caller. */
export interface ArchivePlanView { id: string; digest: string; root: string; archive: string; recordedRoot?: string }

export function decodeArchivePlan(value: unknown, view: ArchivePlanView): TmpArchivePlan {
  const need: Check = checker("归档清单、摘要或实体已变化");
  need(isRecord(value), "清单");
  need(value.version === 1, "version");
  need(value.id === view.id, "id");
  need(digested(value, view.digest), "digest");
  need(value.root === view.root, "root");
  need(value.archive === view.archive, "archive");
  need(view.recordedRoot === undefined || value.recordedRoot === view.recordedRoot, "recordedRoot");
  need(Array.isArray(value.items) && value.items.length <= MAX_ITEMS, "items");
  need(Number.isFinite(value.before), "before");
  value.items.forEach((item: unknown, index: number) => {
    const at = `items[${index}]`;
    need(isRecord(item), at);
    need(isSpacePath(item.space) && isSegment(item.user), `${at}.space/user`);
    const member = memberTmpDir(view.root, item.space, item.user);
    need(typeof item.source === "string" && isPathInside(item.source, member) && resolve(item.source) === item.source, `${at}.source`);
    need(!(item.source === member && item.status === "ready"), `${at}.source（成员 tmp 本身不能归档）`);
    need(item.destination === join(view.archive, `tmp-${view.id}-${index}`), `${at}.destination`);
    need(oneOf(PLAN_STATUSES, item.status), `${at}.status`);
    need(item.evidence === undefined || validTreeEvidence(item.evidence), `${at}.evidence`);
    need(item.task === undefined || isId(item.task), `${at}.task`);
    need(isRecord(item.owners), `${at}.owners`);
    for (const [name, owner] of Object.entries(item.owners)) {
      need(RESULT_NAME.test(name) && isRecord(owner) && typeof owner.phone === "string" && Number.isFinite(owner.createdAt)
        && (owner.isolatedTask === undefined || isId(owner.isolatedTask)), `${at}.owners.${name}`);
    }
  });
  return value as unknown as TmpArchivePlan;
}

/** Archive and removal progress: numeric `started`, outcomes keyed by item index; `done` only after its start was saved. */
function decodeIndexedProgress(value: unknown, message: string, digest: string, length: number, statuses: readonly string[], done: string) {
  const need: Check = checker(message);
  need(isRecord(value), "进度");
  need(value.version === 1, "version");
  need(value.digest === digest, "digest");
  const started = value.started;
  need(Array.isArray(started) && started.every(index => Number.isSafeInteger(index) && index >= 0 && index < length), "started");
  need(isRecord(value.outcomes), "outcomes");
  for (const [key, outcome] of Object.entries(value.outcomes)) {
    need(INDEX_KEY.test(key) && +key < length, `outcomes.${key}`);
    need(isRecord(outcome) && oneOf(statuses, outcome.status) && isCount(outcome.bytes) && validFinishing(outcome, done), `outcomes.${key}`);
    need(outcome.status !== done || started.includes(+key), `outcomes.${key}（未记录开始）`);
  }
  return value;
}

export function decodeArchiveProgress(value: unknown, plan: Pick<TmpArchivePlan, "digest" | "items">): TmpArchiveProgress {
  return decodeIndexedProgress(value, "归档进度与清单不符", plan.digest, plan.items.length, ["archived", "kept", "deferred", "failed"], "archived") as unknown as TmpArchiveProgress;
}

// ---- Removal lists for archived entries (<id>.removal.json) and their progress ----

export type RemovalItem = { plan: string; planDigest: string; index: number; destination: string; task?: string; evidence: TreeEvidence;
  kind: "directory" | "file" | "link"; status: PlanStatus; reason?: string };
export interface ArchiveRemovalPlan { version: 1; id: string; archive: string; archiveIdentity: string; createdAt: number;
  items: RemovalItem[]; skipped: { plan: string; reason: string }[]; digest: string; }
export interface ArchiveRemovalProgress { version: 1; digest: string; started: number[];
  outcomes: Record<string, { status: "removed" | "kept" | "deferred" | "failed" | "missing"; bytes: number; reason?: string; finishing?: true }>; }

/** A removal its backend found already done when this list reached it (an earlier run, or another list): the list only
 * finished the bookkeeping. Nothing proves which list deleted the content, so its bytes are never counted here. */
export const finishedEarlier = () => ({ status: "removed" as const, bytes: 0, finishing: true as const,
  reason: "删除已由此前的操作完成，本次只补完记录，不计入释放量" });
/** A finishing marker is only valid on a removed outcome (removal lists, physical reclamation) with no bytes. */
const validFinishing = (outcome: Record<string, unknown>, done: string) =>
  outcome.finishing === undefined || done === "removed" && outcome.finishing === true && outcome.status === "removed" && outcome.bytes === 0;

/** The archive's identity needs the file system and stays with the caller. */
export function decodeRemovalPlan(value: unknown, view: { id: string; digest: string; archive: string }): ArchiveRemovalPlan {
  const need: Check = checker("删除清单、摘要或归档根已变化");
  need(isRecord(value), "清单");
  need(value.version === 1, "version");
  need(value.id === view.id, "id");
  need(digested(value, view.digest), "digest");
  need(value.archive === view.archive, "archive");
  need(Array.isArray(value.items) && value.items.length <= MAX_ITEMS, "items");
  value.items.forEach((item: unknown, index: number) => {
    const at = `items[${index}]`;
    need(isRecord(item), at);
    need(isId(item.plan) && typeof item.planDigest === "string" && DIGEST_PATTERN.test(item.planDigest), `${at}.plan`);
    need(Number.isSafeInteger(item.index) && (item.index as number) >= 0, `${at}.index`);
    need(item.destination === join(view.archive, `tmp-${item.plan}-${item.index}`), `${at}.destination`);
    need(validTreeEvidence(item.evidence), `${at}.evidence`);
    need(oneOf(["directory", "file", "link"], item.kind), `${at}.kind`);
    need(oneOf(PLAN_STATUSES, item.status), `${at}.status`);
    need(item.task === undefined || isId(item.task), `${at}.task`);
  });
  return value as unknown as ArchiveRemovalPlan;
}

export function decodeRemovalProgress(value: unknown, removal: Pick<ArchiveRemovalPlan, "digest" | "items">): ArchiveRemovalProgress {
  return decodeIndexedProgress(value, "删除进度与清单不符", removal.digest, removal.items.length,
    ["removed", "kept", "deferred", "failed", "missing"], "removed") as unknown as ArchiveRemovalProgress;
}

// ---- Physical reclamation plans (.reclamation/plans/<id>.json) and their progress ----

export type ReclaimItem = { space: string; user: string; path: string; task?: string; token?: string; result?: string; owner?: ResultOwnership;
  evidence?: TreeEvidence; status: PlanStatus; reason?: string };
export interface ReclamationPlan { version: 1; id: string; root: string; recordedRoot: string; rootIdentity: string; legacy: boolean;
  createdAt: number; before: number; items: ReclaimItem[]; digest: string; }
export type ReclaimOutcome = { status: "removed" | "kept" | "deferred" | "failed"; bytes: number; reason?: string; finishing?: true };
/** Unlike archive progress: the plan digest is saved as `plan`, and `started` holds string keys. */
export type ReclaimProgress = { version: 1; plan: string; outcomes: Record<string, ReclaimOutcome>; started: string[] };

/** `recordedRoot` is the name the plan must record (the host's own root when not given). The root's identity stays with the caller. */
export function decodeReclaimPlan(value: unknown, view: { id: string; digest: string; root: string; recordedRoot: string; legacy: boolean }): ReclamationPlan {
  const need: Check = checker("回收清单、摘要或数据目录实体已变化，拒绝执行");
  need(isRecord(value), "清单");
  need(value.version === 1, "version");
  need(value.id === view.id, "id");
  need(digested(value, view.digest), "digest");
  need(value.root === view.root, "root");
  need(value.legacy === view.legacy, "legacy");
  need(value.recordedRoot === view.recordedRoot, "recordedRoot");
  need(Array.isArray(value.items) && value.items.length <= MAX_ITEMS, "items");
  need(Number.isFinite(value.before), "before");
  value.items.forEach((item: unknown, index: number) => {
    const at = `items[${index}]`;
    need(isRecord(item), at);
    need(isSpacePath(item.space) && isSegment(item.user), `${at}.space/user`);
    need(typeof item.path === "string" && resolve(item.path) === item.path, `${at}.path`);
    need(oneOf(PLAN_STATUSES, item.status), `${at}.status`);
    need(item.evidence === undefined || validTreeEvidence(item.evidence), `${at}.evidence`);
    need(item.task === undefined || isId(item.task), `${at}.task`);
  });
  return value as unknown as ReclamationPlan;
}

export function decodeReclaimProgress(value: unknown, plan: Pick<ReclamationPlan, "digest" | "items">): ReclaimProgress {
  const need: Check = checker("回收进度与清单不匹配");
  const validKey = (key: unknown) => typeof key === "string" && INDEX_KEY.test(key) && Number(key) < plan.items.length;
  need(isRecord(value), "进度");
  need(value.version === 1, "version");
  need(value.plan === plan.digest, "plan");
  const started = value.started;
  need(Array.isArray(started) && started.every(validKey), "started");
  need(isRecord(value.outcomes), "outcomes");
  for (const [key, outcome] of Object.entries(value.outcomes)) {
    need(validKey(key) && isRecord(outcome) && oneOf(["removed", "kept", "deferred", "failed"], outcome.status) && isCount(outcome.bytes)
      && validFinishing(outcome, "removed"), `outcomes.${key}`);
    need(outcome.status !== "removed" || started.includes(key), `outcomes.${key}（未记录开始）`);
  }
  return value as unknown as ReclaimProgress;
}

// ---- Platform deletion journals ----

export type WindowsTreeEntry = { path: string; dev: string; ino: string; attributes: number };
export type WindowsJournal = { version: 1; path: string; proof: TreeEvidence; phase: "deleting" | "removed"; entries: WindowsTreeEntry[] };

/** A Windows deletion journal for exactly this path and reviewed evidence. */
export function decodeWindowsJournal(value: unknown, path: string, proof: TreeEvidence): WindowsJournal {
  const need: Check = checker("Windows 回收事务与清单不符");
  need(isRecord(value), "事务");
  need(value.version === 1, "version");
  need(value.path === path, "path");
  need(sameJson(value.proof, proof), "proof");
  need(oneOf(["deleting", "removed"], value.phase), "phase");
  const entries = value.entries;
  need(Array.isArray(entries) && entries.length > 0 && entries.length <= MAX_ITEMS, "entries");
  need(entries.every(entry => isRecord(entry) && typeof entry.path === "string" && isDigits(entry.dev) && isDigits(entry.ino)
    && Number.isInteger(entry.attributes)), "entries[]");
  need(entries[0].path === "", "entries[0].path");
  need(new Set(entries.map(entry => entry.path)).size === entries.length, "entries（路径重复）");
  return value as unknown as WindowsJournal;
}

export type FrozenDirectory = { relative: string; dev: string; ino: string; uid: number; gid: number; mode: number };
export type LegacyJournal = { version: 1; path: string; parent: string; proof: TreeEvidence; phase: "fencing" | "deleting" | "removed" | "restored";
  directories: FrozenDirectory[] };

/** A Linux shared-directory journal: index 0 is the parent (`..`); every frozen directory below it belonged to the old writer. */
export function decodeLegacyJournal(value: unknown, path: string, parent: string, proof: TreeEvidence): LegacyJournal {
  const need: Check = checker("旧目录回收事务与清单不匹配");
  need(isRecord(value), "事务");
  need(value.version === 1, "version");
  need(value.path === path, "path");
  need(value.parent === parent, "parent");
  need(sameJson(value.proof, proof), "proof");
  need(oneOf(["fencing", "deleting", "removed", "restored"], value.phase), "phase");
  const directories = value.directories;
  need(Array.isArray(directories) && directories.length > 0 && directories.length <= MAX_ITEMS + 1, "directories");
  directories.forEach((entry: unknown, index: number) => {
    const at = `directories[${index}]`;
    need(isRecord(entry) && typeof entry.relative === "string", at);
    need(index === 0 ? entry.relative === ".."
      : entry.relative === "" || entry.relative.split("/").every(part => part && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0")),
      `${at}.relative`);
    need(isDigits(entry.dev) && isDigits(entry.ino), `${at}.dev/ino`);
    need(isCount(entry.uid) && (index === 0 || entry.uid === proof.uid), `${at}.uid`);
    need(isCount(entry.gid), `${at}.gid`);
    need(Number.isInteger(entry.mode) && (entry.mode as number) >= 0 && (entry.mode as number) <= 0o7777, `${at}.mode`);
  });
  need(new Set(directories.map(entry => entry.relative)).size === directories.length, "directories（路径重复）");
  return value as unknown as LegacyJournal;
}

/** Either platform journal recorded a deletion intent for this exact path and evidence. Only such a journal lets a
 * started item resume without its original entity; its full contents are checked again by the platform backend. */
export function journalRecordsDeletion(value: unknown, path: string, proof: TreeEvidence): boolean {
  return isRecord(value) && value.version === 1 && value.path === path && sameJson(value.proof, proof)
    && oneOf(["deleting", "removed", "restored"], value.phase);
}

// ---- Host summaries (TUI): any plan kind and its progress, without the service's root and identity checks ----

const INVALID_PLAN = "清单摘要或条目无效", PROGRESS_MISMATCH = "结果与清单不符", INVALID_RESULT = "清单结果无效";

export interface PlanSummary { id: string; digest: string; ready: number; bytes: number; kept: number; deferred: number }
/** Totals of one whole list (all its runs so far), not of the last run. `done`/`bytes` exclude finishing outcomes. */
export interface ProgressSummary { done: number; bytes: number; finishing: number; kept: number; deferred: number; failed: number; missing: number }

/** All three plan kinds: an ID, a digest over everything else, and items with a status and byte evidence. */
export function decodePlanSummary(value: unknown, id: string): PlanSummary {
  const need: Check = checker(INVALID_PLAN);
  need(isRecord(value), "清单");
  need(value.version === 1 && value.id === id, "version/id");
  need(typeof value.digest === "string" && DIGEST_PATTERN.test(value.digest) && digested(value, value.digest), "digest");
  const items = value.items;
  need(Array.isArray(items), "items");
  items.forEach((item: unknown, index: number) => {
    need(isRecord(item) && oneOf(PLAN_STATUSES, item.status), `items[${index}].status`);
    need(item.evidence === undefined || isRecord(item.evidence) && isCount(item.evidence.bytes), `items[${index}].evidence`);
  });
  const typed = items as { status: PlanStatus; evidence?: { bytes: number } }[];
  const ready = typed.filter(item => item.status === "ready");
  return { id, digest: value.digest, ready: ready.length, bytes: ready.reduce((sum, item) => sum + (item.evidence?.bytes ?? 0), 0),
    kept: typed.filter(item => item.status === "kept").length, deferred: typed.filter(item => item.status === "deferred").length };
}

/** Archive/removal progress names the plan by `digest`, reclamation progress by `plan`. */
export function decodeProgressSummary(value: unknown, digest: string, done: "archived" | "removed"): ProgressSummary {
  if (!isRecord(value) || value.version !== 1 || (value.digest ?? value.plan) !== digest || !isRecord(value.outcomes)) {
    throw new ContractError(PROGRESS_MISMATCH);
  }
  const outcomes = Object.values(value.outcomes);
  if (!outcomes.every(item => isRecord(item) && oneOf([done, "kept", "deferred", "failed", "missing"], item.status) && isCount(item.bytes))) {
    throw new ContractError(INVALID_RESULT);
  }
  if (!outcomes.every(item => validFinishing(item as Record<string, unknown>, done))) throw new ContractError(INVALID_RESULT);
  const typed = outcomes as { status: string; bytes: number; finishing?: true }[];
  const count = (status: string) => typed.filter(item => item.status === status).length;
  const finished = typed.filter(item => item.status === done && !item.finishing);
  return { done: finished.length, bytes: finished.reduce((sum, item) => sum + item.bytes, 0), finishing: typed.filter(item => item.finishing).length,
    kept: count("kept"), deferred: count("deferred"), failed: count("failed"), missing: count("missing") };
}
