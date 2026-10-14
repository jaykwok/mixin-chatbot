// Ordinary nested tool usage is a durable fact independent of the parent result's display snapshot.
// The patched ToolTask settlement hook writes it in the same transaction as NestedCallDoc and pi.usage.
import { copyJson } from "@earendil-works/chord";
import { defineDoc, type NestedToolExecutionResult, type ToolHookCall, type Tx } from "@earendil-works/pi-durable";
import type { UsageRecord } from "../attempts.ts";

export type NestedUsageReceipt = { sequence: number; taskId: number; parentTaskId: number; key: string; startedAt: number; usage: UsageRecord };
export const NestedUsageDoc = defineDoc<{ sequence: number; receipts: Record<string, NestedUsageReceipt> }>({
  kind: "mixin.nested-tool-usage", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ sequence: 0, receipts: {} }),
});

/** A stable parent task / nested key identifies one confirmed charge, regardless of VM attempts. */
export async function recordNestedUsage(call: ToolHookCall, key: string, result: NestedToolExecutionResult, tx: Tx): Promise<void> {
  if (result.usage === undefined || call.parent === undefined) return;
  const task = await tx.task(result.taskId);
  if (task === undefined || task.startedAt === undefined) throw new Error("Nested usage has no task start");
  const doc = await tx.doc(NestedUsageDoc, task.conversationId);
  const id = JSON.stringify([call.parent.taskId, key]);
  const usage = copyJson(result.usage, { omitUndefinedProperties: true }) as UsageRecord;
  const prior = doc.receipts[id];
  if (prior !== undefined) {
    if (prior.taskId !== result.taskId || JSON.stringify(prior.usage) !== JSON.stringify(usage)) throw new Error("Nested usage receipt changed");
    return;
  }
  doc.receipts[id] = { sequence: ++doc.sequence, taskId: result.taskId as number, parentTaskId: call.parent.taskId as number,
    key, startedAt: task.startedAt, usage };
}
