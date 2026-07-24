import { describe, expect, test } from "bun:test";
import { entryToModel } from "../../scripts/config/configure.ts";

describe("configure model metadata", () => {
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
});
