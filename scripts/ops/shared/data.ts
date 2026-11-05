import { matchesInstance } from "../../../src/core/health.ts";
// 控制台读取的宿主机状态：服务探测、临时目录、配置摘要和日志尾部，直接读取宿主机文件。
// 体检复用 ops 的 JSON 接口，由控制台的读取路由调用。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { directoryStatus, readScopePaths } from "../directory-admin.ts";
import { healthProgram, type ProgramVersion } from "../version-info.ts";
import { scanTmp, type UserTmp } from "../../lib/tmp-scan.ts";
import { LOG_FILE, PROJECT_DIR } from "./platform.ts";
import { readRuntimeSettings } from "../../config/runtime-draft.ts";
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
  /** 修复建议；控制台调用时指向控制台页面或命令行。 */
  fix: string;
}

/** `ops doctor --json` 的结果；控制台的读取路由逐项校验后再展示。 */
export interface Health {
  pass: number;
  warn: number;
  fail: number;
  checks: HealthCheck[];
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
  /** 保存的范围和生效范围里各部门的路径（readScopePaths）；两者都不是选定部门时不读。 */
  scopePaths?: Record<string, string>;
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
    const directory = directoryStatus(extra.directory);
    const chosen = directory && [directory.scope, directory.effective?.scope].some(scope => scope?.kind === "departments");
    const scopePaths = chosen ? await readScopePaths(port, instanceFile) : undefined;

    return {
      state: body.status === "stopping" ? "stopping" : body.verificationOnly ? "verifying" : "ready",
      pid: body.pid,
      latency: Date.now() - started,
      startedAt,
      ...(isRecord(extra.stream) ? { stream: extra.stream as unknown as StreamStatus } : {}),
      ...(directory ? { directory } : {}),
      ...(scopePaths ? { scopePaths } : {}),
      ...(isRecord(extra.attention) ? { attention: extra.attention as unknown as AttentionStatus } : {}),
      ...(healthProgram(body) ? { program: healthProgram(body) } : {}),
    };
  } catch {
    return { state: "unreachable" };
  }
}

// ===== 临时目录 =====

export type { UserTmp };

/** root 是数据目录：临时目录在 tmp/ 下。 */
export async function loadTmp(root: string): Promise<UserTmp[]> {
  return scanTmp(root);
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
