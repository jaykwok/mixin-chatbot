import { join } from "node:path";

/** Repository-local persistent storage layout. */
export const DATA_DIR = "data";
export const CONFIG_DIR = join(DATA_DIR, "config");
export const STATE_DIR = join(DATA_DIR, "state");
export const RUNTIME_DIR = join(DATA_DIR, "runtime");
export const DEFAULT_GROUP_DATA_ROOT = join(DATA_DIR, "groups");

/** User-managed configuration and secrets. */
export const MODELS_JSON_PATH = join(CONFIG_DIR, "models.json");
export const WEBHOOK_SECRET_FILE = join(CONFIG_DIR, "webhook-secret");
/** 可选：大文件外链分发的 WebDAV 后端；缺失即关闭该特性。 */
export const RELAY_CONFIG_PATH = join(CONFIG_DIR, "relay.json");
export const RUNTIME_CONFIG_PATH = join(CONFIG_DIR, "runtime.json");
export const STATE_DATABASE_PATH = join(STATE_DIR, "agent.sqlite");

/** Rebuildable process-local Pi resources; conversation history lives under GROUP_DATA_ROOT. */
export const PI_AGENT_DIR = join(RUNTIME_DIR, "pi");
/**
 * Pi 模型目录缓存与用户配置分开保存。当前应用显式禁用模型目录联网刷新。
 */
export const MODELS_STORE_PATH = join(RUNTIME_DIR, "models-store.json");
/** 远端对象清理账本；需要备份，不能作为缓存删除。 */
export const RELAY_INDEX_PATH = join(STATE_DIR, "relay.sqlite");
