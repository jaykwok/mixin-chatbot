// Compaction policy and cost (D2-5; plan "D2 工具与模型", D2-5).
//
// Thresholds. The blocking threshold is the one AgentSession compacts at today: `contextWindow - reserveTokens`, with
// Pi's reserve and keep-recent budgets for the selected model (settings.ts). Background compaction starts earlier, so
// a long conversation is usually summarised before a request has to wait for it: `backgroundTokens` below the blocking
// threshold, an eighth of the window and at most 32768 tokens (Durable's default). It stays off when the background
// threshold would leave less than two keep-recent budgets: the summary would then cover less than it keeps, and the
// blocking compaction comes soon anyway. Examples with Pi's defaults (reserve 16384, keep 20000): a 128k window starts
// background compaction at 95616 tokens and blocks at 111616; a 64k window has blocking compaction only.
//
// Cost. Durable adds a summarize response's usage to `pi.usage` under the model's key, together with the conversation's
// generations, and keeps no per-compaction record. The request door (door.ts) therefore marks a summarize request's
// start record `kind: "compaction"` and, before handing the response back, records its usage there (best effort): a
// compaction start without usage was not answered, withdrawn, or lost its usage write, and counts as unknown, not zero.
import type { Context } from "@earendil-works/chord";
import type { CompactionPolicy, Harness } from "@earendil-works/pi-durable";
import { AttemptsDoc, type UsageRecord } from "./attempts.ts";

/** Upper bound of the background margin (Durable's default `backgroundTokens`). */
export const BACKGROUND_MAX = 32768;

/** Durable's compaction policy for a model window from Pi's settings for that model. */
export function compactionPolicy(compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
  contextWindow: number): CompactionPolicy {
  const blocking = contextWindow - compaction.reserveTokens;
  const margin = Math.min(BACKGROUND_MAX, Math.floor(contextWindow / 8));
  const backgroundTokens = contextWindow > 0 && blocking - margin >= 2 * compaction.keepRecentTokens ? margin : 0;
  return { enabled: compaction.enabled, reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens, backgroundTokens };
}

export interface CompactionCost {
  /** Summarize requests handed to a provider (starts not withdrawn). */
  sent: number;
  /** Of those, how many have a recorded usage. */
  known: number;
  /** Sum of the recorded usage; the `sent - known` others are unknown. */
  usage: UsageRecord;
}

const zero = (): UsageRecord => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/**
 * A conversation's compaction cost from the door's start records.
 * @internal Only tests use it (the ledger projection reads the starts itself, src/durable/projection.ts); knip --production skips `@internal`.
 */
export async function compactionCost(harness: Harness, conversationId: number, context: Context): Promise<CompactionCost> {
  const doc = await harness.snapshot(AttemptsDoc, conversationId as never, context);
  const total: CompactionCost = { sent: 0, known: 0, usage: zero() };
  for (const start of Object.values(doc?.starts ?? {})) {
    if (start.kind !== "compaction" || start.withdrawn === true) continue;
    total.sent++;
    if (start.usage === undefined) continue;
    total.known++;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total.usage[key] += start.usage[key];
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.usage.cost[key] += start.usage.cost[key];
  }
  return total;
}
