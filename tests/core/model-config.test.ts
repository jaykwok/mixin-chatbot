import { expect, test } from "bun:test";
import { validateModelConfig } from "../../src/core/model-config.ts";

test("official custom coding plans use the same offline model contract as built-in providers", () => {
  const custom = { modelId: "custom-model", thinkingLevel: "medium", providers: { official: {
    api: "openai-responses", baseUrl: "https://models.example.invalid/v1", apiKey: "fixture",
    models: [{ id: "custom-model", contextWindow: 128000, maxTokens: 32000 }],
  } } };
  expect(validateModelConfig(custom)).toEqual({ providerId: "official", modelId: "custom-model", thinkingLevel: "medium" });
  expect(validateModelConfig({ modelId: "preset", providers: { builtin: {} } })).toEqual({ providerId: "builtin", modelId: "preset", thinkingLevel: "off" });
  for (const value of [null, {}, { providers: {} }, { ...custom, modelId: undefined }, { ...custom, modelId: " other " },
    { ...custom, thinkingLevel: "invalid" }, { ...custom, providers: { one: {}, two: {} } },
    { ...custom, providers: { official: { ...custom.providers.official, models: [{ id: "different" }] } } },
    { ...custom, providers: { official: { ...custom.providers.official, baseUrl: "file:///tmp/model" } } },
    ...[0, -1, 1.5, "4096", Infinity].map(contextWindow => ({ ...custom, providers: { official: {
      ...custom.providers.official, models: [{ id: "custom-model", contextWindow }],
    } } })),
  ]) expect(() => validateModelConfig(value)).toThrow();
});
