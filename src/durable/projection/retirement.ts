// Retiring projected request starts from the group database once the stats ledger has counted them.
//
// Two databases, no shared transaction: the ledger commits first and its checkpoint (`retiring`) carries the batch until
// the group side is confirmed. The states and their replay:
//
// | ledger checkpoint | group starts | how it arose                                         | next projection                         |
// | ----------------- | ------------ | ---------------------------------------------------- | --------------------------------------- |
// | no `retiring`     | present      | nothing staged, or the checkpoint changed meanwhile  | selects a batch again                   |
// | `retiring`        | present      | the group commit failed or the process died before it | recovery: verify fingerprints, prune, confirm |
// | `retiring`        | gone         | the process died after the group commit              | recovery: prune is a no-op, confirm     |
// | no `retiring`     | gone         | confirmed                                            | —                                       |
//
// Usage is charged once. The ledger step moves the batch's usage out of the replaceable pending rows and into the frozen
// `settled:<source>` source in the same ledger transaction that stages `retiring`; recovery only prunes and confirms.
// A start changed since it was counted stops recovery: the ledger is kept for inspection.
//
// Ledger markers and the final totals: a conversation's totals are its entry source (replies, tools, and the pending
// usage of starts still present) plus its `settled:` source (usage of retired starts, with their original start times).
// The first staged batch also writes `durable_retired:<source>`: from then on the entry source cannot be rebuilt from
// the group database, so a projector version change keeps its aggregate and cursor instead of resetting them
// (`ingestConversationRecords`). Both sources stay in the existing ledger; there is no third record.
import type { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { StatsRecord } from "../../agent/session-reader.ts";
import { finalizeConversationProjection, ingestConversationRecords, settleConversationUsage, type ConversationSource } from "../../agent/stats-ledger.ts";
import { AttemptsDoc, type AttemptStart } from "../attempts.ts";
import { AuxiliaryDoc, type AuxiliaryRequest } from "../auxiliary-records.ts";
import { attemptUsage, fingerprint, pendingUsage, usageRecord, type ProjectionCheckpoint, type Retirement } from "./usage.ts";

/** Starts per batch, attempts first, then auxiliary requests, then orphans. */
const BATCH = 256;

type Starts = { attempts: Record<string, AttemptStart>; auxiliary: Record<string, AuxiliaryRequest> };
/** The projection's group snapshot: starts, tasks terminal in that snapshot, and the checkpoint it counted. */
export type ProjectionSnapshot = Starts & { terminal: Set<number>; checkpoint: ProjectionCheckpoint };

// Pure decisions.

/** The batch this snapshot may retire, given the starts now in the group transaction. A start qualifies only if its
 * task was terminal in the snapshot and it is unchanged since; orphans only if no start was added or changed (a new
 * start may still claim one). `frozen` is the batch's usage as the ledger will settle it. */
export function selectRetirement(snapshot: ProjectionSnapshot, current: Readonly<Starts>, floor: number): { retired: Retirement; frozen: StatsRecord[] } | undefined {
  const retired: Retirement = { attempts: {}, auxiliary: {}, orphans: [] }, frozen: StatsRecord[] = [];
  let count = 0;
  for (const [key, start] of Object.entries(snapshot.attempts)) {
    if (count >= BATCH) break;
    if (!snapshot.terminal.has(start.taskId) || !current.attempts[key] || fingerprint(current.attempts[key]) !== fingerprint(start)) continue;
    retired.attempts[key] = fingerprint(start); count++;
    const item = attemptUsage(key, start, snapshot.checkpoint, floor); if (item) frozen.push(item);
  }
  for (const [key, start] of Object.entries(snapshot.auxiliary)) {
    if (count >= BATCH) break;
    if (!snapshot.terminal.has(start.taskId) || !current.auxiliary[key] || fingerprint(current.auxiliary[key]) !== fingerprint(start)) continue;
    retired.auxiliary[key] = fingerprint(start); count++;
    if (!start.withdrawn) frozen.push(usageRecord(start, "auxiliary"));
  }
  if (fingerprint(current.attempts) === fingerprint(snapshot.attempts)) {
    for (const [key, item] of Object.entries(snapshot.checkpoint.orphans)) {
      if (count >= BATCH) break;
      retired.orphans.push(key); frozen.push(item); count++;
    }
  }
  return count ? { retired, frozen } : undefined;
}

/** What stays pending after the batch: the snapshot without the retired starts and orphans. */
function remainingAfter(snapshot: ProjectionSnapshot, retired: Retirement): ProjectionSnapshot {
  const remaining = structuredClone(snapshot);
  for (const key of Object.keys(retired.attempts)) delete remaining.attempts[key];
  for (const key of Object.keys(retired.auxiliary)) delete remaining.auxiliary[key];
  for (const key of retired.orphans) delete remaining.checkpoint.orphans[key];
  return remaining;
}

// Ledger steps (stats ledger SQLite).

/** Step 1, one ledger transaction: stage `retiring`, recompute the pending rows without the batch, settle its usage and
 * mark the source retired. Refused (undefined) when the checkpoint is no longer the one the snapshot counted. */
function stageInLedger(db: Database, source: ConversationSource, snapshot: ProjectionSnapshot, retired: Retirement, frozen: StatsRecord[],
  cursor: number, floor: number): { checkpoint: ProjectionCheckpoint; digest: string } | undefined {
  const checkpoint = structuredClone(snapshot.checkpoint); checkpoint.retiring = retired;
  const remaining = remainingAfter(snapshot, retired);
  const digest = JSON.stringify(checkpoint);
  const saved = db.transaction(() => {
    if (!ingestConversationRecords(db, { ...source, digest }, cursor, cursor, [],
      pendingUsage(remaining.attempts, remaining.auxiliary, remaining.checkpoint, floor), floor, JSON.stringify(snapshot.checkpoint))) return false;
    settleConversationUsage(db, source, frozen);
    finalizeConversationProjection(db, source.id);
    return true;
  }).immediate();
  return saved ? { checkpoint, digest } : undefined;
}

/** Step 3: drop the batch's links and orphans and clear `retiring`, only if the staged checkpoint is still current. */
function confirmInLedger(db: Database, source: ConversationSource, digest: string, checkpoint: ProjectionCheckpoint): void {
  const retired = checkpoint.retiring!;
  for (const key of Object.keys(retired.attempts)) delete checkpoint.links[key];
  for (const key of retired.orphans) delete checkpoint.orphans[key];
  delete checkpoint.retiring;
  db.query("UPDATE sources SET digest = ? WHERE id = ? AND digest = ?").run(JSON.stringify(checkpoint), source.id, digest);
}

/** A staged batch left by an earlier pass. */
function stagedInLedger(db: Database, source: ConversationSource): { checkpoint: ProjectionCheckpoint; digest: string } | undefined {
  const row = db.query("SELECT digest FROM sources WHERE id = ?").get(source.id) as { digest: string } | null;
  if (!row?.digest) return;
  const checkpoint = JSON.parse(row.digest) as ProjectionCheckpoint;
  return checkpoint.retiring ? { checkpoint, digest: row.digest } : undefined;
}

// Group step (inside a group transaction).

/** Step 2: delete the batch's starts. Recovery first checks that every start still present is the one counted. */
function pruneStarts(starts: Starts, retired: Retirement, verify: boolean): void {
  if (verify) for (const [present, proofs] of [[starts.attempts, retired.attempts], [starts.auxiliary, retired.auxiliary]] as const) {
    for (const [key, proof] of Object.entries(proofs)) {
      const start = present[key];
      if (start && fingerprint(start) !== proof) throw new Error("已入账请求在裁剪恢复前发生变化，请保留账本并检查");
    }
  }
  for (const key of Object.keys(retired.attempts)) delete starts.attempts[key];
  for (const key of Object.keys(retired.auxiliary)) delete starts.auxiliary[key];
}

// Coordinator.

/** Finish a batch staged by an earlier pass (rows 2 and 3 of the table) before projecting again. */
export async function recoverProjectionRetirement(db: Database, harness: Harness, source: ConversationSource, conversation: ConversationId, context: Context): Promise<void> {
  const staged = stagedInLedger(db, source);
  if (!staged) return;
  await harness.commit(async tx => {
    pruneStarts({ attempts: (await tx.doc(AttemptsDoc, conversation)).starts, auxiliary: (await tx.doc(AuxiliaryDoc, conversation)).starts }, staged.checkpoint.retiring!, true);
  }, context);
  confirmInLedger(db, source, staged.digest, staged.checkpoint);
}

/** Retire at most 256 terminal starts per pass; active/recoverable tasks retain all their starts. The ledger step runs
 * inside the group transaction, so the group side commits only after the ledger has staged the batch. */
export async function retireProjectedRequests(db: Database, harness: Harness, source: ConversationSource, conversation: ConversationId,
  snapshot: ProjectionSnapshot, cursor: number, floor: number, context: Context): Promise<void> {
  const staged = await harness.commit(async tx => {
    const starts = { attempts: (await tx.doc(AttemptsDoc, conversation)).starts, auxiliary: (await tx.doc(AuxiliaryDoc, conversation)).starts };
    const batch = selectRetirement(snapshot, starts, floor);
    if (!batch) return;
    const staged = stageInLedger(db, source, snapshot, batch.retired, batch.frozen, cursor, floor);
    if (!staged) return;
    pruneStarts(starts, batch.retired, false);
    return staged;
  }, context);
  if (staged) confirmInLedger(db, source, staged.digest, staged.checkpoint);
}
