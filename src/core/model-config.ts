// Pi 原生模型接线。服务商和凭证来自 models.json，选型来自 Pi settings.json。
// 启动和 doctor 只读本地配置；只有向导能刷新并提交模型目录缓存。
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  clampThinkingLevel, InMemoryCredentialStore, InMemoryModelsStore,
  type Api, type Model, type ModelsStoreEntry, type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { MODELS_JSON_PATH, MODELS_STORE_PATH, PI_SETTINGS_PATH } from "./storage.ts";

// Pi 没有从包入口导出这两个类型，用它自己的方法签名取，避免抄一份结构定义出来。
type PiSettings = Parameters<SettingsManager["applyOverrides"]>[0];
type PiSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

/** 与 Pi 的缺省值一致。服务端要在建会话前就把级别定下来并写进日志，所以显式取一次。 */
const FALLBACK_THINKING_LEVEL: ModelThinkingLevel = "medium";

/**
 * 运行策略，不进配置文件：这些值和任务超时、失败回执的行为绑在一起，改一个要连带改
 * 另一个，交给管理员单独调只会调出不一致的组合。
 */
const AGENT_SETTINGS: PiSettings = {
  retry: {
    enabled: true, maxRetries: 1, baseDelayMs: 1000, maxAgentDelayMs: 5000,
    provider: { timeoutMs: 120000, maxRetries: 1, maxRetryDelayMs: 5000 },
  },
  compaction: { enabled: true },
  enableAnalytics: false,
  enableInstallTelemetry: false,
  enableSkillCommands: false,
};

interface OpenModelRuntimeOptions {
  signal?: AbortSignal;
  modelsPath?: string;
  modelsStorePath?: string;
  /** 只供向导的暂存目录使用；其他调用连读取缓存都不申请磁盘锁。 */
  writableCatalog?: boolean;
}

/** Pi 的目录缓存是 provider ID 到 ModelsStoreEntry 的映射；恢复到它自己的内存 store。 */
async function modelCatalogSnapshot(path: string): Promise<InMemoryModelsStore> {
  const store = new InMemoryModelsStore();
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return store;
    throw error;
  }
  const entries = JSON.parse(content.replace(/^\uFEFF/, "")) as Record<string, ModelsStoreEntry>;
  for (const [providerId, entry] of Object.entries(entries)) await store.write(providerId, entry);
  return store;
}

export async function openModelRuntime(options: OpenModelRuntimeOptions = {}): Promise<ModelRuntime> {
  const modelsPath = options.modelsPath ?? MODELS_JSON_PATH;
  const modelsStorePath = options.modelsStorePath ?? MODELS_STORE_PATH;
  const runtime = await ModelRuntime.create({
    modelsPath,
    modelsStorePath,
    modelsStore: options.writableCatalog ? undefined : await modelCatalogSnapshot(modelsStorePath),
    // 不接入磁盘 auth.json：Key 和环境/命令引用统一由 Pi 从 models.json 解析。
    credentials: new InMemoryCredentialStore(),
    allowModelNetwork: false,
    signal: options.signal,
  });
  // Pi 把 models.json 的读取、JSON 和 schema 错误收在 getError() 里，不抛异常。
  const error = runtime.getError();
  if (error) throw new Error(`${modelsPath}: ${error}`);
  return runtime;
}

/**
 * 只读的全局设置后端，不访问群工作区，也不创建 proper-lockfile 锁文件。
 */
function readOnlySettingsStorage(readGlobal: () => string | undefined): PiSettingsStorage {
  return {
    withLock(scope, read) {
      // 返回值的含义是「把这段内容写回去」，只读视图直接丢掉。
      read(scope === "global" ? readGlobal() : undefined);
    },
  };
}

/** 每个会话拥有独立的可变 SDK 视图，reload 仍回到实例启动时的只读策略。 */
export function forkSettings(settings: SettingsManager): SettingsManager {
  const snapshot = JSON.stringify(settings.getGlobalSettings());
  return SettingsManager.fromStorage(readOnlySettingsStorage(() => snapshot), { projectTrusted: false });
}

/**
 * Pi 原生设置管理器，全局作用域读项目私有 agent 目录下的 settings.json。
 *
 * 项目作用域必须关掉：agent 的 cwd 是群共享工作区，群成员能往里传文件，也就能放一个
 * .pi/settings.json 进去改模型和运行策略。
 */
export function openSettings(path = PI_SETTINGS_PATH): SettingsManager {
  const settings = SettingsManager.fromStorage(readOnlySettingsStorage(
    () => existsSync(path) ? readFileSync(path, "utf8") : undefined
  ), { projectTrusted: false });
  const failures = settings.drainErrors();
  // 设置文件坏了就是选型信息坏了，不能退回默认模型继续跑。
  if (failures.length) {
    throw new Error(`${path}: ${failures.map((failure) => failure.error.message).join("; ")}`);
  }
  // Pi 先解析原生设置，再固定本进程的全局视图。策略必须进入 storage 的内容：
  // applyOverrides() 会被 SDK 的 resourceLoader.reload() 清掉，且单例会影响其他会话。
  const configured = settings.getGlobalSettings();
  if (configured.cacheWarming !== undefined && !["off", "streaming", "idle"].includes(configured.cacheWarming)) {
    throw new Error(`${path}: cacheWarming 必须是 off、streaming 或 idle`);
  }
  const snapshot = JSON.stringify({
    ...configured,
    ...AGENT_SETTINGS,
    compaction: { ...configured.compaction, ...AGENT_SETTINGS.compaction },
    // Pi 0.86 默认 streaming；服务器必须由管理员显式开启额外的模型请求。
    cacheWarming: configured.cacheWarming ?? "off",
  });
  return SettingsManager.fromStorage(readOnlySettingsStorage(() => snapshot), { projectTrusted: false });
}

interface ModelSelection {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
}

/**
 * 解析本实例固定使用的那一个模型。
 *
 * 不做「取第一个可用模型」的兜底：配置缺失、模型不存在或凭证缺失都必须在启动时报出
 * 来，而不是换一个管理员没选过的模型去回群消息。
 */
export async function resolveModelSelection(
  runtime: ModelRuntime, settings: SettingsManager, options: { signal?: AbortSignal } = {}
): Promise<ModelSelection> {
  const providerId = settings.getDefaultProvider();
  const modelId = settings.getDefaultModel();
  if (!providerId || !modelId) {
    throw new Error(`${PI_SETTINGS_PATH} 未记录 defaultProvider/defaultModel，请运行 bun run configure`);
  }
  const model = runtime.getModel(providerId, modelId);
  if (!model) {
    throw new Error(`Pi 未提供 ${providerId}/${modelId}，请运行 bun run configure 重新选择`);
  }
  // Let Pi validate native per-model budgets during startup, before accepting work.
  settings.getCompactionSettings(model);
  const auth = await runtime.checkAuth(providerId, { signal: options.signal });
  if (!auth) {
    throw new Error(`provider ${providerId} 未配置可用凭证，请运行 bun run configure`);
  }
  const configured = settings.getModelThinkingLevel(providerId, modelId)
    ?? settings.getDefaultThinkingLevel()
    ?? FALLBACK_THINKING_LEVEL;
  return { model, thinkingLevel: clampThinkingLevel(model, configured) };
}
