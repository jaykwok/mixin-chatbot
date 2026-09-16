// Production runtime -> official Pi SDK -> real adapter; intercept before any HTTP.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { mock } from "bun:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
const sdk = await import("@earendil-works/pi-coding-agent");
const [kind, policy] = process.argv.slice(2);
const documentWorkEnabled = kind !== "document-work-disabled";
delete process.env.BOT_DOCUMENT_WORK_ENABLED;
if (!documentWorkEnabled) process.env.BOT_DOCUMENT_WORK_ENABLED = "0";
delete process.env.PI_CACHE_RETENTION;
process.env.BOT_MODEL_CACHE_RETENTION = policy;
if (kind === "sdk-env") process.env.PI_CACHE_RETENTION = "long";
globalThis.fetch = (() => { throw new Error("Unexpected network request"); }) as unknown as typeof fetch;
const provider = kind === "zai" ? "zai" : "openai";
const modelId = kind === "zai" ? "glm-5.3-flash" : kind === "legacy" ? "gpt-5.2" : "gpt-6-astra";
const providerConfig = kind === "zai" ? { api: "openai-responses", apiKey: "fixture-only", baseUrl: "https://open.bigmodel.cn/api/v1",
  models: [{ id: modelId, contextWindow: 8192, maxTokens: 512, reasoning: false }] } : { apiKey: "fixture-only" };
await mkdir("data/config", { recursive: true });
await mkdir("data/runtime/pi", { recursive: true });
await writeFile("data/config/models.json", JSON.stringify({ providers: { [provider]: providerConfig } }));
await writeFile("data/runtime/pi/settings.json",
  JSON.stringify({ defaultProvider: provider, defaultModel: modelId, defaultThinkingLevel: "off" }));
const createRuntime = sdk.ModelRuntime.create.bind(sdk.ModelRuntime);
let liveRuntime: any;
const payloads: any[] = [], forwarded: any[] = [];
mock.module("@earendil-works/pi-coding-agent", () => ({ ...sdk,
  ModelRuntime: { create: async (options: any) => {
    liveRuntime = await createRuntime({ ...options, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
    const realStream = liveRuntime.streamSimple.bind(liveRuntime);
    liveRuntime.streamSimple = (model: any, context: any, streamOptions: any) => {
      if (context.systemPrompt) {
        assert.equal(context.systemPrompt.includes("<name>document-work</name>"), documentWorkEnabled);
        assert.equal(context.systemPrompt.includes("SKILL.md"), documentWorkEnabled);
        assert.equal(context.systemPrompt.includes("## 文档加工"), documentWorkEnabled);
        assert.ok(!context.systemPrompt.includes("底稿提供结构，当前正式资料提供事实"), "skill body must load on demand");
      }
      forwarded.push({ cacheRetention: streamOptions?.cacheRetention, sessionId: streamOptions?.sessionId });
      return realStream(model, context, { ...streamOptions, apiKey: "fixture-only", maxRetries: 0,
        onPayload(body: any) { payloads.push(body); throw new Error("captured before HTTP"); } });
    };
    return liveRuntime;
  } },
}));
mock.module("../../src/agent/local-tools.ts", () => ({ buildLocalTools: async () => [] }));
mock.module("../../src/integrations/im.ts", () => ({
  abortOutboundRequests() {}, getOutboundRateStatus: () => ({ used: 0, limit: 20 }), sendReplyWithMention: async () => true, sendText: async () => true,
  uploadAttachment: async () => { throw new Error("unexpected upload"); }, sendFile: async () => false, sendImage: async () => false,
}));
const runtime = await import("../../src/agent/runtime.ts");
const { application } = await import("../../src/core/lifecycle.ts");
const { stateDatabase } = await import("../../src/core/state.ts");
try {
  for (const text of ["First fixture prompt", "Second fixture prompt"]) {
    await assert.rejects(runtime.handleUserMessage("user", "group", text, "https://im.zdxlz.com/im-external/v1/webhook/send?key=fixture"), /captured before HTTP/);
  }
  assert.equal(payloads.length, 2);
  for (const name of ["document_inspect", "document_patch", "document_compose", "document_render"]) {
    assert.equal(payloads[0].tools.some((tool: any) => tool.name === name), documentWorkEnabled, "module tool visibility: " + name);
  }
  for (const name of ["document_extract", "document_environment", "send_file", "send_image"]) {
    assert.ok(payloads[0].tools.some((tool: any) => tool.name === name), "base tool missing: " + name);
  }
  assert.equal(forwarded[0].cacheRetention, policy === "auto" ? undefined : policy);
  assert.ok(forwarded[0].sessionId);
  assert.equal(forwarded[0].sessionId, forwarded[1].sessionId);
  assert.equal(payloads[0].prompt_cache_key, payloads[1].prompt_cache_key);
  if (policy === "long" || kind === "sdk-env") {
    if (kind === "legacy") assert.equal(payloads[0].prompt_cache_retention, "24h");
    else assert.deepEqual(payloads[0].prompt_cache_options, { ttl: "30m" });
  } else {
    assert.equal(payloads[0].prompt_cache_retention, undefined);
    assert.equal(payloads[0].prompt_cache_options, undefined);
  }
  // SDK compaction explicitly opts out; a project override must preserve that choice.
  await liveRuntime.completeSimple(liveRuntime.getModel(provider, modelId), { messages: [{ role: "user", content: "one-shot", timestamp: 0 }] },
    { cacheRetention: "none", sessionId: "one-shot" });
  assert.equal(forwarded.at(-1).cacheRetention, "none");
  assert.equal(payloads.at(-1).prompt_cache_retention, undefined);
  assert.equal(payloads.at(-1).prompt_cache_options?.ttl, undefined);
  if (modelId === "gpt-6-astra") assert.deepEqual(payloads.at(-1).prompt_cache_options, { mode: "explicit" });
  assert.equal(payloads.at(-1).prompt_cache_key, undefined);
  console.log("CACHE_PAYLOAD_PASSED");
} finally { await runtime.disposeAllSessions(); await application.drain(); stateDatabase().close(); }
