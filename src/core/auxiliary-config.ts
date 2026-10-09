import { readFileSync } from "node:fs";
import type { ModelRef } from "@earendil-works/pi-durable";
import { AUXILIARY_CONFIG_PATH } from "./storage.ts";

export interface AuxiliaryConfig { format: 1; classifier?: ModelRef; image?: ModelRef; maxConcurrent: number; classifierRetries: number }
export function readAuxiliaryConfig(path = AUXILIARY_CONFIG_PATH): AuxiliaryConfig | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} 必须是对象`);
  const value = raw as Record<string, unknown>;
  if (value.format !== 1 || Object.keys(value).some(key => !["format", "classifier", "image", "maxConcurrent", "classifierRetries"].includes(key))) throw new Error(`${path} 格式无效`);
  const model = (name: string): ModelRef | undefined => {
    const item = value[name] as Record<string, unknown> | undefined;
    if (item === undefined) return undefined;
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["provider", "modelId"].includes(key))
      || typeof item.provider !== "string" || !item.provider.trim() || typeof item.modelId !== "string" || !item.modelId.trim()) throw new Error(`${path}.${name} 必须包含 provider 和 modelId`);
    return { provider: item.provider, modelId: item.modelId };
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const amount = value[key] ?? fallback;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < min || amount > max) throw new Error(`${path}.${key} 必须是 ${min} 到 ${max} 的整数`);
    return amount;
  };
  return { format: 1, classifier: model("classifier"), image: model("image"), maxConcurrent: integer("maxConcurrent", 2, 1, 4), classifierRetries: integer("classifierRetries", 1, 0, 3) };
}
