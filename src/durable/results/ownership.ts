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

/** Record a result's owner, with its isolated task when it has one. An existing record (a repeated registration) stays. */
export async function registerResult(tx: Tx, name: string, phone: string, isolatedTask?: string): Promise<void> {
  const doc = await tx.doc(ResultsDoc);
  if (doc.calls[name]) return;
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
