// Display helpers for times and durations, in the same wording as the command-line tools.

const pad = (value: number) => String(value).padStart(2, "0");

/** The host system as people name it. */
export function platformName(platform: "windows" | "linux" | "macos"): string {
  return platform === "windows" ? "Windows" : platform === "macos" ? "macOS" : "Linux";
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}

export function ago(at: number, now = Date.now()): string {
  const ms = now - at;
  if (ms < 60_000) return "刚刚";
  return `${duration(ms)}前`;
}

export function clock(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function dateTime(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const count = (value: number) => value.toLocaleString("zh-CN");

/** Large counts in 万 and 亿, as the stats report writes them. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${trim(value / 1e8)} 亿`;
  if (abs >= 1e4) return `${trim(value / 1e4)} 万`;
  return count(Math.round(value * 10) / 10);
}
const trim = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2)).replace(/\.?0+$/, "");

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export const percent = (ratio: number, digits = 1) => `${(ratio * 100).toFixed(digits)}%`;

/** Message times: the clock today, month and day this year, the full date before. */
export function stamp(at: number, now = Date.now()): string {
  const date = new Date(at), today = new Date(now);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === today.toDateString()) return time;
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : duration(ms);
}
