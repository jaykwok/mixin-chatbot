import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { AttemptsDoc, type UsageRecord } from "../../src/durable/attempts.ts";

/** Inspect request-door records without starting the service's ledger projection. */
export async function compactionCost(harness: Harness, conversationId: number, context: Context) {
  const doc = await harness.snapshot(AttemptsDoc, conversationId as never, context);
  const usage: UsageRecord = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const total = { sent: 0, known: 0, usage };
  for (const start of Object.values(doc?.starts ?? {})) {
    if (start.kind !== "compaction" || start.withdrawn) continue;
    total.sent++;
    if (!start.usage) continue;
    total.known++;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += start.usage[key];
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[key] += start.usage.cost[key];
  }
  return total;
}
