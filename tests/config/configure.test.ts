import { describe, expect, test } from "bun:test";
import {
  defaultThinkingLevel,
  catalogMatches,
  catalogModelMetadata,
  CUSTOM_APIS,
  modelDefaultsForSelection,
  defaultCatalogSource,
  customProvider,
} from "../../scripts/config/configure.ts";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

describe("configure model metadata", () => {
  test("first configuration adopts a catalog model; reconfiguration preserves existing metadata", () => {
    const model = getBuiltinModels("openai")[0]!;
    const matches = [{ ...model, provider: "other" }, model];
    expect(defaultCatalogSource(matches, "openai", false)).toBe(1);
    expect(defaultCatalogSource([model], "custom-gateway", false)).toBe(0);
    expect(defaultCatalogSource(matches, "openai", true)).toBe(-1);
    expect(defaultCatalogSource([], "openai", false)).toBe(-1);
    const selected = matches[defaultCatalogSource(matches, "openai", false)]!;
    expect(catalogModelMetadata(model.id, selected)).toMatchObject({ input: model.input, cost: model.cost });
  });

  test("writes compatibility settings only on the model, with the selected value winning", () => {
    const entry = customProvider("openai", "https://example.com/v1", "test-only", {
      id: "test", compat: { supportsMaxOutputTokens: false, supportsStrictMode: true },
    }, { supportsMaxOutputTokens: false, supportsDeveloperRole: false }, true);
    expect(entry).not.toHaveProperty("compat");
    expect(entry.models).toEqual([{ id: "test", compat: {
      supportsMaxOutputTokens: true, supportsStrictMode: true, supportsDeveloperRole: false,
    } }]);
  });

  test("offers Pi custom protocols without forcing Responses compatibility", () => {
    expect(CUSTOM_APIS).toEqual(["openai-completions", "openai-responses", "anthropic-messages"]);
    for (const api of CUSTOM_APIS) {
      const entry = customProvider("custom", "https://example.com/v1", "test-only", { id: "test" }, {}, true, api);
      expect(entry.api).toBe(api);
      expect((entry.models as { compat: object }[])[0]!.compat).toEqual(api === "openai-responses" ? { supportsMaxOutputTokens: true } : {});
    }
  });

  test("defaults reasoning models to low and non-reasoning models to off", () => {
    expect(defaultThinkingLevel(true)).toBe("low");
    expect(defaultThinkingLevel(true, "high")).toBe("high");
    expect(defaultThinkingLevel(false, "high")).toBe("off");
  });

  test("uses the official catalog without guessing similar model ids", () => {
    const source = getBuiltinModels("openai")[0]!;
    expect(catalogMatches(source.id)).toContainEqual(source);
    expect(catalogMatches(`${source.id}-unknown-alias`)).toEqual([]);
    expect(catalogMatches("")).toEqual([]);
  });

  test("copies native metadata without leaking provider transport settings", () => {
    const source = getBuiltinModels("openai")[0]!;
    const model = catalogModelMetadata("gateway-alias", {
      ...source,
      headers: { "provider-specific": "value" },
      compat: { supportsMaxOutputTokens: false },
    });
    expect(model).toEqual({
      id: "gateway-alias",
      name: "gateway-alias",
      contextWindow: source.contextWindow,
      maxTokens: source.maxTokens,
      input: source.input,
      reasoning: source.reasoning,
      cost: source.cost,
    });
    expect(model.cost).not.toBe(source.cost);
    expect(model.input).not.toBe(source.input);
  });

  test("does not carry capability and price metadata across model ids", () => {
    const existing = {
      id: "old-model",
      name: "old-model",
      contextWindow: 8,
      maxTokens: 4,
      input: ["text", "image"],
      reasoning: true,
      cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
    };

    expect(modelDefaultsForSelection("old-model", existing)).toMatchObject({
      contextWindow: 8,
      reasoning: true,
    });
    expect(modelDefaultsForSelection("new-model", existing)).toMatchObject({
      id: "new-model",
      contextWindow: 131072,
      maxTokens: 8192,
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(
      modelDefaultsForSelection("old-model", existing, false)
    ).toMatchObject({
      id: "old-model",
      contextWindow: 131072,
      maxTokens: 8192,
      input: ["text"],
      reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });
});
