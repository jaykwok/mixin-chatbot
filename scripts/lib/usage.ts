export type UsageKind = "assistant" | "compaction" | "branch_summary";
export interface UsageTotals {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  requests: number; missingUsage: number; unknownCost: number; cost: number;
}
export interface UsageBreakdown {
  total: UsageTotals;
  kinds: Record<UsageKind, UsageTotals>;
  models: Map<string, UsageTotals>;
  days: Map<string, UsageTotals>;
}
export const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, missingUsage: 0, unknownCost: 0, cost: 0 });
export const emptyUsageBreakdown = (): UsageBreakdown => ({ total: emptyUsage(),
  kinds: { assistant: emptyUsage(), compaction: emptyUsage(), branch_summary: emptyUsage() }, models: new Map(), days: new Map() });
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function addUsage(target: UsageBreakdown, kind: UsageKind, provider: string, model: string, day: string, raw?: Record<string, unknown>): void {
  const modelKey = JSON.stringify([provider || "unknown", model || "unknown"]);
  if (!target.models.has(modelKey)) target.models.set(modelKey, emptyUsage());
  if (!target.days.has(day)) target.days.set(day, emptyUsage());
  for (const total of [target.total, target.kinds[kind], target.models.get(modelKey)!, target.days.get(day)!]) {
    total.requests++;
    if (!raw || !valid(raw.input) || !valid(raw.output) || !valid(raw.cacheRead) || !valid(raw.cacheWrite)) total.missingUsage++;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) if (valid(raw?.[key])) total[key] += raw[key];
    const cost = raw?.cost as { total?: unknown } | undefined;
    if (cost && valid(cost.total)) total.cost += cost.total;
    else total.unknownCost++;
  }
}

/** Pi input excludes cached reads and writes. Weight by tokens, never average percentages. */
export function cacheReadRate(tokens: Pick<UsageTotals, "input" | "cacheRead" | "cacheWrite">): number | null {
  const total = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return total > 0 ? tokens.cacheRead / total : null;
}
export function formatCacheRate(tokens: Pick<UsageTotals, "input" | "cacheRead" | "cacheWrite">): string {
  const rate = cacheReadRate(tokens);
  return rate === null ? "无样本" : (rate * 100).toFixed(1) + "%";
}
