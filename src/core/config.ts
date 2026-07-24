// 全局参数与默认值。AI 配置由 data/models.json 承载（Pi 原生读取，见 src/agent/runtime.ts），
// 由 scripts/config/configure.ts 生成。Webhook 公网鉴权密钥存 data/webhook-secret（见 src/server/index.ts）。
// 无必需 .env/config.json；可选环境变量覆盖部署参数。访问控制由 webhook secret + 防火墙/WAF 共同承担。
// 所有时间常量统一毫秒（Date.now()/setTimeout 均为 ms）。

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

/** Pi 模型/provider 配置文件（持久卷 data/ 下）。 */
export const MODELS_JSON_PATH = "data/models.json";
/** Webhook 随机密钥路径文件（持久卷 data/ 下，64hex/256bit）。缺失或无效时服务默认拒绝启动。 */
export const WEBHOOK_SECRET_FILE = "data/webhook-secret";
/**
 * Pi 群数据总根：agent 的 cwd 是 <AGENT_DATA_ROOT>/<group>/workspace，当前调用用户的
 * 临时目录和会话分别位于 <AGENT_DATA_ROOT>/<group>/<phone>/tmp 与
 * <AGENT_DATA_ROOT>/<group>/<phone>/sessions/session.jsonl。
 * 默认 "data"（相对进程 cwd，即仓库 ./data）。部署时可经环境变量 AGENT_DATA_ROOT 覆盖
 * （绝对或相对路径均可；见 deploy.ps1 / deploy.sh）。应用仍零必需配置——未设时回落 ./data。
 */
export const AGENT_DATA_ROOT = process.env.AGENT_DATA_ROOT?.trim() || "data";

// ===== 服务 =====
export const PORT = integerEnv("BOT_PORT", 1011, 1, 65_535);
export const HOST = process.env.BOT_HOST?.trim() || "0.0.0.0";
/** 仅本地开发可显式开启无 secret 的 /webhook；生产默认失败关闭。 */
export const ALLOW_INSECURE_WEBHOOK = process.env.ALLOW_INSECURE_WEBHOOK === "1";
/** 详细日志会记录用户消息正文，默认关闭。 */
export const DEBUG = process.env.BOT_DEBUG === "1";
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

// ===== IM 服务 =====
export const IM_RETRY_COUNT = 2; // 总尝试次数（首次 + 1 次重试）
export const IM_RETRY_DELAY = 2000; // ms
export const IM_HTTP_TIMEOUT = 15_000; // 单次 webhook 发送超时
export const ATTACHMENT_HTTP_TIMEOUT = 60_000;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** 长任务心跳间隔：3 条/分钟，正常单任务远低于机器人发送限额。 */
export const AGENT_HEARTBEAT_INTERVAL = 20_000; // ms
/** 机器人出站发送滑动窗口（按 callback key 全局统计，多用户共享）。 */
export const IM_RATE_LIMIT_WINDOW = 60_000; // ms
export const IM_RATE_LIMIT_MAX_MESSAGES = 20;
/** 达到此用量后暂停可丢弃的心跳，为最终回复、指令和附件预留额度。 */
export const IM_HEARTBEAT_PAUSE_AT = 12;
/** 达到此用量后尝试向当前群发送一次压力预警（每窗口最多一次）。 */
export const IM_RATE_WARNING_AT = 16;

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
/** phone 合法字符集（用作群内用户目录名，同时防路径穿越）。 */
export const PHONE_PATTERN = /^[A-Za-z0-9_+\-]{1,32}$/;
/** groupId 可含 Unicode，但拒绝会污染日志或无法放入子进程环境的控制字符。 */
export const GROUP_ID_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
export const MAX_GROUP_ID_LENGTH = 256;
export const MAX_CALLBACK_URL_LENGTH = 2048;
/** 单条消息内容上限（防超大 payload）。 */
export const MAX_CONTENT_LENGTH = 16 * 1024;
export const DEDUP_TTL = 30_000; // 请求去重窗口（ms）
export const MAX_DEDUP_SIZE = 1000; // 去重字典最大容量

// ===== 速率限制 =====
export const RATE_LIMIT_WINDOW = 60_000; // ms
export const RATE_LIMIT_MAX_REQUESTS = 10;
export const RATE_LIMIT_CLEANUP_INTERVAL = 300_000; // ms

// ===== Session 缓存 =====
/** 空闲会话从内存释放；历史仍保留在 jsonl，下次自动重开。 */
export const SESSION_IDLE_TTL = 30 * 60_000;

// ===== 日志 =====
export const LOG_DIR = "logs";
export const LOG_FILE = "mixin-chatbot.log";
export const LOG_MAX_BYTES = 5 * 1024 ** 2; // 5MB
export const LOG_BACKUP_COUNT = 3;
