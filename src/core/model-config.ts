import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Offline structural validation shared by startup, doctor and deployment preflight. */
export function validateModelConfig(value: unknown): { providerId: string; modelId: string; thinkingLevel: ModelThinkingLevel } {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(value) || !object(value.providers) || Object.keys(value.providers).length !== 1) throw new Error("models.json 只允许配置一个 provider");
  const providerId = Object.keys(value.providers)[0]!;
  const provider = value.providers[providerId];
  if (!providerId.trim() || !object(provider)) throw new Error("provider 配置必须为对象");
  const modelId = value.modelId;
  if (typeof modelId !== "string" || !modelId.trim() || modelId !== modelId.trim()) throw new Error("需指定顶层 modelId；请运行 bun run configure");
  const thinkingLevel = value.thinkingLevel ?? "off";
  if (typeof thinkingLevel !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(thinkingLevel)) throw new Error("thinkingLevel 无效");
  if (provider.models !== undefined) {
    if (!Array.isArray(provider.models) || provider.models.length !== 1 || !object(provider.models[0]) || provider.models[0].id !== modelId) {
      throw new Error("自定义 models 必须只声明 modelId 指定的一个模型");
    }
    const model = provider.models[0];
    for (const field of ["contextWindow", "maxTokens"]) {
      if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || Number(model[field]) <= 0)) throw new Error(`模型 ${field} 必须为正整数`);
    }
  }
  if (provider.baseUrl !== undefined) {
    if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) throw new Error("模型 baseUrl 无效");
    let url: URL;
    try { url = new URL(String(provider.baseUrl)); } catch { throw new Error("模型 baseUrl 无效"); }
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("模型 baseUrl 必须使用 HTTP(S)");
  }
  return { providerId, modelId, thinkingLevel: thinkingLevel as ModelThinkingLevel };
}
