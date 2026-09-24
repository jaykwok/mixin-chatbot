import { describe, expect, test } from "bun:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { catalogDefaults, catalogMatches, discoverModelIds } from "../../scripts/config/configure.ts";

/** 只读 Pi 随包目录，不碰仓库里的 data/ 和网络。 */
function builtinRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: null, credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
  });
}

describe("自定义端点的模型资料预填", () => {
  test("按精确 id 命中 Pi 目录，不靠子串猜", async () => {
    const runtime = await builtinRuntime();
    const matches = catalogMatches(runtime, "gpt-5.2");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((model) => model.id === "gpt-5.2")).toBe(true);
    // 官方那家也在候选里：自定义 id 取成内置 id 时，正该拿它的资料预填。
    expect(matches.some((model) => model.provider === "openai")).toBe(true);
    // 来源按 provider 排序，重复配置时选项顺序才是稳定的。
    expect(matches.map((model) => model.provider)).toEqual([...matches.map((model) => model.provider)].sort());
    // 近似 id 一律不算命中：猜错的价格和上下文比留空更难发现。
    expect(catalogMatches(runtime, "gpt-5.2-unknown-alias")).toEqual([]);
    expect(catalogMatches(runtime, "")).toEqual([]);
  });

  test("只复制模型资料，provider 的传输设置不跟着进中转站条目", async () => {
    const runtime = await builtinRuntime();
    const source = catalogMatches(runtime, "gpt-5.2")[0]!;
    const defaults = catalogDefaults({ ...source, headers: { "provider-specific": "value" }, compat: { supportsMaxOutputTokens: false },
      promptCache: { short: 300, long: 1800 }, inputLimits: { images: { resize: { maxWidth: 1280 } } } });
    expect(defaults).toEqual({
      contextWindow: source.contextWindow, maxTokens: source.maxTokens,
      input: source.input, reasoning: source.reasoning, cost: source.cost,
    });
    expect(defaults).not.toHaveProperty("id");
    expect(defaults).not.toHaveProperty("api");
    expect(defaults).not.toHaveProperty("baseUrl");
    expect(defaults).not.toHaveProperty("provider");
    expect(defaults).not.toHaveProperty("headers");
    expect(defaults).not.toHaveProperty("compat");
    expect(defaults).not.toHaveProperty("promptCache");
    expect(defaults).not.toHaveProperty("inputLimits");
    // 拷贝而非共享引用，后面的交互改动不会写回 Pi 的目录对象。
    expect(defaults.cost).not.toBe(source.cost);
    expect(defaults.input).not.toBe(source.input);
  });
});

describe("端点模型清单", () => {
  async function withEndpoint(
    handler: (request: Request) => Response, run: (baseUrl: string) => Promise<void>
  ): Promise<void> {
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      await run(`${server.url.origin}/v1`);
    } finally {
      await server.stop(true);
    }
  }

  test("OpenAI 兼容端点：GET {baseUrl}/models，Bearer 鉴权，去重排序", async () => {
    let seen: { path: string; auth: string | null } | undefined;
    await withEndpoint((request) => {
      const url = new URL(request.url);
      seen = { path: url.pathname, auth: request.headers.get("authorization") };
      return Response.json({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }, { id: 7 }, { id: "  " }] });
    }, async (baseUrl) => {
      expect(await discoverModelIds("openai-responses", baseUrl, "k")).toEqual(["a-model", "b-model"]);
    });
    expect(seen).toEqual({ path: "/v1/models", auth: "Bearer k" });
  });

  test("Anthropic 端点：GET {baseUrl}/v1/models，x-api-key 鉴权", async () => {
    let seen: { path: string; key: string | null; version: string | null } | undefined;
    await withEndpoint((request) => {
      const url = new URL(request.url);
      seen = {
        path: url.pathname, key: request.headers.get("x-api-key"),
        version: request.headers.get("anthropic-version"),
      };
      return Response.json({ data: [{ id: "claude-test" }] });
    }, async (baseUrl) => {
      // Anthropic 的 baseUrl 不带 /v1，这里故意传一个带尾斜杠的地址确认不会拼出双斜杠。
      expect(await discoverModelIds("anthropic-messages", `${baseUrl}/`, "k")).toEqual(["claude-test"]);
    });
    expect(seen).toEqual({ path: "/v1/v1/models", key: "k", version: "2023-06-01" });
  });

  test("Google 风格的 models[].name 去掉前缀", async () => {
    await withEndpoint(() => Response.json({ models: [{ name: "models/gemini-test" }] }), async (baseUrl) => {
      expect(await discoverModelIds("google-generative-ai", baseUrl, "k")).toEqual(["gemini-test"]);
    });
  });

  test("端点报错时抛出，由调用方退回手填", async () => {
    await withEndpoint(() => new Response("nope", { status: 403, statusText: "Forbidden" }), async (baseUrl) => {
      expect(discoverModelIds("openai-completions", baseUrl, "k")).rejects.toThrow("403");
    });
  });

  test("没有清单字段时返回空数组，而不是编一个模型出来", async () => {
    await withEndpoint(() => Response.json({ object: "list" }), async (baseUrl) => {
      expect(await discoverModelIds("openai-completions", baseUrl, "k")).toEqual([]);
    });
  });
});
