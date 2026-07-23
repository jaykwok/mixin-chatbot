// 全局常量。应用层零配置：AI 配置由 data/models.json 承载（Pi 原生读取，见 src/agent/agent.ts），
// 由 scripts/configure.ts 生成。Webhook 公网鉴权密钥存 data/webhook-secret（见 src/server/index.ts）。
// 无 .env、无 config.json；访问控制交给服务器防火墙 + Cloudflare WAF（公网）。
// 所有时间常量统一毫秒（Date.now()/setTimeout 均为 ms）。

/** Pi 模型/provider 配置文件（持久卷 data/ 下）。 */
export const MODELS_JSON_PATH = "data/models.json";
/** Webhook 随机密钥路径文件（持久卷 data/ 下，64hex/256bit）。存在 → 启用 /webhook/:secret；不存在 → 回退开放 /webhook（仅内网/本地）。 */
export const WEBHOOK_SECRET_FILE = "data/webhook-secret";

// ===== 服务 =====
export const PORT = 1011;
/** 详细日志（含 webhook 内容），观测用。 */
export const DEBUG = true;

// ===== IM 服务 =====
export const IM_RETRY_COUNT = 2; // 总尝试次数（首次 + 1 次重试）
export const IM_RETRY_DELAY = 2000; // ms

// ===== Webhook =====
export const VALID_HOSTNAMES = new Set(["imtwo.zdxlz.com", "im.zdxlz.com"]);
// 回调 URL 允许的端口（空集合表示仅允许默认 https 端口 443）
export const VALID_CALLBACK_PORTS = new Set<number>();
/** callBackUrl 必须命中此路径（量子密信出站发送端点）。 */
export const CALLBACK_PATH_PREFIX = "/im-external/v1/webhook/send";
export const REQUIRED_WEBHOOK_FIELDS = [
  "type",
  "textMsg",
  "phone",
  "groupId",
  "callBackUrl",
];
/** phone 合法字符集（用作会话文件名，同时防路径穿越）。 */
export const PHONE_PATTERN = /^[A-Za-z0-9_+\-]{1,32}$/;
/** 单条消息内容上限（防超大 payload）。 */
export const MAX_CONTENT_LENGTH = 16 * 1024;
export const DEDUP_TTL = 30_000; // 请求去重窗口（ms）
export const MAX_DEDUP_SIZE = 1000; // 去重字典最大容量

// ===== 速率限制 =====
export const RATE_LIMIT_WINDOW = 60_000; // ms
export const RATE_LIMIT_MAX_REQUESTS = 10;
export const RATE_LIMIT_CLEANUP_INTERVAL = 300_000; // ms

// ===== 日志 =====
export const LOG_DIR = "logs";
export const LOG_FILE = "mixin-chatbot.log";
export const LOG_MAX_BYTES = 5 * 1024 ** 2; // 5MB
export const LOG_BACKUP_COUNT = 3;
