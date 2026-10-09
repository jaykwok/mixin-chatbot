// Model access for the Durable engine (D2-1) against a local fake OpenAI-compatible server on 127.0.0.1: model
// selection and the settings mapping, credentials and headers through the request door versus ModelRuntime directly,
// routed models, samplingParamsByThinkingLevel, and the D0 P05 checks (retries are durable, an abort right after the
// handover cancels the request). No external network, synthetic keys only.
import { afterAll, describe, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AssistantEntry, type Conversation, type HarnessSettings, ProviderDoc } from "@earendil-works/pi-durable";
import { openModelRuntime, openSettings } from "../../src/core/model-config.ts";
import { AttemptsDoc } from "../../src/durable/attempts.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { openModelSelection, selectModel } from "../../src/durable/models.ts";
import { type GroupHarness, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

type Seen = { path: string; authorization: string | null; headers: Record<string, string>; body: Record<string, unknown> };
const seen: Seen[] = [];
/** The next `fail` requests answer 503; the next request is held `hold` ms before it is answered. */
const plan = { fail: 0, hold: 0 };
/** Requests whose headers reached the server (counted before the body is read). */
let arrivals = 0;
const json = { "content-type": "application/json" };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    arrivals++;
    const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (body === undefined) return new Response("", { status: 400 });
    const path = new URL(request.url).pathname;
    seen.push({ path, authorization: request.headers.get("authorization"), headers: Object.fromEntries(request.headers), body });
    if (plan.hold > 0) { const ms = plan.hold; plan.hold = 0; await Bun.sleep(ms); }
    if (plan.fail > 0) {
      plan.fail--;
      return new Response(JSON.stringify({ error: { message: "service unavailable (synthetic)", type: "server_error" } }), { status: 503, headers: json });
    }
    // Only chat completions answer; the Responses APIs are checked by their request bodies.
    if (!path.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ error: { message: "synthetic: not answered", type: "invalid_request_error" } }), { status: 400, headers: json });
    }
    const id = `chatcmpl-${seen.length}`;
    const chunk = (payload: object) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, ...payload })}\n\n`;
    return new Response(
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "本地服务" }, finish_reason: null }] })
      + chunk({ choices: [{ index: 0, delta: { content: "的回答" }, finish_reason: null }] })
      + chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
      + chunk({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 400 } } })
      + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
const fixture = await tempFixture("durable-models-");
afterAll(async () => { server.stop(true); await fixture.cleanup(); });

const base = `http://127.0.0.1:${server.port}/v1`;
const SAMPLING = {
  samplingParams: { top_p: 0.95, presence_penalty: 0.1 },
  samplingParamsByThinkingLevel: { off: { temperature: 0.2 }, high: { temperature: 0.9, top_p: 0.5 } },
};
const model = (id: string, extra: object = {}) => ({
  id, name: id, contextWindow: 32000, maxTokens: 1024, reasoning: false, input: ["text"],
  cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }, ...extra,
});
const tuned = () => model("tuned", { reasoning: true, ...SAMPLING });
const ENV_KEY = "MIXIN_DURABLE_MODELS_TEST_KEY";
const agentDir = join(fixture.root, "agent");
const modelsPath = join(agentDir, "models.json");
const modelsStorePath = join(agentDir, "models-store.json");
await mkdir(agentDir, { recursive: true });
await writeFile(modelsPath, JSON.stringify({
  providers: {
    "local-key": {
      api: "openai-completions", baseUrl: base, apiKey: "synthetic-literal-key",
      headers: { "X-Static": "from-models-json", "X-Case": "from-models-json" },
      models: [model("chat"), tuned()],
    },
    "local-env": { api: "openai-completions", baseUrl: base, apiKey: `$${ENV_KEY}`, models: [model("chat")] },
    "local-command": { api: "openai-completions", baseUrl: base, apiKey: "!echo synthetic-command-key", models: [model("chat")] },
    "local-responses": { api: "openai-responses", baseUrl: base, apiKey: "synthetic-literal-key", models: [tuned(), model("plain", { reasoning: true })] },
    "local-azure": { api: "azure-openai-responses", baseUrl: base, apiKey: "synthetic-literal-key", models: [tuned(), model("plain", { reasoning: true })] },
  },
}));
let counter = 0;

async function settingsFile(settings: object): Promise<string> {
  const path = join(fixture.root, `settings-${++counter}.json`);
  await writeFile(path, JSON.stringify(settings));
  return path;
}

const runtime = () => openModelRuntime({ modelsPath, modelsStorePath });
/** Test settings: no SDK retries (as mapped), short Durable retry delays. */
const SETTINGS: HarnessSettings = { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, stream: { maxRetries: 0, timeoutMs: 10000 } };

function open(models: Models | ModelRuntime, options: Parameters<typeof openGroupHarness>[2] = {}): Promise<GroupHarness> {
  return openGroupHarness(join(fixture.root, `db-${++counter}.sqlite`), models as Models, { settings: SETTINGS, ...options });
}

/** One turn of member m1 on `ref`; returns what the server received, with the conversation's pi.provider id normalised. */
async function turn(opened: GroupHarness, ref: { provider: string; modelId: string }, thinkingLevel: "off" | "high" = "off") {
  const before = seen.length;
  const { conversation } = await memberConversation(opened.harness, "group-a", "m1", { model: ref, thinkingLevel }, context);
  const settled = await (await conversation.submit({ type: "input", content: "同一个问题", requestId: "t1" }, context)).wait(context);
  const own = (await opened.harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId;
  const requests = seen.slice(before);
  const normalised = own === undefined ? requests : JSON.parse(JSON.stringify(requests).replaceAll(own, "<own pi.provider>")) as Seen[];
  return { conversation, settled, own, requests: normalised, raw: requests };
}

async function assistants(conversation: Conversation): Promise<AssistantMessage[]> {
  const page = await conversation.entries({}, 200, undefined, context);
  return [...page.items].reverse().filter((entry) => AssistantEntry.is(entry)).map((entry) => entry.model![0] as AssistantMessage);
}

describe("model selection and Durable settings", () => {
  test("the configured model, with the project's run policy mapped onto Durable settings", async () => {
    const settingsPath = await settingsFile({
      defaultProvider: "local-key", defaultModel: "chat", defaultThinkingLevel: "high",
      durable: { compaction: { reserveTokens: 1024, keepRecentTokens: 2048 } },
    });
    const selection = await openModelSelection({ modelsPath, modelsStorePath, settingsPath, cacheRetention: "long" });
    expect(selection.ref).toEqual({ provider: "local-key", modelId: "chat" });
    expect(selection.thinkingLevel).toBe("off");
    expect(selection.harnessSettings).toEqual({
      // Agent retry 1 × SDK retry 1 today: up to 4 HTTP requests; Durable retries 3 times, SDK retries are off.
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 1000, maxAgentDelayMs: 5000 },
      stream: { timeoutMs: 120000, maxRetries: 0, maxRetryDelayMs: 5000, cacheRetention: "long" },
      // Window 32000: background compaction an eighth of the window below the blocking threshold (src/durable/compaction.ts).
      compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 2048, backgroundTokens: 4000 },
      followUpMode: "one-at-a-time",
      steeringMode: "one-at-a-time",
      // Pi 1.0.3: tool progress every 20 ms (codemode sub-calls wait for it), answer progress at Durable's 100 ms.
      progress: { partialIntervalMs: 100, outputIntervalMs: 20 },
      contextRetentionMs: 600000,
    });
    expect(selection.notices).toEqual([]);
    const reasoning = await openModelSelection({ modelsPath, modelsStorePath, settingsPath: await settingsFile({ defaultProvider: "local-key", defaultModel: "tuned", defaultThinkingLevel: "high" }) });
    expect(reasoning.thinkingLevel).toBe("high");
    expect(reasoning.harnessSettings.stream).toEqual({ timeoutMs: 120000, maxRetries: 0, maxRetryDelayMs: 5000 });
  });

  test("legacy engine settings require the one-time migration", async () => {
    for (const mode of ["idle", "streaming"] as const) {
      const settingsPath = await settingsFile({ defaultProvider: "local-key", defaultModel: "chat", cacheWarming: mode });
      await expect(openModelSelection({ modelsPath, modelsStorePath, settingsPath })).rejects.toThrow("旧配置请通过升级迁移");
    }
  });

  test("a routed (virtual) model is refused at startup and by the door; ModelRuntime itself would route and send it", async () => {
    const routed = await runtime();
    routed.registerVirtualModel({ provider: "local-key", id: "router", name: "Router", route: () => ({ model: routed.getModel("local-key", "chat")!, thinkingLevel: "off" }) });
    const settings = openSettings(await settingsFile({ defaultProvider: "local-key", defaultModel: "router" }));
    await expect(selectModel(routed, settings)).rejects.toThrow("路由（虚拟）模型");

    const ref = { provider: "local-key", modelId: "router" };
    const through = await open(routed);
    try {
      const result = await turn(through, ref);
      expect(result.settled.status).toBe("unanswered");
      expect(result.requests).toHaveLength(0);
      expect(through.door!.setupFailed).toBe(1);
      expect((await assistants(result.conversation))[0]!.errorMessage).toContain("routed model local-key/router");
    } finally { await through.close(); }
    const direct = await open(routed, { door: false });
    try {
      const result = await turn(direct, ref);
      expect(result.settled.status).toBe("done");
      expect(result.requests.map((request) => request.body.model)).toEqual(["chat"]);
    } finally { await direct.close(); }
  });
});

describe("credentials and headers through the door", () => {
  test("a models.json key, an environment reference and a command reference reach the server as from ModelRuntime directly; request headers replace models.json headers of any case", async () => {
    const previous = process.env[ENV_KEY];
    process.env[ENV_KEY] = "synthetic-env-key";
    try {
      const models = await runtime();
      const settings: HarnessSettings = { ...SETTINGS, stream: { ...SETTINGS.stream, headers: { "x-case": "from-request" } } };
      const expected: Record<string, string> = { "local-key": "synthetic-literal-key", "local-env": "synthetic-env-key", "local-command": "synthetic-command-key" };
      for (const [provider, key] of Object.entries(expected)) {
        const ref = { provider, modelId: "chat" };
        const results = [];
        for (const door of [true, false]) {
          const opened = await open(models, { settings, door: door ? {} : false });
          try { results.push({ ...(await turn(opened, ref)), dispatched: opened.door?.dispatched }); } finally { await opened.close(); }
        }
        const [through, direct] = results as [typeof results[0], typeof results[0]];
        expect([through.settled.status, direct.settled.status]).toEqual(["done", "done"]);
        expect(through.dispatched).toBe(1);
        expect(through.requests).toHaveLength(1);
        expect(through.requests).toEqual(direct.requests);
        const request = through.requests[0]!;
        expect(request.authorization).toBe(`Bearer ${key}`);
        expect(request.headers["x-case"]).toBe("from-request");
        expect<string | undefined>(request.headers["x-static"]).toBe(provider === "local-key" ? "from-models-json" : undefined);
        // openai-completions to a custom host sends no session id (no prompt_cache_key, no session header), so the two
        // conversations' different pi.provider ids leave the requests equal; door.test.ts checks the provider gets its own.
        expect(through.own).not.toBe(direct.own);
        expect(JSON.stringify(through.raw)).not.toContain(through.own!);
      }
    } finally {
      if (previous === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previous;
    }
  }, 30000); // the command reference starts a shell (about 3 s for a process's first spawn under HIPS)

  test("credentials resolved anew for each request and a header transform are forwarded as ModelRuntime forwards them (not enabled in the production configuration)", async () => {
    /** A runtime whose credentials change on every resolution, as a refreshed OAuth token would. */
    const rotating = async () => {
      const models = await runtime();
      const getAuth = models.getAuth.bind(models);
      let issued = 0;
      models.getAuth = (async (...args: Parameters<typeof getAuth>) => {
        const resolution = await getAuth(...args);
        return resolution && { ...resolution, auth: { ...resolution.auth, apiKey: `rotated-${++issued}` } };
      }) as typeof models.getAuth;
      return models;
    };
    /** Durable never passes `transformHeaders`; add one between the Harness and the Models view it was given. */
    const transforming = (models: Models): Models => new Proxy(models, {
      get: (target, property) => property === "streamSimple"
        ? (requestModel: never, transcript: never, options?: Record<string, unknown>) => target.streamSimple(requestModel, transcript, {
          ...options, transformHeaders: (headers: Record<string, string>) => ({ ...headers, "x-transformed": Object.keys(headers).sort().join(",") }),
        } as never)
        : Reflect.get(target, property, target),
    });
    const run = async (door: boolean) => {
      const opened = await open(await rotating(), { door: door ? {} : false, outside: transforming });
      try {
        const keys: (string | null)[] = [];
        const transformed: (string | undefined)[] = [];
        const { conversation } = await memberConversation(opened.harness, "group-a", "m1", { model: { provider: "local-key", modelId: "chat" } }, context);
        for (const requestId of ["r1", "r2"]) {
          const before = seen.length;
          expect((await (await conversation.submit({ type: "input", content: "轮换凭据", requestId }, context)).wait(context)).status).toBe("done");
          keys.push(...seen.slice(before).map((request) => request.authorization));
          transformed.push(...seen.slice(before).map((request) => request.headers["x-transformed"]));
        }
        return { keys, transformed };
      } finally { await opened.close(); }
    };
    const through = await run(true);
    const direct = await run(false);
    expect(through.keys).toEqual(["Bearer rotated-1", "Bearer rotated-2"]);
    expect(direct.keys).toEqual(through.keys);
    // The transform saw the merged headers (models.json's included) and its result was sent.
    expect(through.transformed).toHaveLength(2);
    expect(through.transformed[0]).toContain("X-Static");
    expect(through.transformed).toEqual(direct.transformed);
  });
});

describe("D0 P05 on the project's ModelRuntime", () => {
  test("a 503 is retried by Durable, not inside the SDK: every HTTP request is a durable entry with its own start; with an SDK retry it would not be", async () => {
    const models = await runtime();
    const selection = await selectModel(models, openSettings(await settingsFile({ defaultProvider: "local-key", defaultModel: "chat" })));
    const mapped: HarnessSettings = { ...selection.harnessSettings, retry: { ...selection.harnessSettings.retry, baseDelayMs: 5, maxAgentDelayMs: 20 } };
    const run = async (settings: HarnessSettings) => {
      const opened = await open(models, { settings });
      try {
        plan.fail = 1;
        const result = await turn(opened, selection.ref);
        const entries = await assistants(result.conversation);
        const starts = Object.values((await opened.harness.snapshot(AttemptsDoc, result.conversation.id, context))?.starts ?? {});
        return { status: result.settled.status, requests: result.requests.length, keys: result.requests.map((request) => request.authorization),
          entries: entries.map((message) => ({ stopReason: message.stopReason, cost: message.usage.cost.total > 0 })), starts: starts.length };
      } finally { plan.fail = 0; await opened.close(); }
    };
    expect(await run(mapped)).toEqual({
      status: "done", requests: 2, keys: ["Bearer synthetic-literal-key", "Bearer synthetic-literal-key"],
      entries: [{ stopReason: "error", cost: false }, { stopReason: "stop", cost: true }], starts: 2,
    });
    // Control: one SDK retry hides the 503 from Durable, two HTTP requests stand behind one entry and one start.
    const hidden = await run({ ...mapped, stream: { ...mapped.stream, maxRetries: 1 } });
    expect(hidden).toMatchObject({ status: "done", requests: 2, entries: [{ stopReason: "stop", cost: true }], starts: 1 });
  });

  test("an abort right after the handover cancels the request in flight; its start is recorded once and nothing follows", async () => {
    const models = await runtime();
    let target: Conversation | undefined;
    let aborted = false;
    // The control's abort, started synchronously at the handover (the earliest a control can act on a sent request).
    const opened = await open(models, { door: { onDispatch: () => { aborted = true; void target?.abort(context); } } });
    try {
      const { conversation } = await memberConversation(opened.harness, "group-a", "m1", { model: { provider: "local-key", modelId: "chat" } }, context);
      target = conversation;
      const before = arrivals;
      plan.hold = 2000;
      const settled = await (await conversation.submit({ type: "input", content: "交出后立即中止", requestId: "x1" }, context)).wait(context);
      await Bun.sleep(300);
      const atSettle = arrivals - before;
      await Bun.sleep(300);
      plan.hold = 0;
      const starts = Object.values((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))?.starts ?? {});
      expect({ status: settled.status, reason: "reason" in settled ? settled.reason : undefined }).toEqual({ status: "unanswered", reason: "aborted" });
      expect(aborted).toBe(true);
      expect(opened.door!.dispatched).toBe(1);
      // The request may or may not have reached the server before the abort; either way it counts once.
      expect(atSettle).toBeLessThanOrEqual(1);
      expect(arrivals - before).toBe(atSettle);
      expect(starts.map((start) => ({ k: start.k, withdrawn: start.withdrawn === true }))).toEqual([{ k: 1, withdrawn: false }]);
    } finally { plan.hold = 0; await opened.close(); }
  });
});

describe("samplingParamsByThinkingLevel", () => {
  const keys = ["temperature", "top_p", "presence_penalty"] as const;
  const sampling = (body: Record<string, unknown> | undefined) => Object.fromEntries(keys.filter((key) => body?.[key] !== undefined).map((key) => [key, body![key]]));

  test("models.json values reach ModelRuntime unchanged", async () => {
    const models = await runtime();
    for (const provider of ["local-key", "local-responses", "local-azure"]) {
      const configured = models.getModel(provider, "tuned")!;
      expect(configured.samplingParams).toEqual(SAMPLING.samplingParams);
      expect(configured.samplingParamsByThinkingLevel).toEqual(SAMPLING.samplingParamsByThinkingLevel);
    }
    expect(models.getModel("local-key", "chat")!.samplingParamsByThinkingLevel).toBeUndefined();
  });

  test("request bodies of the three OpenAI APIs: model defaults, the effective (clamped) level, request parameters last; nothing without configuration", async () => {
    const models = await runtime();
    // Azure reads its base URL from the environment before the model; pin it to the local server.
    const env = { AZURE_OPENAI_BASE_URL: base, AZURE_OPENAI_API_VERSION: "v1" };
    const body = async (provider: string, modelId: string, options: { reasoning?: "low" | "high" | "xhigh"; samplingParams?: Record<string, unknown> }) => {
      const before = seen.length;
      await models.completeSimple(models.getModel(provider, modelId)!, { messages: [{ role: "user", content: "采样参数", timestamp: Date.now() }] }, { ...options, maxRetries: 0, env });
      expect(seen.length).toBe(before + 1);
      return sampling(seen[before]!.body);
    };
    for (const [provider, plain] of [["local-key", "chat"], ["local-responses", "plain"], ["local-azure", "plain"]] as const) {
      expect(await body(provider, "tuned", {})).toEqual({ temperature: 0.2, top_p: 0.95, presence_penalty: 0.1 });
      // A level without its own entry keeps the model defaults.
      expect(await body(provider, "tuned", { reasoning: "low" })).toEqual({ top_p: 0.95, presence_penalty: 0.1 });
      // xhigh is not offered by this model and clamps to high.
      expect(await body(provider, "tuned", { reasoning: "xhigh" })).toEqual({ temperature: 0.9, top_p: 0.5, presence_penalty: 0.1 });
      expect(await body(provider, "tuned", { reasoning: "high", samplingParams: { temperature: 0.5 } })).toEqual({ temperature: 0.5, top_p: 0.5, presence_penalty: 0.1 });
      expect(await body(provider, plain, { reasoning: "high" })).toEqual({});
    }
  });

  test("through the door a member's thinking level selects its parameters, with the same body as without the door", async () => {
    const models = await runtime();
    const bodies = async (modelId: string, thinkingLevel: "off" | "high") => {
      const results = [];
      for (const door of [true, false]) {
        const opened = await open(models, { door: door ? {} : false });
        try { results.push(await turn(opened, { provider: "local-key", modelId }, thinkingLevel)); } finally { await opened.close(); }
      }
      const [through, direct] = results as [typeof results[0], typeof results[0]];
      expect([through.settled.status, direct.settled.status]).toEqual(["done", "done"]);
      expect(through.requests.map((request) => request.body)).toEqual(direct.requests.map((request) => request.body));
      return sampling(through.requests[0]!.body);
    };
    expect(await bodies("tuned", "high")).toEqual({ temperature: 0.9, top_p: 0.5, presence_penalty: 0.1 });
    expect(await bodies("tuned", "off")).toEqual({ temperature: 0.2, top_p: 0.95, presence_penalty: 0.1 });
    expect(await bodies("chat", "off")).toEqual({});
  });
});
