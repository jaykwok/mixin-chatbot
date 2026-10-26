import { matchesInstance } from "../../../src/core/health.ts";
// 统计、会话和临时目录直接读取宿主机文件，无需 npm 依赖。
// 健康诊断复用 ops 的 JSON 接口，容器和服务维护转交对应平台脚本。

import { readdir, lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { collectAll, type GroupStats, type Window } from "../stats-admin.ts";
import { lastActivity, scanHistory, spaceName, type SpaceHistory } from "../../lib/history-scan.ts";
import { healthProgram, type ProgramVersion } from "../version-info.ts";
import { scanTmp, type UserTmp } from "../../lib/tmp-scan.ts";
import { capture, parseJson, type RunResult } from "./exec.ts";
import { LOG_FILE, PROJECT_DIR, opsCommand, type Deployment } from "./platform.ts";
import { day } from "./render/format.ts";
import { readRuntimeSettings } from "../../config/runtime-settings.ts";
import { validateRelayConfig } from "../../../src/integrations/relay-s3.ts";
import { readAuxiliaryConfig } from "../../../src/core/auxiliary-config.ts";
import { readMcpConfig } from "../../../src/core/mcp-config.ts";
import { parseAppBotConfig } from "../../../src/integrations/open-platform/config.ts";
import type { StreamStatus } from "../../../src/integrations/open-platform/stream.ts";
import type { DirectoryStatus } from "../../../src/integrations/open-platform/identity-directory.ts";
import type { AttentionStatus } from "../../../src/durable/attention.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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
 * 超时给到 90 秒：模型校验要起一次性容器，外链检查要连对象存储，叠起来很容易超过默认值，
 * 而超时被当成「体检失败」比真失败更难排查。
 */
export async function loadHealth(deployment: Deployment, signal?: AbortSignal): Promise<Health> {
  const { command, args, env } = opsCommand(deployment.platform, ["doctor", "--json"]);
  const result = await capture(command, args, { timeout: 90_000, signal, env });
  if (result.timedOut) throw new Error("体检超时（90 秒）；外链后端或 Docker 可能无响应");
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
  /** 事件 Stream 与通讯录同步状态，取自同一次 /health；验证实例没有 Stream。 */
  stream?: StreamStatus;
  directory?: DirectoryStatus;
  /** 自服务本次启动以来需要留意的事件（停住或出错的任务、超时放弃的交付等），取自同一次 /health。 */
  attention?: AttentionStatus;
  /** 运行中程序的版本与构建，取自同一次 /health（appVersion、build）。 */
  program?: ProgramVersion;
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
    const extra = body as unknown as Record<string, unknown>;

    return {
      state: body.status === "stopping" ? "stopping" : body.verificationOnly ? "verifying" : "ready",
      pid: body.pid,
      latency: Date.now() - started,
      startedAt,
      ...(isRecord(extra.stream) ? { stream: extra.stream as unknown as StreamStatus } : {}),
      ...(isRecord(extra.directory) ? { directory: extra.directory as unknown as DirectoryStatus } : {}),
      ...(isRecord(extra.attention) ? { attention: extra.attention as unknown as AttentionStatus } : {}),
      ...(healthProgram(body) ? { program: healthProgram(body) } : {}),
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
/** 第一次读到的 HEAD：界面代码在启动时加载，升级或回滚后运行中的界面仍是这个版本。 */
let startCommit: string | null = null;

/**
 * 自启动以来界面会加载的代码是否被升级、继续或回滚改动；只有退出后重新运行才会加载新代码。
 * 界面也引用 src 与其他脚本里的校验和读取逻辑，因此按代码与依赖清单判断，只改文档时不提示。
 */
export async function tuiCodeChanged(signal?: AbortSignal): Promise<boolean> {
  if (!startCommit) return false;
  const diff = await git(["diff", "--quiet", startCommit, "HEAD", "--", "scripts", "src", "package.json", "bun.lock"], signal);
  return diff.code === 1;
}

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

  if (/^[0-9a-f]{40,64}$/.test(sha)) startCommit ??= sha;
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

/** 每日一格的指标；成员按账本身份跨群去重，与今日口径一致。 */
export interface DailyPoint {
  day: string;
  asks: number;
  people: number;
  /** 当天入账的 token 合计（按同步日）。 */
  tokens: number;
}

export interface RecentStats {
  today: { asks: number; people: number; tokens: number; groups: number };
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
    byDay.set(day(date.getTime()), { day: day(date.getTime()), asks: 0, people: 0, tokens: 0 });
  }
  const today = { asks: 0, people: 0, tokens: 0, groups: 0 };
  const people = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const [date, daily] of group.daily) {
      const point = byDay.get(date);
      if (point) {
        point.asks += daily.asks;
        let users = people.get(date);
        if (!users) people.set(date, users = new Set());
        for (const user of daily.askers) users.add(user);
        point.people = users.size;
      }
      if (date === day(now)) {
        today.asks += daily.asks;
        today.people = people.get(date)?.size ?? 0;
        if (daily.askers.size > 0) today.groups++;
      }
    }
    for (const [date, tokens] of group.tokenDays) {
      const point = byDay.get(date);
      if (point) point.tokens += tokens.totalTokens;
      if (date === day(now)) today.tokens += tokens.totalTokens;
    }
  }
  return { today, trend: [...byDay.values()] };
}

// ===== 会话历史与临时目录 =====

export type { SpaceHistory, UserTmp };
export { lastActivity, spaceName };

/** root 是数据目录：会话库在 conversations/ 下，临时目录在 tmp/ 下。 */
export async function loadHistory(root: string): Promise<SpaceHistory[]> {
  return scanHistory(root);
}

export async function loadTmp(root: string): Promise<UserTmp[]> {
  return scanTmp(root);
}

// ===== 磁盘占用 =====

/** data/ 的总占用。给总览一个「这台机器被吃掉了多少」的数字。 */
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

/** 设置页展示的外链状态：只含可显示字段，凭据不离开配置文件。 */
export type RelaySummary = { enabled: false } | {
  enabled: true; endpoint: string; region: string; bucket: string; prefix: string; pathStyle: boolean;
  maxBytes: number; expireHours: number; cleanupGraceMinutes: number; sessionToken: boolean;
};

/** 设置页展示的应用机器人状态：只有平台环境，AppID 和 AppSecret 不离开配置文件。 */
export type AppBotSummary = { configured: false } | { configured: true; environment: "production" | "staging" };

export async function loadAppBotSummary(project = PROJECT_DIR, signal?: AbortSignal): Promise<AppBotSummary> {
  let raw: string;
  try {
    raw = await readFile(join(project, "data", "config", "app-bot.json"), { encoding: "utf8", signal });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { configured: false };
    if (code === "ABORT_ERR") throw error;
    throw new Error("app-bot.json 无法读取" + (code ? `（${code}）` : ""));
  }
  let doc: unknown;
  // 解析错误的原文可能带出配置片段（含密钥），只给固定说明。
  try { doc = JSON.parse(raw); } catch { throw new Error("app-bot.json 不是有效 JSON，请重新运行应用机器人配置"); }
  try { return { configured: true, environment: parseAppBotConfig(doc).environment }; }
  catch { throw new Error("app-bot.json 内容无效，请重新运行应用机器人配置"); }
}

export async function loadRelaySummary(project = PROJECT_DIR, signal?: AbortSignal): Promise<RelaySummary> {
  let raw: string;
  try {
    raw = await readFile(join(project, "data", "config", "relay.json"), { encoding: "utf8", signal });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { enabled: false };
    if (code === "ABORT_ERR") throw error;
    throw new Error("relay.json 无法读取" + (code ? `（${code}）` : ""));
  }
  let doc: unknown;
  // 解析错误的原文可能带出配置片段（含密钥），只给固定说明。
  try { doc = JSON.parse(raw); } catch { throw new Error("relay.json 不是有效 JSON，请重新运行外链配置"); }
  const config = validateRelayConfig(doc, "relay.json");
  return {
    enabled: true, endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: config.prefix,
    pathStyle: config.forcePathStyle, maxBytes: config.maxBytes, expireHours: config.expireHours,
    cleanupGraceMinutes: config.cleanupGraceMinutes, sessionToken: config.sessionToken !== undefined,
  };
}

/**
 * 设置页展示的当前模型：只读 Pi 设置里的选择，完整校验（目录、凭证）由体检和启动负责。
 * 推理级别与服务相同：先取该模型的单独设置，再取全局默认；超出模型能力时由服务启动时下调。
 */
export interface ModelSummary { provider: string; model: string; thinking: { level: string; source: "model" | "default" } | null }

export async function loadModelSummary(project = PROJECT_DIR, signal?: AbortSignal): Promise<ModelSummary | null> {
  let raw: string;
  try {
    raw = await readFile(join(project, "data", "runtime", "pi", "settings.json"), { encoding: "utf8", signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let doc: unknown;
  try { doc = JSON.parse(raw.replace(/^\uFEFF/, "")); } catch { throw new Error("data/runtime/pi/settings.json 不是有效 JSON"); }
  const value = doc && typeof doc === "object" && !Array.isArray(doc) ? doc as Record<string, unknown> : {};
  const text = (name: string) => typeof value[name] === "string" && (value[name] as string).trim() ? value[name] as string : null;
  const provider = text("defaultProvider"), model = text("defaultModel");
  if (!provider || !model) return null;
  const overrides = value.modelThinkingLevels && typeof value.modelThinkingLevels === "object" && !Array.isArray(value.modelThinkingLevels)
    ? value.modelThinkingLevels as Record<string, unknown> : {};
  const override = overrides[`${provider}/${model}`], fallback = text("defaultThinkingLevel");
  const thinking = typeof override === "string" && override.trim() ? { level: override, source: "model" as const }
    : fallback ? { level: fallback, source: "default" as const } : null;
  return { provider, model, thinking };
}

/** 辅助模型只读状态：引用的分类 / 识图模型与并发预算；文件格式错误原样报出。 */
export type AuxiliarySummary = { enabled: false } | {
  enabled: true; classifier: string | null; image: string | null; maxConcurrent: number; classifierRetries: number;
};

export async function loadAuxiliarySummary(project = PROJECT_DIR, signal?: AbortSignal): Promise<AuxiliarySummary> {
  signal?.throwIfAborted();
  const config = readAuxiliaryConfig(join(project, "data", "config", "auxiliary.json"));
  if (!config) return { enabled: false };
  const ref = (model: { provider: string; modelId: string } | undefined) => model ? `${model.provider}/${model.modelId}` : null;
  return { enabled: true, classifier: ref(config.classifier), image: ref(config.image), maxConcurrent: config.maxConcurrent, classifierRetries: config.classifierRetries };
}

/** MCP 只读状态：服务器名称、传输、工具白名单数量和是否需要 OAuth 登录；不显示命令参数、环境变量或 URL 凭据。 */
export interface McpServerSummary { name: string; transport: "stdio" | "http"; tools: number; oauth: boolean }

export async function loadMcpSummary(project = PROJECT_DIR, signal?: AbortSignal): Promise<McpServerSummary[] | null> {
  signal?.throwIfAborted();
  const config = readMcpConfig(join(project, "data", "config", "mcp.json"));
  return config ? config.servers.map(server => ({ name: server.name, transport: server.transport, tools: server.tools.length, oauth: server.oauth !== undefined })) : null;
}

export function loadRuntimeSettings(project = PROJECT_DIR, signal?: AbortSignal) {
  return readRuntimeSettings(join(project, "data", "config", "runtime.json"), signal);
}

function parseLogLine(text: string): LogLine {
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
