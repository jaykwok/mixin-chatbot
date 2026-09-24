/** 入账时就固定下来的用量类型；Pi 的用量条目可以带任意 kind（例如 cache_warm），未知类型按需补进来。 */
export const KNOWN_USAGE_KINDS = ["assistant", "compaction", "branch_summary"] as const;
export type UsageKind = string;
export interface UsageTotals {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  requests: number; missingUsage: number; unknownCost: number; cost: number;
}
export interface UsageBreakdown {
  total: UsageTotals;
  kinds: Map<UsageKind, UsageTotals>;
  models: Map<string, UsageTotals>;
  days: Map<string, UsageTotals>;
}
export const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "requests", "missingUsage", "unknownCost", "cost"] as const;
export const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, missingUsage: 0, unknownCost: 0, cost: 0 });
export const emptyUsageBreakdown = (): UsageBreakdown => ({ total: emptyUsage(),
  kinds: new Map(KNOWN_USAGE_KINDS.map(kind => [kind as UsageKind, emptyUsage()])), models: new Map(), days: new Map() });
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** 一条模型请求的用量口径：缺字段算「用量不完整」，缺费用算「费用未知」，两者分开计。 */
export function countUsageRecord(total: UsageTotals, raw?: Record<string, unknown>): void {
  total.requests++;
  if (!raw || !valid(raw.input) || !valid(raw.output) || !valid(raw.cacheRead) || !valid(raw.cacheWrite)) total.missingUsage++;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) if (valid(raw?.[key])) total[key] += raw[key];
  const cost = raw?.cost as { total?: unknown } | undefined;
  if (cost && valid(cost.total)) total.cost += cost.total;
  else total.unknownCost++;
}

/** 账本已按类型/模型/日期聚合过，折算时按整块相加。 */
export function mergeUsage(target: UsageBreakdown, kind: UsageKind, modelKey: string, day: string, totals: UsageTotals): void {
  if (!target.kinds.has(kind)) target.kinds.set(kind, emptyUsage());
  if (!target.models.has(modelKey)) target.models.set(modelKey, emptyUsage());
  if (!target.days.has(day)) target.days.set(day, emptyUsage());
  for (const into of [target.total, target.kinds.get(kind)!, target.models.get(modelKey)!, target.days.get(day)!]) {
    for (const key of USAGE_FIELDS) into[key] += totals[key];
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
