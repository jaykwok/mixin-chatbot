import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, type Message, type Tool } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import { memberConversation } from "../../src/durable/identity.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { scopeOf } from "../helpers/layout.ts";
import { enginePolicy } from "../../src/core/engine-policy.ts";
import { tempFixture } from "../helpers/temp.ts";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { int, obj, str } from "@earendil-works/pi-schema";

describe("installed Pi SDK integration", () => {
  test("native key-only configuration preserves Pi ZAI transport, tools and thinking metadata", async () => {
    const files = await tempFixture("pi-native-");
    try {
      // 配置向导内置方式的产物：只有凭证，一条模型定义都不写。
      const modelsPath = join(files.root, "models.json");
      await writeFile(modelsPath, JSON.stringify({ providers: { "zai-coding-cn": { apiKey: "test-only" } } }));
      const runtime = await ModelRuntime.create({ modelsPath, credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
      expect(runtime.getError()).toBeUndefined();
      const model = runtime.getModel("zai-coding-cn", "glm-5.3-flash")!;
      const builtin = getBuiltinModels("zai-coding-cn").find((item) => item.id === model.id)!;
      expect(model).toMatchObject({ api: builtin.api, baseUrl: builtin.baseUrl, compat: builtin.compat,
        thinkingLevelMap: builtin.thinkingLevelMap, contextWindow: builtin.contextWindow, maxTokens: builtin.maxTokens });
      expect(await runtime.checkAuth("zai-coding-cn")).toBeDefined();
      let payload: Record<string, unknown> | undefined;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "test", timestamp: 0 }],
        tools: [{ name: "lookup", description: "test", parameters: { type: "object", properties: {} } }] }, {
        reasoning: "low", maxTokens: 128,
        onPayload(body) { payload = body as Record<string, unknown>; throw new Error("captured native payload before network"); },
      });
      expect(result.errorMessage).toContain("captured native payload before network");
      expect(payload?.model).toBe("glm-5.3-flash");
      expect(payload?.tools).toBeDefined();
      expect(payload?.max_tokens).toBe(128);
      expect(payload).not.toHaveProperty("max_output_tokens");
    } finally { await files.cleanup(); }
  // The first real provider call lazily loads its transport; this tests payload compatibility, not a 5s cold-load SLA.
  }, 15000);
  // The official OpenAI endpoint chooses request fields by credential shape: `sk-` keys are API keys, anything else
  // sent there is a Sign in with ChatGPT token, which rejects cache options and output limits. Gateways are unaffected.
  const openAIPayload = async (id: string, apiKey: string, baseUrl?: string) => {
    const files = await tempFixture("pi-openai-");
    try {
      const modelsPath = join(files.root, "models.json");
      if (baseUrl) await writeFile(modelsPath, JSON.stringify({ providers: { openai: { baseUrl } } }));
      const runtime = await ModelRuntime.create({ modelsPath: baseUrl ? modelsPath : null, credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
      const model = runtime.getModel("openai", id)!;
      expect(model.baseUrl).toBe(baseUrl ?? "https://api.openai.com/v1");
      let payload: Record<string, unknown> | undefined;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "cache regression", timestamp: 0 }] }, {
        apiKey, cacheRetention: "long", sessionId: "offline-test", maxTokens: 512,
        onPayload(body) { payload = body as Record<string, unknown>; throw new Error("captured before network"); },
      });
      expect(result.errorMessage).toContain("captured before network");
      return payload!;
    } finally { await files.cleanup(); }
  };
  const openAIModels = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"];
  test.each(openAIModels)("an OpenAI API key gets the real long-cache payload for %s", async (id) => {
    const payload = await openAIPayload(id, "sk-test-only");
    expect(payload).toHaveProperty("prompt_cache_options", { ttl: "30m" });
    expect(payload.prompt_cache_retention).toBeUndefined();
    expect(payload).toHaveProperty("prompt_cache_key", "offline-test");
    expect(payload).toHaveProperty("max_output_tokens", 512);
  });
  test.each(openAIModels)("a ChatGPT sign-in token omits the fields it rejects for %s", async (id) => {
    const payload = await openAIPayload(id, "test-subscription-token");
    expect(payload.prompt_cache_options).toBeUndefined();
    expect(payload.prompt_cache_retention).toBeUndefined();
    expect(payload.max_output_tokens).toBeUndefined();
    expect(payload).toHaveProperty("prompt_cache_key", "offline-test");
  });
  test("a gateway in front of OpenAI builds the same payload for any credential shape", async () => {
    const gateway = "http://127.0.0.1:1/v1";
    const keyed = await openAIPayload("gpt-6-sol", "sk-test-only", gateway);
    expect(keyed).toHaveProperty("max_output_tokens", 512);
    expect(keyed).toHaveProperty("prompt_cache_key", "offline-test");
    expect(await openAIPayload("gpt-6-sol", "gateway-token", gateway)).toEqual(keyed);
  });

  // Pi 自己做 mergeCompat(provider, model)，模型一级的值覆盖 provider 一级；配置向导因此
  // 不需要也不应该再合并一遍。内置 provider id 和全新 id 走的是同一条合成路径。
  test.each(["openai", "test-gateway"])("configured %s lets model compat override provider compat", async (provider) => {
    const files = await tempFixture("pi-compat-");
    try {
      const modelsPath = join(files.root, "models.json");
      await writeFile(modelsPath, JSON.stringify({ providers: {
        [provider]: {
          api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only",
          compat: { supportsMaxOutputTokens: false },
          models: [{ id: "gpt-5.2", contextWindow: 8192, maxTokens: 512, reasoning: false,
            compat: { supportsMaxOutputTokens: true } }],
        },
      } }));
      const runtime = await ModelRuntime.create({
        modelsPath, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
      });
      const model = runtime.getModel(provider, "gpt-5.2")!;
      let captured: unknown;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "test", timestamp: 0 }] }, {
        maxTokens: 128,
        onPayload(body) { captured = body; throw new Error("request captured"); },
      });
      expect(result.errorMessage).toContain("request captured");
      expect(captured).toMatchObject({ max_output_tokens: 128 });
    } finally {
      await files.cleanup();
    }
  });

  test.each([undefined, false, true])("Responses max_output_tokens respects compat=%s", async (supports) => {
    const files = await tempFixture("pi-sdk-");
    try {
      const modelsPath = join(files.root, "models.json");
      await writeFile(modelsPath, JSON.stringify({ providers: { "test-gateway": {
        api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only",
        compat: { supportsMaxOutputTokens: false },
        models: [{ id: "test-model", contextWindow: 8192, maxTokens: 512, reasoning: false,
          ...(supports === undefined ? {} : { compat: { supportsMaxOutputTokens: supports } }),
        }],
      } } }));
      const runtime = await ModelRuntime.create({
        modelsPath, credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
      });
      const model = runtime.getModel("test-gateway", "test-model")!;
      let payload: Record<string, unknown> | undefined;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, {
        maxTokens: 128,
        onPayload: (body) => {
          payload = body as Record<string, unknown>;
          // 截获真实适配器生成的请求，在发出网络请求前停止。
          throw new Error("request captured");
        },
      });
      expect(result.errorMessage).toContain("request captured");
      expect(payload).toBeDefined();
      if (supports === true) expect(payload!.max_output_tokens).toBe(128);
      else expect(payload).not.toHaveProperty("max_output_tokens");
      expect(model.maxTokens).toBe(512);
    } finally {
      await files.cleanup();
    }
  });
});

describe("provider boundaries", () => {
  const offlineRuntime = () => ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  const fixtureTool = (name: string, strict: "prefer" | "require", bounded: boolean): Tool => ({
    name, description: "fixture " + name, constrainedSampling: { type: "json_schema", strict },
    parameters: bounded ? obj({ count: int({ minimum: 1, maximum: 10 }) }, { open: true }) : obj({ path: str() }, { open: true }),
  });

  test("Anthropic strict prefer falls back for rejected keywords and require fails before any request", async () => {
    const runtime = await offlineRuntime();
    const model = runtime.getModel("anthropic", "claude-sonnet-5-5")!;
    expect(model.compat).toMatchObject({ supportsStrictTools: true });
    const capture = async (tools: Tool[]) => {
      let payload: { tools?: { name: string; strict?: boolean; input_schema: { properties: Record<string, unknown> } }[] } | undefined;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "strict", timestamp: 0 }], tools }, {
        apiKey: "sk-ant-test-only", onPayload(body) { payload = body as typeof payload; throw new Error("captured before network"); },
      });
      return { result, payload };
    };
    const preferred = await capture([fixtureTool("bounded", "prefer", true), fixtureTool("plain", "prefer", false)]);
    expect(preferred.result.errorMessage).toContain("captured before network");
    const sent = new Map(preferred.payload!.tools!.map(tool => [tool.name, tool]));
    // The keyword stays in the declared schema; only strict sampling is dropped for that tool.
    expect(sent.get("bounded")).not.toHaveProperty("strict");
    expect(sent.get("bounded")!.input_schema.properties.count).toMatchObject({ minimum: 1, maximum: 10 });
    expect(sent.get("plain")).toHaveProperty("strict", true);
    const required = await capture([fixtureTool("bounded", "require", true)]);
    expect(required.payload).toBeUndefined();
    expect(required.result.errorMessage).toContain('Tool "bounded" requires JSON-schema constrained sampling');
  });

  test("Durable still validates arguments against keywords left out of strict sampling", async () => {
    const files = await tempFixture("pi-validate-");
    const { faux, models, model } = fauxModels();
    let executed = 0, result: Message | undefined;
    const bounded = { ...fixtureTool("bounded", "prefer", true), replay: "safe",
      execute: async () => { executed++; return { output: [{ type: "text", text: "ran" }] }; } } as unknown as ToolRegistration;
    const group = await openGroupHarness(join(files.root, "group.sqlite"), models, { extensions: [defineExtension({ name: "fixture.bounded", tools: [bounded] })] });
    try {
      const conversation = (await memberConversation(group.harness, scopeOf("group-a"), "alice", { model }, context)).conversation;
      faux.setResponses([fauxAssistantMessage([fauxToolCall("bounded", { count: 99 })], { stopReason: "toolUse" }),
        (transcript) => { result = transcript.messages.find(message => message.role === "toolResult"); return fauxAssistantMessage("done"); }]);
      await (await conversation.submit({ type: "input", content: "use the bounded tool" }, context)).wait(context);
      expect(executed).toBe(0);
      expect(result).toMatchObject({ isError: true, toolName: "bounded" });
      // Refused by the schema (count ≤ 10), not as an unknown tool.
      expect(JSON.stringify(result)).toContain("count");
    } finally {
      await group.close();
      await files.cleanup();
    }
  });

  test("provider retries back off on an unparseable Retry-After, stop on cancel and honour the delay cap", async () => {
    const files = await tempFixture("pi-retry-");
    const hits: number[] = [];
    let retryAfter = "not-a-date";
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
      hits.push(Date.now());
      return new Response(JSON.stringify({ error: { message: "slow down" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": retryAfter } });
    } });
    try {
      const modelsPath = join(files.root, "models.json");
      await writeFile(modelsPath, JSON.stringify({ providers: { "retry-gateway": {
        api: "openai-completions", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-only",
        models: [{ id: "retry-model", contextWindow: 8192, maxTokens: 512, reasoning: false }],
      } } }));
      const runtime = await ModelRuntime.create({ modelsPath, credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
      const model = runtime.getModel("retry-gateway", "retry-model")!;
      const production = enginePolicy({}).stream;
      expect(production).toMatchObject({ maxRetries: 0, maxRetryDelayMs: 5000 });
      // Exercise the SDK's standalone backoff with one retry; production retries only through Durable.
      const policy = { ...production, maxRetries: 1 };
      const call = (signal?: AbortSignal) => runtime.completeSimple(model,
        { messages: [{ role: "user", content: "retry", timestamp: 0 }] },
        { maxRetries: policy.maxRetries, maxRetryDelayMs: policy.maxRetryDelayMs, signal });

      const failed = await call();
      expect(failed.stopReason).toBe("error");
      expect(hits).toHaveLength(2);
      // Exponential backoff for the first retry is 375-500 ms; before 0.99.2 an unparseable date retried at once.
      expect(hits[1]! - hits[0]!).toBeGreaterThanOrEqual(300);

      hits.length = 0;
      const controller = new AbortController();
      const started = Date.now();
      const pending = call(controller.signal);
      while (!hits.length) await Bun.sleep(5);
      controller.abort();
      const cancelled = await pending;
      expect(cancelled.stopReason).toBe("aborted");
      expect(Date.now() - started).toBeLessThan(2000);
      await Bun.sleep(600);
      expect(hits).toHaveLength(1);

      hits.length = 0;
      retryAfter = "30";
      const capped = await call();
      expect(hits).toHaveLength(1);
      expect(capped.errorMessage).toContain("Server requested 30s retry delay (max: 5s)");
    } finally {
      server.stop(true);
      await files.cleanup();
    }
  });
});
