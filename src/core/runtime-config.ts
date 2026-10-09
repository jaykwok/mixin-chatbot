import { readFileSync } from "node:fs";
import { RUNTIME_CONFIG_PATH } from "./storage.ts";
import { validateRuntimeConfig, type RuntimeKey } from "./runtime-schema.ts";

function readConfig(): Partial<Record<RuntimeKey, string>> {
  if (process.env.BOT_MODEL_CACHE_RETENTION?.trim()) {
    throw new Error("BOT_MODEL_CACHE_RETENTION 已移除：请移除这个环境变量，再通过 TUI“升级”或 ops update 完成数据迁移；新版使用 PI_CACHE_RETENTION");
  }
  try { return validateRuntimeConfig(JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
const config = readConfig();
export function runtimeSetting(name: string): string | undefined {
  const env = process.env[name]?.trim();
  return env ? validateRuntimeConfig({ [name]: env })[name as RuntimeKey] : config[name as RuntimeKey];
}
