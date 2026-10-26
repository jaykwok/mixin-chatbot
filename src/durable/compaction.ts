// Compaction policy and cost.
//
// Thresholds. The blocking threshold follows Pi's `contextWindow - reserveTokens`, with
// Pi's reserve and keep-recent budgets for the selected model (settings.ts). Background compaction starts earlier, so
// a long conversation is usually summarised before a request has to wait for it: `backgroundTokens` below the blocking
// threshold, an eighth of the window and at most 32768 tokens (Durable's default). It stays off when the background
// threshold would leave less than two keep-recent budgets: the summary would then cover less than it keeps, and the
// blocking compaction comes soon anyway. Examples with Pi's defaults (reserve 16384, keep 20000): a 128k window starts
// background compaction at 95616 tokens and blocks at 111616; a 64k window has blocking compaction only.
//
// Usage. Durable adds a summarize response's usage to `pi.usage` under the model's key, together with the conversation's
// generations; statistics count it there and do not separate compactions. Summarize requests reach the provider through
// the request door (door.ts), found by the conversation's provider session like a generation.
import type { CompactionPolicy } from "@earendil-works/pi-durable";

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
