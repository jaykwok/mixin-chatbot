import { readFileSync } from "node:fs";
import { RUNTIME_CONFIG_PATH } from "./storage.ts";
import { isIP } from "node:net";

export const RUNTIME_KEYS = [
  "BOT_PORT", "BOT_HOST", "BOT_DEBUG", "GROUP_DATA_ROOT", "BOT_MAX_ACTIVE_REQUESTS",
  "BOT_BASH_TIMEOUT", "BOT_INDEX_TTL_MINUTES", "BOT_INDEX_MAX_FILES", "BOT_INDEX_MAX_DEPTH",
  "BOT_RUN_TIMEOUT_SECONDS", "BOT_SHUTDOWN_TIMEOUT_SECONDS", "BOT_DELIVERY_TIMEOUT_SECONDS",
  "BOT_DOCUMENT_ENV",
] as const;
type RuntimeKey = typeof RUNTIME_KEYS[number];
const ranges: Partial<Record<RuntimeKey, [number, number]>> = {
  BOT_PORT: [1, 65535], BOT_MAX_ACTIVE_REQUESTS: [1, 1000], BOT_BASH_TIMEOUT: [10, 3600],
  BOT_INDEX_TTL_MINUTES: [1, 1440], BOT_INDEX_MAX_FILES: [100, 1000000], BOT_INDEX_MAX_DEPTH: [1, 64],
  BOT_RUN_TIMEOUT_SECONDS: [10, 7200], BOT_SHUTDOWN_TIMEOUT_SECONDS: [5, 25], BOT_DELIVERY_TIMEOUT_SECONDS: [1, 600],
};

export function validateRuntimeConfig(value: unknown): Partial<Record<RuntimeKey, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime.json 必须是对象");
  const result: Partial<Record<RuntimeKey, string>> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!(RUNTIME_KEYS as readonly string[]).includes(key)) throw new Error(`未知运行配置: ${key}`);
    if ((typeof setting !== "string" && typeof setting !== "number") || !String(setting).trim()) throw new Error(`无效运行配置: ${key}`);
    result[key as RuntimeKey] = String(setting).trim();
    const text = result[key as RuntimeKey]!;
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`运行配置包含控制字符: ${key}`);
    const range = ranges[key as RuntimeKey];
    if (range && (!Number.isInteger(Number(text)) || Number(text) < range[0] || Number(text) > range[1])) {
      throw new Error(`${key} 必须是 ${range[0]}-${range[1]} 的整数`);
    }
    if (key === "BOT_DEBUG" && !["0", "1"].includes(text)) throw new Error("BOT_DEBUG 只能是 0 或 1");
    if (key === "BOT_HOST" && text !== "localhost" && !isIP(text)) throw new Error("BOT_HOST 必须是 IP 地址或 localhost");
  }
  return result;
}

function readConfig(): Partial<Record<RuntimeKey, string>> {
  try { return validateRuntimeConfig(JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
const config = readConfig();
export function runtimeSetting(name: string): string | undefined {
  const env = process.env[name]?.trim();
  return env ? validateRuntimeConfig({ [name]: env })[name as RuntimeKey] : config[name as RuntimeKey];
}
