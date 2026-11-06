// Bounded revision chains for the bot's documents. Every one of them keeps only its current value (session scope, or a
// conversation document with history "latest"), so when Durable writes a base it deletes all older revisions of that
// document in the same commit. Writing a base every CHECKPOINT_INTERVAL changes therefore keeps each chain at most that
// long, and loading a document reads at most that many revisions.
import type { CheckpointInfo } from "@earendil-works/pi-durable";

export const CHECKPOINT_INTERVAL = 64;

export type CheckpointPolicy = (value: unknown, ops: unknown, info: CheckpointInfo) => boolean;

/**
 * A `checkpointWhen`: `deltasSinceBase` counts the deltas stored after the base before this change, so the change that would
 * be the `interval`-th revision of the chain is written as a base instead.
 */
export function checkpointPolicy({ interval = CHECKPOINT_INTERVAL } = {}): CheckpointPolicy {
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error(`invalid checkpoint interval ${interval}`);
  return (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= interval - 1;
}

/** `checkpointWhen` of every bot document. */
export const checkpointDue = checkpointPolicy();
