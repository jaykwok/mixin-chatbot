import type { TokenTotals } from "../../src/agent/stats-ledger.ts";

/** Pi input excludes cached reads and writes. Weight by tokens, never average percentages. */
export function cacheReadRate(tokens: Pick<TokenTotals, "input" | "cacheRead" | "cacheWrite">): number | null {
  const total = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return total > 0 ? tokens.cacheRead / total : null;
}
export function formatCacheRate(tokens: Pick<TokenTotals, "input" | "cacheRead" | "cacheWrite">): string {
  const rate = cacheReadRate(tokens);
  return rate === null ? "无样本" : (rate * 100).toFixed(1) + "%";
}
