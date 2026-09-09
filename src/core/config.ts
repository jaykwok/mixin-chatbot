// 全局参数与默认值。持久化目录统一由 src/core/storage.ts 定义：
// data/config 放配置与密钥，data/state 放持久账本与部署状态，data/runtime 放 SDK 运行资源，
// data/groups 放群共享工作区、用户临时文件与会话。
// 无必需 .env/config.json；可选环境变量覆盖部署参数。访问控制由 webhook secret + 防火墙/WAF 共同承担。
// 所有时间常量统一毫秒（Date.now()/setTimeout 均为 ms）。

import { DEFAULT_GROUP_DATA_ROOT } from "./storage.ts";
import { readFileSync } from "node:fs";
import { runtimeSetting } from "./runtime-config.ts";
import { documentPackages } from "../../scripts/runtime/document-manifest.ts";

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = runtimeSetting(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

/**
 * 群数据总根：agent 的 cwd 是 <GROUP_DATA_ROOT>/<group>/workspace，当前调用用户的
 * 临时目录和会话分别位于 <GROUP_DATA_ROOT>/<group>/users/<phone>/tmp 与
 * <GROUP_DATA_ROOT>/<group>/users/<phone>/session.jsonl。
 * 默认 data/groups。部署时可经 GROUP_DATA_ROOT 指向其他磁盘；配置、部署状态和 runtime
 * 仍固定在项目 data/ 的分类子目录中，避免运维脚本失去统一入口。
 */
export const GROUP_DATA_ROOT =
  runtimeSetting("GROUP_DATA_ROOT") || DEFAULT_GROUP_DATA_ROOT;

// ===== 服务 =====
export const PORT = integerEnv("BOT_PORT", 1011, 1, 65_535);
export const HOST = runtimeSetting("BOT_HOST") || "0.0.0.0";
/** 仅本地开发可显式开启无 secret 的 /webhook；生产默认失败关闭。 */
export const ALLOW_INSECURE_WEBHOOK = process.env.ALLOW_INSECURE_WEBHOOK === "1";
/** 详细日志会记录用户消息正文，默认关闭。 */
export const DEBUG = runtimeSetting("BOT_DEBUG") === "1";
export const RUN_TIMEOUT_MS = integerEnv("BOT_RUN_TIMEOUT_SECONDS", 1200, 10, 7200) * 1000;
/** Only model waiting/streaming; raw tool deltas do not renew this budget without parsed changes. */
export const MODEL_IDLE_TIMEOUT_MS = integerEnv("BOT_MODEL_IDLE_TIMEOUT_SECONDS", 180, 10, 7200) * 1000;
/** Per response, including time to first content; even continuous progress cannot renew it. */
export const MODEL_RESPONSE_TIMEOUT_MS = integerEnv("BOT_MODEL_RESPONSE_TIMEOUT_SECONDS", 600, 10, 7200) * 1000;
export const SHUTDOWN_TIMEOUT_MS = integerEnv("BOT_SHUTDOWN_TIMEOUT_SECONDS", 20, 5, 25) * 1000;
export const DELIVERY_TIMEOUT_MS = integerEnv("BOT_DELIVERY_TIMEOUT_SECONDS", 180, 1, 600) * 1000;
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

// ===== IM 服务 =====
export const IM_RETRY_COUNT = 2; // 总尝试次数（首次 + 1 次重试）
export const IM_RETRY_DELAY = 2000; // ms
export const IM_HTTP_TIMEOUT = 15_000; // 单次 webhook 发送超时
/** 官方 textMsg.content 单条上限。 */
export const IM_TEXT_MAX_LENGTH = 5000;
export const ATTACHMENT_HTTP_TIMEOUT = 60_000;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** 外链分发总预算，包含快照、等锁、探测和 PUT；同时受整轮任务和 /stop 取消约束。 */
export const RELAY_HTTP_TIMEOUT = 30 * 60_000;
/** 复用去重索引里的地址前，探测它是否还活着的超时。 */
export const RELAY_PROBE_TIMEOUT = 15_000;
/** 机器人出站发送滑动窗口（按 callback key 全局统计，多用户共享）。 */
export const IM_RATE_LIMIT_WINDOW = 60_000; // ms
export const IM_RATE_LIMIT_MAX_MESSAGES = 20;
/** 达到此用量后暂停可丢弃的状态消息，为最终回复、指令和附件预留额度。 */
export const IM_STATUS_PAUSE_AT = 12;
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
/** groupId 可含 Unicode，但拒绝控制字符和 Unicode 行分隔符。 */
export const GROUP_ID_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
export const MAX_GROUP_ID_LENGTH = 256;
export const MAX_CALLBACK_URL_LENGTH = 2048;
/** 单条消息内容上限（防超大 payload）。 */
export const MAX_CONTENT_LENGTH = 16 * 1024;
export const DEDUP_TTL = 30_000; // 请求去重窗口（ms）
export const MAX_DEDUP_SIZE = 1000; // 去重字典最大容量
/** callback key 到群路由观察的闲置保留时间与容量；超限时对未知 key 失败关闭。 */
export const CALLBACK_ROUTE_TTL = 24 * 60 * 60_000;
export const MAX_CALLBACK_ROUTES = 1000;

// ===== 速率限制 =====
export const RATE_LIMIT_WINDOW = 60_000; // ms
/** 本应用自设的入站防滥用阈值；与自定义 Webhook 机器人官方 20 RPM 出站额度无关。 */
export const RATE_LIMIT_MAX_REQUESTS = 10;
/** 入站限流键容量；容量耗尽时把新 (群, phone) 按限流处理并回调通知，避免内存无界增长。 */
export const MAX_RATE_LIMIT_KEYS = 10_000;
export const RATE_LIMIT_CLEANUP_INTERVAL = 300_000; // ms
/** 已确认但尚未完成清理的 Pi 后台任务总数；超限时通过 callback 通知用户重发。 */
export const MAX_ACTIVE_REQUESTS = integerEnv(
  "BOT_MAX_ACTIVE_REQUESTS",
  32,
  1,
  1000
);

// ===== Agent 工具 =====
/**
 * 模型没有显式声明 timeout 时，注入给 bash 工具的默认上限（秒）。
 * 同时受整轮期限和取消信号约束；模型声明的 timeout 最大为 3600 秒。
 */
export const BASH_DEFAULT_TIMEOUT = integerEnv("BOT_BASH_TIMEOUT", 600, 10, 3600);

// ===== 资料索引 =====
/**
 * 每轮检查索引是否过期；首次等待构建，之后返回旧索引并在后台刷新。
 */
export const MATERIALS_INDEX_TTL = integerEnv(
  "BOT_INDEX_TTL_MINUTES",
  5,
  1,
  1440
) * 60_000;
/** 单次扫描收录的文件数上限，防止异常巨大的目录树吃光内存与磁盘。 */
export const MATERIALS_INDEX_MAX_FILES = integerEnv(
  "BOT_INDEX_MAX_FILES",
  50_000,
  100,
  1_000_000
);
/** 目录递归深度上限；跳过更深分支并将索引标为不完整。 */
export const MATERIALS_INDEX_MAX_DEPTH = integerEnv("BOT_INDEX_MAX_DEPTH", 12, 1, 64);

// ===== 文档解析环境 =====
/**
 * 解析和生成文档的直接依赖，完整依赖锁为 requirements.txt。
 * 能力工具检查解释器、包版本及导入结果；标记只用于识别配置，不作为就绪依据。
 * 使用指定环境、预装项目 .venv 或按需准备的群 venv；模型不能修改共享环境。
 */
export const DOCUMENT_TOOLCHAIN_PACKAGES: readonly string[] = documentPackages(readFileSync(
  new URL("../../scripts/runtime/requirements.in", import.meta.url), "utf8"
));
/** 建环境、装包与验证的总时限（ms）；失败由能力工具明确返回。 */
export const DOCUMENT_TOOLCHAIN_TIMEOUT = 10 * 60_000;

// ===== Session 缓存 =====
/** 空闲会话从内存释放；历史仍保留在 jsonl，下次自动重开。 */
export const SESSION_IDLE_TTL = 30 * 60_000;

// ===== 日志 =====
export const LOG_DIR = "logs";
export const LOG_FILE = "mixin-chatbot.log";
export const LOG_MAX_BYTES = 5 * 1024 ** 2; // 5MB
export const LOG_BACKUP_COUNT = 3;
