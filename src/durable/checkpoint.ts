// Bounded revision chains for the bot's documents. Every one of them keeps only its current value (session scope, or a
// conversation document with history "latest"), so when Durable writes a base it deletes all older revisions of that
// document in the same commit. Writing a base every CHECKPOINT_INTERVAL changes therefore keeps each chain at most that
// long, and loading a document reads at most that many revisions.
//
// A chain left by an older release (which never wrote a base) can be far longer. Rewriting it online would delete the
// whole chain in one commit on the shared SQL thread, so a chain with LEGACY_CHAIN_LIMIT deltas or more (more than
// LEGACY_CHAIN_LIMIT revisions) keeps receiving deltas as before until the offline cleanup compacts it. Shorter chains are
// compacted by their next change, which deletes at most LEGACY_CHAIN_LIMIT revisions.
import type { CheckpointInfo } from "@earendil-works/pi-durable";

export const CHECKPOINT_INTERVAL = 64;
/**
 * Measured at the limit (revision-chain R2, deltas of 256 B–16 KB, a 4 GB space): the change that compacts a 1,024-revision
 * chain commits in at most 67 ms on WSL and 167 ms on Windows, with about 2,100 WAL frames (8.7 MB).
 */
export const LEGACY_CHAIN_LIMIT = 1_024;

export type CheckpointPolicy = (value: unknown, ops: unknown, info: CheckpointInfo) => boolean;

/**
 * A `checkpointWhen`: `deltasSinceBase` counts the deltas stored after the base before this change, so the change that would
 * be the `interval`-th revision of the chain is written as a base instead, unless the chain already has `legacyLimit`
 * deltas or more.
 */
export function checkpointPolicy({ interval = CHECKPOINT_INTERVAL, legacyLimit = LEGACY_CHAIN_LIMIT } = {}): CheckpointPolicy {
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error(`invalid checkpoint interval ${interval}`);
  if (!Number.isSafeInteger(legacyLimit) || legacyLimit < interval) throw new Error(`invalid legacy limit ${legacyLimit}`);
  return (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= interval - 1 && deltasSinceBase < legacyLimit;
}

/** `checkpointWhen` of every bot document. */
export const checkpointDue = checkpointPolicy();
