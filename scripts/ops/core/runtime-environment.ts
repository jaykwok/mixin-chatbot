import { createHash } from "node:crypto";
import { ADVANCED_RUNTIME_KEYS } from "../../../src/core/runtime-schema.ts";

/** Only non-secret advanced settings; other container environment fields are never copied into argv or records. */
export function runtimeEnvironment(values: unknown): string[] {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("容器环境无法核对");
  const selected = values.filter(value => (ADVANCED_RUNTIME_KEYS as readonly string[]).includes(value.split("=", 1)[0]!)) as string[];
  if (new Set(selected.map(value => value.split("=", 1)[0])).size !== selected.length || selected.some(value => value.length > 8192 || /[\x00-\x1f\x7f]/.test(value) || !value.includes("=")))
    throw new Error("高级运行参数环境重复或无效");
  return selected.sort();
}
export const runtimeEnvironmentDigest = (values: string[]) => createHash("sha256").update(JSON.stringify(runtimeEnvironment(values))).digest("hex");
