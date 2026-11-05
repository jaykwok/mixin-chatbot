/** How long until `at` (a scheduled retry), in minutes or hours; "即将" once it is due. */
export function describeUntil(at: number): string {
  const minutes = Math.ceil((at - Date.now()) / 60_000);
  if (minutes <= 0) return "即将";
  if (minutes < 60) return `${minutes} 分钟后`;
  return `${Math.round(minutes / 60)} 小时后`;
}

/** Shared CLI and console age display, in minutes, hours and days. */
export function describeAge(at: number | string, unknown = "—"): string {
  const timestamp = typeof at === "string" ? Date.parse(at) : at;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return unknown;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
