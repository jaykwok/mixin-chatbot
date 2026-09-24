import { byName, resolveGroupName, type GroupSelection } from "../lib/group-data.ts";
import { emptyUsageBreakdown, formatCacheRate, mergeUsage, type UsageBreakdown, type UsageTotals } from "../lib/usage.ts";
// 统计只读使用统计账本（<群数据根>/stats.sqlite），不再现算 session.jsonl：
// 会话历史会被 /clear 与 history clear 归档，归档前机器人已把那段入账，数字照样在。
// 入账口径见 src/agent/stats-ledger.ts：指令不算提问、附件只认有 fileId 的成功结果。
import { dayKey, dayWindow, openExistingStatsLedger, readLedger, type DayWindow, type LedgerRows } from "../../src/agent/stats-ledger.ts";
import { groupSegment } from "../../src/agent/paths.ts";
import { GROUP_DATA_ROOT } from "../../src/core/config.ts";

export interface UserStats {
  user: string;
  asks: number;
  replies: number;
  files: number;
  firstAt: number;
  lastAt: number;
  days: Set<string>;
}

export interface GroupStats {
  group: string;
  users: UserStats[];
  asks: number;
  replies: number;
  tools: Map<string, number>;
  delivered: Map<string, number>;
  tokens: UsageTotals;
  usage: UsageBreakdown;
  months: Map<string, { asks: number; users: Set<string> }>;
  daily: Map<string, { asks: number; users: Set<string>; files: number; images: number }>;
  days: Set<string>;
  firstAt: number;
  lastAt: number;
  skipped: number;
}

export interface Window {
  since?: number;
  until?: number;
}

function usage(): void {
  console.log("用法：bun run stat [群号] [选项]");
  console.log("");
  console.log("  不带群号          列出各群的使用概览");
  console.log("  <群号>            该群的详细统计（按月、按成员）");
  console.log("  --since <日期>    只统计该日期当天及之后（YYYY-MM-DD）");
  console.log("  --until <日期>    只统计该日期当天及之前（YYYY-MM-DD）");
  console.log("  --group-id / --storage-segment  明确使用原始群号或存储目录段，两者互斥");
  console.log("");
  console.log("  只读取统计账本，不改动统计数据，机器人运行中也可以执行；每次任务结束后即入账。");
}

function formatDay(at: number): string {
  return Number.isFinite(at) ? dayKey(at) : "—";
}

/** 汇报材料里的数字习惯按万看。 */
function formatCount(value: number): string {
  if (value < 10_000) return String(value);
  return `${(value / 10_000).toFixed(1)} 万`;
}

/** --since/--until 收的是自然日，转成当天的起止时刻，避免边界少算一天。 */
export function parseDate(raw: string, endOfDay: boolean): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new Error(`日期格式应为 YYYY-MM-DD，收到「${raw}」`);
  const [, year, month, day] = match;
  const at = endOfDay
    ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
    : new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(at.getTime()) || at.getFullYear() !== Number(year) || at.getMonth() !== Number(month) - 1 || at.getDate() !== Number(day)) {
    throw new Error(`无效日期：${raw}`);
  }
  return at.getTime();
}

function emptyGroup(group: string): GroupStats {
  const usage = emptyUsageBreakdown();
  return {
    group,
    users: [],
    asks: 0,
    replies: 0,
    tools: new Map(),
    delivered: new Map(),
    tokens: usage.total,
    usage,
    months: new Map(),
    daily: new Map(),
    days: new Set(),
    firstAt: Number.POSITIVE_INFINITY,
    lastAt: Number.NEGATIVE_INFINITY,
    skipped: 0,
  };
}

/**
 * 把账本行折成一个群的统计。
 *
 * 账本行已按「世代 × 自然日」聚合，这里只做相加与去重：同一个人可能有多个世代
 * （每次 /clear 之后是新的一代），所以成员维度按用户目录段合并。行的读取顺序固定，
 * 浮点费用的累加顺序因此与平台、写入次序无关。
 */
function foldGroup(group: string, rows: LedgerRows): GroupStats {
  const stats = emptyGroup(group);
  stats.skipped = rows.skipped.get(group) ?? 0;
  const users = new Map<string, UserStats>();
  const entryOf = (user: string): UserStats => {
    const existing = users.get(user);
    if (existing) return existing;
    const created: UserStats = { user, asks: 0, replies: 0, files: 0,
      firstAt: Number.POSITIVE_INFINITY, lastAt: Number.NEGATIVE_INFINITY, days: new Set() };
    users.set(user, created);
    return created;
  };
  const dailyOf = (day: string) => {
    const existing = stats.daily.get(day);
    if (existing) return existing;
    const created = { asks: 0, users: new Set<string>(), files: 0, images: 0 };
    stats.daily.set(day, created);
    return created;
  };

  for (const row of rows.activity) {
    const entry = entryOf(row.user);
    entry.asks += row.asks;
    entry.replies += row.replies;
    entry.firstAt = Math.min(entry.firstAt, row.firstAt);
    entry.lastAt = Math.max(entry.lastAt, row.lastAt);
    const daily = dailyOf(row.day);
    daily.asks += row.asks;
    if (row.asks > 0 || row.replies > 0) daily.users.add(row.user);
    if (row.asks > 0) {
      entry.days.add(row.day);
      stats.days.add(row.day);
      const monthKey = row.day.slice(0, 7);
      const month = stats.months.get(monthKey) ?? { asks: 0, users: new Set<string>() };
      month.asks += row.asks;
      month.users.add(row.user);
      stats.months.set(monthKey, month);
    }
  }
  for (const row of rows.tools) {
    if (row.kind === "call") {
      stats.tools.set(row.tool, (stats.tools.get(row.tool) ?? 0) + row.count);
      continue;
    }
    stats.delivered.set(row.tool, (stats.delivered.get(row.tool) ?? 0) + row.count);
    const daily = dailyOf(row.day);
    if (row.tool === "send_file") {
      entryOf(row.user).files += row.count;
      daily.files += row.count;
    } else daily.images += row.count;
  }
  for (const row of rows.usage) {
    mergeUsage(stats.usage, row.kind, JSON.stringify([row.provider || "unknown", row.model || "unknown"]), row.day, row);
    // 压缩、分支摘要与缓存保温不属于任何一次提问，但它们确实发生过，要算进活跃区间。
    if (row.kind === "assistant") continue;
    stats.firstAt = Math.min(stats.firstAt, row.firstAt);
    stats.lastAt = Math.max(stats.lastAt, row.lastAt);
  }

  // 只有在区间内真正问过或被回答过的人才算「使用过」；只剩工具结果的成员不列名。
  for (const entry of users.values()) {
    if (entry.asks === 0 && entry.replies === 0) continue;
    stats.users.push(entry);
    stats.asks += entry.asks;
    stats.replies += entry.replies;
    stats.firstAt = Math.min(stats.firstAt, entry.firstAt);
    stats.lastAt = Math.max(stats.lastAt, entry.lastAt);
  }
  stats.users.sort((a, b) => b.asks - a.asks || b.lastAt - a.lastAt || byName(a.user, b.user));
  return stats;
}

function rowsOf(rows: LedgerRows, group: string): LedgerRows {
  return {
    activity: rows.activity.filter(row => row.group === group),
    tools: rows.tools.filter(row => row.group === group),
    usage: rows.usage.filter(row => row.group === group),
    skipped: rows.skipped,
    groups: [group],
  };
}

/** 服务还没建账本时按空账处理。 */
function readRows(root: string, window: DayWindow = {}, group?: string): LedgerRows {
  const db = openExistingStatsLedger(root);
  if (!db) return { activity: [], tools: [], usage: [], skipped: new Map(), groups: [] };
  try { return readLedger(db, window, group); } finally { db.close(); }
}

export async function collectGroup(
  group: string,
  root: string = GROUP_DATA_ROOT,
  window: Window = {}
): Promise<GroupStats> {
  return foldGroup(group, readRows(root, dayWindow(window), group));
}

export async function collectAll(
  root: string = GROUP_DATA_ROOT,
  window: Window = {}
): Promise<GroupStats[]> {
  const rows = readRows(root, dayWindow(window));
  return rows.groups
    .map(group => foldGroup(group, rowsOf(rows, group)))
    .filter(stats => stats.users.length > 0 || stats.usage.total.requests > 0)
    .sort((a, b) => b.asks - a.asks || byName(a.group, b.group));
}

/** 群目录可能已经被删掉，但账本里还有它的历史：按群号或目录段在账本里再找一次。 */
async function resolveStatsGroup(value: string, root: string, kind: GroupSelection): Promise<string | null> {
  const fromDisk = await resolveGroupName(value, root, kind);
  if (fromDisk) return fromDisk;
  const known = new Set(readRows(root).groups);
  const encoded = groupSegment(value);
  const byId = known.has(encoded) ? encoded : null;
  const bySegment = known.has(value) ? value : null;
  if (kind === "id") return byId;
  if (kind === "segment") return bySegment;
  if (byId && bySegment && byId !== bySegment) {
    throw new Error("群号与存储目录存在歧义；请使用 --group-id 或 --storage-segment 明确选择");
  }
  return byId ?? bySegment;
}

function describeWindow(window: Window): string {
  if (window.since === undefined && window.until === undefined) return "";
  const from = window.since === undefined ? "最早" : formatDay(window.since);
  const to = window.until === undefined ? "至今" : formatDay(window.until);
  return `   （统计区间 ${from} ~ ${to}）`;
}

function printFootnote(): void {
  console.log(
    "统计口径：一条发给机器人的消息算一次提问（含干活途中的插话），/help /clear 等指令不计入。"
  );
  console.log(
    "数据来自统计账本，归档或清空会话都不影响已入账的历史；区间按自然日裁剪。"
  );
  console.log(
    "附件数只计有 fileId 的成功工具结果，链接生成不等于送达。"
  );
}

function printGroup(stats: GroupStats, window: Window): void {
  const span = `${formatDay(stats.firstAt)} ~ ${formatDay(stats.lastAt)}`;
  console.log(`群 ${stats.group}   ${span}${describeWindow(window)}`);
  console.log("");
  console.log(`  使用人数    ${stats.users.length} 人`);
  console.log(
    `  提问次数    ${stats.asks} 次` +
      (stats.users.length > 0
        ? `（人均 ${(stats.asks / stats.users.length).toFixed(1)} 次）`
        : "")
  );
  console.log(`  活跃天数    ${stats.days.size} 天`);
  console.log(`  AI 处理轮次 ${stats.replies} 次`);

  const sentFiles = stats.delivered.get("send_file") ?? 0;
  const sentImages = stats.delivered.get("send_image") ?? 0;
  console.log(`  成功发送附件    ${sentFiles} 份文件` + (sentImages > 0 ? `、${sentImages} 张图片` : ""));

  const toolTotal = [...stats.tools.values()].reduce((sum, n) => sum + n, 0);
  const topTools = [...stats.tools]
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
    .slice(0, 5)
    .map(([name, count]) => `${name} ${count}`)
    .join("、");
  console.log(`  工具调用    ${toolTotal} 次` + (topTools ? `（${topTools}）` : ""));
  console.log(
    `  模型用量    输入 ${formatCount(stats.tokens.input)}、输出 ${formatCount(stats.tokens.output)}、` +
      `缓存命中 ${formatCount(stats.tokens.cacheRead)} token`
  );

  if (stats.months.size > 0) {
    console.log("");
    console.log("  按月");
    for (const [month, data] of [...stats.months].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`    ${month}    ${String(data.asks).padStart(4)} 次提问    ${data.users.size} 人`);
    }
  }

  if (stats.users.length > 0) {
    console.log("");
    console.log("  按成员");
    let rank = 0;
    for (const user of stats.users) {
      rank++;
      console.log(
        `    ${String(rank).padStart(2)}. ${user.user.padEnd(14)}` +
          `${String(user.asks).padStart(4)} 次提问  ${String(user.files).padStart(3)} 份已确认附件  ` +
          `${formatDay(user.firstAt)} ~ ${formatDay(user.lastAt)}  ${user.days.size} 天`
      );
    }
  }

  if (stats.skipped > 0) {
    console.log("");
    console.log(`  入账时跳过 ${stats.skipped} 行（无法解析的记录；尾部半行会在写完后补入）。`);
  }
  console.log("");
  printFootnote();
}

async function overview(root: string, window: Window): Promise<number> {
  const groups = await collectAll(root, window);
  if (groups.length === 0) {
    console.log(`没有找到任何使用记录（群数据总根：${root}）${describeWindow(window)}。`);
    return 0;
  }
  const people = groups.reduce((sum, group) => sum + group.users.length, 0);
  const asks = groups.reduce((sum, group) => sum + group.asks, 0);
  // 人数按群相加：同一个人出现在两个群里算两次，跨群去重需要手机号，这里不做。
  console.log(`共 ${groups.length} 个群、${people} 位成员、${asks} 次提问${describeWindow(window)}`);
  console.log("");
  for (const group of groups) {
    const files = group.delivered.get("send_file") ?? 0;
    console.log(
      `  ${group.group}    ${String(group.users.length).padStart(3)} 人  ` +
        `${String(group.asks).padStart(4)} 次提问  ${String(files).padStart(3)} 份已确认附件  ` +
        `${formatDay(group.firstAt)} ~ ${formatDay(group.lastAt)}`
    );
  }
  console.log("");
  console.log("查看某个群的明细：bun run stat <群号>");
  printFootnote();
  return 0;
}

async function main(args: string[]): Promise<number> {
  const window: Window = {};
  let selection: GroupSelection = "auto";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      usage();
      return 0;
    }
    if (arg === "--since" || arg === "--until") {
      const value = args[++i];
      if (!value) {
        console.error(`${arg} 需要一个日期，格式 YYYY-MM-DD`);
        return 1;
      }
      try {
        if (arg === "--since") window.since = parseDate(value, false);
        else window.until = parseDate(value, true);
      } catch (error) {
        console.error(String(error instanceof Error ? error.message : error));
        return 1;
      }
      continue;
    }
    if (arg === "--storage-segment" || arg === "--group-id") {
      if (selection !== "auto") throw new Error("群目录选择参数不能重复");
      selection = arg === "--storage-segment" ? "segment" : "id";
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`无法识别的参数：${arg}`);
      return 1;
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    console.error("一次只能统计一个群。");
    return 1;
  }
  if (window.since !== undefined && window.until !== undefined && window.since > window.until) {
    console.error("--since 晚于 --until，区间为空。");
    return 1;
  }

  const root = GROUP_DATA_ROOT;
  const groupId = positional[0];
  if (!groupId) return overview(root, window);

  const group = await resolveStatsGroup(groupId, root, selection);
  if (!group) {
    console.error(`在 ${root} 的群目录和统计账本里都找不到群 ${groupId}。不带参数运行可以列出有记录的群。`);
    return 1;
  }
  const stats = await collectGroup(group, root, window);
  if (stats.users.length === 0 && stats.usage.total.requests === 0) {
    console.log(`群 ${group} 在该区间内没有使用记录 ${describeWindow(window)}。`);
    return 0;
  }
  printGroup(stats, window);
  console.log("缓存写入: " + stats.tokens.cacheWrite + "；加权缓存读率: " + formatCacheRate(stats.tokens));
  console.log("已知估算费用: $" + stats.tokens.cost.toFixed(6) + "；费用未知记录: " + stats.tokens.unknownCost + "；用量不完整记录: " + stats.tokens.missingUsage);
  console.log("费用按 SDK 配置价格估算，不代表 Coding Plan 的实际账单或套餐配额。");
  for (const [kind, usage] of stats.usage.kinds) console.log(kind + ": " + JSON.stringify(usage));
  for (const [model, usage] of stats.usage.models) console.log("模型 " + model + ": " + JSON.stringify(usage));
  for (const [day, usage] of stats.usage.days) console.log("日期 " + day + ": " + JSON.stringify(usage));
  return 0;
}

// 直接运行时才执行；测试要 import 这些函数，不能顺带把整个 CLI 跑起来。
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
