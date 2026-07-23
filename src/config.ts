// 配置加载：从 .env 读取（Bun 原生 process.env），大小写兼容，启动校验必填项。
// 对应 Python 版 config.py。所有时间常量统一用毫秒（Date.now()/setTimeout 均为 ms）。

/** 大小写兼容读取环境变量：依次尝试原样、大写、小写。 */
function env(key: string, fallback?: string): string | undefined {
  for (const variant of [key, key.toUpperCase(), key.toLowerCase()]) {
    const v = process.env[variant];
    if (v !== undefined && v !== "") return v;
  }
  return fallback;
}

// ===== Provider 与模型（参数化）=====
// 支持 DashScope/DeepSeek/智谱等任意 openai-completions 兼容端点，改这几项即可切换。
// 命名不加 AI_ 前缀；向后兼容旧变量名（AI_BASE_URL/DASHSCOPE_API_KEY/DEFAULT_MODEL）。
export const PROVIDER = env("PROVIDER") ?? "dashscope"; // provider 标识（自洽即可，主要用于日志）
export const BASE_URL = env("BASE_URL") ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const API_KEY = env("API_KEY");
export const MODEL = env("MODEL") ?? "qwen3.7-plus";

export const APP_USERNAME = env("APP_USERNAME");
export const APP_PASSWORD = env("APP_PASSWORD");

const _required = { API_KEY, APP_USERNAME, APP_PASSWORD };
const _missing = Object.entries(_required)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (_missing.length) {
  throw new Error(`缺少必要环境变量: ${_missing.join(", ")}`);
}

// ===== AI 服务 =====
export const AI_TIMEOUT = 60_000; // ms
export const AI_MAX_RETRIES = 1;

// ===== IM 服务 =====
export const IM_TIMEOUT = 10_000; // ms
export const IM_RETRY_COUNT = 2; // 总尝试次数（首次 + 1 次重试）
export const IM_RETRY_DELAY = 2000; // ms

// ===== Webhook =====
export const VALID_HOSTNAMES = new Set(["imtwo.zdxlz.com", "im.zdxlz.com"]);
// 回调 URL 允许的端口（空集合表示仅允许默认 https 端口 443）
export const VALID_CALLBACK_PORTS = new Set<number>();
export const REQUIRED_WEBHOOK_FIELDS = [
  "type",
  "textMsg",
  "phone",
  "groupId",
  "callBackUrl",
];
export const DEDUP_TTL = 30_000; // 请求去重窗口（ms）
export const MAX_DEDUP_SIZE = 1000; // 去重字典最大容量

// ===== Webhook 鉴权 =====
const _robotIdsRaw = env("ROBOT_IDS", "") ?? "";
export const ALLOWED_ROBOT_IDS = new Set(
  _robotIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
);
const _allowedIpsRaw = env("ALLOWED_IPS", "") ?? "";
export const ALLOWED_IPS = new Set(
  _allowedIpsRaw.split(",").map((s) => s.trim()).filter(Boolean)
);

// ===== 速率限制 =====
export const RATE_LIMIT_WINDOW = 60_000; // ms
export const RATE_LIMIT_MAX_REQUESTS = 10;
export const RATE_LIMIT_CLEANUP_INTERVAL = 300_000; // ms
export const RATE_LIMIT_MAX_USERS = 10000;

// ===== 调试 =====
export const DEBUG = ["1", "true", "yes"].includes(
  (env("DEBUG", "0") ?? "0").toLowerCase()
);

// ===== 后台任务 =====
export const CLEANUP_INTERVAL = 300_000; // 过期会话清理间隔（ms）

// ===== 会话存储（Pi SessionManager 用，以下仅部分保留给管理/兼容）=====
export const SESSION_TIMEOUT = 0; // 0 表示永不过期
export const MAX_HISTORY_MESSAGES = 20; // 兼容（Pi SessionManager 自管历史）
export const MAX_CACHE_SIZE = 100;
export const MAX_ADMIN_SESSIONS = 500;

// ===== 日志 =====
export const LOG_DIR = "logs";
export const LOG_FILE = "mixin-chatbot.log";
export const LOG_MAX_BYTES = 5 * 1024 ** 2; // 5MB
export const LOG_BACKUP_COUNT = 3;

// ===== 群组配置（per-group 覆盖模型）=====
export interface GroupConfig {
  model: string;
}

export const DEFAULT_SYSTEM_PROMPT =
  "你是聊天机器人。请使用 Markdown 格式回复，恰当使用标题、**粗体**、列表、表格、代码块等让回复清晰易读。保持简洁、聚焦问题，避免过度装饰。";

export const DEFAULT_GROUP_CONFIG: GroupConfig & { system_prompt: string } = {
  model: MODEL,
  system_prompt: DEFAULT_SYSTEM_PROMPT,
};

// 从 .env 解析群组配置，格式: GROUP_CONFIGS=群组ID1:模型名1,群组ID2:模型名2
export const GROUP_CONFIGS: Record<string, GroupConfig> = {};
const _raw = env("GROUP_CONFIGS", "") ?? "";
for (const _item of _raw.split(",")) {
  const trimmed = _item.trim();
  if (trimmed.includes(":")) {
    const [gid, m] = trimmed.split(":", 2);
    GROUP_CONFIGS[gid.trim()] = { model: m.trim() };
  }
}
