// 使用统计：从 <群数据总根>/<群>/users/<用户>/session.jsonl 里数出「谁用过、用了多少」。
//
// 用途是写汇报材料，所以口径必须说得清、经得起问：
//   - 「提问」= 一条真正发给模型的用户消息。斜杠指令不进会话（handleCommand 直接回执），
//     历史里偶尔留有的几条是早期版本的残留，这里按同一套 commands.ts 规则再筛一次。
//   - 干活途中插话的干预（steer）也会落成用户消息，同样计入：对提问的人来说那就是又问
//     了一次，把它排除反而不符合直觉。
//   - 统计只读文件，不需要停机；正在写入的最后一行可能是半条 JSON，跳过并在结尾报数。
//
// 唯一要当心的是数据来源：统计建立在 session.jsonl 之上，而 /clear 和 history-clear 会
// 把它删掉。清过的那部分永远找不回来，输出里因此固定带一句说明。
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isSlashCommandMessage } from "../../src/agent/commands.ts";
import { groupSegment, isPathInside } from "../../src/agent/paths.ts";
import { GROUP_DATA_ROOT } from "../../src/core/config.ts";

const HISTORY_FILE = "session.jsonl";

interface UserStats {
  user: string;
  asks: number;
  replies: number;
  files: number;
  firstAt: number;
  lastAt: number;
  days: Set<string>;
}

interface GroupStats {
  group: string;
  users: UserStats[];
  asks: number;
  replies: number;
  tools: Map<string, number>;
  tokens: { input: number; output: number; cacheRead: number };
  months: Map<string, { asks: number; users: Set<string> }>;
  days: Set<string>;
  firstAt: number;
  lastAt: number;
  skipped: number;
}

interface Window {
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
function parseDate(raw: string, endOfDay: boolean): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new Error(`日期格式应为 YYYY-MM-DD，收到「${raw}」`);
  const [, year, month, day] = match;
  const at = endOfDay
    ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
    : new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(at.getTime())) throw new Error(`无效日期：${raw}`);
  return at.getTime();
}

async function readDirNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function emptyGroup(group: string): GroupStats {
  return {
    group,
    users: [],
    asks: 0,
    replies: 0,
    tools: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0 },
    months: new Map(),
    days: new Set(),
    firstAt: Number.POSITIVE_INFINITY,
    lastAt: Number.NEGATIVE_INFINITY,
    skipped: 0,
  };
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") return text;
    }
  }
  return "";
}

async function readUser(
  path: string,
  user: string,
  group: GroupStats,
  window: Window
): Promise<UserStats | null> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return null;
  }

  const stats: UserStats = {
    user,
    asks: 0,
    replies: 0,
    files: 0,
    firstAt: Number.POSITIVE_INFINITY,
    lastAt: Number.NEGATIVE_INFINITY,
    days: new Set(),
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; content?: unknown; usage?: Record<string, unknown> };
    };
    try {
      record = JSON.parse(line);
    } catch {
      // 机器人正在追写时，最后一行可能只写了一半。跳过并计数，不让统计整体失败。
      group.skipped++;
      continue;
    }
    if (record.type !== "message" || !record.message) continue;

    const at = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    if (window.since !== undefined && at < window.since) continue;
    if (window.until !== undefined && at > window.until) continue;

    const role = record.message.role;
    if (role === "user") {
      // 指令不算提问：它没有进过模型，只是让机器人停一下或清个历史。
      if (isSlashCommandMessage(firstText(record.message.content))) continue;
      stats.asks++;
      const day = dayKey(at);
      stats.days.add(day);
      group.days.add(day);
      const monthKey = day.slice(0, 7);
      const month = group.months.get(monthKey) ?? { asks: 0, users: new Set<string>() };
      month.asks++;
      month.users.add(user);
      group.months.set(monthKey, month);
    } else if (role === "assistant") {
      stats.replies++;
      const usage = record.message.usage;
      if (usage) {
        group.tokens.input += Number(usage.input) || 0;
        group.tokens.output += Number(usage.output) || 0;
        group.tokens.cacheRead += Number(usage.cacheRead) || 0;
      }
      if (Array.isArray(record.message.content)) {
        for (const part of record.message.content) {
          if (!part || typeof part !== "object") continue;
          const { type, name } = part as { type?: string; name?: string };
          if (type !== "toolCall" || !name) continue;
          group.tools.set(name, (group.tools.get(name) ?? 0) + 1);
          if (name === "send_file") stats.files++;
        }
      }
    } else {
      continue;
    }
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
  for (const user of await readDirNames(usersDir)) {
    const entry = await readUser(join(usersDir, user, HISTORY_FILE), user, stats, window);
    if (!entry) continue;
    stats.users.push(entry);
    stats.asks += entry.asks;
    stats.replies += entry.replies;
    stats.firstAt = Math.min(stats.firstAt, entry.firstAt);
    stats.lastAt = Math.max(stats.lastAt, entry.lastAt);
  }
  stats.users.sort((a, b) => b.asks - a.asks || b.lastAt - a.lastAt);
  return stats;
}

export async function collectAll(
  root: string = GROUP_DATA_ROOT,
  window: Window = {}
): Promise<GroupStats[]> {
  const groups: GroupStats[] = [];
  for (const group of await readDirNames(root)) {
    const stats = await collectGroup(group, root, window);
    if (stats.users.length > 0) groups.push(stats);
  }
  return groups.sort((a, b) => b.asks - a.asks);
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
    "数据来自各成员的 session.jsonl，被 /clear 或 history-clear 清空过的部分无法计入。"
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

  const sentFiles = stats.tools.get("send_file") ?? 0;
  const sentImages = stats.tools.get("send_image") ?? 0;
  console.log(`  发送资料    ${sentFiles} 份文件` + (sentImages > 0 ? `、${sentImages} 张图片` : ""));

  const toolTotal = [...stats.tools.values()].reduce((sum, n) => sum + n, 0);
  const topTools = [...stats.tools]
    .sort((a, b) => b[1] - a[1])
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
          `${String(user.asks).padStart(4)} 次提问  ${String(user.files).padStart(3)} 份资料  ` +
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

/**
 * 群号 → 目录。与 history-admin 同一套规则：外部群号不适合做目录名时会落成 sha256
 * 摘要，所以先按规则换算；换算不出来再把参数当目录名本身试一次，方便直接从概览里复制。
 * 后一条路径必须重新校验边界，否则 `..` 这类输入会走出群数据根。
 */
function resolveGroupName(groupId: string, root: string): string | null {
  const segment = groupSegment(groupId);
  if (existsSync(join(root, segment))) return segment;
  const raw = join(root, groupId);
  if (existsSync(raw) && isPathInside(resolve(raw), resolve(root))) return groupId;
  return null;
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
    const files = group.tools.get("send_file") ?? 0;
    console.log(
      `  ${group.group}    ${String(group.users.length).padStart(3)} 人  ` +
        `${String(group.asks).padStart(4)} 次提问  ${String(files).padStart(3)} 份资料  ` +
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

  const group = resolveGroupName(groupId, root);
  if (!group) {
    console.error(`在 ${root} 下找不到群 ${groupId}。不带参数运行可以列出现有的群。`);
    return 1;
  }
  const stats = await collectGroup(group, root, window);
  if (stats.users.length === 0) {
    console.log(`群 ${group} 在该区间内没有使用记录 ${describeWindow(window)}。`);
    return 0;
  }
  printGroup(stats, window);
  return 0;
}

// 直接运行时才执行；测试要 import 这些函数，不能顺带把整个 CLI 跑起来。
if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
