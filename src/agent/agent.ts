// Pi agent 集成：用 pi-coding-agent 的 AgentSession + SessionManager 内嵌大脑。
// 纯适配——只用 Pi 公开 API：
//   - provider/model/key 由 data/models.json 承载，Pi 原生读取（ModelRuntime.create({modelsPath})）
//   - 内置工具 read/bash/edit/write 由 createAgentSession 自动构建（按 tools 名启用），绑定 cwd=AGENT_CWD（默认 ./data，可经环境变量覆盖）
//   - 发送工具 send_image/send_file 经 customTools（ToolDefinition）注册，定义在 ./tools.ts
//   - system prompt 用 Pi 默认 + appendSystemPromptOverride 追加最小群聊/中文上下文（方便上游升级）
// 会话持久化到 data/sessions/<phone>.<group>.jsonl。
//
// 中途干预（Pi 官方 API）：
//   - agent 正忙时，普通消息 → session.steer()（等当前这批工具调用完、下次调 LLM 前注入，软干预）
//   - /stop → session.abort()（硬中断，经 AbortSignal 连带取消在跑的工具）
//   - /status /cancel /reset /help → 队列查询/清空、清会话、帮助
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MODELS_JSON_PATH, AGENT_CWD } from "../lib/config.ts";
import { log } from "../lib/log.ts";
import { sendReplyWithMention, sendText } from "../im/im.ts";
import { buildSendTools } from "./tools.ts";

// ModelRuntime 单例 + 解析出的单模型。从 data/models.json 加载（Pi 原生）。
let modelRuntime: ModelRuntime | null = null;
let resolvedModel: Model<Api> | null = null;

async function getRuntime(): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  if (modelRuntime && resolvedModel) {
    return { runtime: modelRuntime, model: resolvedModel };
  }

  // 显式读 models.json 拿到声明的 provider/model id（getProviders() 会混入内置 provider，不能取 [0]）。
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
  log.info(`Pi ModelRuntime 就绪（provider=${providerId}, model=${modelId}, 工作目录=${AGENT_CWD}）`);
  return { runtime, model };
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

// 每 (phone, 群) 一个 AgentSession（内存缓存）。
const sessions = new Map<string, AgentSession>();
// 正在跑 prompt 的 session（中途来的消息走 steer；同一 session 同时只允许一个 prompt）。
const busySessions = new WeakSet<AgentSession>();
// 被指令（/stop /reset）主动中断的 session——其 in-flight prompt 不再发回复/错误（指令已自己回执）。
const abortingSessions = new WeakSet<AgentSession>();
// 每个session最近一次工具调用摘要，供 /status 展示。
const lastTool = new WeakMap<AgentSession, string>();

/** 追加到 Pi 默认 system prompt 的最小上下文（群聊 + 中文）。刻意最小化，方便 Pi 上游升级。 */
const CHAT_CONTEXT = `## 运行环境
你在「量子密信」群聊机器人里。用户用中文 @你 提问，请用中文、用 Markdown 简洁回复。纯文字回复会自动发到群里。
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

/** 把 groupId 解析为安全的会话文件名片段：符合标识符字符集则原样用，否则用 sha256 片段。
 *  绝不把原始 groupId 直接拼进路径（防路径穿越）；哈希兜底——不拒绝任何合法 id，且无碰撞。 */
function safeGroupSegment(groupId: string): string {
  return /^[A-Za-z0-9_+\-]{1,64}$/.test(groupId)
    ? groupId
    : createHash("sha256").update(groupId, "utf8").digest("hex").slice(0, 16);
}

function sessionFilePath(phone: string, groupId: string): string {
  return join("data", "sessions", `${phone}.${safeGroupSegment(groupId)}.jsonl`);
}

async function getOrCreateSession(phone: string, groupId: string, callbackUrl: string): Promise<AgentSession> {
  const key = sessionKey(phone, groupId);
  const existing = sessions.get(key);
  if (existing) return existing;

  const { runtime, model } = await getRuntime();
  const sessionManager = SessionManager.open(sessionFilePath(phone, groupId));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: AGENT_CWD, // 隔离 Pi context + 内置工具的工作目录（默认 ./data，可经 AGENT_CWD 覆盖）
    agentDir: "./.pi",
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
    cwd: AGENT_CWD, // 内置工具（read/bash/edit/write）绑定到此目录
    model,
    modelRuntime: runtime,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: ["read", "bash", "edit", "write", "send_image", "send_file"], // 启用内置 + 发送工具
    customTools: buildSendTools(callbackUrl),
    thinkingLevel: "off",
  });
  sessions.set(key, session);
  log.info(`新建会话 - 用户: ${phone}, 群: ${groupId}`);
  return session;
}

// ===== 工具进度卡片摘要 =====
// 展示「工具 + 实际入参」，让用户知道 agent 在干什么、能否/如何干预。
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

/** 工具执行进度：订阅 Pi 事件，每个 tool_execution_start 发一条带入参的 🔧 卡片，并记最近工具。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onToolProgress(event: any, groupId: string, phone: string, callbackUrl: string, session: AgentSession): void {
  if (event?.type === "tool_execution_start" && event.toolName) {
    const summary = summarizeToolCall(event.toolName, event.args);
    lastTool.set(session, summary);
    sendText(`🔧 ${summary}`, groupId, phone, callbackUrl).catch((e) =>
      log.error(`工具进度发送失败 - 用户: ${phone}, 错误: ${String(e)}`)
    );
  }
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
  const reply = (msg: string) =>
    sendText(msg, groupId, phone, callbackUrl).catch((e) => log.error(`指令回执失败 - 用户: ${phone}, 错误: ${String(e)}`));

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
      }
      await reply("⏹ 已强制停止当前任务");
      return;

    case "/status": {
      const busy = busySessions.has(session);
      const pending = typeof session.pendingMessageCount === "number" ? session.pendingMessageCount : 0;
      const last = lastTool.get(session) ?? "无";
      await reply(
        `状态：${busy ? "忙碌中" : "空闲"}\n待消化的干预：${pending} 条\n最近工具：🔧 ${last}`
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
        }
      }
      const key = sessionKey(phone, groupId);
      sessions.delete(key);
      try {
        await session.dispose();
      } catch (e) {
        log.error(`session dispose 失败 - 用户: ${phone}, 错误: ${String(e)}`);
      }
      const fp = sessionFilePath(phone, groupId);
      try {
        await unlink(fp);
        log.info(`已删除会话文件 - 用户: ${phone}, 群: ${groupId}, 文件: ${fp}`);
      } catch {
        /* 文件可能不存在，忽略 */
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsub: (() => void) | undefined =
    typeof session.subscribe === "function"
      ? (session.subscribe((event: any) =>
          onToolProgress(event, groupId, phone, callbackUrl, session)
        ) as (() => void) | undefined)
      : undefined;

  const start = Date.now();
  try {
    await sendText("🤔 正在思考...", groupId, phone, callbackUrl);
    await session.prompt(content);
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
    await sendReplyWithMention(replyText, groupId, phone, callbackUrl);
  } catch (e) {
    // 中断（AbortError 或 abortingSessions）→ 静默；其余异常上抛由 processRequest 兜底回错误提示
    if (abortingSessions.has(session) || isAbortError(e)) {
      abortingSessions.delete(session);
      log.info(`任务被中断（abort），跳过回复 - 用户: ${phone}`);
      return;
    }
    throw e;
  } finally {
    try {
      unsub?.();
    } catch {
      /* 忽略 */
    }
    busySessions.delete(session);
  }
}

/** 应用关闭时释放所有 session。 */
export async function disposeAllSessions(): Promise<void> {
  for (const [, session] of sessions) {
    try {
      await session.dispose();
    } catch {
      /* 忽略 */
    }
  }
  sessions.clear();
}
