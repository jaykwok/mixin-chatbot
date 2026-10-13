// Isolated-task receipt protocol: every phase change of a receipt is one of these named steps. Each step only edits the
// receipt in memory; the caller saves it before the side effect the step permits (see the R0 state table):
//
//   allocating ─(reserved → entity-registered → marker-written → work-created)→ active
//   allocating ─(any allocation error)→ allocation-failed
//   active | allocation-failed | stopping ─→ stopping ─→ writers-reaped ─→ reclaiming ─→ removed
//                                                      writers-reaped ─→ archiving ─→ archived
//
// Writer retirement never downgrades a saved deletion or archive intent: once `reclaiming` or `archiving` is durable,
// reconfirming retirement keeps that phase, so a replay still resumes the same physical action.
import type { TreeEvidence } from "../../contracts/maintenance.ts";
import { ALLOCATION_STEPS, type Receipt } from "../../contracts/task-receipt.ts";

type AllocationStep = typeof ALLOCATION_STEPS[number];
type Identity = { dev: bigint; ino: bigint };

function allowed(receipt: Receipt, ok: boolean, step: string): void {
  if (!ok) throw new Error(`任务回执阶段不允许${step}：${receipt.id} 处于 ${receipt.phase}`);
}

/** A new receipt owns nothing yet: no entity, work, container or name. Field order is the saved payload's order. */
export function reserved(fields: Omit<Receipt, "phase" | "allocation" | "containers" | "pendingNames" | "mounts" | "role" | "resultName">,
  role: "worker" | "results", resultName?: string): Receipt {
  return { ...fields, phase: "allocating", allocation: { step: "reserved" }, containers: [], pendingNames: [], mounts: {}, role, ...(resultName ? { resultName } : {}) };
}

/** The held task directory and its parent are the only entities later removal may act on. */
export function entityRegistered(receipt: Receipt, parent: Identity, entity: Identity): void {
  allocationStep(receipt, "entity-registered");
  receipt.parentIdentity = { dev: String(parent.dev), ino: String(parent.ino) };
  receipt.identity = { dev: String(entity.dev), ino: String(entity.ino) };
}

export function allocationStep(receipt: Receipt, step: Exclude<AllocationStep, "reserved">): void {
  allowed(receipt, receipt.phase === "allocating" && !!receipt.allocation
    && ALLOCATION_STEPS.indexOf(step) === ALLOCATION_STEPS.indexOf(receipt.allocation.step) + 1, `分配步骤 ${step}`);
  receipt.allocation!.step = step;
}

/** Workers may start only after every allocation write and close succeeded. */
export function activated(receipt: Receipt): void {
  allowed(receipt, receipt.phase === "allocating" && receipt.allocation?.step === "work-created", "启动");
  receipt.phase = "active";
}

/** Also from `active` whose save failed: no worker can have started before that save returned. */
export function allocationFailed(receipt: Receipt, cause: unknown): void {
  allowed(receipt, receipt.phase === "allocating" || receipt.phase === "active", "记录分配失败");
  receipt.phase = "allocation-failed";
  receipt.allocation!.error = String(cause).slice(-4096);
}

/** A saved deletion or archive intent survives writer reconfirmation. */
export function intentKept(receipt: Receipt): boolean {
  return receipt.phase === "reclaiming" || receipt.phase === "archiving";
}

/** Writers are being retired: no new start may be accepted from here on. */
export function stopping(receipt: Receipt): void {
  if (!intentKept(receipt)) receipt.phase = "stopping";
}

export function writersReaped(receipt: Receipt): void {
  if (!intentKept(receipt)) receipt.phase = "writers-reaped";
}

/** Deletion intent: saved before the task tree is touched. */
export function reclaiming(receipt: Receipt): void {
  allowed(receipt, receipt.phase === "writers-reaped" || receipt.phase === "reclaiming", "开始回收");
  receipt.phase = "reclaiming";
}

export function removed(receipt: Receipt): void {
  allowed(receipt, receipt.phase === "reclaiming", "确认回收");
  receipt.phase = "removed";
}

/** Archive intent with its destination and evidence: saved before the tree moves. */
export function archiving(receipt: Receipt, destination: string, evidence: TreeEvidence): void {
  allowed(receipt, receipt.phase === "writers-reaped" && receipt.archive === undefined, "开始归档");
  receipt.archive = { destination, evidence };
  receipt.phase = "archiving";
}

export function archived(receipt: Receipt): void {
  allowed(receipt, receipt.phase === "archiving" && receipt.archive !== undefined, "确认归档");
  receipt.phase = "archived";
}

/** A deferred or refused sweep attempt waits a minute before the next try. */
export function retryLater(receipt: Receipt, reason: string | undefined, now = Date.now()): void {
  receipt.reclamation = { attemptedAt: now, nextAttemptAt: now + 60_000, reason };
}
