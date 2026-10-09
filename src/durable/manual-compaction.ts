// Atomic enqueue via public tokens/Tx, matching Pi 1.0.4 createCompaction's small admission step.
// The official CompactionTask retains selection, retry, provider identity, placement and cancellation.
import { CompactionEntry, CompactionTask, type ConversationId, InboxDoc, LiveDoc, type Tx } from "@earendil-works/pi-durable";

export async function queueManualCompaction(tx: Tx, conversationId: ConversationId) {
  const live = await tx.doc(LiveDoc, conversationId);
  // A completed task can have an unplaced summary. Reuse that public write submission rather than generating again.
  const summary = (await tx.doc(InboxDoc, conversationId)).items.find(item => item.mode === "write" && item.entry.kind === CompactionEntry.kind);
  if (summary) return { submissionId: summary.id, created: false };
  const pending = live.compactions?.[0];
  if (pending) return { taskId: pending.taskId, created: false };
  const taskId = await tx.createTask(CompactionTask, { reason: "manual" }, {
    ownership: { kind: "conversation" }, conversationId, background: false,
  });
  live.compactions ??= [];
  live.compactions.push({ taskId, reason: "manual", blocking: false, attempt: 1 });
  return { taskId, created: true };
}
