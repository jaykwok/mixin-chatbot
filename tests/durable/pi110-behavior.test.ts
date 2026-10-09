import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { calculateCost, normalizeContext, type Usage } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { AttemptsDoc } from "../../src/durable/attempts.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("pi110-behavior-"); afterAll(() => fixture.cleanup());
let n = 0;
test("3.5 character estimates reduce output limits near the window, while preserving the configured maximum", () => {
  const { models, model: ref } = fauxModels(), base = models.getModel(ref.provider, ref.modelId)!;
  const model = { ...base, contextWindow: 16384, maxTokens: 8192 };
  expect(estimateTextTokens("x".repeat(28672))).toBe(8192);
  expect(buildBaseOptions(model, normalizeContext({ messages: [{ role: "user", content: "x".repeat(28672), timestamp: 1 }] }), {}, "fixture").maxTokens).toBe(4096);
  expect(buildBaseOptions(model, normalizeContext({ messages: [{ role: "user", content: "x".repeat(43008), timestamp: 1 }] }), {}, "fixture").maxTokens).toBe(1);
  expect(buildBaseOptions(model, normalizeContext({ messages: [] }), { maxTokens: 777 }, "fixture").maxTokens).toBe(777);
});

test("tier pricing uses the whole request's input plus cache and never rewrites an existing usage fact", () => {
  const { models, model: ref } = fauxModels(), base = models.getModel(ref.provider, ref.modelId)!;
  const model = { ...base, cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1.5, tiers: [
    { inputTokensAbove: 200000, input: 2, output: 3, cacheRead: .2, cacheWrite: 2.5 },
  ] } };
  const old: Usage = { input: 180000, output: 10, cacheRead: 25000, cacheWrite: 0, totalTokens: 205010,
    cost: { input: 1, output: .741503, cacheRead: 0, cacheWrite: 0, total: 1.741503 } };
  const next = structuredClone(old); calculateCost(model, next);
  expect(next.cost.total).toBeCloseTo(.36503, 8); expect(old.cost.total).toBe(1.741503);
  const official = anthropicProvider().getModels();
  expect(official.filter(model => model.cost.tiers?.length).length).toBeGreaterThan(0);
  expect(official.every(model => model.cost.tiers?.every(tier => tier.inputTokensAbove > 0) ?? true)).toBe(true);
});

test.each(["server_busy", "servers are currently busy", "the engine is currently overloaded", "503 service unavailable"])("native retry %s has a fresh start and SDK retries zero", async error => {
  const { faux, models, model } = fauxModels();
  expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: error }))).toBe(true);
  const options: number[] = [];
  faux.setResponses([(_transcript, request) => { options.push(request!.maxRetries!); return fauxAssistantMessage("", { stopReason: "error", errorMessage: error }); },
    (_transcript, request) => { options.push(request!.maxRetries!); return fauxAssistantMessage("retry result"); }]);
  const opened = await openGroupHarness(join(fixture.root, `retry-${++n}.sqlite`), models,
    { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 }, stream: { maxRetries: 0, timeoutMs: 120000 } } });
  try {
    const { conversation } = await memberConversation(opened.harness, "group-a", "alice", { model }, context);
    expect((await (await conversation.submit({ type: "input", content: "retry" }, context)).wait(context)).status).toBe("done");
    expect(options).toEqual([0, 0]); expect(faux.state.callCount).toBe(2);
    const starts = Object.values((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts);
    expect(starts).toHaveLength(2); expect(starts.map(start => start.attempt)).toEqual([1, 2]);
    expect(starts[0]!.usage).toBeUndefined(); expect(starts[1]!.usage).toBeDefined();
    const response = (await conversation.entries({}, 30, undefined, context)).items.flatMap(entry => entry.model ?? []).find(message => message.role === "assistant" && message.stopReason === "stop")!;
    expect(response.role === "assistant" && response.durationMs! >= 0).toBe(true);
  } finally { await opened.close(); }
});

test("budget and account exhaustion remain non-retryable", () => {
  for (const errorMessage of ["insufficient_quota", "Monthly usage limit reached", "subscription_sharing_usage_limit_exceeded"])
    expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
});

test("Radius's known account catalog replaces the shipped baseline, including an empty catalog", async () => {
  const radius = radiusProvider(), shipped = radius.getModels(); expect(shipped.length).toBeGreaterThan(1);
  const publish = async (value: { update?: () => void }) => { value.update?.(); return true; };
  await radius.refreshModels!({ stored: { models: [shipped[0]!], checkedAt: 1 }, allowNetwork: false, signal: new AbortController().signal, publish });
  expect(radius.getModels().map(model => model.id)).toEqual([shipped[0]!.id]);
  await radius.refreshModels!({ stored: { models: [], checkedAt: 2 }, allowNetwork: false, signal: new AbortController().signal, publish });
  expect(radius.getModels()).toEqual([]);
});

test("Codex SSE preserves custom model/request headers through the public API without a real account", async () => {
  const model = { ...openaiCodexProvider().getModels()[0]!, headers: { "x-fixture-model": "model", "x-fixture-case": "model" } };
  const apiKey = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
  let seen: Headers | undefined;
  const result = await codexStream(model, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] }), {
    apiKey, transport: "sse", maxRetries: 0, headers: { "x-fixture-request": "request", "x-fixture-case": "request" },
    fetch: (async (_url, init) => { seen = new Headers(init?.headers); return Response.json({ error: { message: "fixture stop" } }, { status: 400 }); }) as typeof fetch,
  }).result();
  expect(result.stopReason).toBe("error"); expect(seen!.get("x-fixture-model")).toBe("model");
  expect(seen!.get("x-fixture-request")).toBe("request"); expect(seen!.get("x-fixture-case")).toBe("request");
});

test.each(["openai.gpt-5.4", "openai.gpt-oss-120b-1:0"])("Bedrock OpenAI reasoning payload for %s is built before any network dispatch", async id => {
  const { models, model: ref } = fauxModels(), base = models.getModel(ref.provider, ref.modelId)!;
  let payload: { additionalModelRequestFields?: unknown } | undefined;
  const result = await bedrockStream({ ...base, provider: "amazon-bedrock", api: "bedrock-converse-stream", id, reasoning: true, compat: undefined }, normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 1 }] }), {
    bearerToken: "fixture", env: { AWS_REGION: "us-east-1" }, reasoning: "minimal", maxRetries: 0,
    onPayload: value => { payload = value as typeof payload; throw new Error("fixture stop before dispatch"); },
  }).result();
  expect(result.stopReason).toBe("error"); expect(result.errorMessage).toContain("fixture stop before dispatch");
  expect(payload!.additionalModelRequestFields).toEqual(id.includes("gpt-oss") ? { reasoning_effort: "low" } : { reasoning: { effort: "low" } });
});
