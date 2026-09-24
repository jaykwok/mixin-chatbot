// SDK configuration and session construction. Task queues and delivery belong to runtime.ts.
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Type, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { GROUP_DATA_ROOT } from "../core/config.ts";
import { log } from "../core/log.ts";
import { PI_AGENT_DIR, RUNTIME_DIR } from "../core/storage.ts";
import { application } from "../core/lifecycle.ts";
import { getRelayConfig } from "../integrations/relay.ts";
import { groupIndexDir, groupVenvDir, groupWorkspaceDir, materialsIndexPath, sessionFilePath, userTempDir } from "./paths.ts";
import { ensureDocumentToolchain, venvPythonPath } from "./python-toolchain.ts";
import { buildLocalTools } from "./local-tools.ts";
import { buildSendTools, type OutboundNotes } from "./send-tools.ts";
import { buildChatContext } from "./prompt.ts";
import { runtimeSetting } from "../core/runtime-config.ts";
import { RUNTIME_DEFAULTS } from "../core/runtime-schema.ts";
import { ensureStorageIdentity } from "./storage-identity.ts";
import { forkSettings, openModelRuntime, openSettings, resolveModelSelection } from "../core/model-config.ts";
import { buildDocumentTool } from "./document-extract.ts";
import { loadAgentModules } from "./modules.ts";

// Pi 运行时单例：共享目录、选型和设置基线；创建会话时复制独立设置视图。
type RuntimeSelection = {
  runtime: ModelRuntime;
  settings: SettingsManager;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
};
let resolvedRuntime: RuntimeSelection | null = null;
let runtimePromise: Promise<RuntimeSelection> | null = null;

export async function getRuntime(): Promise<RuntimeSelection> {
  if (resolvedRuntime) return resolvedRuntime;
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    // 仅在机器人初始化时映射到 Pi 原生环境；配置编辑器导入模块不改变环境优先级。
    // Provider 与 warmer 读取同一配置，摘要的显式 cacheRetention:none 仍优先。
    const retention = runtimeSetting("PI_CACHE_RETENTION");
    if (retention) process.env.PI_CACHE_RETENTION = retention;
    // Pi 默认把模型目录缓存写在 models.json 旁边；显式指向 data/runtime，让
    // data/config 里只剩用户真正要维护的东西。首次写入前目录必须存在。
    await mkdir(RUNTIME_DIR, { recursive: true });
    const runtime = await openModelRuntime({ signal: application.signal });
    const settings = openSettings();
    const { model, thinkingLevel } = await resolveModelSelection(runtime, settings, { signal: application.signal });
    resolvedRuntime = { runtime, settings, model, thinkingLevel };
    log.info(
      `Pi ModelRuntime 就绪（provider=${model.provider}, model=${model.id}, api=${model.api}, thinkingLevel=${thinkingLevel}, cacheWarming=${settings.getCacheWarmingMode()}, 群数据总根=${GROUP_DATA_ROOT}）`
    );
    return resolvedRuntime;
  })();

  try {
    return await runtimePromise;
  } catch (e) {
    runtimePromise = null;
    throw e;
  }
}


interface SessionOptions {
  phone: string;
  groupId: string;
  notes: OutboundNotes;
  getCallbackUrl: () => string;
}

export async function createChatSession(options: SessionOptions, signal: AbortSignal) {
  await ensureStorageIdentity(GROUP_DATA_ROOT, options.groupId, options.phone);
  signal.throwIfAborted();
  const { runtime, settings, model, thinkingLevel } = await getRuntime();
  const settingsManager = forkSettings(settings);
  signal.throwIfAborted();
  const cwd = resolve(groupWorkspaceDir(GROUP_DATA_ROOT, options.groupId));
  const tempDir = resolve(userTempDir(GROUP_DATA_ROOT, options.groupId, options.phone));
  const history = resolve(sessionFilePath(GROUP_DATA_ROOT, options.groupId, options.phone));
  const indexPath = resolve(materialsIndexPath(GROUP_DATA_ROOT, options.groupId));
  const venvDir = resolve(runtimeSetting("BOT_DOCUMENT_ENV") || groupVenvDir(GROUP_DATA_ROOT, options.groupId));
  for (const dir of [cwd, tempDir, dirname(history), PI_AGENT_DIR, groupIndexDir(GROUP_DATA_ROOT, options.groupId)]) {
    await mkdir(dir, { recursive: true });
  }
  const modules = await loadAgentModules({ workspaceDir: cwd, tempDir, indexPath, venvDir,
    documentWorkEnabled: (runtimeSetting("BOT_DOCUMENT_WORK_ENABLED") ?? RUNTIME_DEFAULTS.BOT_DOCUMENT_WORK_ENABLED) === "1" });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: resolve(PI_AGENT_DIR), settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    skillsOverride: () => modules.skills,
    systemPromptOverride: () => buildChatContext({ relayEnabled: !!getRelayConfig(), modulePrompt: modules.prompt }),
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  signal.throwIfAborted();
  const localTools = await buildLocalTools({ workspaceDir: cwd, tempDir, phone: options.phone,
    groupId: options.groupId, venvDir, materialsIndexPath: indexPath, resourceReadDirs: modules.readOnlyDirs });
  const { session } = await createAgentSession({
    cwd, agentDir: resolve(PI_AGENT_DIR), modelRuntime: runtime, model, thinkingLevel, settingsManager, resourceLoader,
    sessionManager: SessionManager.open(history, undefined, cwd),
    tools: ["read", "bash", "edit", "write", "send_image", "send_file", "document_environment", "document_extract",
      ...modules.tools.map(tool => tool.name)],
    customTools: [...localTools, buildDocumentTool({ workspaceDir: cwd, tempDir, indexPath, venvDir }),
      ...modules.tools, ...buildSendTools({
      getCallbackUrl: options.getCallbackUrl, groupId: options.groupId, workspaceDir: cwd, tempDir,
      relay: getRelayConfig(), notes: options.notes,
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
  return session;
}
