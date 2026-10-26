// 全局参数与默认值。持久化目录统一由 src/core/storage.ts 定义：
// data/config 放配置与密钥，data/state 放持久账本与部署状态，data/runtime 放 SDK 运行资源；
// 资料、索引、会话库与临时文件的布局见 src/core/layout.ts。
// 无必需 .env/config.json；可选环境变量覆盖部署参数。消息只经平台 Stream 入站，HTTP 只监听回环地址。
// 计时和期限常量使用毫秒；bash 工具的 timeout 参数使用秒。

import { DATA_DIR } from "./storage.ts";
import { appLayout } from "./layout.ts";
import { readFileSync } from "node:fs";
import { runtimeSetting } from "./runtime-config.ts";
import { RUNTIME_DEFAULTS, RUNTIME_RANGES } from "./runtime-schema.ts";
import { documentPackages } from "../../scripts/runtime/document-manifest.ts";

function integerEnv(name: keyof typeof RUNTIME_RANGES): number {
  const [min, max] = RUNTIME_RANGES[name];
  const raw = runtimeSetting(name);
  if (!raw) return Number(RUNTIME_DEFAULTS[name]);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

/**
 * 应用数据布局：全部单聊和群聊共用的资料 workspace（默认 data/workspace，WORKSPACE_ROOT 可指向外置目录，相对路径
 * 以项目根解析），以及固定在 data 下的索引、会话库、临时文件和统计。启动后固定，改资料路径需重启。
 */
export const LAYOUT = appLayout(DATA_DIR, runtimeSetting("WORKSPACE_ROOT"));

// ===== 服务 =====
export const PORT = integerEnv("BOT_PORT");
/**
 * HTTP 只供本机的 TUI、/health 与 /_admin/shutdown：配置只接受回环地址。rootless 容器的端口发布要求容器内监听全部
 * 地址，这由部署脚本设置 BOT_CONTAINER_BIND_ALL=1 决定（宿主只发布到 127.0.0.1），不来自用户配置。
 */
export const HOST = process.env.BOT_CONTAINER_BIND_ALL === "1" ? "0.0.0.0" : runtimeSetting("BOT_HOST") || RUNTIME_DEFAULTS.BOT_HOST;
export const RUN_TIMEOUT_MS = integerEnv("BOT_RUN_TIMEOUT_SECONDS") * 1000;
export const CLOSEOUT_MS = integerEnv("BOT_CLOSEOUT_SECONDS") * 1000;
export const DELIVERY_RESERVE_MS = integerEnv("BOT_DELIVERY_RESERVE_SECONDS") * 1000;
export const FALLBACK_SEND_MS = integerEnv("BOT_FALLBACK_SEND_SECONDS") * 1000;
/** Only model waiting/streaming; raw tool deltas do not renew this budget without parsed changes. */
export const MODEL_IDLE_TIMEOUT_MS = integerEnv("BOT_MODEL_IDLE_TIMEOUT_SECONDS") * 1000;
/** Per response, including time to first content; even continuous progress cannot renew it. */
export const MODEL_RESPONSE_TIMEOUT_MS = integerEnv("BOT_MODEL_RESPONSE_TIMEOUT_SECONDS") * 1000;
export const SHUTDOWN_TIMEOUT_MS = integerEnv("BOT_SHUTDOWN_TIMEOUT_SECONDS") * 1000;

// ===== 出站文件 =====
export const ATTACHMENT_HTTP_TIMEOUT = 60_000;
export { NATIVE_FILE_MAX_BYTES } from "./transfer-limits.ts";
/** 外链分发总预算，包含快照、等锁、探测和 PUT；同时受整轮任务和 /stop 取消约束。 */
export { RELAY_HTTP_TIMEOUT } from "./transfer-limits.ts";

// ===== 入站 =====
/** phone 合法字符集（用作群内用户目录名，同时防路径穿越）。 */
export const PHONE_PATTERN = /^[A-Za-z0-9_+\-]{1,32}$/;
/** 单条消息内容上限（防超大 payload）。 */
export const MAX_CONTENT_LENGTH = 16 * 1024;
/** 已打开空间里空闲成员的内存状态保留时间（ms）。 */
export const MEMBER_IDLE_MS = 30_000;
/** 后台维护（空间回收、记录过期、附件过期）的间隔。 */
export const MAINTENANCE_INTERVAL_MS = 300_000;
/** 已确认但尚未完成清理的 Pi 后台任务总数；超限时提示用户稍后重发。 */
export const MAX_ACTIVE_REQUESTS = integerEnv("BOT_MAX_ACTIVE_REQUESTS");

// ===== Agent 工具 =====
/**
 * 模型没有显式声明 timeout 时，注入给 bash 工具的默认上限（秒）。
 * 同时受整轮期限和取消信号约束；模型声明的 timeout 最大为 3600 秒。
 */
export const BASH_DEFAULT_TIMEOUT = integerEnv("BOT_BASH_TIMEOUT");

// ===== 资料索引 =====
/**
 * 每轮检查索引是否过期；有效 manifest 可复用，否则首次等待构建，过期后后台刷新。
 */
export const MATERIALS_INDEX_TTL = integerEnv("BOT_INDEX_TTL_MINUTES") * 60_000;
/** 单次扫描收录的文件数上限，防止异常巨大的目录树吃光内存与磁盘。 */
export const MATERIALS_INDEX_MAX_FILES = integerEnv("BOT_INDEX_MAX_FILES");
/** 目录递归深度上限；跳过更深分支并将索引标为不完整。 */
export const MATERIALS_INDEX_MAX_DEPTH = integerEnv("BOT_INDEX_MAX_DEPTH");

// ===== 文档解析环境 =====
/**
 * 解析和生成文档的直接依赖，完整依赖锁为 uv.lock。
 * 就绪校验包含解释器、锁定版本和导入结果；文件状态未变时可短期复用成功结果。
 * 默认按需准备应用共享的 data/runtime/document-env；BOT_DOCUMENT_ENV 可指定现成环境，模型不能修改环境。
 */
export const DOCUMENT_TOOLCHAIN_PACKAGES: readonly string[] = documentPackages(readFileSync(
  new URL("../../pyproject.toml", import.meta.url), "utf8"
));
/** 建环境、装包与验证的总时限（ms）；失败由能力工具明确返回。 */
export const DOCUMENT_TOOLCHAIN_TIMEOUT = 10 * 60_000;

// ===== 日志 =====
export const LOG_DIR = "logs";
export const LOG_FILE = "mixin-chatbot.log";
export const LOG_MAX_BYTES = 5 * 1024 ** 2; // 5MB
export const LOG_BACKUP_COUNT = 3;
