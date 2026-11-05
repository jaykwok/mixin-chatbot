// 数值到人话的转换。全部是纯函数，报表导出和降级文本输出共用同一套口径。

/**
 * 字节数。
 *
 * 刻意用 1024 进制并标 KB/MB/GB——运维看的是磁盘占用，和 `du -h`、`docker system df`
 * 对得上比进制学名重要。三位有效数字，列宽稳定在 7 以内，表格不会因为一行 1023.9 抖动。
 */
export function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

/** 计数。沿用 stats-admin 的口径：汇报材料里的数字习惯按万看。 */
export function count(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < 10_000) return String(value);
  return `${(value / 10_000).toFixed(1)} 万`;
}

/** 千分位，用于需要精确到个位的表格列。 */
export function grouped(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US");
}

/** 时长（毫秒）→ 3d 14h / 2h 05m / 47s。运行时间和耗时共用。 */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** 本地时区的 YYYY-MM-DD。汇报材料按自然日看，不能用 UTC。 */
export function day(at: number): string {
  if (!Number.isFinite(at)) return "—";
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 本地时区的 HH:MM:SS，日志和执行步骤用。 */
export function clock(at: number = Date.now()): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/**
 * 手机号打码。
 *
 * 统计页会被截图进汇报材料，默认不该把成员手机号明文摆在上面。保留前三后四，中间打星，
 * 足够运维辨认是谁、又不构成一份可直接抄走的通讯录。
 *
 * 非手机号形态（sha256-user-… 这种摘要目录名）原样返回摘要前缀，它本来就不是明文。
 */
export function maskUser(user: string): string {
  if (user.startsWith("sha256-user-")) return `${user.slice(0, 19)}…`;
  if (user.length <= 7) return user.length <= 2 ? user : `${user.slice(0, 1)}***`;
  return `${user.slice(0, 3)}****${user.slice(-4)}`;
}

/** 空间的显示名，与会话页、统计页一致：单聊、群 <编号>。 */
export function spaceLabel(space: string): string {
  return space === "direct" ? "单聊" : space.startsWith("groups/") ? `群 ${space.slice(7)}` : space;
}

/** 本地时区的 YYYY-MM-DD HH:MM:SS；无效值显示“—”。 */
export function dateTime(at: number | string | undefined): string {
  const value = typeof at === "string" ? Date.parse(at) : at;
  return value === undefined || !Number.isFinite(value) ? "—" : `${day(value)} ${clock(value)}`;
}
