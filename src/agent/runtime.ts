// Pi local SDK integration. One SessionQueue owns each user's entire task lifecycle.
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { clampThinkingLevel, Type, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { GROUP_DATA_ROOT, SESSION_IDLE_TTL, RUN_TIMEOUT_MS } from "../core/config.ts";
import { log } from "../core/log.ts";
import { MODELS_JSON_PATH, MODELS_STORE_PATH, PI_AGENT_DIR, RUNTIME_DIR } from "../core/storage.ts";
import { application, waitFor } from "../core/lifecycle.ts";
import { archiveFile } from "../core/maintenance.ts";
import { abortOutboundRequests, getOutboundRateStatus, sendReplyWithMention, sendText } from "../integrations/im.ts";
import { getRelayConfig } from "../integrations/relay.ts";
import { groupIndexDir, groupVenvDir, groupWorkspaceDir, materialsIgnorePath, materialsIndexPath, sessionFilePath, userTempDir } from "./paths.ts";
import { ensureMaterialsIndex } from "./materials-index.ts";
import { ensureDocumentToolchain, venvPythonPath } from "./python-toolchain.ts";
import { canonicalCommand, HELP_TEXT, isSlashCommandMessage, stripLeadingMention, unknownCommandText } from "./commands.ts";
import { buildLocalTools } from "./local-tools.ts";
import { buildSendTools, createOutboundNotes, type OutboundNotes } from "./send-tools.ts";
import { buildChatContext } from "./prompt.ts";
import { DeliveryStore } from "./delivery-store.ts";
import { SessionQueue } from "./session-queue.ts";
import { runtimeSetting } from "../core/runtime-config.ts";
import { ensureStorageIdentity } from "./storage-identity.ts";

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
      if (Object.keys(raw.providers ?? {}).length !== 1) throw new Error("只允许配置一个 provider");
      providerId = Object.keys(raw.providers ?? {})[0];
      if (raw.providers?.[providerId]?.models?.length !== 1) throw new Error("只允许配置一个模型");
      modelId = raw.providers?.[providerId]?.models?.[0]?.id;
      configuredThinkingLevel = raw.thinkingLevel ?? "off";
    } catch (error) {
      throw new Error(
        `无法加载 ${MODELS_JSON_PATH}: ${String(error)}。请运行 bun run configure 检查 AI 配置。`
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
      signal: application.signal,
      allowModelNetwork: false,
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
interface SessionRecord {
  key: string; phone: string; groupId: string; callbackUrl: string;
  queue: SessionQueue; session?: AgentSession; lastUsed: number; lastTool?: string;
  notes: OutboundNotes; deliveryId?: string; unsubscribe?: () => void;
}
const records = new Map<string, SessionRecord>();
const controlReceipts = new Map<string, Promise<unknown>>();
let deliveries: DeliveryStore | undefined;
const store = () => deliveries ??= new DeliveryStore();
const sessionKey = (phone: string, groupId: string) => JSON.stringify([groupId, phone]);

export function resolveSessionCallbackUrl(phone: string, groupId: string, fallback: string): string {
  return records.get(sessionKey(phone, groupId))?.callbackUrl ?? fallback;
}

/** Stop remains available even if control receipts are already queued. */
export function stopUserTask(phone: string, groupId: string): void {
  void records.get(sessionKey(phone, groupId))?.queue.cancel();
}

function getRecord(phone: string, groupId: string, callbackUrl: string): SessionRecord {
  const key = sessionKey(phone, groupId);
  let record = records.get(key);
  if (!record) {
    if (records.size >= 1000) throw new Error("会话容量已满，请稍后重试");
    record = { key, phone, groupId, callbackUrl, queue: new SessionQueue(), lastUsed: Date.now(),
      notes: createOutboundNotes((note) => {
        record!.deliveryId = store().save(key, [...record!.notes.peek(), note].join("\n\n"), record!.deliveryId);
      }) };
    records.set(key, record);
  }
  record.callbackUrl = callbackUrl;
  record.lastUsed = Date.now();
  return record;
}

async function refreshIndex(record: SessionRecord, signal: AbortSignal): Promise<void> {
  const indexPath = resolve(materialsIndexPath(GROUP_DATA_ROOT, record.groupId));
  await mkdir(dirname(indexPath), { recursive: true });
  await waitFor(ensureMaterialsIndex({
    workspaceDir: resolve(groupWorkspaceDir(GROUP_DATA_ROOT, record.groupId)), indexPath,
    ignorePath: resolve(materialsIgnorePath(GROUP_DATA_ROOT, record.groupId)),
  }), signal);
}

async function createSession(record: SessionRecord, signal: AbortSignal): Promise<AgentSession> {
  await ensureStorageIdentity(GROUP_DATA_ROOT, record.groupId, record.phone);
  signal.throwIfAborted();
  const { runtime, model, thinkingLevel } = await getRuntime();
  signal.throwIfAborted();
  const cwd = resolve(groupWorkspaceDir(GROUP_DATA_ROOT, record.groupId));
  const tempDir = resolve(userTempDir(GROUP_DATA_ROOT, record.groupId, record.phone));
  const history = resolve(sessionFilePath(GROUP_DATA_ROOT, record.groupId, record.phone));
  const indexPath = resolve(materialsIndexPath(GROUP_DATA_ROOT, record.groupId));
  const venvDir = resolve(runtimeSetting("BOT_DOCUMENT_ENV") ||
    (existsSync(".venv/.mixin-doc-toolchain") ? ".venv" : groupVenvDir(GROUP_DATA_ROOT, record.groupId)));
  for (const dir of [cwd, tempDir, dirname(history), PI_AGENT_DIR, groupIndexDir(GROUP_DATA_ROOT, record.groupId)]) {
    await mkdir(dir, { recursive: true });
  }
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000,
      provider: { timeoutMs: 120000, maxRetries: 1, maxRetryDelayMs: 5000 } },
    compaction: { enabled: true }, enableAnalytics: false, enableInstallTelemetry: false,
    enableSkillCommands: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: resolve(PI_AGENT_DIR), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => buildChatContext({ tempDir, relayEnabled: !!getRelayConfig() }),
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  signal.throwIfAborted();
  const localTools = await buildLocalTools({ workspaceDir: cwd, tempDir, phone: record.phone,
    groupId: record.groupId, venvDir, materialsIndexPath: indexPath });
  const { session } = await createAgentSession({
    cwd, agentDir: resolve(PI_AGENT_DIR), modelRuntime: runtime, model, thinkingLevel, settingsManager, resourceLoader,
    sessionManager: SessionManager.open(history, undefined, cwd),
    tools: ["read", "bash", "edit", "write", "send_image", "send_file", "document_environment"],
    customTools: [...localTools, ...buildSendTools({
      getCallbackUrl: () => record.callbackUrl, groupId: record.groupId, workspaceDir: cwd, tempDir,
      relay: getRelayConfig(), notes: record.notes,
    }), {
      name: "document_environment", label: "文档解析环境", description: "查询并按需准备本群固定版本的文档解析环境；成功后返回解释器位置。失败时说明能力不可用，不自行安装或修改共享环境。",
      parameters: Type.Object({}),
      async execute(_id, _params, toolSignal) {
        const ready = await ensureDocumentToolchain(venvDir, toolSignal);
        if (!ready) throw new Error("文档解析环境不可用，请联系管理员检查 uv、网络或部署依赖");
        return { content: [{ type: "text", text: "解析环境已验证，PI_PYTHON=" + venvPythonPath(venvDir) }], details: {} };
      },
    }],
  });
  record.session = session;
  record.unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") record.lastTool = event.toolName;
    if (event.type === "auto_retry_start") log.warn("模型自动重试: " + event.errorMessage);
  });
  signal.throwIfAborted();
  return session;
}

export async function initializeAgentRuntime(): Promise<void> { await getRuntime(); }

async function run(record: SessionRecord, content: string, cancellation: AbortSignal): Promise<void> {
  const signal = AbortSignal.any([application.signal, cancellation, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
  record.notes.clear();
  record.deliveryId = undefined;
  let session: AgentSession | undefined;
  let abortTask: Promise<void> | undefined;
  const onAbort = () => {
    if (session) abortTask ??= session.abort().catch((error) => log.warn("Pi abort: " + String(error)));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    store().assertCapacity(record.key);
    session = record.session ?? await createSession(record, signal);
    if (signal.aborted) { onAbort(); signal.throwIfAborted(); }
    await refreshIndex(record, signal);
    record.queue.phase = "执行中";
    // A status message is disposable and cannot delay model execution.
    const status = sendText("🤔 正在处理...", record.groupId, record.phone, record.callbackUrl,
      { traffic: "status", signal }).catch(() => false);
    application.track(status);
    await session.prompt(content);
    signal.throwIfAborted();
    const failure = session.state.errorMessage;
    const text = session.getLastAssistantText();
    const appendix = record.notes.peek().join("\n\n");
    if (failure) throw new Error(failure);
    if (!text && !appendix) throw new Error("Pi 未返回回复");
    const body = text || "文件链接已生成。";
    // Persist before entering the network queue; /deliver can recover after stop/restart.
    record.deliveryId = store().save(record.key, [body, appendix].filter(Boolean).join("\n\n"), record.deliveryId);
    record.queue.phase = "交付中";
    const sent = await sendReplyWithMention(body, record.groupId, record.phone, record.callbackUrl, signal, appendix || undefined);
    if (!sent) throw new Error("回复未送达，内容已保存，可使用 /deliver 重试");
    store().acknowledge([record.deliveryId]);
    record.notes.clear();
  } catch (error) {
    if (cancellation.aborted || application.signal.aborted) return;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await abortTask;
    record.lastUsed = Date.now();
  }
}

/** Control action is immediate; its network receipt is separately bounded/coalesced. */
export async function handleUserMessage(phone: string, groupId: string, content: string, callbackUrl: string): Promise<void> {
  application.signal.throwIfAborted();
  const record = getRecord(phone, groupId, callbackUrl);
  if (!isSlashCommandMessage(content)) return record.queue.enqueue((signal) => run(record, stripLeadingMention(content), signal));
  const command = canonicalCommand(content);
  let reply: string;
  if (command === "/stop") {
    await record.queue.cancel();
    reply = "⏹ 当前任务及排队消息已停止。未送达内容已保留，可用 /deliver 重试。";
  } else if (command === "/clear") {
    record.queue.cancel();
    await record.queue.enqueue(async () => {
      await ensureStorageIdentity(GROUP_DATA_ROOT, groupId, phone);
      await disposeSession(record);
      await archiveFile(sessionFilePath(GROUP_DATA_ROOT, groupId, phone));
    });
    reply = "🧹 本群会话历史已归档，下条消息将开启新会话。未送达内容仍可用 /deliver 查看。";
  } else if (command === "/deliver") {
    return record.queue.enqueue(async (cancel) => {
      const signal = AbortSignal.any([application.signal, cancel]);
      const pending = store().pending(record.key);
      if (!pending.length) { await sendText("没有未送达内容。", groupId, phone, callbackUrl, { signal }); return; }
      for (const item of pending) {
        if (!await sendText(item.text, groupId, phone, record.callbackUrl, { signal })) throw new Error("补发失败，未送达内容继续保留");
        store().acknowledge([item.id]);
      }
    });
  } else if (command === "/status") {
    const rate = getOutboundRateStatus(callbackUrl);
    reply = "状态：" + record.queue.phase + "\n排队消息：" + record.queue.waiting +
      "\n最近工具：" + (record.lastTool ?? "无") + "\n未送达记录：" + store().pending(record.key).length +
      "\n机器人发送窗口：" + rate.used + "/" + rate.limit;
  } else reply = command === "/help" ? HELP_TEXT : unknownCommandText(content);
  const receiptKey = record.key + command;
  if (controlReceipts.has(receiptKey) || controlReceipts.size >= 128) return;
  const receipt = sendText(reply, groupId, phone, record.callbackUrl, { signal: application.signal })
    .catch((error) => log.warn("控制指令回执失败: " + String(error)))
    .finally(() => controlReceipts.delete(receiptKey));
  controlReceipts.set(receiptKey, application.track(receipt));
}

export async function cleanupIdleSessions(now = Date.now()): Promise<void> {
  for (const [key, record] of records) {
    if (record.queue.busy || now - record.lastUsed < SESSION_IDLE_TTL) continue;
    const lastUsed = record.lastUsed;
    try {
      // Keep the same record until disposal finishes; arriving messages queue behind it.
      await record.queue.enqueue(() => disposeSession(record));
      if (!record.queue.busy && record.lastUsed === lastUsed && records.get(key) === record) records.delete(key);
    } catch (error) {
      if (application.signal.aborted) return;
      // Keep the failed record available for a later retry, but continue disposing other idle sessions.
      log.warn(`空闲会话释放失败，保留待重试 - 群: ${record.groupId}, 用户: ${record.phone}, 错误: ${String(error)}`);
    }
  }
}

async function disposeSession(record: SessionRecord): Promise<void> {
  record.unsubscribe?.();
  record.unsubscribe = undefined;
  await record.session?.dispose();
  record.session = undefined;
}

export async function disposeAllSessions(): Promise<void> {
  application.abort();
  abortOutboundRequests();
  const all = [...records.values()];
  await Promise.allSettled(all.map(async (record) => {
    await record.queue.close();
    await disposeSession(record);
  }));
  records.clear();
}
