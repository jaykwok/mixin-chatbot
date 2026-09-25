/** Shared CLI/TUI age display, in minutes, hours and days. */
export function describeAge(at: number | string, unknown = "—"): string {
  const timestamp = typeof at === "string" ? Date.parse(at) : at;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return unknown;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
