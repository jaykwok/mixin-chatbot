import { assertDataDirectory, byName, dataDirectoryNames, resolveGroupName, type GroupSelection } from "../lib/group-data.ts";
import { readSessionStats } from "../lib/session-stats-cache.ts";
import { mapConcurrent } from "../lib/concurrent.ts";
import { addUsage, emptyUsageBreakdown, formatCacheRate, type UsageBreakdown, type UsageTotals } from "../lib/usage.ts";
// 只读统计仍在 session.jsonl 中的用户消息、模型轮次及成功资料工具结果。
// 斜杠指令按 commands.ts 排除；未完成的尾行跳过并报告。
// /clear 与 history-clear 会归档会话，已归档部分不纳入本次统计。
import { join } from "node:path";
import { GROUP_DATA_ROOT } from "../../src/core/config.ts";

const HISTORY_FILE = "session.jsonl";

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
  console.log("  只读取 session.jsonl，不修改任何文件，机器人运行中也可以执行。");
}

/** 本地时区的 YYYY-MM-DD；汇报材料按自然日和自然月看，不能用 UTC。 */
function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
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

function readUser(
  source: Awaited<ReturnType<typeof readSessionStats>>,
  user: string,
  group: GroupStats,
  window: Window
): UserStats | null {
  group.skipped += source.skipped;
  let provider = "unknown", model = "unknown";

  const stats: UserStats = {
    user,
    asks: 0,
    replies: 0,
    files: 0,
    firstAt: Number.POSITIVE_INFINITY,
    lastAt: Number.NEGATIVE_INFINITY,
    days: new Set(),
  };

  for (const record of source.records) {
    if (record.type === "model_change") { provider = record.provider ?? "unknown"; model = record.modelId ?? "unknown"; continue; }
    if (record.type === "message" && record.message?.role === "assistant") {
      provider = record.message.provider ?? provider; model = record.message.model ?? model;
    }
    const at = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    if (window.since !== undefined && at < window.since) continue;
    if (window.until !== undefined && at > window.until) continue;

    if (record.type === "compaction" || record.type === "branch_summary") {
      addUsage(group.usage, record.type, provider, model, dayKey(at), record.usage);
      group.firstAt = Math.min(group.firstAt, at); group.lastAt = Math.max(group.lastAt, at);
      continue;
    }
    if (record.type !== "message" || !record.message) continue;
    const role = record.message.role;
    const day = dayKey(at);
    const daily = group.daily.get(day) ?? { asks: 0, users: new Set<string>(), files: 0, images: 0 };
    if (role === "user") {
      // 指令不算提问：它没有进过模型，只是让机器人停一下或清个历史。
      if (record.message.command) continue;
      stats.asks++;
      daily.asks++;
      stats.days.add(day);
      group.days.add(day);
      const monthKey = day.slice(0, 7);
      const month = group.months.get(monthKey) ?? { asks: 0, users: new Set<string>() };
      month.asks++;
      month.users.add(user);
      group.months.set(monthKey, month);
    } else if (role === "assistant") {
      stats.replies++;
      addUsage(group.usage, "assistant", provider, model, day, record.message.usage);
      if (Array.isArray(record.message.content)) {
        for (const part of record.message.content) {
          if (!part || typeof part !== "object") continue;
          const { type, name } = part as { type?: string; name?: string };
          if (type !== "toolCall" || !name) continue;
          group.tools.set(name, (group.tools.get(name) ?? 0) + 1);

        }
      }
    } else if (role === "toolResult") {
      const message = record.message;
      if (!message.isError && message.details?.fileId && ["send_file", "send_image"].includes(message.toolName ?? "")) {
        const name = message.toolName!;
        group.delivered.set(name, (group.delivered.get(name) ?? 0) + 1);
        if (name === "send_file") stats.files++;
        if (name === "send_file") daily.files++;
        else daily.images++;
      }
    } else {
      continue;
    }
    if (role === "user" || role === "assistant") daily.users.add(user);
    group.daily.set(day, daily);
    stats.firstAt = Math.min(stats.firstAt, at);
    stats.lastAt = Math.max(stats.lastAt, at);
  }

  if (stats.asks === 0 && stats.replies === 0) return null;
  return stats;
}

export async function collectGroup(
  group: string,
  root: string = GROUP_DATA_ROOT,
  window: Window = {}
): Promise<GroupStats> {
  const stats = emptyGroup(group);
  const usersDir = join(root, group, "users");
  await assertDataDirectory(join(root, group), root);
  const users = (await dataDirectoryNames(usersDir, root)).sort(byName);
  const sources = await mapConcurrent(users, user =>
    readSessionStats(join(usersDir, user, HISTORY_FILE)).catch(() => null));
  // Read concurrently, then fold in directory order so maps and floating-point
  // usage totals cannot depend on which file finished reading first.
  for (const [index, source] of sources.entries()) {
    if (!source) continue;
    const entry = readUser(source, users[index]!, stats, window);
    if (!entry) continue;
    stats.users.push(entry);
    stats.asks += entry.asks;
    stats.replies += entry.replies;
    stats.firstAt = Math.min(stats.firstAt, entry.firstAt);
    stats.lastAt = Math.max(stats.lastAt, entry.lastAt);
  }
  stats.users.sort((a, b) => b.asks - a.asks || b.lastAt - a.lastAt || byName(a.user, b.user));
  return stats;
}

export async function collectAll(
  root: string = GROUP_DATA_ROOT,
  window: Window = {}
): Promise<GroupStats[]> {
  const groups: GroupStats[] = [];
  for (const group of await dataDirectoryNames(root, root)) {
    const stats = await collectGroup(group, root, window);
    if (stats.users.length > 0 || stats.usage.total.requests > 0) groups.push(stats);
  }
  return groups.sort((a, b) => b.asks - a.asks || byName(a.group, b.group));
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
    "数据来自保留的 session.jsonl；归档历史未计入。附件数只计有 fileId 的成功工具结果，链接生成不等于送达。"
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
    console.log(`  跳过 ${stats.skipped} 行无法解析的记录（机器人正在写入时读到半行属正常）。`);
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

  const group = await resolveGroupName(groupId, root, selection);
  if (!group) {
    console.error(`在 ${root} 下找不到群 ${groupId}。不带参数运行可以列出现有的群。`);
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
  for (const [kind, usage] of Object.entries(stats.usage.kinds)) console.log(kind + ": " + JSON.stringify(usage));
  for (const [model, usage] of stats.usage.models) console.log("模型 " + model + ": " + JSON.stringify(usage));
  for (const [day, usage] of stats.usage.days) console.log("日期 " + day + ": " + JSON.stringify(usage));
  return 0;
}

// 直接运行时才执行；测试要 import 这些函数，不能顺带把整个 CLI 跑起来。
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
