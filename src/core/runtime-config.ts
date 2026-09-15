import { readFileSync } from "node:fs";
import { RUNTIME_CONFIG_PATH } from "./storage.ts";
import { validateRuntimeConfig, type RuntimeKey } from "./runtime-schema.ts";

function readConfig(): Partial<Record<RuntimeKey, string>> {
  try { return validateRuntimeConfig(JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
const config = readConfig();
export function runtimeSetting(name: string): string | undefined {
  const env = process.env[name]?.trim();
  return env ? validateRuntimeConfig({ [name]: env })[name as RuntimeKey] : config[name as RuntimeKey];
}
