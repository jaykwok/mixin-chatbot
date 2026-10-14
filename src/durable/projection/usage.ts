// Usage classification of request starts for the stats ledger: pure functions over the group's start records and the
// projection checkpoint saved in the ledger source. Nothing here reads or writes a database.
import { createHash } from "node:crypto";
import type { StatsRecord } from "../../agent/session-reader.ts";
import type { AttemptStart } from "../attempts.ts";
import type { AuxiliaryRequest } from "../auxiliary-records.ts";

/** A staged retirement batch: start keys with the fingerprint each had when the ledger counted it, and orphan keys. */
export type Retirement = { attempts: Record<string, string>; auxiliary: Record<string, string>; orphans: string[] };
/** Saved as the ledger source's `digest` (JSON, key order as written). */
export type ProjectionCheckpoint = {
  version: 1;
  links: Record<string, { through: number; entryId?: number; interrupted?: boolean }>;
  orphans: Record<string, StatsRecord>;
  /** Last independently charged nested usage receipt. Committed with the bill, never the parent result. */
  nestedThrough?: number;
  retiring?: Retirement;
};
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The usage record of a start: its own start time, provider, model and (when known) usage. */
export const usageRecord = (start: AttemptStart | AuxiliaryRequest, kind: string): StatsRecord => ({ type: "usage", kind,
  timestamp: new Date(start.startedAt).toISOString(), provider: start.provider, model: start.model,
  ...(start.usage === undefined ? {} : { usage: start.usage as unknown as Record<string, unknown> }) });

/** The usage a generation or compaction start still owes the ledger; none once a reply entry carries it. */
export function attemptUsage(key: string, start: AttemptStart, checkpoint: ProjectionCheckpoint, floor: number): StatsRecord | undefined {
  if (start.withdrawn || start.afterEntry < floor) return;
  if (start.kind === "compaction") return usageRecord(start, "compaction");
  const link = checkpoint.links[key];
  if (link?.interrupted || (link?.entryId === undefined && start.outcome === "aborted")) return usageRecord(start, "interrupted");
  if (link?.entryId !== undefined) return;
  return usageRecord(start, start.usage === undefined ? "generation_unconfirmed" : "generation_unsettled");
}

/** The replaceable usage rows of the remaining starts, one group per kind (each kind is recomputed as a whole). */
export function pendingUsage(attempts: Record<string, AttemptStart>, auxiliary: Record<string, AuxiliaryRequest>, checkpoint: ProjectionCheckpoint, floor: number) {
  const groups = new Map<string, StatsRecord[]>(["compaction", "interrupted", "generation_unconfirmed", "generation_unsettled", "auxiliary"].map(kind => [kind, []]));
  for (const [key, start] of Object.entries(attempts)) {
    const item = attemptUsage(key, start, checkpoint, floor);
    if (item) groups.get(item.kind!)!.push(item);
  }
  groups.get("interrupted")!.push(...Object.values(checkpoint.orphans));
  for (const start of Object.values(auxiliary)) if (!start.withdrawn) groups.get("auxiliary")!.push(usageRecord(start, "auxiliary"));
  return [...groups].map(([kind, records]) => ({ kind, records }));
}
