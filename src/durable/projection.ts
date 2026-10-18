// Usage facts of the Durable engine into the stats ledger (src/agent/stats-ledger.ts).
//
// The ledger stays the only source of the statistics, so the admin tools (stat, TUI) read the same tables.
// One member conversation is one ledger source; its cursor is the newest entry already counted. Entries are
// read oldest first after the cursor and folded into daily rows by their message time (the attempt start: entries
// carry no commit time), so a run across midnight counts on the day each message started, and re-running a
// projection never counts an entry twice. The request door's NOT_SENT entries are not replies and are skipped.
//
// Start records cover requests killed before an entry exists. Complete terminal usage survives a crash before
// classification; partial estimates do not become confirmed bills. Aborted entries do not count as replies.
//
import type { Database } from "bun:sqlite";
import { copyJson, type Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, type EntryRecord, type Harness, type TaskId, ToolResultEntry, UserEntry, type Tx } from "@earendil-works/pi-durable";
import { groupSegment, userSegment } from "../agent/paths.ts";
import type { StatsRecord } from "../agent/stats-record.ts";
import { type ConversationSource, DURABLE_PROJECTION, finalizeConversationProjection, ingestConversationRecords } from "../agent/stats-ledger.ts";
import { type AttemptStart, AttemptsDoc, isNotSent } from "./attempts.ts";
import { AuxiliaryDoc } from "./auxiliary-records.ts";
import { recoverProjectionRetirement, retireProjectedRequests } from "./projection/retirement.ts";
import { pendingUsage, type ProjectionCheckpoint } from "./projection/usage.ts";
import { KeyedQueue } from "../core/lifecycle.ts";
import { GroupDoc } from "./identity.ts";
import { NestedUsageDoc } from "./codemode/usage.ts";

const PAGE = 200;

export function conversationSource(groupId: string, phone: string, conversationId: number, generation: string): ConversationSource {
  if (!generation) throw new Error("群数据库缺少统计代际");
  const group = groupSegment(groupId);
  const user = userSegment(phone);
  return { id: `durable:${generation}:${group}:${user}:${conversationId}`, group, user, identity: `durable:${generation}:${conversationId}` };
}

const at = (timestamp: unknown) => new Date(typeof timestamp === "number" ? timestamp : Number.NaN).toISOString();

function records(entry: EntryRecord, start?: AttemptStart): StatsRecord[] {
  const message = entry.model?.[0] as (Record<string, unknown> & { timestamp?: number }) | undefined;
  if (message === undefined || !Number.isFinite(message.timestamp)) return [];
  if (UserEntry.is(entry)) return [{ type: "message", timestamp: at(message.timestamp), message: message as StatsRecord["message"] }];
  if (ToolResultEntry.is(entry)) {
    const details = message.details as { calls?: { name?: unknown }[]; complete?: unknown; partial?: unknown; usage?: unknown } | undefined;
    const codemode = message.toolName === "codemode" && Array.isArray(details?.calls) ? details : undefined;
    const nested = codemode === undefined ? undefined : {
      names: codemode.calls!.map(call => typeof call?.name === "string" ? call.name : "unknown"),
      complete: codemode.partial !== true,
    };
    // Official codemode details are display snapshots. Its ordinary children have independent atomic receipts;
    // AuxiliaryDoc already owns auxiliary charges. Legacy result usage remains on the message.
    return [{ type: "message", timestamp: at(message.timestamp),
      message: { ...message, ...(nested === undefined ? {} : { nested }) } as StatsRecord["message"] }];
  }
  if (AssistantEntry.is(entry)) {
    if (isNotSent(message as { stopReason?: string; errorMessage?: string })) return [];
    if (message.stopReason === "aborted") return [];
    return [{ type: "message", timestamp: at(start?.startedAt ?? message.timestamp),
      message: { ...message, ...(start?.outcome === "error" ? { usage: undefined } : start?.usage ? { usage: start.usage } : {}) } as StatsRecord["message"] }];
  }
  return [];
}

/** The conversation's entries after `after`, oldest first. */
async function entriesAfter(tx: Tx, conversationId: number, after: number): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Parameters<typeof tx.scanEntries>[2];
  for (;;) {
    const page = await tx.scanEntries({ conversationId: conversationId as ConversationId, minEntryId: (after + 1) as never, order: "ascending" }, PAGE, cursor);
    entries.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return entries.filter((entry) => (entry.id as number) > after);
}

const checkpoint = (digest: string): ProjectionCheckpoint => digest ? JSON.parse(digest) as ProjectionCheckpoint : { version: 1, links: {}, orphans: {} };
const projections = new KeyedQueue();

/** The entry cursor and start-to-entry links are committed together in the existing ledger source. */
export async function projectConversation(db: Database, harness: Harness, member: { groupId: string; phone: string; conversationId: number },
  context: Context): Promise<number> {
  const generation = (await harness.snapshot(GroupDoc, context))?.generation;
  if (!generation) throw new Error("群数据库缺少统计代际，请使用当前格式新群库");
  const source = conversationSource(member.groupId, member.phone, member.conversationId, generation);
  return projections.run(db.filename + ":" + source.id, () => project(db, harness, member.conversationId as ConversationId, source, context), context.abortSignal);
}

async function project(db: Database, harness: Harness, conversation: ConversationId, source: ConversationSource, context: Context): Promise<number> {
  await recoverProjectionRetirement(db, harness, source, conversation, context);
  const floor = 0;
  for (let attempt = 1; ; attempt++) {
    const row = db.query("SELECT offset, digest, projection FROM sources WHERE id = ?").get(source.id) as
      { offset: number; digest: string; projection: number } | null;
    if (row && row.projection !== DURABLE_PROJECTION) throw new Error("当前会话的统计投影格式不匹配；保留历史账本并检查数据库代际");
    const current = row !== null;
    const prior = current ? row.offset : floor, digest = current ? row.digest : "", links = checkpoint(digest);
    const { attempts, auxiliary, terminal, generations, entries, nested } = await harness.commit(async tx => {
      // One group transaction prevents a new entry from racing its request's start snapshot.
      const attempts = JSON.parse(JSON.stringify((await tx.doc(AttemptsDoc, conversation)).starts)) as Record<string, AttemptStart>;
      const auxiliary = JSON.parse(JSON.stringify((await tx.doc(AuxiliaryDoc, conversation)).starts)) as Record<string, import("./auxiliary-records.ts").AuxiliaryRequest>;
      const nestedDoc = await tx.doc(NestedUsageDoc, conversation);
      const nested = copyJson(nestedDoc) as typeof nestedDoc;
      // Only tasks already terminal in this snapshot can retire. A later terminal transition may commit
      // an assistant entry after this cursor; settling its start early would charge that request twice.
      const terminal = new Set<number>();
      for (const id of new Set([...Object.values(attempts), ...Object.values(auxiliary)].map(start => start.taskId))) {
        const task = await tx.task(id as TaskId);
        if (task?.conversationId === conversation && task.state.status === "terminal") terminal.add(id);
      }
      const generations = Object.entries(attempts).filter(([, start]) => !start.withdrawn && start.afterEntry >= floor && start.kind !== "compaction")
        .sort(([, a], [, b]) => a.afterEntry - b.afterEntry || a.taskId - b.taskId || a.attempt - b.attempt || a.k - b.k);
      // An unmatched start only checks entries after its last projected cursor.
      const after = generations.reduce((after, [key, start]) => links.links[key]?.entryId !== undefined
        ? after : Math.min(after, links.links[key]?.through ?? start.afterEntry), prior);
      return { attempts, auxiliary, terminal, generations, nested, entries: await entriesAfter(tx, conversation, after) };
    }, context);
    const to = Math.max(prior, (entries.at(-1)?.id as number | undefined) ?? prior);
    const byEntry = new Map<number, AttemptStart>();
    for (const [key, start] of generations) {
      const linked = links.links[key]?.entryId;
      if (linked !== undefined) byEntry.set(linked, start);
    }
    let generationIndex = -1;
    for (const entry of entries) {
      if (!AssistantEntry.is(entry) || byEntry.has(entry.id as number)) continue;
      const message = entry.model?.[0] as { stopReason?: string; errorMessage?: string; content?: unknown[]; timestamp?: number; provider?: string; model?: string } | undefined;
      if (!message || isNotSent(message)) continue;
      // Both lists are ordered. Only the last start before this entry can own its interval: an earlier start's
      // interval ends at the following start. Advance once across the batch instead of rescanning all starts.
      while (generationIndex + 1 < generations.length && generations[generationIndex + 1]![1].afterEntry < (entry.id as number)) generationIndex++;
      const candidate = generations[generationIndex];
      if (candidate && links.links[candidate[0]]?.entryId === undefined
        && (entry.byTaskId === undefined || (entry.byTaskId as number) === candidate[1].taskId)) {
        const [key, start] = candidate;
        links.links[key] = { through: to, entryId: entry.id as number, ...(message.stopReason === "aborted" ? { interrupted: true } : {}) };
        delete links.orphans[String(entry.id)];
        byEntry.set(entry.id as number, start);
      } else if ((entry.id as number) > prior && message.stopReason === "aborted" && message.content?.length && Number.isFinite(message.timestamp)) {
        // Old partials with no start record still show missing usage; empty unsent aborts do not add requests.
        links.orphans[String(entry.id)] = { type: "usage", kind: "interrupted", timestamp: at(message.timestamp),
          provider: message.provider, model: message.model };
      }
    }
    for (const [key] of generations) links.links[key] ??= { through: to };
    for (const [key] of generations) if (links.links[key]!.entryId === undefined) links.links[key]!.through = to;
    const added = entries.filter((entry) => (entry.id as number) > prior).flatMap((entry) => records(entry, byEntry.get(entry.id as number)));
    const nestedCharges: StatsRecord[] = Object.values(nested.receipts).filter(receipt => receipt.sequence > (links.nestedThrough ?? 0))
      .map(receipt => ({ type: "usage", kind: "tool", timestamp: at(receipt.startedAt), usage: receipt.usage }));
    if (nested.sequence > 0) links.nestedThrough = nested.sequence;
    const ingested = db.transaction(() => {
      if (!ingestConversationRecords(db, { ...source, digest: JSON.stringify(links) }, prior, to, [...added, ...nestedCharges],
        pendingUsage(attempts, auxiliary, links, floor), floor, digest)) return false;
      // Once receipts may be pruned, a future projector upgrade must preserve these already settled aggregates.
      if (nestedCharges.length) finalizeConversationProjection(db, source.id);
      return true;
    }).immediate();
    if (ingested) {
      // Ledger first. A crash before pruning re-reads receipts but the committed sequence suppresses every old bill.
      // Active parents retain stable keys for replay; after terminal settlement no child can settle again.
      await harness.commit(async tx => {
        const doc = await tx.doc(NestedUsageDoc, conversation);
        for (const [key, receipt] of Object.entries(doc.receipts)) {
          if (receipt.sequence > nested.sequence) continue;
          if ((await tx.task(receipt.parentTaskId as TaskId))?.state.status === "terminal") delete doc.receipts[key];
        }
      }, context);
      await retireProjectedRequests(db, harness, source, conversation, { attempts, auxiliary, terminal, checkpoint: links }, to, floor, context);
      return added.length;
    }
    if (attempt >= 3) throw new Error("统计入账冲突：同一会话正被反复入账，稍后由下次入账补上");
  }
}
