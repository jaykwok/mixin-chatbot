// Pi agent 集成：用 pi-coding-agent 的 AgentSession + SessionManager 内嵌大脑。
// Provider 参数化（AI_BASE_URL/AI_API_KEY/DEFAULT_MODEL），支持 DashScope/DeepSeek/智谱等
// 任意 openai-completions 兼容端点，改 config 即可切换。会话持久化到 data/sessions/<phone>.jsonl。
import { join } from "node:path";
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BASE_URL, DEFAULT_GROUP_CONFIG, GROUP_CONFIGS, MODEL, PROVIDER } from "./config.ts";
import { log } from "./log.ts";
import { sendReplyWithMention, sendText } from "./im.ts";

// provider id（来自 config.PROVIDER，自洽：model.provider 与 provider.id 一致即可）
const PROVIDER_ID = PROVIDER;

function buildModel(modelId: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 8192,
  };
}

function buildProvider() {
  return createProvider({
    id: PROVIDER_ID,
    name: "AI Provider",
    baseUrl: BASE_URL,
    auth: { apiKey: envApiKeyAuth("AI API key", ["API_KEY"]) },
    models: [buildModel(MODEL)],
    api: openAICompletionsApi(),
  });
}

// ModelRuntime 单例（注册 provider，所有 session 共享）
let modelRuntime: ModelRuntime | null = null;
async function getModelRuntime(): Promise<ModelRuntime> {
  if (!modelRuntime) {
    modelRuntime = await ModelRuntime.create();
    modelRuntime.registerNativeProvider(buildProvider());
    log.info(`Pi ModelRuntime 初始化完成（provider=${PROVIDER}, baseUrl=${BASE_URL}, model=${MODEL}）`);
  }
  return modelRuntime;
}

function resolveModelId(groupId: string): string {
  return GROUP_CONFIGS[groupId]?.model ?? MODEL;
}

type AgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

// 每用户 AgentSession 缓存（内存）。注：第一步未做 LRU 上限清理。
const sessions = new Map<string, { session: AgentSession; modelId: string }>();

async function getOrCreateSession(phone: string, groupId: string): Promise<AgentSession> {
  const modelId = resolveModelId(groupId);
  const existing = sessions.get(phone);
  if (existing && existing.modelId === modelId) return existing.session;
  if (existing) {
    try {
      await existing.session.dispose();
    } catch {
      /* 忽略 dispose 错误 */
    }
  }

  const runtime = await getModelRuntime();
  const sessionManager = SessionManager.open(join("data", "sessions", `${phone}.jsonl`));
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: "./data", // 隔离 Pi 的 context：避免读到项目根的 README/AGENTS.md 污染对话
    agentDir: "./.pi",
    settingsManager,
    systemPrompt: DEFAULT_GROUP_CONFIG.system_prompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: "./data", // 同上，隔离 context
    model: buildModel(modelId),
    modelRuntime: runtime,
    sessionManager,
    settingsManager,
    resourceLoader,
    noTools: "all",
    thinkingLevel: "off",
  });
  sessions.set(phone, { session, modelId });
  return session;
}

/** 工具执行进度：订阅 Pi 事件，每个 tool_execution_start 发一条 text@ 进度。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onToolProgress(event: any, groupId: string, phone: string, callbackUrl: string): void {
  if (event?.type === "tool_execution_start" && event.toolName) {
    sendText(`🔧 正在执行：${event.toolName}...`, groupId, phone, callbackUrl).catch((e) =>
      log.error(`工具进度发送失败 - 用户: ${phone}, 错误: ${String(e)}`)
    );
  }
}

/** 处理用户消息：开始 text@ 反馈 → Pi 推理（工具事件实时进度）→ 完成 markdown 正文。 */
export async function handleUserMessage(
  phone: string,
  groupId: string,
  content: string,
  callbackUrl: string
): Promise<void> {
  const session = await getOrCreateSession(phone, groupId);
  // 开始反馈：让用户知道已收到、正在处理（@ 触发通知）
  await sendText("🤔 正在思考...", groupId, phone, callbackUrl);
  // 订阅工具执行事件 → 每步 text@ 进度（agent 启用工具后生效；第一步 noTools 无工具事件）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsub: (() => void) | undefined =
    typeof session.subscribe === "function"
      ? (session.subscribe((event: any) =>
          onToolProgress(event, groupId, phone, callbackUrl)
        ) as (() => void) | undefined)
      : undefined;

  const start = Date.now();
  try {
    await session.prompt(content);
    const reply = session.getLastAssistantText();
    if (!reply) throw new Error("Pi 未返回回复");
    log.info(
      `Pi 回复完成 - 用户: ${phone}, 耗时: ${((Date.now() - start) / 1000).toFixed(2)}秒, 长度: ${reply.length}`
    );
    await sendReplyWithMention(reply, groupId, phone, callbackUrl);
  } finally {
    try {
      unsub?.();
    } catch {
      /* 忽略 */
    }
  }
}

/** 应用关闭时释放所有 session。 */
export async function disposeAllSessions(): Promise<void> {
  for (const [, entry] of sessions) {
    try {
      await entry.session.dispose();
    } catch {
      /* 忽略 */
    }
  }
  sessions.clear();
}
