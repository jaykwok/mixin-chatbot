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
export const TUNNEL_TOKEN_FILE = join(CONFIG_DIR, "tunnel-token");
/** 可选：大文件外链分发的 WebDAV 后端；缺失即关闭该特性。 */
export const RELAY_CONFIG_PATH = join(CONFIG_DIR, "relay.json");

/** Deployment-generated state shared by deploy, ops and tunnel scripts. */
export const BOT_PORT_FILE = join(STATE_DIR, "bot-port");
export const DEPLOY_MODE_FILE = join(STATE_DIR, "deploy-mode");
export const BOT_DOMAIN_FILE = join(STATE_DIR, "bot-domain");
export const GROUP_DATA_ROOT_FILE = join(STATE_DIR, "group-data-root");

/** Rebuildable process-local Pi resources; conversation history lives under GROUP_DATA_ROOT. */
export const PI_AGENT_DIR = join(RUNTIME_DIR, "pi");
/** 外链去重索引（内容哈希 -> 已上传地址）。丢失只会导致重传一次，因此归在 runtime。 */
export const RELAY_INDEX_PATH = join(RUNTIME_DIR, "relay-index.jsonl");
