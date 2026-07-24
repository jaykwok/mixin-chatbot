// Pi agent 集成：用 pi-coding-agent 的 AgentSession + SessionManager 内嵌大脑。
// 纯适配——只用 Pi 公开 API：
//   - provider/model/key 由 data/models.json 承载，Pi 原生读取（ModelRuntime.create({modelsPath})）
//   - 内置工具 read/bash/edit/write 由 createAgentSession 自动构建（按 tools 名启用），
//     每个用户绑定到 <AGENT_CWD>/<phone>/tmp
//   - 发送工具 send_image/send_file 经 customTools（ToolDefinition）注册，定义在 ./tools.ts
//   - system prompt 用 Pi 默认 + appendSystemPromptOverride 追加最小群聊/中文上下文（方便上游升级）
// 会话持久化到 <AGENT_CWD>/<phone>/sessions/<group>.jsonl。
//
// 中途干预（Pi 官方 API）：
//   - agent 正忙时，普通消息 → session.steer()（等当前这批工具调用完、下次调 LLM 前注入，软干预）
//   - /stop → session.abort()（硬中断，经 AbortSignal 连带取消在跑的工具）
//   - /status /cancel /reset /help → 队列查询/清空、清会话、帮助
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_CWD,
  AGENT_HEARTBEAT_INTERVAL,
  MODELS_JSON_PATH,
  SESSION_IDLE_TTL,
} from "../lib/config.ts";
import { log } from "../lib/log.ts";
import { getOutboundRateStatus, sendReplyWithMention, sendText } from "../im/im.ts";
import { buildSendTools } from "./tools.ts";

// ModelRuntime 单例 + 解析出的单模型。从 data/models.json 加载（Pi 原生）。
let modelRuntime: ModelRuntime | null = null;
let resolvedModel: Model<Api> | null = null;
let runtimePromise: Promise<{ runtime: ModelRuntime; model: Model<Api> }> | null = null;

async function getRuntime(): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  if (modelRuntime && resolvedModel) {
    return { runtime: modelRuntime, model: resolvedModel };
  }
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    // 显式读 models.json 拿声明的 provider/model id（getProviders() 会混入内置 provider）。
    let providerId: string | undefined;
    let modelId: string | undefined;
    try {
      const raw = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8")) as {
        providers?: Record<string, { models?: { id?: string }[] }>;
      };
      providerId = Object.keys(raw.providers ?? {})[0];
      modelId = raw.providers?.[providerId]?.models?.[0]?.id;
    } catch {
      throw new Error(
        `无法读取 ${MODELS_JSON_PATH}。请先生成 AI 配置：运行 scripts/configure.ts（部署脚本会自动调；或手动 bun run scripts/configure.ts）`
      );
    }
    if (!providerId || !modelId) {
      throw new Error(`${MODELS_JSON_PATH} 未声明 provider/model，请重新运行 configure 工具。`);
    }

    const runtime = await ModelRuntime.create({ modelsPath: MODELS_JSON_PATH });
    const model = runtime.getModel(providerId, modelId);
    if (!model) {
      throw new Error(`${MODELS_JSON_PATH} 中未找到 ${providerId}/${modelId}，请检查配置。`);
    }
    modelRuntime = runtime;
    resolvedModel = model;
    log.info(`Pi ModelRuntime 就绪（provider=${providerId}, model=${modelId}, 用户目录总根=${AGENT_CWD}）`);
    return { runtime, model };
  })();

  try {
    return await runtimePromise;
  } catch (e) {
    runtimePromise = null;
    throw e;
  }
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

// 每 (phone, 群) 一个 AgentSession（内存缓存）。
const sessions = new Map<string, AgentSession>();
// 避免同一用户/群的并发首条消息重复创建两个 session 并同时写一个 jsonl。
const sessionCreations = new Map<string, Promise<AgentSession>>();
// dispose 期间阻止同一会话立刻重开并与旧实例同时操作同一个 jsonl。
const sessionDisposals = new Map<string, Promise<void>>();
const sessionLastUsed = new Map<string, number>();
// 平台可能轮换 callback key；发送工具在每次执行时读取当前会话最新 URL。
const sessionCallbackUrls = new Map<string, string>();
// 正在跑 prompt 的 session（中途来的消息走 steer；同一 session 同时只允许一个 prompt）。
const busySessions = new WeakSet<AgentSession>();
// 被指令（/stop /reset）主动中断的 session——其 in-flight prompt 不再发回复/错误（指令已自己回执）。
const abortingSessions = new WeakSet<AgentSession>();
// 每个session最近一次工具调用摘要，供 /status 展示。
const lastTool = new WeakMap<AgentSession, string>();

/** 追加到 Pi 默认 system prompt 的最小上下文（群聊 + 中文）。刻意最小化，方便 Pi 上游升级。 */
const CHAT_CONTEXT = `## 运行环境
你在「量子密信」群聊机器人里。用户用中文 @你 提问，请用中文、用 Markdown 简洁回复。纯文字回复会自动发到群里。
当前工作目录是该用户独立的 tmp 目录。所有工作文件和临时文件都保存在当前工作目录内，不要写入上级目录或系统临时目录。
干活途中用户可能插话干预（ steer ），请把后续用户消息当作对当前任务的补充/纠正，及时调整。`;

const HELP_TEXT = `可用指令（在群里直接发送，必须以 / 开头）：
/help   查看本帮助
/stop   强制停止当前任务（硬中断）
/status 查看状态（忙/闲、待消化的干预、最近工具）
/cancel 撤销尚未被消化的干预消息
/reset  清空本群会话历史，重新开始

提示：agent 干活途中发普通消息 = 插入干预（下一步纳入）；发 /stop = 立即硬停。`;

function sessionKey(phone: string, groupId: string): string {
  return `${phone}:${groupId}`;
}

/** 把 groupId 解析为安全的会话文件名片段；不安全时使用完整 sha256。 */
function safeGroupSegment(groupId: string): string {
  return /^[A-Za-z0-9_+\-]{1,64}$/.test(groupId)
    ? groupId
    : createHash("sha256").update(groupId, "utf8").digest("hex");
}

/** 每个用户(phone)的 agent 工作目录：<AGENT_CWD>/<phone>/tmp/（read/write/edit/bash 在此，按人隔离）。 */
function userWorkspaceDir(phone: string): string {
  return join(AGENT_CWD, phone, "tmp");
}

/** 每个用户每群的会话文件：<AGENT_CWD>/<phone>/sessions/<group段>.jsonl。 */
function sessionFilePath(phone: string, groupId: string): string {
  return join(AGENT_CWD, phone, "sessions", `${safeGroupSegment(groupId)}.jsonl`);
}

async function disposeSession(key: string, session: AgentSession): Promise<void> {
  const existing = sessionDisposals.get(key);
  if (existing) return existing;
  const disposal = (async () => {
    try {
      await session.dispose();
    } catch (e) {
      log.error(`session dispose 失败 - 会话: ${key}, 错误: ${String(e)}`);
    }
  })();
  sessionDisposals.set(key, disposal);
  try {
    await disposal;
  } finally {
    if (sessionDisposals.get(key) === disposal) sessionDisposals.delete(key);
  }
}

/** 释放长期空闲的内存 session；jsonl 历史保留，下次消息会自动重开。 */
export async function cleanupIdleSessions(now = Date.now()): Promise<void> {
  for (const [key, session] of sessions) {
    const lastUsed = sessionLastUsed.get(key) ?? now;
    if (busySessions.has(session) || now - lastUsed < SESSION_IDLE_TTL) continue;
    sessions.delete(key);
    sessionLastUsed.delete(key);
    sessionCallbackUrls.delete(key);
    lastTool.delete(session);
    await disposeSession(key, session);
    log.info(`已释放空闲会话缓存 - 会话: ${key}`);
  }
}

async function createSession(
  phone: string,
  groupId: string,
  callbackUrl: string
): Promise<AgentSession> {
  const key = sessionKey(phone, groupId);
  const { runtime, model } = await getRuntime();
  // 按人隔离：工作目录 <AGENT_CWD>/<phone>/tmp/，会话 <AGENT_CWD>/<phone>/sessions/<group>.jsonl
  const cwd = userWorkspaceDir(phone);
  await mkdir(cwd, { recursive: true });
  await mkdir(join(AGENT_CWD, phone, "sessions"), { recursive: true });
  const historyPath = sessionFilePath(phone, groupId);
  const sessionManager = SessionManager.open(historyPath);
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd, // 按人隔离的 agent 工作目录（<phone>/tmp/）
    agentDir: join(process.cwd(), ".pi"), // 共享 Pi 内部缓存，避免落入用户 tmp/
    settingsManager,
    noExtensions: true, // 不加载发现的 .pi 扩展（不影响 createAgentSession 自建的内置工具）
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPromptOverride: (base) => [...base, CHAT_CONTEXT], // 保留 Pi 默认 prompt + 追加最小群聊上下文
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd, // 内置工具（read/bash/edit/write）绑定到当前用户的 <phone>/tmp/
    model,
    modelRuntime: runtime,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: ["read", "bash", "edit", "write", "send_image", "send_file"], // 启用内置 + 发送工具
    customTools: buildSendTools(
      () => sessionCallbackUrls.get(key) ?? callbackUrl,
      cwd
    ),
    thinkingLevel: "off",
  });
  sessions.set(key, session);
  sessionLastUsed.set(key, Date.now());
  log.info(`新建会话 - 用户: ${phone}, 群: ${groupId}`);
  return session;
}

async function getOrCreateSession(
  phone: string,
  groupId: string,
  callbackUrl: string
): Promise<AgentSession> {
  const key = sessionKey(phone, groupId);
  sessionCallbackUrls.set(key, callbackUrl);
  const disposing = sessionDisposals.get(key);
  if (disposing) await disposing;
  const existing = sessions.get(key);
  if (existing) {
    sessionLastUsed.set(key, Date.now());
    return existing;
  }
  const pending = sessionCreations.get(key);
  if (pending) return pending;

  const creation = createSession(phone, groupId, callbackUrl);
  sessionCreations.set(key, creation);
  try {
    const session = await creation;
    sessionLastUsed.set(key, Date.now());
    return session;
  } finally {
    if (sessionCreations.get(key) === creation) sessionCreations.delete(key);
  }
}

// ===== 工具状态摘要 =====
// 只供 /status 查询，不逐次发到群里，避免 Flash 模型密集调用工具时撞 IM 发送限额。
const PREFERRED_ARG_KEYS = [
  "command", "cmd", "path", "file_path", "filePath", "source", "filename", "url", "pattern", "query",
];
const NOISY_ARG_KEYS = new Set([
  "content", "newContent", "oldContent", "new_string", "old_string", "patch", "diff", "text",
]);

function truncateOneLine(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

/** 把一次工具调用摘要成一行：优先取标识字段（bash→command、read/write/edit→path、send_*→source）。 */
function summarizeToolCall(toolName: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  for (const k of PREFERRED_ARG_KEYS) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) {
      return `${toolName}: ${truncateOneLine(v, 100)}`;
    }
  }
  const small: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (NOISY_ARG_KEYS.has(k)) continue;
    small[k] = v;
  }
  const json = Object.keys(small).length ? JSON.stringify(small) : "";
  return json ? `${toolName} · ${truncateOneLine(json, 120)}` : toolName;
}

function isAbortError(e: unknown): boolean {
  if (e instanceof Error) {
    if (e.name === "AbortError") return true;
    if (e.message.toLowerCase().includes("abort")) return true;
  }
  return false;
}

/** 订阅 Pi 工具事件并记录最近工具；不向群里发送工具消息。 */
function recordToolProgress(event: AgentSessionEvent, session: AgentSession): void {
  if (event?.type === "tool_execution_start" && event.toolName) {
    const summary = summarizeToolCall(event.toolName, event.args);
    lastTool.set(session, summary);
  }
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/**
 * 长任务心跳：首次反馈由调用方立即发送；之后每 20 秒发送一次。
 * 使用递归 setTimeout，确保上一次发送结束后才安排下一次，不会因网络变慢而并发堆积。
 */
function startHeartbeat(
  startedAt: number,
  groupId: string,
  phone: string,
  callbackUrl: string
): () => Promise<void> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeTick: Promise<void> | undefined;

  const tick = () => {
    if (stopped) return;
    activeTick = sendText(
      `⏳ 仍在处理，已用时 ${formatElapsed(Date.now() - startedAt)}…`,
      groupId,
      phone,
      callbackUrl,
      { traffic: "status" }
    )
      .catch((e) => {
        log.error(`任务心跳发送失败 - 用户: ${phone}, 错误: ${String(e)}`);
      })
      .then(() => {
        activeTick = undefined;
        if (!stopped) timer = setTimeout(tick, AGENT_HEARTBEAT_INTERVAL);
      });
  };

  timer = setTimeout(tick, AGENT_HEARTBEAT_INTERVAL);
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await activeTick;
  };
}

/** /指令 路由：立即处理，不进 prompt/steer。 */
async function handleCommand(
  session: AgentSession,
  content: string,
  phone: string,
  groupId: string,
  callbackUrl: string
): Promise<void> {
  const parts = content.trim().split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const reply = async (msg: string): Promise<boolean> => {
    try {
      const sent = await sendText(msg, groupId, phone, callbackUrl);
      if (!sent) log.error(`指令回执未送达 - 用户: ${phone}`);
      return sent;
    } catch (e) {
      log.error(`指令回执失败 - 用户: ${phone}, 错误: ${String(e)}`);
      return false;
    }
  };

  switch (cmd) {
    case "/help":
      await reply(HELP_TEXT);
      return;

    case "/stop":
      if (!busySessions.has(session)) {
        await reply("ℹ️ 当前没有正在执行的任务");
        return;
      }
      abortingSessions.add(session);
      try {
        await session.abort();
      } catch (e) {
        log.error(`abort 失败 - 用户: ${phone}, 错误: ${String(e)}`);
        abortingSessions.delete(session);
        await reply("⚠️ 停止任务失败，请稍后重试");
        return;
      }
      await reply("⏹ 已强制停止当前任务");
      return;

    case "/status": {
      const busy = busySessions.has(session);
      const pending = typeof session.pendingMessageCount === "number" ? session.pendingMessageCount : 0;
      const last = lastTool.get(session) ?? "无";
      const rate = getOutboundRateStatus(callbackUrl);
      const rateMode = {
        normal: "正常",
        reduced: "心跳已降频",
        full: "关键消息排队中",
        cooldown: "平台限流冷却中",
      }[rate.mode];
      await reply(
        `状态：${busy ? "忙碌中" : "空闲"}\n待消化的干预：${pending} 条\n最近工具：🔧 ${last}\n机器人发送窗口：${rate.used}/${rate.limit}（${rateMode}${rate.pending ? `，排队 ${rate.pending}` : ""}）`
      );
      return;
    }

    case "/cancel": {
      let n = 0;
      try {
        const q = session.clearQueue();
        n = q.steering.length + q.followUp.length;
      } catch (e) {
        log.error(`clearQueue 失败 - 用户: ${phone}, 错误: ${String(e)}`);
      }
      await reply(n > 0 ? `🗑 已撤销 ${n} 条待消化的干预` : "ℹ️ 没有待消化的干预");
      return;
    }

    case "/reset": {
      // 先打断在跑的任务（若有）；in-flight prompt 会因 abortingSessions 自行跳过回复。
      if (busySessions.has(session)) {
        abortingSessions.add(session);
        try {
          await session.abort();
        } catch (e) {
          log.error(`reset abort 失败 - 用户: ${phone}, 错误: ${String(e)}`);
          abortingSessions.delete(session);
          await reply("⚠️ 当前任务未能停止，会话历史没有删除；请稍后重试 /reset");
          return;
        }
      }
      const key = sessionKey(phone, groupId);
      sessions.delete(key);
      sessionLastUsed.delete(key);
      sessionCallbackUrls.delete(key);
      await disposeSession(key, session);
      const fp = sessionFilePath(phone, groupId);
      try {
        await unlink(fp);
        log.info(`已删除会话文件 - 用户: ${phone}, 群: ${groupId}, 文件: ${fp}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          log.error(`删除会话文件失败 - 用户: ${phone}, 群: ${groupId}, 错误: ${String(e)}`);
          await reply("⚠️ 会话已关闭，但历史文件删除失败；请检查目录权限后重试 /reset");
          return;
        }
      }
      lastTool.delete(session);
      busySessions.delete(session);
      await reply("🗑 已清空本群会话历史，重新开始");
      return;
    }

    default:
      await reply(`未知指令「${parts[0]}」。发送 /help 查看可用指令`);
  }
}

/** 处理用户消息：/指令 → busy 则 steer → 否则 prompt（带中途干预 + abort 兜底）。 */
export async function handleUserMessage(
  phone: string,
  groupId: string,
  content: string,
  callbackUrl: string
): Promise<void> {
  const session = await getOrCreateSession(phone, groupId, callbackUrl);
  const trimmed = content.trim();

  // 1) /指令：立即处理
  if (trimmed.startsWith("/")) {
    await handleCommand(session, trimmed, phone, groupId, callbackUrl);
    return;
  }

  // 2) agent 正忙 → 中途干预（steer）
  if (busySessions.has(session)) {
    try {
      await session.steer(content);
      await sendText("↩️ 已插入干预，agent 将在下一步纳入", groupId, phone, callbackUrl);
    } catch (e) {
      log.error(`steer 失败 - 用户: ${phone}, 错误: ${String(e)}`);
      await sendText("⚠️ 干预插入失败，请稍后重试", groupId, phone, callbackUrl).catch(() => {});
    }
    return;
  }

  // 3) 空闲 → 正常一轮：标记 busy → 思考反馈 → prompt → 回复
  busySessions.add(session);
  const unsub: (() => void) | undefined =
    typeof session.subscribe === "function"
      ? session.subscribe((event: AgentSessionEvent) => recordToolProgress(event, session))
      : undefined;

  const start = Date.now();
  let stopHeartbeat: (() => Promise<void>) | undefined;
  try {
    await sendText("🤔 正在思考...", groupId, phone, callbackUrl, {
      traffic: "status",
    });
    stopHeartbeat = startHeartbeat(start, groupId, phone, callbackUrl);
    await session.prompt(content);
    await stopHeartbeat();
    stopHeartbeat = undefined;
    // 被 /stop /reset 中断 → 不发回复（指令已自己回执）
    if (abortingSessions.has(session)) {
      abortingSessions.delete(session);
      log.info(`任务被指令中断，跳过回复 - 用户: ${phone}`);
      return;
    }
    const replyText = session.getLastAssistantText();
    if (!replyText) throw new Error("Pi 未返回回复");
    log.info(
      `Pi 回复完成 - 用户: ${phone}, 耗时: ${((Date.now() - start) / 1000).toFixed(2)}秒, 长度: ${replyText.length}`
    );
    const sent = await sendReplyWithMention(replyText, groupId, phone, callbackUrl);
    if (!sent) throw new Error("Pi 回复生成成功，但群聊消息发送失败");
  } catch (e) {
    // 中断（AbortError 或 abortingSessions）→ 静默；其余异常上抛由 processRequest 兜底回错误提示
    if (abortingSessions.has(session) || isAbortError(e)) {
      abortingSessions.delete(session);
      log.info(`任务被中断（abort），跳过回复 - 用户: ${phone}`);
      return;
    }
    throw e;
  } finally {
    await stopHeartbeat?.();
    try {
      unsub?.();
    } catch {
      /* 忽略 */
    }
    busySessions.delete(session);
    const key = sessionKey(phone, groupId);
    if (sessions.get(key) === session) sessionLastUsed.set(key, Date.now());
  }
}

/** 应用关闭时释放所有 session。 */
export async function disposeAllSessions(): Promise<void> {
  await Promise.allSettled(sessionCreations.values());
  for (const [key, session] of sessions) {
    await disposeSession(key, session);
  }
  sessions.clear();
  sessionLastUsed.clear();
  sessionCallbackUrls.clear();
  await Promise.allSettled(sessionDisposals.values());
}
