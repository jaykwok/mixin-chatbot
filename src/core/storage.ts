import { join } from "node:path";

/** Repository-local persistent storage layout. */
export const DATA_DIR = "data";
export const CONFIG_DIR = join(DATA_DIR, "config");
export const STATE_DIR = join(DATA_DIR, "state");
export const RUNTIME_DIR = join(DATA_DIR, "runtime");
export const DEFAULT_GROUP_DATA_ROOT = join(DATA_DIR, "groups");

/**
 * User-managed configuration and secrets.
 *
 * models.json 是 Pi 自己的格式：声明服务商、凭证和模型，由 Pi 解析和校验。它放在
 * data/config 而不是 Pi 默认的 agent 目录，是为了让备份、权限和「哪些文件必须保留」
 * 这几件事只有一个入口。选中哪个模型另存在 PI_SETTINGS_PATH。
 */
export const MODELS_JSON_PATH = join(CONFIG_DIR, "models.json");
export const WEBHOOK_SECRET_FILE = join(CONFIG_DIR, "webhook-secret");
/** 可选：大文件外链分发的 WebDAV 后端；缺失即关闭该特性。 */
export const RELAY_CONFIG_PATH = join(CONFIG_DIR, "relay.json");
export const RUNTIME_CONFIG_PATH = join(CONFIG_DIR, "runtime.json");
export const STATE_DATABASE_PATH = join(STATE_DIR, "agent.sqlite");

/**
 * 项目私有的 Pi agent 目录，就是 Pi 各处 agentDir 参数指的那个目录；会话历史另存在
 * GROUP_DATA_ROOT 下。目录里除可重建资源外还有 settings.json，删掉会丢选型，要备份。
 */
export const PI_AGENT_DIR = join(RUNTIME_DIR, "pi");
/**
 * Pi 原生设置：选中的服务商、模型和推理级别，由 Pi 的 SettingsManager 读写，位置就是
 * Pi 对 agentDir 的默认约定。
 */
export const PI_SETTINGS_PATH = join(PI_AGENT_DIR, "settings.json");
/**
 * Pi 模型目录缓存，与用户配置分开保存。只有配置向导会联网刷新它；机器人进程一律离线读，
 * 动态目录服务商依赖它离线启动；移除后需重新运行向导刷新目录。
 */
export const MODELS_STORE_PATH = join(RUNTIME_DIR, "models-store.json");
/** 远端对象清理账本；需要备份，不能作为缓存删除。 */
export const RELAY_INDEX_PATH = join(STATE_DIR, "relay.sqlite");
