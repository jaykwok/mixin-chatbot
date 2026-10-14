// Active result ownership: one record per result directory, written by the same commit that makes the directory the
// member's. The table is bounded; maintenance (maintenance.ts) frees it by handing records to the reclamation queue
// (queue.ts) — moving a record out of the active table never means its bytes are gone.
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import type { ResultOwnership } from "../../contracts/maintenance.ts";

/** Session scope: /clear and context compaction must not erase ownership or pending-delivery references. */
export const ResultsDoc = defineDoc<{ calls: Record<string, ResultOwnership> }>({
  kind: "mixin.results", version: 1, scope: "session", initial: () => ({ calls: {} }),
});

/** Active records per group database. A full table refuses new results until maintenance hands old ones over. */
export const RESULT_CAPACITY = 4096;
/** From this many active records maintenance expires unreferenced results before their retention deadline. */
export const RESULT_PRESSURE = 3072;

/**
 * Record a result's owner, with its isolated task when it has one. A repeated registration of the same directory leaves
 * the record as it is.
 *
 * A rerun of the call after a restart (a replay-safe tool such as codemode) writes into a new isolated task when the
 * earlier attempt's outcome was not stored: each attempt reserves its own. Then the record moves to the new task in
 * this commit, before any file in it is visible, so the record names the directory the result will name. A requested
 * expiry (/clear) stays. The task it named before keeps its manager receipt, the task's ownership evidence; no record
 * claims it any more, which is what the receipt sweep (maintenance.ts step 7) and the offline reclamation take as the
 * owner's hand-over: it is reclaimed once due and unreferenced. A shared directory has no evidence besides its record,
 * so a record of one is never moved.
 */
export async function registerResult(tx: Tx, name: string, phone: string, isolatedTask?: string): Promise<void> {
  const doc = await tx.doc(ResultsDoc);
  const existing = doc.calls[name];
  if (existing) {
    if (existing.isolatedTask === isolatedTask) return;
    if (existing.phone !== phone) throw new Error("结果归属记录属于另一成员，拒绝改登记");
    if (existing.isolatedTask === undefined) throw new Error("结果目录已登记为共享目录，拒绝改登记到其他目录");
    doc.calls[name] = {
      phone, createdAt: Date.now(), ...(isolatedTask ? { isolatedTask } : {}),
      ...(existing.expiredAt === undefined && existing.expiryRequestedAt !== undefined ? { expiryRequestedAt: existing.expiryRequestedAt } : {}),
    };
    return;
  }
  if (Object.keys(doc.calls).length >= RESULT_CAPACITY) throw new Error("结果归属记录已达上限，请先清理不再引用的结果");
  doc.calls[name] = { phone, createdAt: Date.now(), ...(isolatedTask ? { isolatedTask } : {}) };
}

/** The registration a tool front door gives its `SubCallFiles`: called before the first file becomes visible. */
export function resultRegistration(api: { commit(change: (tx: Tx) => Promise<void>, context: Context): Promise<void> }, context: Context,
  phone: string, name: string): (isolatedTask?: string) => Promise<void> {
  return isolatedTask => api.commit(tx => registerResult(tx, name, phone, isolatedTask), context);
}

/** /clear: every live result of the member is due at the next idle maintenance pass (which checks references first). */
export async function requestMemberExpiry(tx: Tx, phone: string): Promise<void> {
  for (const call of Object.values((await tx.doc(ResultsDoc)).calls)) {
    if (call.phone === phone && call.expiredAt === undefined) call.expiryRequestedAt ??= Date.now();
  }
}
