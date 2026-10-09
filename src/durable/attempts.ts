// Start records of generation and summarize requests (contract 3, review R2-4 of D0; summarize requests since D2-5).
//
// The `pi.generation` request phase keeps only the latest attempt number in `pi.live`, and a recovered invocation reuses
// the checkpoint's attempt, so the Harness keeps no trace of a request that died before its first partial. The request
// door (src/durable/door.ts) therefore commits a start record before it hands a request to the provider, and hands it
// over only once that commit succeeded: every provider call has a durable start, so attempt counts are an upper bound
// (a crash between the commit and the call, or a held request whose withdraw failed, counts once more), never lower.
// The `pi.compaction` summarize phase behaves the same way; its starts carry `kind: "compaction"`, so background and
// overflow compaction cost stays separate from the conversation's turns.
// Projecting starts into usage facts and reconciling them with `pi.usage` belongs to D3.
import { defineDoc } from "@earendil-works/pi-durable";

/** pi-ai `Usage` as JSON (an interface does not satisfy the document's JSON constraint). */
export type UsageRecord = {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  cacheWrite1h?: number; reasoning?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

export type AttemptStart = {
  taskId: number;
  attempt: number;
  /** Invocation number within (task, attempt): a recovered request reuses the attempt number. */
  k: number;
  /** Newest entry of the conversation when the start was committed. */
  afterEntry: number;
  startedAt: number;
  provider: string;
  model: string;
  /** The door held the request after committing the start and did not send it. */
  withdrawn?: boolean;
  /** A compaction task's summarize request; absent for generation requests. */
  kind?: "compaction";
  /**
   * Completed response's usage, recorded before Durable sees it. It also covers a crash before the assistant entry.
   * Absent: no complete response, withdrawn, or the write failed; unknown, not zero. Partial estimates are not bills.
   */
  usage?: UsageRecord;
  outcome?: "done" | "error" | "aborted";
};

/** Error-message prefix of a generation the request door ended without calling the provider (Durable retries it). */
export const NOT_SENT = "mixin request door: internal error, request not sent";

/** A generation the request door ended without calling the provider (projection skips it). */
export function isNotSent(message: { stopReason?: string; errorMessage?: string } | undefined): boolean {
  return message?.stopReason === "error" && message.errorMessage?.startsWith(NOT_SENT) === true;
}

/** Conversation-scoped start records, written only by the request door; never copied into forks. */
export const AttemptsDoc = defineDoc<{ starts: Record<string, AttemptStart> }>({
  kind: "mixin.attempts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ starts: {} }),
});
