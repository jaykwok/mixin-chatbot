import { describe, expect, test } from "bun:test";
import {
  defaultThinkingLevel,
  entryToModel,
  MODEL_API,
  modelDefaultsForSelection,
} from "../../scripts/config/configure.ts";

describe("configure model metadata", () => {
  test("writes the OpenAI Responses API type", () => {
    expect(MODEL_API).toBe("openai-responses");
  });

  test("defaults reasoning models to low and non-reasoning models to off", () => {
    expect(defaultThinkingLevel(true)).toBe("low");
    expect(defaultThinkingLevel(true, "high")).toBe("high");
    expect(defaultThinkingLevel(false, "high")).toBe("off");
  });

  test("converts LiteLLM per-token prices to Pi per-million-token prices", () => {
    const model = entryToModel("example-model", {
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
      cache_read_input_token_cost: 0.000000125,
      cache_creation_input_token_cost: 0.00000125,
      supports_reasoning: true,
    });

    expect(model.cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.125,
      cacheWrite: 1.25,
    });
    expect(model.reasoning).toBe(true);
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
