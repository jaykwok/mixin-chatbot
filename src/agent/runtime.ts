// Pi agent 集成：用 pi-coding-agent 的 AgentSession + SessionManager 内嵌大脑。
// 纯适配——只用 Pi 公开 API：
//   - provider/model/key 由 data/config/models.json 承载，Pi 原生读取（ModelRuntime.create({modelsPath})）
//   - read/bash/edit/write 复用 Pi 官方工具工厂，同名覆盖只增加路径边界和用户临时环境；
//     cwd 绑定到 <GROUP_DATA_ROOT>/<group>/workspace，临时文件写当前用户的 users/<phone>/tmp
//   - 发送工具 send_image/send_file 经 customTools（ToolDefinition）注册，定义在 ./send-tools.ts
//   - system prompt 用 Pi 默认 + appendSystemPromptOverride 追加最小群聊/中文上下文（方便上游升级）
// 会话持久化到 <GROUP_DATA_ROOT>/<group>/users/<phone>/session.jsonl。
//
// 中途干预（Pi 官方 API）：
//   - agent 正忙时，普通消息 → session.steer()（等当前这批工具调用完、下次调 LLM 前注入，软干预）
//   - /stop → session.abort()（硬中断，经 AbortSignal 连带取消在跑的工具）
//     + session.clearQueue()（abort 只结束这一轮，排队中的干预要一起丢）
//   - /status /clear /help → 状态查询、清会话、帮助
import { readFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  GROUP_DATA_ROOT,
  SESSION_IDLE_TTL,
} from "../core/config.ts";
import { log } from "../core/log.ts";
import {
  MODELS_JSON_PATH,
  MODELS_STORE_PATH,
  PI_AGENT_DIR,
  RUNTIME_DIR,
} from "../core/storage.ts";
import {
  abortOutboundRequests,
  getOutboundRateStatus,
  sendReplyWithMention,
  sendText,
} from "../integrations/im.ts";
import { getRelayConfig } from "../integrations/relay.ts";
import {
  groupWorkspaceDir,
  sessionFilePath,
  userTempDir,
} from "./paths.ts";
import {
  canonicalCommand,
  HELP_TEXT,
  isSlashCommandMessage,
  stripLeadingMention,
  unknownCommandText,
} from "./commands.ts";
import { buildLocalTools } from "./local-tools.ts";
import {
  buildSendTools,
  createOutboundNotes,
  type OutboundNotes,
} from "./send-tools.ts";
import {
  consumeTerminalToolBlockReply,
  createToolPolicyExtension,
  type TerminalToolBlockState,
} from "./tool-policy.ts";
import { getWorkspaceCoordinationStatus } from "./workspace-coordinator.ts";

// ModelRuntime 单例 + 解析出的单模型。从 data/config/models.json 加载（Pi 原生）。
let modelRuntime: ModelRuntime | null = null;
let resolvedModel: Model<Api> | null = null;
let resolvedThinkingLevel: ModelThinkingLevel = "off";
type RuntimeSelection = {
  runtime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
};
let runtimePromise: Promise<RuntimeSelection> | null = null;

async function getRuntime(): Promise<RuntimeSelection> {
  if (modelRuntime && resolvedModel) {
    return {
      runtime: modelRuntime,
      model: resolvedModel,
      thinkingLevel: resolvedThinkingLevel,
    };
  }
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    // 显式读 models.json 拿声明的 provider/model id（getProviders() 会混入内置 provider）。
    let providerId: string | undefined;
    let modelId: string | undefined;
    let configuredThinkingLevel: ModelThinkingLevel = "off";
    try {
      const raw = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8")) as {
        thinkingLevel?: ModelThinkingLevel;
        providers?: Record<string, { models?: { id?: string }[] }>;
      };
      providerId = Object.keys(raw.providers ?? {})[0];
      modelId = raw.providers?.[providerId]?.models?.[0]?.id;
      configuredThinkingLevel = raw.thinkingLevel ?? "off";
    } catch {
      throw new Error(
        `无法读取 ${MODELS_JSON_PATH}。请先生成 AI 配置：运行 bun run configure（部署脚本会自动调用）`
      );
    }
    if (!providerId || !modelId) {
      throw new Error(`${MODELS_JSON_PATH} 未声明 provider/model，请重新运行 configure 工具。`);
    }

    // Pi 默认把模型目录缓存写在 models.json 旁边；显式指向 data/runtime，让
    // data/config 里只剩用户真正要维护的东西。首次写入前目录必须存在。
    await mkdir(RUNTIME_DIR, { recursive: true });
    const runtime = await ModelRuntime.create({
      modelsPath: MODELS_JSON_PATH,
      modelsStorePath: MODELS_STORE_PATH,
    });
    const model = runtime.getModel(providerId, modelId);
    if (!model) {
      throw new Error(`${MODELS_JSON_PATH} 中未找到 ${providerId}/${modelId}，请检查配置。`);
    }
    const auth = await runtime.checkAuth(providerId);
    if (!auth) {
      throw new Error(
        `${MODELS_JSON_PATH} 中的 provider ${providerId} 未配置可用凭证，请重新运行 configure 工具。`
      );
    }
    const thinkingLevel = clampThinkingLevel(model, configuredThinkingLevel);
    modelRuntime = runtime;
    resolvedModel = model;
    resolvedThinkingLevel = thinkingLevel;
    log.info(
      `Pi ModelRuntime 就绪（provider=${providerId}, model=${modelId}, thinkingLevel=${thinkingLevel}, 群数据总根=${GROUP_DATA_ROOT}）`
    );
    return { runtime, model, thinkingLevel };
  })();

  try {
    return await runtimePromise;
  } catch (e) {
    runtimePromise = null;
    throw e;
  }
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type ClearResult = { ok: true } | { ok: false; message: string };

// 每 (群, phone) 一个 AgentSession；不同用户可并发，workspace 写入由工具层按文件协调。
const sessions = new Map<string, AgentSession>();
// 避免同一群/用户的并发首条消息重复创建两个 session 并同时写一个 jsonl。
const sessionCreations = new Map<string, Promise<AgentSession>>();
// dispose 期间阻止同一会话立刻重开并与旧实例同时操作同一个 jsonl。
const sessionDisposals = new Map<string, Promise<void>>();
// /clear 的 abort、dispose、删除历史必须整体完成后，才能为同一用户重建 session。
const sessionClears = new Map<string, Promise<ClearResult>>();
const sessionLastUsed = new Map<string, number>();
// 平台可能轮换 callback key；发送工具在每次执行时读取当前会话最新 URL。
const sessionCallbackUrls = new Map<string, string>();
// 正在跑 prompt 的 session（中途来的消息走 steer；同一 session 同时只允许一个 prompt）。
const busySessions = new WeakSet<AgentSession>();
// 被指令（/stop /clear）主动中断的 session——其 in-flight prompt 不再发回复/错误（指令已自己回执）。
const abortingSessions = new WeakSet<AgentSession>();
// 让 /clear 与进程关闭能等 runPrompt 的外围发送/清理逻辑真正结束。
const activeRuns = new Map<AgentSession, Promise<void>>();
// /stop 与 /clear 同时取消适配层自己的状态/最终回复发送，不只中断 Pi prompt。
const runOutboundControllers = new WeakMap<AgentSession, AbortController>();
// 每个session最近一次工具调用摘要，供 /status 展示。
const lastTool = new WeakMap<AgentSession, string>();
// 0.84.1：全终止 tool_call 批次不会再调用模型，直接把策略原因回复给用户。
const terminalToolBlockStates = new WeakMap<
  AgentSession,
  TerminalToolBlockState
>();
// 工具产出的、必须原样进群的文本（目前只有大文件外链）。每个 session 一份；同一 session
// 的 run 是串行的（busySessions 保证），所以不会串台。
const sessionOutboundNotes = new WeakMap<AgentSession, OutboundNotes>();
let acceptingRequests = true;

/** 追加到 Pi 默认 system prompt 的群聊、共享工作区与当前用户临时目录上下文。 */
function buildChatContext(tempDir: string): string {
  return `## 运行环境
你在「量子密信」群聊机器人里。用户用中文 @你 提问，请用中文简洁回复；需要标题、强调、列表、链接、表格或代码时使用 Markdown，普通段落不必添加格式。回复会自动发到群里。
当前工作目录是本群共享的 workspace，只放需要让群成员长期复用的成果。先检查已有文件，不要覆盖或删除无关内容。
不同用户的任务可以同时运行。read 可直接并行；edit/write 会自动按目标文件协调。同一个文件的写入按 FIFO 执行，不同文件可并行。
调用 bash 时，mutates 用于排队协调，请列出命令可能创建、修改、重命名或删除的每个路径；纯读取命令填空数组，无法列清或会批量修改时填 ["."]。临时目录内的路径不需要协调，列进去也会被忽略，不必为此改写命令。禁止启动退出工具后仍会继续改 workspace 的后台进程。
当前调用用户的专属临时目录是：${resolve(tempDir)}
下载、缓存、解压、转换产物、草稿和其他中间文件必须放进上述临时目录；不要放进 workspace、系统临时目录、其他用户目录或上级目录。
bash 工具已自动把 TMPDIR、TMP、TEMP 和常见包管理器缓存指向上述临时目录；PI_USER_TMP 可直接读取该路径。命令若有独立的缓存或输出参数，也要显式指向该目录。
需要 Python 时，只使用 uv 和本群 workspace/.venv；环境不存在时用 uv venv 创建，创建环境或变更依赖时把 .venv 列入 bash.mutates，依赖变更使用 uv pip。脚本使用 uv run --active --no-sync，不使用全局 Python 或 conda。PYTHONIOENCODING 已固定为 utf-8。
安全、量子产品及项目知识以共享 workspace 中的项目资料为优先依据；观点冲突时先核对项目资料，需要外部最新事实且具备检索能力时再查询。
仅当任务确实需要定位会话或调用者时，才使用 bash 中的 PI_* 环境变量，不要主动枚举或检查它们。本适配层提供 PI_CALLER_PHONE、PI_GROUP_ID 和 PI_USER_TMP。
只有用户明确要保留或共享的最终成果才写入当前 workspace。
干活途中用户可能插话干预（ steer ），请把后续用户消息当作对当前任务的补充/纠正，及时调整。`;
}

/** 在开放 HTTP 端口前验证 models.json 与目标模型确实可加载。 */
export async function initializeAgentRuntime(): Promise<void> {
  await getRuntime();
}

function sessionKey(phone: string, groupId: string): string {
  return JSON.stringify([groupId, phone]);
}

/** 后台错误回执也使用会话最近一次收到的 callback URL。 */
export function resolveSessionCallbackUrl(
  phone: string,
  groupId: string,
  fallback: string
): string {
  return sessionCallbackUrls.get(sessionKey(phone, groupId)) ?? fallback;
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
  const { runtime, model, thinkingLevel } = await getRuntime();
  const cwd = resolve(groupWorkspaceDir(GROUP_DATA_ROOT, groupId));
  const tempDir = resolve(userTempDir(GROUP_DATA_ROOT, groupId, phone));
  const historyPath = resolve(sessionFilePath(GROUP_DATA_ROOT, groupId, phone));
  const piAgentDir = resolve(PI_AGENT_DIR);
  await mkdir(cwd, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(dirname(historyPath), { recursive: true });
  await mkdir(piAgentDir, { recursive: true });
  const sessionManager = SessionManager.open(historyPath);
  const settingsManager = SettingsManager.inMemory();
  const toolPolicy = createToolPolicyExtension();
  const resourceLoader = new DefaultResourceLoader({
    cwd, // 群共享工作目录（<group>/workspace/）
    agentDir: piAgentDir, // 可重建的共享 Pi 内部目录，避免污染仓库根目录或用户 tmp。
    settingsManager,
    noExtensions: true, // 不加载磁盘上的 .pi 扩展；本进程显式注册工具。
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // noExtensions 只禁用磁盘发现；这一个受信任的内联策略仍由代码显式加载。
    extensionFactories: [toolPolicy.extension],
    appendSystemPromptOverride: (base) => [...base, buildChatContext(tempDir)],
  });
  await resourceLoader.reload();
  const localTools = await buildLocalTools(cwd, tempDir, phone, groupId);
  const outboundNotes = createOutboundNotes();

  const { session } = await createAgentSession({
    cwd, // Pi session 与工具的默认目录都是群共享 <group>/workspace/。
    model,
    modelRuntime: runtime,
    sessionManager,
    settingsManager,
    resourceLoader,
    // 同名 custom tool 覆盖内置定义：仍复用 Pi 官方工具工厂，只增加路径边界和调用者临时环境。
    tools: ["read", "bash", "edit", "write", "send_image", "send_file"],
    customTools: [
      ...localTools,
      ...buildSendTools({
        getCallbackUrl: () => sessionCallbackUrls.get(key) ?? callbackUrl,
        groupId,
        workspaceDir: cwd,
        tempDir,
        relay: getRelayConfig(),
        notes: outboundNotes,
      }),
    ],
    thinkingLevel,
  });
  terminalToolBlockStates.set(session, toolPolicy.state);
  sessionOutboundNotes.set(session, outboundNotes);
  sessions.set(key, session);
  sessionLastUsed.set(key, Date.now());
  log.info(
    `新建会话 - 用户: ${phone}, 群: ${groupId}, Pi session: ${session.sessionManager.getSessionId()}`
  );
  return session;
}

async function getOrCreateSession(
  phone: string,
  groupId: string,
  callbackUrl: string
): Promise<AgentSession | null> {
  const key = sessionKey(phone, groupId);
  if (!acceptingRequests) return null;
  const clearing = sessionClears.get(key);
  if (clearing) await clearing;
  if (!acceptingRequests) return null;
  const disposing = sessionDisposals.get(key);
  if (disposing) await disposing;
  if (!acceptingRequests) return null;
  sessionCallbackUrls.set(key, callbackUrl);
  const existing = sessions.get(key);
  if (existing) {
    sessionLastUsed.set(key, Date.now());
    return existing;
  }
  const pending = sessionCreations.get(key);
  if (pending) {
    const session = await pending;
    return acceptingRequests ? session : null;
  }

  const creation = createSession(phone, groupId, callbackUrl);
  sessionCreations.set(key, creation);
  try {
    const session = await creation;
    sessionLastUsed.set(key, Date.now());
    return acceptingRequests ? session : null;
  } catch (error) {
    if (!sessions.has(key)) sessionCallbackUrls.delete(key);
    throw error;
  } finally {
    if (sessionCreations.get(key) === creation) sessionCreations.delete(key);
  }
}

/**
 * Clear is one per-user transaction: stop the active turn, wait for runPrompt's
 * outer work, dispose the SDK session, then remove its JSONL before allowing a
 * new session for the same (group, phone).
 */
async function clearUserSession(
  session: AgentSession,
  phone: string,
  groupId: string
): Promise<ClearResult> {
  const key = sessionKey(phone, groupId);
  const existing = sessionClears.get(key);
  if (existing) return existing;

  const clear = (async (): Promise<ClearResult> => {
    if (busySessions.has(session)) {
      abortingSessions.add(session);
      runOutboundControllers.get(session)?.abort();
      try {
        await session.abort();
        await activeRuns.get(session);
      } catch (error) {
        log.error(`clear abort 失败 - 用户: ${phone}, 错误: ${String(error)}`);
        abortingSessions.delete(session);
        return {
          ok: false,
          message: "⚠️ 当前任务未能停止，会话历史没有删除；请稍后重试 /clear",
        };
      }
    }

    if (sessions.get(key) === session) sessions.delete(key);
    sessionLastUsed.delete(key);
    sessionCallbackUrls.delete(key);
    await disposeSession(key, session);
    lastTool.delete(session);
    busySessions.delete(session);

    const historyPath = resolve(
      sessionFilePath(GROUP_DATA_ROOT, groupId, phone)
    );
    try {
      await unlink(historyPath);
      log.info(
        `已删除会话文件 - 用户: ${phone}, 群: ${groupId}, 文件: ${historyPath}`
      );
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: true };
      }
      log.error(
        `删除会话文件失败 - 用户: ${phone}, 群: ${groupId}, 错误: ${String(error)}`
      );
      return {
        ok: false,
        message: "⚠️ 会话已关闭，但历史文件删除失败；请检查目录权限后重试 /clear",
      };
    }
  })();

  sessionClears.set(key, clear);
  try {
    return await clear;
  } finally {
    if (sessionClears.get(key) === clear) sessionClears.delete(key);
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

/**
 * Drop steering/follow-up messages that were queued for a turn which no longer
 * exists. Pi's abort() only cancels the active run; the agent loop reads its
 * steering queue at the start of the *next* run, so anything left over would be
 * injected into an unrelated later task. Returns how many were discarded.
 */
function discardQueuedInterventions(session: AgentSession): number {
  try {
    const { steering, followUp } = session.clearQueue();
    return steering.length + followUp.length;
  } catch (e) {
    log.error(`清空干预队列失败: ${String(e)}`);
    return 0;
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
  const cmd = canonicalCommand(content);
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

    case "/stop": {
      if (!busySessions.has(session)) {
        await reply("ℹ️ 当前没有正在执行的任务");
        return;
      }
      abortingSessions.add(session);
      runOutboundControllers.get(session)?.abort();
      try {
        await session.abort();
        await activeRuns.get(session);
      } catch (e) {
        log.error(`abort 失败 - 用户: ${phone}, 错误: ${String(e)}`);
        abortingSessions.delete(session);
        await reply("⚠️ 停止任务失败，请稍后重试");
        return;
      }
      // abort() 只取消在跑的这一轮，排队中的 steer 会留到下次 prompt 开头注入。
      // 这个 session 会继续服务下一个任务，所以丢弃属于已停任务的干预。
      const dropped = discardQueuedInterventions(session);
      await reply(
        dropped > 0
          ? `⏹ 已强制停止当前任务，并丢弃 ${dropped} 条未消化的干预`
          : "⏹ 已强制停止当前任务"
      );
      return;
    }

    case "/status": {
      const busy = busySessions.has(session);
      const pending = typeof session.pendingMessageCount === "number" ? session.pendingMessageCount : 0;
      const last = lastTool.get(session) ?? "无";
      const rate = getOutboundRateStatus(callbackUrl);
      const workspace = getWorkspaceCoordinationStatus(
        resolve(groupWorkspaceDir(GROUP_DATA_ROOT, groupId))
      );
      const workspaceMode = workspace.opaqueActive
        ? "bash 独占操作中"
        : workspace.fileMutations > 0
          ? `${workspace.fileMutations} 个文件写操作进行中`
          : "空闲";
      const rateMode = {
        normal: "正常",
        reduced: "状态消息已降频",
        full: "关键消息排队中",
        cooldown: "平台限流冷却中",
      }[rate.mode];
      await reply(
        `状态：${busy ? "忙碌中" : "空闲"}\nPi 会话：${session.sessionManager.getSessionId()}\n待消化的干预：${pending} 条\n群工作区协调：${workspaceMode}${workspace.waiting ? `，另有 ${workspace.waiting} 个操作等待` : ""}\n最近工具：🔧 ${last}\n机器人发送窗口：${rate.used}/${rate.limit}（${rateMode}${rate.pending ? `，排队 ${rate.pending}` : ""}）`
      );
      return;
    }

    case "/clear": {
      const result = await clearUserSession(session, phone, groupId);
      await reply(
        result.ok
          ? "🗑 已清空你在本群的会话历史；下一条消息将开启新会话"
          : result.message
      );
      return;
    }

    default:
      await reply(unknownCommandText(content));
  }
}

async function runPrompt(
  session: AgentSession,
  phone: string,
  groupId: string,
  content: string,
  callbackUrl: string
): Promise<void> {
  let finishRun!: () => void;
  const runFinished = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const outboundController = new AbortController();
  activeRuns.set(session, runFinished);
  runOutboundControllers.set(session, outboundController);
  busySessions.add(session);
  const unsub: (() => void) | undefined =
    typeof session.subscribe === "function"
      ? session.subscribe((event: AgentSessionEvent) => recordToolProgress(event, session))
      : undefined;

  const start = Date.now();
  const key = sessionKey(phone, groupId);
  const getCallbackUrl = () => sessionCallbackUrls.get(key) ?? callbackUrl;
  try {
    // Slash commands return from handleUserMessage before runPrompt, so only
    // normalized ordinary prompt text reaches this acknowledgement.
    await sendText("🤔 正在思考...", groupId, phone, getCallbackUrl(), {
      traffic: "status",
      signal: outboundController.signal,
    });
    // /stop 或 /clear 可能发生在状态消息发送期间。
    if (abortingSessions.has(session)) {
      abortingSessions.delete(session);
      return;
    }
    await session.prompt(content);
    // 被 /stop /clear 中断 → 不发回复（指令已自己回执）
    if (abortingSessions.has(session)) {
      abortingSessions.delete(session);
      log.info(`任务被指令中断，跳过回复 - 用户: ${phone}`);
      return;
    }
    const replyText =
      consumeTerminalToolBlockReply(terminalToolBlockStates.get(session)) ??
      session.getLastAssistantText();
    // 工具留下的必送文本（大文件外链）随这一条回复一起走，而不是各发各的：平台按条
    // 限流，「工具发链接 + 模型发说明」会让一次发送吃掉两条配额。
    //
    // 这里只 peek 不清空：送达之前先清掉的话，一旦发送失败，链接就既没进群也不在
    // 兜底队列里了，而文件已经在外链后端上躺着。
    const notes = sessionOutboundNotes.get(session);
    const pending = notes?.peek() ?? [];
    const appendix = pending.length > 0 ? pending.join("\n\n") : undefined;
    // 模型什么都没说但文件确实发出去了时，链接本身就是完整的回复。
    if (!replyText && !appendix) throw new Error("Pi 未返回回复");
    const body = replyText || "文件已发送。";
    log.info(
      `Pi 回复完成 - 用户: ${phone}, 耗时: ${((Date.now() - start) / 1000).toFixed(2)}秒, 长度: ${body.length}`
    );
    const sent = await sendReplyWithMention(
      body,
      groupId,
      phone,
      getCallbackUrl(),
      outboundController.signal,
      appendix
    );
    if (!sent) throw new Error("Pi 回复生成成功，但群聊消息发送失败");
    notes?.clear();
  } catch (e) {
    // 中断（AbortError 或 abortingSessions）→ 静默；其余异常上抛由 processRequest 兜底回错误提示
    if (abortingSessions.has(session) || isAbortError(e)) {
      abortingSessions.delete(session);
      log.info(`任务被中断（abort），跳过回复 - 用户: ${phone}`);
      return;
    }
    throw e;
  } finally {
    // 兜底：正常路径上 drain 已经清空了，这里拿到东西只可能是回复没发出去（模型报错、
    // /stop、发送失败）。文件此时已经躺在外链后端上了，链接跟着失败一起消失的话，谁都
    // 拿不到它，而且它还会一直占着网盘直到过期。所以单独补发一条，且不带本轮的
    // AbortSignal——那个信号多半正是导致走到这里的原因。
    const orphaned = sessionOutboundNotes.get(session)?.drain() ?? [];
    if (orphaned.length > 0) {
      log.warn(`本轮回复未送达，单独补发外链消息 - 用户: ${phone}, 群: ${groupId}`);
      await sendText(orphaned.join("\n\n"), groupId, phone, getCallbackUrl()).catch((e) =>
        log.error(`外链消息补发失败 - 用户: ${phone}, 错误: ${String(e)}`)
      );
    }
    try {
      unsub?.();
    } catch {
      /* 忽略 */
    }
    busySessions.delete(session);
    if (sessions.get(key) === session) sessionLastUsed.set(key, Date.now());
    if (activeRuns.get(session) === runFinished) activeRuns.delete(session);
    if (runOutboundControllers.get(session) === outboundController) {
      runOutboundControllers.delete(session);
    }
    finishRun();
  }
}

/** /指令立即处理；当前用户忙时 steer；不同用户并发，文件写入由工具层协调。 */
export async function handleUserMessage(
  phone: string,
  groupId: string,
  content: string,
  callbackUrl: string
): Promise<void> {
  if (!acceptingRequests) return;
  let session = await getOrCreateSession(phone, groupId, callbackUrl);
  if (!session || !acceptingRequests) return;
  const key = sessionKey(phone, groupId);
  // A concurrent /clear can replace the session while getOrCreateSession is
  // yielding. Refresh once before routing commands, steer, or a new prompt.
  if (sessions.get(key) !== session) {
    session = await getOrCreateSession(phone, groupId, callbackUrl);
    if (!session || !acceptingRequests) return;
  }
  const trimmed = content.trim();

  if (isSlashCommandMessage(trimmed)) {
    await handleCommand(session, trimmed, phone, groupId, callbackUrl);
    return;
  }

  // The platform includes the leading @bot mention in textMsg.content. It is
  // transport syntax rather than part of the user's prompt, so remove it once
  // before prompt/steer while preserving later mentions in the actual message.
  const promptContent = stripLeadingMention(trimmed);

  if (busySessions.has(session) && abortingSessions.has(session)) {
    await activeRuns.get(session);
    if (!acceptingRequests) return;
  } else if (busySessions.has(session)) {
    try {
      await session.steer(promptContent);
      await sendText("↩️ 已插入干预，agent 将在下一步纳入", groupId, phone, callbackUrl);
    } catch (e) {
      log.error(`steer 失败 - 用户: ${phone}, 错误: ${String(e)}`);
      await sendText("⚠️ 干预插入失败，请稍后重试", groupId, phone, callbackUrl).catch(() => {});
    }
    return;
  }

  // There is intentionally no await between the busy check above and
  // runPrompt marking this session busy, preventing concurrent prompts on one
  // AgentSession while still allowing different users to run together.
  await runPrompt(session, phone, groupId, promptContent, callbackUrl);
}

/** 应用关闭时释放所有 session。 */
export async function disposeAllSessions(): Promise<void> {
  acceptingRequests = false;
  abortOutboundRequests();
  await Promise.allSettled(sessionCreations.values());
  const runningSessions = [...activeRuns.keys()];
  for (const session of runningSessions) {
    abortingSessions.add(session);
    runOutboundControllers.get(session)?.abort();
  }
  await Promise.allSettled(runningSessions.map((session) => session.abort()));
  await Promise.allSettled(activeRuns.values());
  await Promise.allSettled(sessionClears.values());
  for (const [key, session] of sessions) {
    await disposeSession(key, session);
  }
  sessions.clear();
  sessionLastUsed.clear();
  sessionCallbackUrls.clear();
  sessionClears.clear();
  activeRuns.clear();
  await Promise.allSettled(sessionDisposals.values());
}
