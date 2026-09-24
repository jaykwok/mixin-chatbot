// 运行时与运维界面共用的纯配置定义；导入时不读取磁盘或加载机器人。
import { isIP } from "node:net";

export const RUNTIME_KEYS = [
  "BOT_PORT", "BOT_HOST", "BOT_DEBUG", "GROUP_DATA_ROOT", "BOT_MAX_ACTIVE_REQUESTS",
  "BOT_BASH_TIMEOUT", "BOT_INDEX_TTL_MINUTES", "BOT_INDEX_MAX_FILES", "BOT_INDEX_MAX_DEPTH",
  "BOT_RUN_TIMEOUT_SECONDS", "BOT_MODEL_IDLE_TIMEOUT_SECONDS", "BOT_MODEL_RESPONSE_TIMEOUT_SECONDS",
  "BOT_SHUTDOWN_TIMEOUT_SECONDS", "BOT_DELIVERY_TIMEOUT_SECONDS",
  "BOT_DOCUMENT_ENV", "BOT_DOCUMENT_WORK_ENABLED", "PI_CACHE_RETENTION", "BOT_ATTACHMENT_CONCURRENCY",
] as const;
export type RuntimeKey = typeof RUNTIME_KEYS[number];
export type RuntimeConfig = Partial<Record<RuntimeKey, string>>;
export type AdvancedRuntimeKey = Exclude<RuntimeKey, "BOT_PORT" | "BOT_HOST" | "GROUP_DATA_ROOT">;
export const ADVANCED_RUNTIME_KEYS = RUNTIME_KEYS.filter((key): key is AdvancedRuntimeKey =>
  key !== "BOT_PORT" && key !== "BOT_HOST" && key !== "GROUP_DATA_ROOT");

export const RUNTIME_RANGES = {
  BOT_PORT: [1, 65535], BOT_MAX_ACTIVE_REQUESTS: [1, 1000], BOT_BASH_TIMEOUT: [10, 3600],
  BOT_INDEX_TTL_MINUTES: [1, 1440], BOT_INDEX_MAX_FILES: [100, 1000000], BOT_INDEX_MAX_DEPTH: [1, 64],
  BOT_RUN_TIMEOUT_SECONDS: [10, 7200], BOT_SHUTDOWN_TIMEOUT_SECONDS: [5, 25], BOT_DELIVERY_TIMEOUT_SECONDS: [1, 600],
  BOT_MODEL_IDLE_TIMEOUT_SECONDS: [10, 7200], BOT_MODEL_RESPONSE_TIMEOUT_SECONDS: [10, 7200],
  BOT_ATTACHMENT_CONCURRENCY: [1, 8],
} as const;

export const RUNTIME_DEFAULTS = {
  BOT_PORT: "1011", BOT_HOST: "0.0.0.0", BOT_DEBUG: "0", BOT_MAX_ACTIVE_REQUESTS: "32",
  BOT_BASH_TIMEOUT: "600", BOT_INDEX_TTL_MINUTES: "5", BOT_INDEX_MAX_FILES: "50000", BOT_INDEX_MAX_DEPTH: "12",
  BOT_RUN_TIMEOUT_SECONDS: "1200", BOT_MODEL_IDLE_TIMEOUT_SECONDS: "180", BOT_MODEL_RESPONSE_TIMEOUT_SECONDS: "600",
  BOT_SHUTDOWN_TIMEOUT_SECONDS: "20", BOT_DELIVERY_TIMEOUT_SECONDS: "180",
  BOT_DOCUMENT_ENV: "", BOT_DOCUMENT_WORK_ENABLED: "1", PI_CACHE_RETENTION: "short", BOT_ATTACHMENT_CONCURRENCY: "2",
} satisfies Partial<Record<RuntimeKey, string>>;

export function validateRuntimeConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime.json 必须是对象");
  const result: RuntimeConfig = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!(RUNTIME_KEYS as readonly string[]).includes(key)) throw new Error(`未知运行配置: ${key}`);
    if ((typeof setting !== "string" && typeof setting !== "number") || !String(setting).trim()) throw new Error(`无效运行配置: ${key}`);
    result[key as RuntimeKey] = String(setting).trim();
    const text = result[key as RuntimeKey]!;
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`运行配置包含控制字符: ${key}`);
    const range = RUNTIME_RANGES[key as keyof typeof RUNTIME_RANGES];
    if (range && (!Number.isInteger(Number(text)) || Number(text) < range[0] || Number(text) > range[1])) {
      throw new Error(`${key} 必须是 ${range[0]}-${range[1]} 的整数`);
    }
    if ((key === "BOT_DEBUG" || key === "BOT_DOCUMENT_WORK_ENABLED") && !["0", "1"].includes(text)) throw new Error(`${key} 只能是 0 或 1`);
    if (key === "PI_CACHE_RETENTION" && !["short", "long"].includes(text)) throw new Error("PI_CACHE_RETENTION 必须是 short 或 long");
    if (key === "BOT_HOST" && text !== "localhost" && !isIP(text)) throw new Error("BOT_HOST 必须是 IP 地址或 localhost");
  }
  return result;
}
