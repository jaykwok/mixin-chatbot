import { matchesInstance } from "../../../src/core/health.ts";
// 统计、会话和临时目录直接读取宿主机文件，无需 npm 依赖。
// 健康诊断复用 ops 的 JSON 接口，容器和服务维护转交对应平台脚本。

import { readdir, lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { collectAll, type GroupStats, type Window } from "../stats-admin.ts";
import { scanHistory, type GroupHistory } from "../../lib/history-scan.ts";
import { scanTmp, type UserTmp } from "../../lib/tmp-scan.ts";
import { capture, parseJson, type RunResult } from "./exec.ts";
import { LOG_FILE, PROJECT_DIR, opsCommand, type Deployment } from "./platform.ts";
import { day } from "./render/format.ts";
import { readRuntimeSettings } from "../../config/runtime-settings.ts";

// ===== 体检 =====

export interface HealthCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  /** 修复建议；通过 TUI 调用时使用对应平台的菜单路径。 */
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
export async function loadHealth(deployment: Deployment, signal?: AbortSignal): Promise<Health> {
  const { command, args, env } = opsCommand(deployment.platform, ["doctor", "--json"]);
  const result = await capture(command, args, { timeout: 90_000, signal, env });
  if (result.timedOut) throw new Error("体检超时（90 秒）；隧道或外链后端可能无响应");
  const health = parseJson<Health>(result, "体检");
  if (!health || !Array.isArray(health.checks) || !health.checks.every(check =>
    check && ["pass", "warn", "fail"].includes(check.status) && typeof check.name === "string" && typeof check.detail === "string"
  )) throw new Error("体检返回了不完整的检查结果；请在「监控 → 体检」按 r 重试");
  return health;
}

// ===== 服务本身 =====

export interface Service {
  /** unreachable 表示请求失败、响应无效或实例身份不匹配。 */
  state: "ready" | "verifying" | "stopping" | "unreachable";
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
      state: body.status === "stopping" ? "stopping" : body.verificationOnly ? "verifying" : "ready",
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

async function git(args: string[], signal?: AbortSignal, timeout = 15_000): Promise<RunResult> {
  // GIT_TERMINAL_PROMPT=0 让缺凭证时立刻失败，而不是挂在一个没人应答的提示上。
  const result = await capture("git", args, { env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C" }, timeout, signal });
  if (result.timedOut) throw new Error(`Git 查询超时（${timeout / 1000} 秒）：${result.stderr.trim() || args[0]}`);
  return result;
}

let gitRead: Promise<GitState | null> | null = null;

/**
 * 页眉、总览和维护页共享在途查询；下次刷新仍读取最新状态。
 * 不 fetch：页眉与总览只读本地；升级预览通过 loadUpgrade 联网检查。
 */
export function loadGit(): Promise<GitState | null> {
  return gitRead ??= readGit().finally(() => { gitRead = null; });
}

export interface UpgradeState {
  git: GitState;
  targetSha: string;
}

/** 升级预览先同步明确的远端分支，再独立读取，不能复用 fetch 前的在途快照。 */
export async function loadUpgrade(signal?: AbortSignal): Promise<UpgradeState | null> {
  if (!Bun.which("git")) return null;
  const fetched = await git(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], signal, 60_000);
  if (fetched.code !== 0) {
    if (/not a git repository/i.test(fetched.stderr)) return null;
    throw new Error(`远端检查失败：${fetched.stderr.trim() || `退出码 ${fetched.code}`}`);
  }
  signal?.throwIfAborted();
  const target = await git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], signal);
  const targetSha = target.stdout.trim();
  if (target.code !== 0 || !/^[0-9a-f]{40,64}$/.test(targetSha)) throw new Error("无法读取 origin/main 的目标提交，请重新检查远端");
  const state = await readGit(signal, targetSha);
  if (!state) return null;
  if (state.behind < 0) throw new Error("无法比较本地版本与远端提交，请重新检查远端");
  return { git: state, targetSha };
}

async function readGit(signal?: AbortSignal, target = "origin/main"): Promise<GitState | null> {
  if (!Bun.which("git")) return null;
  // 短查询顺序复用已有宿主；并发排队会触发第二个 Windows 宿主的昂贵冷启动。
  const head = await git(["log", "-1", "--format=%H%n%s"], signal);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], signal);
  const status = await git(["status", "--porcelain", "--untracked-files=no"], signal);
  const counts = await git(["rev-list", "--left-right", "--count", `HEAD...${target}`], signal);
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
    const log = await git(["log", "--pretty=%h %s", `HEAD..${target}`], signal);
    if (log.code !== 0) throw new Error(`Git 提交列表读取失败：${log.stderr.trim() || `退出码 ${log.code}`}`);
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
  level: "debug" | "info" | "warn" | "error" | "other";
}

export type TunnelLogging = "off" | "on";
export type TunnelProtocol = "auto" | "http2" | "quic";

export async function loadTunnelProtocol(project = PROJECT_DIR, signal?: AbortSignal): Promise<TunnelProtocol> {
  let value: string;
  try {
    value = (await readFile(join(project, "data", "config", "cloudflared-protocol"), { encoding: "utf8", signal })).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "auto";
    throw error;
  }
  if (value !== "auto" && value !== "http2" && value !== "quic") throw new Error("cloudflared-protocol 只接受 auto、http2 或 quic");
  return value;
}

export async function loadTunnelLogging(project = PROJECT_DIR, signal?: AbortSignal): Promise<TunnelLogging> {
  let value: string;
  try {
    value = (await readFile(join(project, "data", "config", "cloudflared-logging"), { encoding: "utf8", signal })).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "off";
    throw error;
  }
  if (value !== "off" && value !== "on") throw new Error("cloudflared-logging 只接受 off 或 on");
  return value;
}

export function loadRuntimeSettings(project = PROJECT_DIR, signal?: AbortSignal) {
  return readRuntimeSettings(join(project, "data", "config", "runtime.json"), signal);
}

function parseLogLine(text: string): LogLine {
  // Cloudflared's rolling files contain JSON with UTC timestamps. Display local time
  // alongside the bot's local timestamps, retaining cfRay and request/response fields.
  if (text.startsWith("{")) {
    try {
      const row = JSON.parse(text) as Record<string, unknown>;
      const level: LogLine["level"] = row.level === "debug" || row.level === "info" || row.level === "warn"
        ? row.level : ["error", "fatal", "panic"].includes(String(row.level)) ? "error" : "other";
      const date = new Date(String(row.time));
      const two = (n: number) => String(n).padStart(2, "0");
      const time = Number.isNaN(date.getTime()) ? String(row.time ?? "")
        : `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
      const fields = Object.entries(row).filter(([key]) => !["time", "level", "message"].includes(key))
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
      const message = `${time} - ${String(row.level ?? "other").toUpperCase()} - ${String(row.message ?? "")}${fields ? " " + fields : ""}`;
      // Parsing JSON must not reintroduce terminal escapes or forged multi-line records.
      return { level, text: message.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu,
        character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")) };
    } catch { /* Older text logs and partially written JSON remain readable. */ }
  }
  return {
    text,
    level: text.includes(" - ERROR - ") ? "error"
      : text.includes(" - WARNING - ") || text.includes(" - WARN - ") ? "warn"
        : text.includes(" - INFO - ") ? "info" : "other",
  };
}

/**
 * 读日志尾部。
 *
 * 只读文件末尾那一段，不把整份日志读进内存；每次按路径重开，轮转后自动跟到新文件。
 */
export async function loadLogTail(lines: number, bytes = 256 * 1024, path = LOG_FILE): Promise<LogLine[]> {
  const file = Bun.file(path);
  const size = file.size;
  if (!size) return [];
  const slice = await file.slice(Math.max(0, size - bytes)).text();
  const rows = slice.split(/\r?\n/).filter((line) => line.trim().length > 0);
  // 第一行多半是从中间截断的，丢掉，避免显示半句话。
  if (size > bytes && rows.length > 1) rows.shift();
  return rows.slice(-lines).map(parseLogLine);
}
