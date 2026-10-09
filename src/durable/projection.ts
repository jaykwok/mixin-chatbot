// Usage facts of the Durable engine into the stats ledger (D3; src/agent/stats-ledger.ts).
//
// The ledger stays the only source of the statistics, so the admin tools (stat, TUI) read the same tables for both
// engines. One member conversation is one ledger source; its cursor is the newest entry already counted. Entries are
// read oldest first after the cursor and folded into daily rows by their message time (the attempt start: entries
// carry no commit time), so a run across midnight counts on the day each message started, and re-running a
// projection never counts an entry twice. The request door's NOT_SENT entries are not replies and are skipped.
//
// Start records cover requests killed before an entry exists. Complete terminal usage survives a crash before
// classification; partial estimates do not become confirmed bills. Aborted entries do not count as replies.
//
// A conversation the data migration imported (scripts/migrations/v3.ts) starts counting after its import record: the
// imported entries were counted from the session file, which the old ledger source keeps covering.
import type { Database } from "bun:sqlite";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type ConversationId, defineDoc, type EntryRecord, type Harness, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { groupSegment, userSegment } from "../agent/paths.ts";
import type { StatsRecord } from "../agent/session-reader.ts";
import { type ConversationSource, DURABLE_PROJECTION, ingestConversationRecords } from "../agent/stats-ledger.ts";
import { type AttemptStart, AttemptsDoc, isNotSent } from "./attempts.ts";
import { AuxiliaryDoc } from "./auxiliary-records.ts";

const PAGE = 200;

/** What the v3 import wrote into a conversation (scripts/migrations/lib/durable.ts keeps a frozen copy). */
export type LegacyImport = {
  version: 1; source: string; sha256: string; bytes: number; entries: number;
  /** The newest imported entry (0 when none): usage at or before it was counted by the old ledger. */
  through: number;
  interrupted: boolean; importedAt: number;
};
export const LegacyImportDoc = defineDoc<LegacyImport>({
  kind: "mixin.legacy-import", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ version: 1, source: "", sha256: "", bytes: 0, entries: 0, through: 0, interrupted: false, importedAt: 0 }),
});

export function conversationSource(groupId: string, phone: string, conversationId: number): ConversationSource {
  const group = groupSegment(groupId);
  const user = userSegment(phone);
  return { id: `durable:${group}:${user}:${conversationId}`, group, user, identity: `durable:${conversationId}` };
}

const at = (timestamp: unknown) => new Date(typeof timestamp === "number" ? timestamp : Number.NaN).toISOString();

function records(entry: EntryRecord, start?: AttemptStart): StatsRecord[] {
  const message = entry.model?.[0] as (Record<string, unknown> & { timestamp?: number }) | undefined;
  if (message === undefined || !Number.isFinite(message.timestamp)) return [];
  if (UserEntry.is(entry)) return [{ type: "message", timestamp: at(message.timestamp), message: message as StatsRecord["message"] }];
  if (ToolResultEntry.is(entry)) {
    const details = message.details as { calls?: { name?: unknown }[]; complete?: unknown } | undefined;
    const nested = message.toolName === "codemode" && Array.isArray(details?.calls)
      ? { names: details.calls.map(call => typeof call?.name === "string" ? call.name : "unknown"), complete: details.complete === true }
      : undefined;
    // Charge the parent result's combined usage once; the child list contributes counts, never another bill.
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
async function entriesAfter(harness: Harness, conversationId: number, after: number, context: Context): Promise<EntryRecord[]> {
  const conversation = await harness.conversation(conversationId as ConversationId, context);
  if (conversation === undefined) return [];
  const entries: EntryRecord[] = [];
  let cursor: Parameters<typeof conversation.entries>[2];
  for (;;) {
    const page = await conversation.entries({ minEntryId: (after + 1) as never, order: "ascending" }, PAGE, cursor, context);
    entries.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return entries.filter((entry) => (entry.id as number) > after);
}

type Link = { through: number; entryId?: number; interrupted?: boolean };
type Checkpoint = { version: 1; links: Record<string, Link>; orphans: Record<string, StatsRecord> };
const checkpoint = (digest: string): Checkpoint => digest ? JSON.parse(digest) as Checkpoint : { version: 1, links: {}, orphans: {} };
const usageRecord = (start: AttemptStart, kind: string): StatsRecord => ({ type: "usage", kind, timestamp: at(start.startedAt),
  provider: start.provider, model: start.model, ...(start.usage === undefined ? {} : { usage: start.usage as unknown as Record<string, unknown> }) });

/** The entry cursor and start-to-entry links are committed together in the existing ledger source. */
export async function projectConversation(db: Database, harness: Harness, member: { groupId: string; phone: string; conversationId: number },
  context: Context): Promise<number> {
  const source = conversationSource(member.groupId, member.phone, member.conversationId);
  const floor = (await harness.snapshot(LegacyImportDoc, member.conversationId as ConversationId, context))?.through ?? 0;
  for (let attempt = 1; ; attempt++) {
    const row = db.query("SELECT offset, digest, projection FROM sources WHERE id = ?").get(source.id) as
      { offset: number; digest: string; projection: number } | null;
    const current = row?.projection === DURABLE_PROJECTION;
    const prior = current ? row.offset : floor, digest = current ? row.digest : "", links = checkpoint(digest);
    const doc = await harness.snapshot(AttemptsDoc, member.conversationId as ConversationId, context);
    const starts = Object.entries(doc?.starts ?? {}).filter(([, start]) => start.withdrawn !== true && start.afterEntry >= floor);
    const generations = starts.filter(([, start]) => start.kind !== "compaction")
      .sort(([, a], [, b]) => a.afterEntry - b.afterEntry || a.taskId - b.taskId || a.attempt - b.attempt || a.k - b.k);
    // An old unmatched start is checked only through new entries, not by rescanning all history every heartbeat.
    const after = generations.reduce((after, [key, start]) => links.links[key]?.entryId !== undefined
      ? after : Math.min(after, links.links[key]?.through ?? start.afterEntry), prior);
    const entries = await entriesAfter(harness, member.conversationId, after, context);
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
      } else if (message.stopReason === "aborted" && message.content?.length && Number.isFinite(message.timestamp)) {
        // Old partials with no start record still show missing usage; empty unsent aborts do not add requests.
        links.orphans[String(entry.id)] = { type: "usage", kind: "interrupted", timestamp: at(message.timestamp),
          provider: message.provider, model: message.model };
      }
    }
    for (const [key] of generations) links.links[key] ??= { through: to };
    for (const [key] of generations) if (links.links[key]!.entryId === undefined) links.links[key]!.through = to;
    const added = entries.filter((entry) => (entry.id as number) > prior).flatMap((entry) => records(entry, byEntry.get(entry.id as number)));
    const whole = new Map<string, StatsRecord[]>(["compaction", "interrupted", "generation_unconfirmed", "generation_unsettled"].map((kind) => [kind, []]));
    for (const [key, start] of starts) {
      let kind: string;
      if (start.kind === "compaction") kind = "compaction";
      else if (links.links[key]?.interrupted || (links.links[key]?.entryId === undefined && start.outcome === "aborted")) kind = "interrupted";
      else if (links.links[key]?.entryId !== undefined) continue;
      else kind = start.usage === undefined ? "generation_unconfirmed" : "generation_unsettled";
      whole.get(kind)!.push(usageRecord(start, kind));
    }
    whole.get("interrupted")!.push(...Object.values(links.orphans));
    const auxiliary = await harness.snapshot(AuxiliaryDoc, member.conversationId as ConversationId, context);
    whole.set("auxiliary", Object.values(auxiliary?.starts ?? {}).filter(start => start.withdrawn !== true).map(start => ({
      type: "usage", kind: "auxiliary", timestamp: at(start.startedAt), provider: start.provider, model: start.model,
      ...(start.usage === undefined ? {} : { usage: start.usage as unknown as Record<string, unknown> }),
    })));
    if (ingestConversationRecords(db, { ...source, digest: JSON.stringify(links) }, prior, to, added,
      [...whole].map(([kind, records]) => ({ kind, records })), floor, digest)) return added.length;
    if (attempt >= 3) throw new Error("统计入账冲突：同一会话正被反复入账，稍后由下次入账补上");
  }
}
