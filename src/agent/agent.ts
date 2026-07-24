// Pi agent 集成：用 pi-coding-agent 的 AgentSession + SessionManager 内嵌大脑。
// 纯适配——只用 Pi 公开 API：
//   - provider/model/key 由 data/models.json 承载，Pi 原生读取（ModelRuntime.create({modelsPath})）
//   - 内置工具 read/bash/edit/write 由 createAgentSession 自动构建（按 tools 名启用），绑定 cwd=AGENT_CWD（默认 ./data，可经环境变量覆盖）
//   - 发送工具 send_image/send_file 经 customTools（ToolDefinition）注册，定义在 ./tools.ts
//   - system prompt 用 Pi 默认 + appendSystemPromptOverride 追加最小群聊/中文上下文（方便上游升级）
// 会话持久化到 data/sessions/<phone>.jsonl。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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

// 每用户 AgentSession 缓存（内存）。
const sessions = new Map<string, AgentSession>();

/** 追加到 Pi 默认 system prompt 的最小上下文（群聊 + 中文）。刻意最小化，方便 Pi 上游升级。 */
const CHAT_CONTEXT = `## 运行环境
你在「量子密信」群聊机器人里。用户用中文 @你 提问，请用中文、用 Markdown 简洁回复。纯文字回复会自动发到群里。`;

/** 把 groupId 解析为安全的会话文件名片段：符合标识符字符集则原样用，否则用 sha256 片段。
 *  绝不把原始 groupId 直接拼进路径（防路径穿越）；哈希兜底——不拒绝任何合法 id，且无碰撞。 */
function safeGroupSegment(groupId: string): string {
  return /^[A-Za-z0-9_+\-]{1,64}$/.test(groupId)
    ? groupId
    : createHash("sha256").update(groupId, "utf8").digest("hex").slice(0, 16);
}

async function getOrCreateSession(phone: string, groupId: string, callbackUrl: string): Promise<AgentSession> {
  const key = `${phone}:${groupId}`;
  const existing = sessions.get(key);
  if (existing) return existing;

  const { runtime, model } = await getRuntime();
  // 会话按 (phone, 群) 隔离：同一人在不同群各自独立历史；文件名 = phone.<group段>.jsonl
  const sessionManager = SessionManager.open(
    join("data", "sessions", `${phone}.${safeGroupSegment(groupId)}.jsonl`)
  );
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
  const session = await getOrCreateSession(phone, groupId, callbackUrl);
  // 开始反馈：让用户知道已收到、正在处理（@ 触发通知）
  await sendText("🤔 正在思考...", groupId, phone, callbackUrl);
  // 订阅工具执行事件 → 每步 text@ 进度（agent 调 read/bash/send_* 等工具时触发）
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
  for (const [, session] of sessions) {
    try {
      await session.dispose();
    } catch {
      /* 忽略 */
    }
  }
  sessions.clear();
}
