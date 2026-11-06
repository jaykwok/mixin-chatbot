// 数值到人话的转换。全部是纯函数，报表导出和降级文本输出共用同一套口径。

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
