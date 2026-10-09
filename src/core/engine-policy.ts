import type { CacheRetention } from "@earendil-works/pi-ai";
import type { CompactionPolicy, ConversationRetryPolicy, HarnessSettings, ProgressPolicy } from "@earendil-works/pi-durable";

type Budgets = { reserveTokens?: number; keepRecentTokens?: number };
export interface EnginePolicy {
  retry: ConversationRetryPolicy;
  stream: NonNullable<HarnessSettings["stream"]>;
  compaction: Omit<CompactionPolicy, "backgroundTokens"> & { backgroundTokens?: number; modelOverrides?: Record<string, Budgets> };
  progress: ProgressPolicy;
  contextRetentionMs: number;
}

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}.${key} 不受支持`);
}
function integer(value: unknown, fallback: number, path: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${path} 必须是 0 到 ${max} 的整数`);
  return value;
}
function boolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${path} 必须是布尔值`);
  return value;
}

/** A single Durable policy; no AgentSession/provider retry multiplication at runtime. */
export function enginePolicy(value: unknown): EnginePolicy {
  const policy = object(value ?? {}, "durable");
  keys(policy, ["retry", "stream", "compaction", "progress", "contextRetentionMs"], "durable");
  const retry = object(policy.retry ?? {}, "durable.retry");
  keys(retry, ["enabled", "maxRetries", "baseDelayMs", "maxAgentDelayMs"], "durable.retry");
  const stream = object(policy.stream ?? {}, "durable.stream");
  keys(stream, ["timeoutMs", "maxRetries", "maxRetryDelayMs", "cacheRetention"], "durable.stream");
  if (stream.maxRetries !== undefined && stream.maxRetries !== 0) throw new Error("durable.stream.maxRetries 必须为 0；每次请求必须有独立开始回执");
  if (stream.cacheRetention !== undefined && !["none", "short", "long"].includes(stream.cacheRetention as string)) throw new Error("durable.stream.cacheRetention 无效");
  const compaction = object(policy.compaction ?? {}, "durable.compaction");
  keys(compaction, ["enabled", "reserveTokens", "keepRecentTokens", "backgroundTokens", "modelOverrides"], "durable.compaction");
  const modelOverrides: Record<string, Budgets> = Object.create(null);
  for (const [key, raw] of Object.entries(object(compaction.modelOverrides ?? {}, "durable.compaction.modelOverrides"))) {
    const budgets = object(raw, `durable.compaction.modelOverrides.${key}`);
    keys(budgets, ["reserveTokens", "keepRecentTokens"], `durable.compaction.modelOverrides.${key}`);
    modelOverrides[key] = Object.fromEntries(Object.entries(budgets).map(([field, amount]) => [field, integer(amount, 0, `durable.compaction.modelOverrides.${key}.${field}`)]));
  }
  const progress = object(policy.progress ?? {}, "durable.progress");
  keys(progress, ["partialIntervalMs", "outputIntervalMs"], "durable.progress");
  const timeoutMs = integer(stream.timeoutMs, 120000, "durable.stream.timeoutMs", 600000);
  if (timeoutMs === 0) throw new Error("durable.stream.timeoutMs 必须大于 0");
  return {
    retry: { enabled: boolean(retry.enabled, true, "durable.retry.enabled"), maxRetries: integer(retry.maxRetries, 3, "durable.retry.maxRetries", 10),
      baseDelayMs: integer(retry.baseDelayMs, 1000, "durable.retry.baseDelayMs", 60000), maxAgentDelayMs: integer(retry.maxAgentDelayMs, 5000, "durable.retry.maxAgentDelayMs", 60000) },
    stream: { timeoutMs, maxRetries: 0,
      maxRetryDelayMs: integer(stream.maxRetryDelayMs, 5000, "durable.stream.maxRetryDelayMs", 60000),
      ...(stream.cacheRetention === undefined ? {} : { cacheRetention: stream.cacheRetention as CacheRetention }) },
    compaction: { enabled: boolean(compaction.enabled, true, "durable.compaction.enabled"),
      reserveTokens: integer(compaction.reserveTokens, 16384, "durable.compaction.reserveTokens"),
      keepRecentTokens: integer(compaction.keepRecentTokens, 20000, "durable.compaction.keepRecentTokens"),
      ...(compaction.backgroundTokens === undefined ? {} : { backgroundTokens: integer(compaction.backgroundTokens, 0, "durable.compaction.backgroundTokens") }),
      ...(Object.keys(modelOverrides).length ? { modelOverrides } : {}) },
    progress: { partialIntervalMs: integer(progress.partialIntervalMs, 100, "durable.progress.partialIntervalMs", 10000),
      outputIntervalMs: integer(progress.outputIntervalMs, 20, "durable.progress.outputIntervalMs", 10000) },
    contextRetentionMs: integer(policy.contextRetentionMs, 600000, "durable.contextRetentionMs", 600000),
  };
}

/** Selection still uses Pi's manager; only selection fields and native policy belong to this service. */
export function validateEngineSettings(value: unknown): void {
  const settings = object(value, "settings.json");
  keys(settings, ["format", "defaultProvider", "defaultModel", "defaultThinkingLevel", "modelThinkingLevels", "durable"], "settings.json（旧配置请通过升级迁移）");
  if (settings.format !== undefined && settings.format !== 1) throw new Error("settings.json.format 不受支持");
  for (const name of ["defaultProvider", "defaultModel"]) if (settings[name] !== undefined
    && (typeof settings[name] !== "string" || !settings[name].trim())) throw new Error(`settings.json.${name} 必须是非空字符串`);
  const thinking = (value: unknown) => typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
  if (settings.defaultThinkingLevel !== undefined && !thinking(settings.defaultThinkingLevel)) throw new Error("settings.json.defaultThinkingLevel 无效");
  if (settings.modelThinkingLevels !== undefined && Object.values(object(settings.modelThinkingLevels, "settings.json.modelThinkingLevels")).some(value => !thinking(value))) throw new Error("settings.json.modelThinkingLevels 无效");
  enginePolicy(settings.durable);
}
