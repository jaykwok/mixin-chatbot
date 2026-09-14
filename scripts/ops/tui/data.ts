import { matchesInstance } from "../../../src/core/health.ts";
// 统计、会话和临时目录直接读取宿主机文件，无需 npm 依赖。
// 健康诊断复用 ops 的 JSON 接口，容器和服务维护转交对应平台脚本。

import { readdir, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { collectAll, type GroupStats, type Window } from "../stats-admin.ts";
import { scanHistory, type GroupHistory } from "../../lib/history-scan.ts";
import { scanTmp, type UserTmp } from "../../lib/tmp-scan.ts";
import { capture, parseJson, type RunResult } from "./exec.ts";
import { LOG_FILE, PROJECT_DIR, opsCommand, type Deployment } from "./platform.ts";
import { day } from "./render/format.ts";

// ===== 体检 =====

export interface HealthCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  /** 修复建议；Windows 侧的体检会给，Linux 侧目前为空。 */
  fix: string;
}

export interface Health {
  pass: number;
  warn: number;
  fail: number;
  checks: HealthCheck[];
}

/**
 * 跑一次体检。
 *
 * 超时给到 90 秒：隧道模式下这一步要打公网、探 WebDAV，几次 curl 叠起来很容易超过默认值，
 * 而超时被当成「体检失败」比真失败更难排查。
 */
export async function loadHealth(deployment: Deployment): Promise<Health> {
  const { command, args } = opsCommand(deployment.platform, ["doctor", "--json"]);
  const result = await capture(command, args, { timeout: 90_000 });
  if (result.timedOut) throw new Error("体检超时（90 秒）；隧道或外链后端可能无响应");
  const health = parseJson<Health>(result, "doctor --json");
  if (!health || !Array.isArray(health.checks) || !health.checks.every(check =>
    check && ["pass", "warn", "fail"].includes(check.status) && typeof check.name === "string" && typeof check.detail === "string"
  )) throw new Error("doctor 返回了不完整的检查结果");
  return health;
}

// ===== 服务本身 =====

export interface Service {
  /** unreachable 表示请求失败、响应无效或实例身份不匹配。 */
  state: "ready" | "stopping" | "unreachable";
  pid?: number;
  /** 往返毫秒；unreachable 时为空。 */
  latency?: number;
  /** 从通过完整身份校验的实例记录取得的启动时刻。 */
  startedAt?: number;
}

export async function probeService(port: number, instanceFile = join(PROJECT_DIR, "data", "state", "instance.json")): Promise<Service> {
  const started = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const body: unknown = await response.json();
    const instance = await Bun.file(instanceFile).json();
    if (!matchesInstance(body, instance, port) || (!response.ok && body.status !== "stopping")) return { state: "unreachable" };
    const startedAt = instance.startedAt;

    return {
      state: body.status === "stopping" ? "stopping" : "ready",
      pid: body.pid,
      latency: Date.now() - started,
      startedAt,
    };
  } catch {
    return { state: "unreachable" };
  }
}

// ===== 代码版本 =====

export interface GitState {
  branch: string;
  sha: string;
  subject: string;
  /** 已跟踪文件有未提交改动；有的话升级会被拒绝。 */
  dirty: boolean;
  /** 落后 origin/main 多少个提交。-1 表示没有可比较的 origin/main。 */
  behind: number;
  ahead: number;
  /** 待应用的提交，新的在前。 */
  incoming: { sha: string; subject: string }[];
}

async function git(args: string[]): Promise<RunResult> {
  // GIT_TERMINAL_PROMPT=0 让缺凭证时立刻失败，而不是挂在一个没人应答的提示上。
  const result = await capture("git", args, { env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, timeout: 15_000 });
  if (result.timedOut) throw new Error(`Git 查询超时（15 秒）：${result.stderr.trim() || args[0]}`);
  return result;
}

let gitRead: Promise<GitState | null> | null = null;

/**
 * 页眉、总览和维护页共享在途查询；下次刷新仍读取最新状态。
 * 不 fetch：落后提交数相对上次 fetch，真正升级时由 update 流程联网。
 */
export function loadGit(): Promise<GitState | null> {
  return gitRead ??= readGit().finally(() => { gitRead = null; });
}

async function readGit(): Promise<GitState | null> {
  if (!Bun.which("git")) return null;
  // 短查询顺序复用已有宿主；并发排队会触发第二个 Windows 宿主的昂贵冷启动。
  const head = await git(["log", "-1", "--format=%H%n%s"]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await git(["status", "--porcelain", "--untracked-files=no"]);
  const counts = await git(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
  const failed = [head, branch, status].find(result => result.code !== 0);
  if (failed) {
    if (/not a git repository|does not have any commits yet/i.test(failed.stderr)) return null;
    throw new Error(`Git 查询失败：${failed.stderr.trim() || `退出码 ${failed.code}`}`);
  }
  const [sha = "", subject = ""] = head.stdout.trim().split(/\r?\n/);

  let ahead = 0;
  let behind = -1;
  if (counts.code === 0) {
    const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
    ahead = left ?? 0;
    behind = right ?? 0;
  }

  const incoming: GitState["incoming"] = [];
  if (behind > 0) {
    const log = await git(["log", "--pretty=%h %s", "HEAD..origin/main"]);
    for (const line of log.stdout.split("\n")) {
      const match = /^(\S+)\s+(.*)$/.exec(line.trim());
      if (match) incoming.push({ sha: match[1]!, subject: match[2]! });
    }
  }

  return {
    branch: branch.stdout.trim(),
    sha,
    subject,
    dirty: status.stdout.trim().length > 0,
    behind,
    ahead,
    incoming,
  };
}

// ===== 统计 =====

export type { GroupStats, Window };

export async function loadStatsOverview(root: string, window: Window = {}): Promise<GroupStats[]> {
  return collectAll(root, window);
}

/** 每日一格的指标；成员按「人次」计，同一个人在两个群里活跃算两次，与今日口径一致。 */
export interface DailyPoint {
  day: string;
  asks: number;
  people: number;
  files: number;
}

export interface RecentStats {
  today: { asks: number; people: number; files: number; images: number; groups: number };
  /** 从最早到今天，长度恒等于请求的天数；没有记录的那天补 0，趋势线不会因为缺天而变短。 */
  trend: DailyPoint[];
}

/**
 * 一次历史扫描同时得到今日指标和每日趋势，数字直接来自消息发生的自然日。
 *
 * 三个指标都按天留档而不是只留提问数：总览上的指标块要显示环比和趋势线，那需要昨天的值，
 * 只攒一个当日总数的话，界面就只能摆四个孤零零的数字，看不出是在涨还是在跌。
 */
export async function loadRecentStats(root: string, days: number, now = Date.now()): Promise<RecentStats> {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const groups = await collectAll(root, { since: since.getTime(), until: now });
  const byDay = new Map<string, DailyPoint>();
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(since);
    date.setDate(date.getDate() + offset);
    byDay.set(day(date.getTime()), { day: day(date.getTime()), asks: 0, people: 0, files: 0 });
  }
  const today = { asks: 0, people: 0, files: 0, images: 0, groups: 0 };
  for (const group of groups) {
    for (const [date, daily] of group.daily) {
      const point = byDay.get(date);
      if (point) {
        point.asks += daily.asks;
        point.people += daily.users.size;
        point.files += daily.files;
      }
      if (date === day(now)) {
        today.asks += daily.asks;
        today.people += daily.users.size;
        today.files += daily.files;
        today.images += daily.images;
        if (daily.users.size > 0 || daily.files > 0 || daily.images > 0) today.groups++;
      }
    }
  }
  return { today, trend: [...byDay.values()] };
}

// ===== 会话历史与临时目录 =====

export type { GroupHistory, UserTmp };

export async function loadHistory(root: string): Promise<GroupHistory[]> {
  return scanHistory(root);
}

export async function loadTmp(root: string): Promise<UserTmp[]> {
  return scanTmp(root);
}

// ===== 磁盘占用 =====

/** data/ 与群数据根的总占用。给总览一个「这台机器被吃掉了多少」的数字。 */
export async function loadDiskUsage(paths: string[]): Promise<number> {
  let total = 0;
  const seen = new Set<string>();
  const queue = paths.map(path => resolve(path));
  const walk = async (path: string): Promise<void> => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    let info;
    try {
      info = await lstat(path);
    } catch {
      return;
    }
    if (!info.isDirectory()) {
      total += info.size;
      return;
    }
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      return;
    }
    for (const name of names) queue.push(join(path, name));
  };
  // 有限并发，避免每个文件串行等待，也不一次创建成千上万个文件系统请求。
  while (queue.length) await Promise.all(queue.splice(-16).map(walk));
  return total;
}

// ===== 日志 =====

export interface LogLine {
  text: string;
  level: "info" | "warn" | "error" | "other";
}

/**
 * 读日志尾部。
 *
 * 只读文件末尾那一段，不整文件读进内存：日志上限 5MB，轮转前读全量既慢又没必要。
 */
export async function loadLogTail(lines: number, bytes = 256 * 1024): Promise<LogLine[]> {
  const file = Bun.file(LOG_FILE);
  const size = file.size;
  if (!size) return [];
  const slice = await file.slice(Math.max(0, size - bytes)).text();
  const rows = slice.split(/\r?\n/).filter((line) => line.trim().length > 0);
  // 第一行多半是从中间截断的，丢掉，避免显示半句话。
  if (size > bytes && rows.length > 1) rows.shift();
  return rows.slice(-lines).map((text) => ({
    text,
    level: text.includes(" - ERROR - ")
      ? "error"
      : text.includes(" - WARNING - ") || text.includes(" - WARN - ")
        ? "warn"
        : text.includes(" - INFO - ")
          ? "info"
          : "other",
  }));
}
