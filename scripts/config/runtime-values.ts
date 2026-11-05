// Runtime settings answered before a deployment's stop: the complete runtime.json the deployment installs after the stop,
// and the digest of the file it was computed from. runtime-settings.ts writes (--prepare-values) and installs (--values)
// it; the ops core validates it under deploy.lock. Built-ins and the pure schema only: the host core has no node_modules.
import { createHash } from "node:crypto";
import { validateRuntimeConfig, type RuntimeConfig } from "../../src/core/runtime-schema.ts";

export const RUNTIME_VALUES_FILE = "runtime-values.json";
export interface RuntimeValues { format: 1; base: string | null; values: RuntimeConfig }
/** The bytes runtime-settings.ts has always written for a configuration. */
export const runtimeText = (values: RuntimeConfig) => JSON.stringify(validateRuntimeConfig(values), null, 2) + "\n";
export const runtimeDigest = (raw: string | null) => raw === null ? null : createHash("sha256").update(raw).digest("hex");

/** validateRuntimeConfig names fields and ranges, never values. */
export function parseRuntimeValues(raw: string): RuntimeValues {
  let value: RuntimeValues;
  try { value = JSON.parse(raw); } catch { throw new Error("运行参数暂存无法读取"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "base,format,values" || value.format !== 1
    || value.base !== null && (typeof value.base !== "string" || !/^[a-f0-9]{64}$/.test(value.base))) throw new Error("运行参数暂存格式不支持");
  return { format: 1, base: value.base, values: validateRuntimeConfig(value.values) };
}
export const serializeRuntimeValues = (value: RuntimeValues) => JSON.stringify({ format: 1, base: value.base, values: validateRuntimeConfig(value.values) }) + "\n";
