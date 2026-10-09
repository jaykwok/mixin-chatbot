// Frozen configuration migration. Preview must work from updater exports before installing Pi.
import { join } from "node:path";
import { json, ordinaryPath, publishJson } from "./lib/io.ts";
import type { Migration } from "./lib/types.ts";

const SETTINGS = "data/runtime/pi/settings.json";
const SELECTION = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "modelThinkingLevels"];
function budgets(value: unknown, path: string): Record<string, number> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  const result: Record<string, number> = {};
  for (const key of ["reserveTokens", "keepRecentTokens"]) {
    const amount = (value as Record<string, unknown>)[key];
    if (amount === undefined) continue;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new Error(`${path}.${key} 必须是非负整数`);
    result[key] = amount;
  }
  return result;
}
function converted(settings: Record<string, unknown>): Record<string, unknown> {
  if (settings.format !== undefined && settings.format !== 1) throw new Error("v4 迁移拒绝未知 settings.json.format");
  const selection = Object.fromEntries(SELECTION.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
  // Older frozen steps may have projected cacheWarming again when an unregistered replacement root starts at v1.
  if (settings.format === 1) return { format: 1, ...selection, ...(settings.durable === undefined ? {} : { durable: settings.durable }) };
  if (settings.durable !== undefined) {
    if (Object.keys(settings).some(key => ![...SELECTION, "durable"].includes(key))) throw new Error("v4 迁移拒绝混合新旧运行策略，请先检查配置");
    return { format: 1, ...selection, durable: settings.durable };
  }
  const ordinary = budgets(settings.compaction, "compaction");
  const overrides = (settings.compaction as { modelOverrides?: unknown } | undefined)?.modelOverrides;
  if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides))) throw new Error("compaction.modelOverrides 必须是对象");
  const modelOverrides = Object.fromEntries(Object.entries(overrides ?? {}).map(([key, value]) => [key, budgets(value, `compaction.modelOverrides.${key}`)]));
  return { format: 1, ...selection, durable: {
    // Before v4 the service always overrode these AgentSession settings; preserve the effective four-request budget.
    retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxAgentDelayMs: 5000 },
    stream: { timeoutMs: 120000, maxRetries: 0, maxRetryDelayMs: 5000 },
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, ...ordinary,
      ...(Object.keys(modelOverrides).length ? { modelOverrides } : {}) },
    progress: { partialIntervalMs: 100, outputIntervalMs: 20 }, contextRetentionMs: 600000,
  } };
}
async function change(project: string) {
  const path = join(project, SETTINGS);
  await ordinaryPath(project, path);
  const before = await json(path);
  if (!before) return undefined;
  const after = converted(before);
  return JSON.stringify(before) === JSON.stringify(after) ? undefined : { before, after };
}

export const v4: Migration = {
  to: 4,
  async preview(context) {
    const value = await change(context.project);
    const removed = value ? Object.keys(value.before).filter(key => ![...SELECTION, "format", "durable"].includes(key)) : [];
    return { files: [{ root: "project", path: SETTINGS }], decisions: [],
      ...(value ? { configuration: { [SETTINGS]: value.after } } : {}),
      steps: ["运行设置改为 Durable 原生策略：最多四次独立请求，每次 120 秒、SDK 重试为 0，保留选型和分模型压缩预算；历史会话及费用不重写"
        + (removed.length ? `；退出旧设置：${removed.join("、")}` : ""),
      "完整校验配置与账本，登记项目和群根版本 4；旧代码禁止直接使用新版本数据"] };
  },
  async apply(context) {
    const value = await change(context.project);
    if (value) await publishJson(join(context.project, SETTINGS), value.after);
  },
  async validate(context) {
    if (await change(context.project)) throw new Error("v4 迁移校验失败：运行设置尚未转换");
  },
};
