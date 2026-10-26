import { byName, type GroupSelection } from "../lib/group-data.ts";
import { cliArgs, groupOptions, groupSelection } from "../lib/cli.ts";
import { formatCacheRate } from "../lib/usage.ts";
// 统计只读使用统计账本（<数据目录>/state/stats.sqlite）：提问数和模型返回的 token 用量。
// /clear 不清零统计；入账口径见 src/agent/stats-ledger.ts：指令不算提问，token 按同步当天计入。
import { addTokens, dayKey, dayWindow, emptyTokens, openExistingStatsLedger, readLedger, type DayWindow, type LedgerRows, type TokenTotals } from "../../src/agent/stats-ledger.ts";
import { appLayout, groupSegment } from "../../src/core/layout.ts";
import { DATA_DIR } from "../../src/core/storage.ts";
import { maskUser } from "./tui/render/format.ts";
import { change, comparisons, comparisonWindows, describeStatsWindow, engagement, periodWindow, STATS_NOTE, summarize, TOKEN_NOTE, trend, type ComparisonData, type StatsPeriod } from "./stats-summary.ts";

export interface UserStats {
  user: string;
  asks: number;
  firstAt: number;
  lastAt: number;
  days: Set<string>;
}

export interface GroupStats {
  group: string;
  users: UserStats[];
  asks: number;
  /** 全部 token：对话与压缩（models）加上工具自身调用的辅助模型（tools）。 */
  tokens: TokenTotals;
  /** 按 provider/model。 */
  models: Map<string, TokenTotals>;
  /** 按工具名：辅助分类、生图等工具自身发起的模型请求。 */
  tools: Map<string, TokenTotals>;
  /** 按入账（同步）日期。 */
  tokenDays: Map<string, TokenTotals>;
  months: Map<string, { asks: number; users: Set<string> }>;
  daily: Map<string, { asks: number; askers: Set<string> }>;
  days: Set<string>;
  firstAt: number;
  lastAt: number;
}

export interface Window {
  since?: number;
  until?: number;
  period?: StatsPeriod;
}

function usage(): void {
  console.log("用法：bun run stat [群号] [选项]");
  console.log("");
  console.log("  不带群号          列出各群（及单聊，记为 direct）的使用概览");
  console.log("  <群号>|direct     该群（或单聊）的详细统计（每日、每周、每月、提问排行）");
  console.log("  --period <范围>   today / yesterday / week / last-week / month / last-month / 7d / 30d / all");
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
  return {
    group,
    users: [],
    asks: 0,
    tokens: emptyTokens(),
    models: new Map(),
    tools: new Map(),
    tokenDays: new Map(),
    months: new Map(),
    daily: new Map(),
    days: new Set(),
    firstAt: Number.POSITIVE_INFINITY,
    lastAt: Number.NEGATIVE_INFINITY,
  };
}

export const hasTokens = (tokens: TokenTotals) => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.totalTokens > 0;

function addTo(map: Map<string, TokenTotals>, key: string, tokens: TokenTotals): void {
  let total = map.get(key);
  if (!total) map.set(key, total = emptyTokens());
  addTokens(total, tokens);
}

/**
 * 把账本行折成一个群的统计。
 *
 * 账本行已按「空间 × 成员 × 自然日」聚合，这里只做相加与去重；行的读取顺序固定，结果与平台、写入次序无关。
 * 活跃区间只看提问时间：token 按同步日入账，不代表使用时刻。
 */
function foldGroup(group: string, rows: LedgerRows): GroupStats {
  const stats = emptyGroup(group);
  const users = new Map<string, UserStats>();
  for (const row of rows.asks) {
    if (row.asks <= 0) continue;
    let entry = users.get(row.user);
    if (!entry) users.set(row.user, entry = { user: row.user, asks: 0, firstAt: Number.POSITIVE_INFINITY, lastAt: Number.NEGATIVE_INFINITY, days: new Set() });
    entry.asks += row.asks;
    entry.firstAt = Math.min(entry.firstAt, row.firstAt);
    entry.lastAt = Math.max(entry.lastAt, row.lastAt);
    entry.days.add(row.day);
    stats.days.add(row.day);
    let daily = stats.daily.get(row.day);
    if (!daily) stats.daily.set(row.day, daily = { asks: 0, askers: new Set() });
    daily.asks += row.asks;
    daily.askers.add(row.user);
    const monthKey = row.day.slice(0, 7);
    const month = stats.months.get(monthKey) ?? { asks: 0, users: new Set<string>() };
    month.asks += row.asks;
    month.users.add(row.user);
    stats.months.set(monthKey, month);
  }
  for (const row of rows.usage) {
    addTokens(stats.tokens, row);
    addTo(row.bucket === "models" ? stats.models : stats.tools, row.key, row);
    addTo(stats.tokenDays, row.day, row);
  }
  for (const entry of users.values()) {
    stats.users.push(entry);
    stats.asks += entry.asks;
    stats.firstAt = Math.min(stats.firstAt, entry.firstAt);
    stats.lastAt = Math.max(stats.lastAt, entry.lastAt);
  }
  stats.users.sort((a, b) => b.asks - a.asks || b.lastAt - a.lastAt || byName(a.user, b.user));
  return stats;
}

function rowsOf(rows: LedgerRows, group: string): LedgerRows {
  return { asks: rows.asks.filter(row => row.group === group), usage: rows.usage.filter(row => row.group === group), groups: [group] };
}

/** root 是数据目录；服务还没建账本时按空账处理。 */
function readRows(root: string, window: DayWindow = {}, group?: string): LedgerRows {
  const db = openExistingStatsLedger(appLayout(root).stats);
  if (!db) return { asks: [], usage: [], groups: [] };
  try { return db.transaction(() => readLedger(db, window, group))(); } finally { db.close(); }
}

export async function collectGroup(
  group: string,
  root: string = DATA_DIR,
  window: Window = {}
): Promise<GroupStats> {
  return foldGroup(group, readRows(root, dayWindow(window), group));
}

export async function collectAll(
  root: string = DATA_DIR,
  window: Window = {}
): Promise<GroupStats[]> {
  const rows = readRows(root, dayWindow(window));
  return rows.groups
    .map(group => foldGroup(group, rowsOf(rows, group)))
    .filter(stats => stats.users.length > 0 || hasTokens(stats.tokens))
    .sort((a, b) => b.asks - a.asks || byName(a.group, b.group));
}

export async function collectComparisons(root: string, window: Window): Promise<ComparisonData | null> {
  const ranges = comparisonWindows(window);
  if (!ranges) return null;
  const [previous, yearAgo] = await Promise.all([collectAll(root, ranges.previous), collectAll(root, ranges.yearAgo)]);
  return { previous: { window: ranges.previous, groups: previous }, yearAgo: { window: ranges.yearAgo, groups: yearAgo } };
}

/** 按群号或目录段在账本里找来源段；会话目录删掉后历史仍在账本里。单聊来源段是 direct。 */
async function resolveStatsGroup(value: string, root: string, kind: GroupSelection): Promise<string | null> {
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
  console.log(STATS_NOTE);
  console.log(
    "统计口径：一条发给机器人的消息算一次提问（含干活途中的插话），/help /clear 等指令不计入。"
  );
  console.log(TOKEN_NOTE);
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
  console.log(
    `  模型用量    输入 ${formatCount(stats.tokens.input)}、输出 ${formatCount(stats.tokens.output)}、` +
      `缓存命中 ${formatCount(stats.tokens.cacheRead)}、缓存写入 ${formatCount(stats.tokens.cacheWrite)} token；` +
      `合计 ${formatCount(stats.tokens.totalTokens)}；加权缓存读率 ${formatCacheRate(stats.tokens)}`
  );
  for (const [label, map] of [["按模型", stats.models], ["按工具（辅助模型）", stats.tools]] as const) {
    if (!map.size) continue;
    console.log("");
    console.log(`  ${label}`);
    for (const [key, tokens] of [...map].sort((a, b) => b[1].totalTokens - a[1].totalTokens || byName(a[0], b[0]))) {
      console.log(`    ${key}    输入 ${formatCount(tokens.input)}  输出 ${formatCount(tokens.output)}  缓存命中 ${formatCount(tokens.cacheRead)}  ` +
        `缓存写入 ${formatCount(tokens.cacheWrite)}  合计 ${formatCount(tokens.totalTokens)}`);
    }
  }

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
          `${String(user.asks).padStart(4)} 次提问  ` +
          `${formatDay(user.firstAt)} ~ ${formatDay(user.lastAt)}  ${user.days.size} 天`
      );
    }
  }

  console.log("");
  printFootnote();
}

function printAnalysis(groups: GroupStats[], window: Window, data: ComparisonData | null, scope?: Set<string>): void {
  const summary = summarize(groups);
  console.log(`总提问数 ${summary.asks} 次 · 覆盖提问人数 ${summary.people} 人（跨群去重） · 人均 ${summary.average.toFixed(1)} 次 · 活跃 ${summary.activeDays} 天`);
  const activity = engagement(groups, window);
  console.log(`日均 ${activity.dailyAverage.toFixed(1)} 次 · 活跃天数占比 ${(activity.activeRate * 100).toFixed(1)}% · 前五名提问占比 ${(activity.topFiveShare * 100).toFixed(1)}% · 高峰日 ${activity.peak?.date ?? "—"}（${activity.peak?.asks ?? 0} 次）`);
  for (const period of comparisons(data, scope)) {
    console.log(`${period.label}（${describeStatsWindow(period.window)}）：基期 ${period.asks} 次 / ${period.people} 人；提问 ${change(summary.asks, period.asks)}，人数 ${change(summary.people, period.people)}`);
  }
  for (const [grain, label] of [["day", "每日"], ["week", "每周（周一为起点）"], ["month", "每月"]] as const) {
    console.log(`\n${label}：日期 / 提问 / 提问人数 / 入账 token（合计）`);
    for (const row of trend(groups, window, grain)) console.log(`  ${row.date}  ${row.asks} 次  ${row.askers.size} 人  ${row.tokens.totalTokens}`);
  }
  console.log("\n提问排行（跨群合并，前 20 位）：");
  for (const [index, user] of summary.ranking.slice(0, 20).entries()) console.log(`  ${index + 1}. ${scope ? user.user : maskUser(user.user)}  ${user.asks} 次  占比 ${(100 * user.asks / summary.asks).toFixed(1)}%  ${user.days.size} 天  ${user.groups.size} 个群`);
}

async function overview(root: string, window: Window): Promise<number> {
  const groups = await collectAll(root, window);
  console.log(`共 ${groups.length} 个有记录的群${describeWindow(window)}`);
  if (!groups.length) console.log(`没有找到任何使用记录（统计账本：${appLayout(root).stats}）。`);
  printAnalysis(groups, window, await collectComparisons(root, window));
  console.log("");
  for (const group of groups) {
    console.log(
      `  ${group.group}    ${String(group.users.length).padStart(3)} 人  ` +
        `${String(group.asks).padStart(4)} 次提问  ${formatCount(group.tokens.totalTokens).padStart(8)} token  ` +
        `${formatDay(group.firstAt)} ~ ${formatDay(group.lastAt)}`
    );
  }
  console.log("");
  console.log("查看某个群的明细：bun run stat <群号>");
  printFootnote();
  return 0;
}

async function main(args: string[]): Promise<number> {
  const { values, positionals: positional } = cliArgs(args, { ...groupOptions, help: { type: "boolean", short: "h" }, period: { type: "string" }, since: { type: "string" }, until: { type: "string" } });
  if (values.help) { usage(); return 0; }
  if (values.period && (values.since || values.until)) throw new Error("--period 与 --since/--until 不能同时使用");
  const window: Window = values.period ? periodWindow(values.period) : {};
  if (values.since) window.since = parseDate(values.since, false);
  if (values.until) window.until = parseDate(values.until, true);
  const selection = groupSelection(values, positional[0]);

  if (positional.length > 1) {
    console.error("一次只能统计一个群。");
    return 1;
  }
  if (window.since !== undefined && window.until !== undefined && window.since > window.until) {
    console.error("--since 晚于 --until，区间为空。");
    return 1;
  }

  const root = DATA_DIR;
  const groupId = positional[0];
  if (!groupId) return overview(root, window);

  const group = await resolveStatsGroup(groupId, root, selection);
  if (!group) {
    console.error(`统计账本里找不到群 ${groupId}。不带参数运行可以列出有记录的群。`);
    return 1;
  }
  const stats = await collectGroup(group, root, window);
  if (stats.users.length === 0 && !hasTokens(stats.tokens)) {
    console.log(`群 ${group} 在该区间内没有使用记录 ${describeWindow(window)}。`);
  }
  printAnalysis([stats], window, await collectComparisons(root, window), new Set([group]));
  printGroup(stats, window);
  return 0;
}

// 直接运行时才执行；测试要 import 这些函数，不能顺带把整个 CLI 跑起来。
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); return 1; }));
}
