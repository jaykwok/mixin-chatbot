// Stats of the Durable engine into the stats ledger (src/agent/stats-ledger.ts): a member's asks from its run records and
// its conversation's `pi.usage` totals. Both are idempotent, so every sync point (after a run or a command, maintenance,
// opening a space) may run them again.
import type { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord";
import { type ConversationId, type Harness, UsageDoc } from "@earendil-works/pi-durable";
import { statsSegment, userSegment, type Scope } from "../core/layout.ts";
import { recordAsks, syncUsage, type UsageState } from "../agent/stats-ledger.ts";
import { KeyedQueue } from "../core/lifecycle.ts";
import { SpaceDoc } from "./identity.ts";
import { memberRecords } from "./records.ts";

/** Count one admitted message; the sync counts it again from the run record when this fails. */
export function countAsk(db: Database, scope: Scope, phone: string, requestId: string, at: number): void {
  recordAsks(db, [{ requestId, space: statsSegment(scope), user: userSegment(phone), at }]);
}

const syncs = new KeyedQueue();

/**
 * Count the member's run records not counted yet and the growth of its conversation's usage. One sync per member at a
 * time: the usage snapshot is read inside the turn. Returns the usage keys whose totals went down.
 */
export function syncMemberStats(db: Database, harness: Harness, member: { scope: Scope; phone: string; conversationId?: number },
  context: Context): Promise<string[]> {
  const space = statsSegment(member.scope), user = userSegment(member.phone);
  return syncs.run(`${db.filename}\u0000${space}\u0000${user}`, async () => {
    const records = await memberRecords(harness, member.phone, context);
    recordAsks(db, Object.values(records.requests).map(record => ({ requestId: record.requestId, space, user, at: record.createdAt })));
    if (member.conversationId === undefined) return [];
    const generation = (await harness.snapshot(SpaceDoc, context))?.generation;
    if (!generation) throw new Error("会话库缺少统计代际，请使用当前格式会话库");
    const usage = await harness.snapshot(UsageDoc, member.conversationId as ConversationId, context);
    if (usage === undefined) return [];
    return syncUsage(db, { id: `${generation}:${member.conversationId}`, space, user }, usage as unknown as UsageState);
  }, context.abortSignal);
}
