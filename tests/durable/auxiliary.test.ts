import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type AssistantImages, type ClassifierModel, type ClassifierOptions, type ClassifierResult, type ImageModel, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, UsageDoc, type Conversation } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { AuxiliaryBudget, auxiliaryMemberTools } from "../../src/durable/auxiliary.ts";
import { codemodeExtension } from "../../src/durable/codemode/index.ts";
import { removeResultDirectories } from "../../src/durable/results/files.ts";
import { claimSpace, memberConversation } from "../../src/durable/identity.ts";
import { spaceDoor } from "../../src/durable/models.ts";
import { syncMemberStats } from "../../src/durable/projection.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { memberPlaces, memberRegistration } from "../../src/durable/tools.ts";
import { fauxModels } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { handoffFullResults, stubResultsBackend } from "../helpers/results-backend.ts";
import { scopeOf, statsOf } from "../helpers/layout.ts";
import { appLayout, groupScope } from "../../src/core/layout.ts";

const f = await tempFixture("durable-auxiliary-");
afterAll(() => f.cleanup());
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: .01, output: .01, cacheRead: 0, cacheWrite: 0, total: .02 } };
const classifier: ClassifierModel<"fixture-classifier"> = { type: "classifier", id: "route", name: "route", provider: "aux", api: "fixture-classifier",
  baseUrl: "https://fixture.invalid", input: ["text", "image"], contextWindow: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const image: ImageModel<"fixture-image"> = { ...classifier, type: "image", id: "image", name: "image", api: "fixture-image", output: ["image"] };
const result = (overrides: Partial<ClassifierResult> = {}): ClassifierResult => ({ api: classifier.api, provider: "aux", model: classifier.id,
  answers: { route: { type: "choice", choice: "ocr", confidence: .9, probabilities: { ocr: .9, text: .1 } } }, usage, stopReason: "stop", timestamp: Date.now(), ...overrides });
let n = 0;
async function setup(options: { credentials?: boolean; vision?: boolean; budget?: AuxiliaryBudget; retry?: number;
  classify?: (options: ClassifierOptions) => Promise<ClassifierResult>; waitForStart?: () => Promise<void>;
  dispatchError?: () => Error | undefined; beforeDispatch?: () => Promise<void> } = {}) {
  const { models, faux, model } = fauxModels();
  const state = { classifications: 0, images: 0, maxRetries: -1 };
  models.setProvider({ ...faux.provider, id: "aux", name: "aux", getModels: () => [],
    getAllModels: () => [{ ...classifier, input: options.vision === false ? ["text"] : classifier.input }, image],
    auth: { apiKey: { name: "fixture", resolve: async () => options.credentials === false ? undefined : { auth: { apiKey: "fixture-secret", headers: { "x-fixture": "private" } } } } },
    classify: async (_model, _context, request = {}) => { state.classifications++; state.maxRetries = request.maxRetries!; return options.classify?.(request) ?? result(); },
    generateImages: async () => { state.images++; return { api: image.api, provider: "aux", model: image.id, timestamp: Date.now(), stopReason: "stop", usage,
      output: [{ type: "image", data: PNG, mimeType: "image/png" }] } satisfies AssistantImages; },
  });
  const root = join(f.root, `root-${++n}`); await mkdir(root);
  const holder: { harness?: Harness } = {}, reports: unknown[] = [];
  const door = spaceDoor(holder, { onReport: e => reports.push(e), dispatchError: options.dispatchError,
    ...(options.beforeDispatch ? { beforeDispatch: options.beforeDispatch } : {}) });
  const members = { layout: appLayout(root), scope: groupScope("group-a") };
  const tools = auxiliaryMemberTools(members, door, { format: 1, classifier: { provider: "aux", modelId: "route" },
    image: { provider: "aux", modelId: "image" }, maxConcurrent: 1, classifierRetries: options.retry ?? 0 }, options.budget ?? new AuxiliaryBudget(1));
  if (options.waitForStart) tools.push({ definition: { name: "wait_for_auxiliary_start", label: "fixture barrier", description: "Wait for the synthetic provider dispatch.",
    parameters: Type.Object({}), execute: async () => { throw new Error("Member invocation required"); } }, replay: "safe", outputLimits: { maxBytes: 1024, maxLines: 10 },
    async run() { await options.waitForStart!(); return { content: [{ type: "text", text: "ready" }], details: undefined }; },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "mixin.auxiliary", tools: tools.map(memberRegistration) }));
  registry.install(codemodeExtension({ members, tools }));
  const view = door.wrap(models), path = join(f.root, `db-${n}.sqlite`);
  const harness = await Harness.open(await openGroupStorage(path), { registry, models: view, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } }, context);
  holder.harness = harness; await claimSpace(harness, scopeOf("group-a"), context);
  const { conversation } = await memberConversation(harness, scopeOf("group-a"), "alice", { model }, context);
  return { root, path, faux, state, harness, door, conversation, reports, view, tools, members, async close() { await door.close(); await harness.close(context); } };
}
async function invoke(g: Awaited<ReturnType<typeof setup>>, conversation: Conversation, name: string, args: unknown, during?: () => Promise<void>) {
  const id = `call-${++n}`;
  g.faux.setResponses([fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const submission = await conversation.submit({ type: "input", content: "work" }, context);
  await during?.(); await submission.wait(context);
  return (await conversation.entries({}, 200, undefined, context)).items.flatMap(entry => entry.model ?? [])
    .find(message => message.role === "toolResult" && message.toolCallId === id) as ToolResultMessage;
}
/** The conversation's tool usage in pi.usage: auxiliary tools return their provider usage on their result. */
async function toolUsage(g: Awaited<ReturnType<typeof setup>>) { return (await g.harness.snapshot(UsageDoc, g.conversation.id, context))?.tools ?? {}; }

test.each(process.platform === "linux" ? [false, true] : [false])("native auxiliary retries sum their usage and keep owned images (isolated=%s)", async isolated => {
  let calls = 0;
  const g = await setup({ retry: 1, classify: async request => {
    expect(request.apiKey).toBe("fixture-secret"); expect(request.headers).toMatchObject({ "x-fixture": "private" });
    return ++calls === 1 ? result({ stopReason: "error", errorMessage: "server_busy" }) : result();
  } });
  const ledger = openStatsLedger(statsOf(g.root));
  const runtime = isolated ? stubResultsBackend(join(f.root, `control-${n}`)) : undefined;
  try {
    if (isolated) await handoffFullResults(g.harness);
    const classified = await invoke(g, g.conversation, "document_route", { text: "scanned page", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(classified.isError).toBe(false); expect(JSON.parse((classified.content[0] as { text: string }).text)).toMatchObject({ route: "ocr" });
    // Both attempts were answered and billed by the provider: the result carries their sum.
    expect(classified.usage).toMatchObject({ input: 20, output: 4, totalTokens: 24, cost: { total: .04 } });
    expect(g.state.classifications).toBe(2); expect(g.state.maxRetries).toBe(0);
    const generated = await invoke(g, g.conversation, "generate_image", { prompt: "fixture" });
    expect(generated.isError).toBe(false); expect(generated.usage).toMatchObject({ input: 10, output: 2, totalTokens: 12 });
    expect(generated.durationMs).toBeGreaterThanOrEqual(0);
    const path = generated.content.find(item => item.type === "text" && item.text.startsWith("Image saved to "))!;
    expect(path.type).toBe("text");
    const imagePath = (path as { text: string }).text.slice("Image saved to ".length);
    expect(await readFile(imagePath)).toEqual(Buffer.from(PNG, "base64"));
    expect(imagePath.startsWith(memberPlaces(g.members, g.members.scope, "alice").tempDir)).toBe(true);
    expect(Object.values((await g.harness.snapshot(ResultsDoc, context))!.calls).filter(call => call.phone === "alice")).toMatchObject([{ phone: "alice" }]);
    const used = await toolUsage(g);
    expect([used.document_route?.totalTokens, used.generate_image?.totalTokens]).toEqual([24, 12]);
    const member = { scope: scopeOf("group-a"), phone: "alice", conversationId: g.conversation.id };
    await syncMemberStats(ledger, g.harness, member, context); await syncMemberStats(ledger, g.harness, member, context);
    const billed = readLedger(ledger).usage.filter(row => row.bucket === "tools").map(({ key, input, totalTokens }) => ({ key, input, totalTokens }));
    expect(billed).toEqual([{ key: "document_route", input: 20, totalTokens: 24 }, { key: "generate_image", input: 10, totalTokens: 12 }]);
    const calls = (await g.harness.snapshot(ResultsDoc, context))!.calls, names = Object.keys(calls).filter(name => calls[name]!.phone === "alice");
    const mapping = new Map(names.flatMap(name => calls[name]!.isolatedTask ? [[name, calls[name]!.isolatedTask!] as const] : []));
    if (isolated) expect(mapping.size).toBe(1);
    const tempDir = memberPlaces(g.members, g.members.scope, "alice").tempDir;
    const policy = { registered: new Set(names), protected: new Set(names), isolated: mapping, expire: async () => {} };
    expect(await removeResultDirectories(tempDir, Infinity, policy)).toEqual([]);
    expect(await readFile(imagePath)).toEqual(Buffer.from(PNG, "base64"));
    policy.protected.clear();
    expect(await removeResultDirectories(tempDir, Infinity, policy)).toEqual(process.platform === "linux" && !isolated ? [] : names);
    if (runtime) for (const id of mapping.values()) expect((await runtime.backend.describe(id, tempDir)).phase).toBe("removed");
    if (isolated) expect((await g.harness.snapshot(ResultsDoc, context))!.calls["999999-protected"]!.phone).toBe("protected-member");
    expect(g.reports).toEqual([]);
  } finally { runtime?.restore(); ledger.close(); await g.close(); }
}, 15000);

test.each(["credentials", "image-capability"])("auxiliary setup failure (%s) sends no provider request and charges nothing", async failure => {
  const g = await setup({ credentials: failure !== "credentials", vision: failure !== "image-capability" });
  try {
    const value = await invoke(g, g.conversation, "document_route", { text: "page", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(value.isError).toBe(true); expect(g.state.classifications).toBe(0); expect(await toolUsage(g)).toEqual({});
  } finally { await g.close(); }
});

test("the tool model view cannot bypass the request door", async () => {
  const g = await setup();
  try {
    await expect(g.view.classify(classifier, { state: {}, questions: {} })).rejects.toThrow("explicit Durable tool");
    expect(() => g.view.getProvider("aux")).toThrow("unavailable");
    expect(() => g.view.stream(classifier as never, { messages: [] })).toThrow("unavailable");
    expect(() => g.view.refresh()).toThrow("unavailable");
    expect(() => (g.view as unknown as { getRegisteredProviderConfig(id: string): unknown }).getRegisteredProviderConfig("aux")).toThrow("unavailable");
    expect(g.state.classifications).toBe(0);
  } finally { await g.close(); }
});

for (const operation of ["classifier", "image"] as const) test.each(["control", "deadline"])(
  `a %s arriving just before the ${operation} dispatch prevents it and charges nothing`, async cause => {
  let expired = false, intercepted = false;
  const received = Promise.withResolvers<void>();
  const g: Awaited<ReturnType<typeof setup>> = await setup({
    dispatchError: () => expired ? new Error("synthetic total deadline") : undefined,
    beforeDispatch: async () => {
      if (intercepted) return;
      intercepted = true;
      if (cause === "deadline") expired = true;
      else g.door.controlReceived("alice", "stop-fixture");
      received.resolve();
    },
  });
  try {
    await invoke(g, g.conversation, operation === "classifier" ? "document_route" : "generate_image",
      operation === "classifier" ? { text: "page" } : { prompt: "fixture" }, async () => {
        await received.promise;
        if (cause === "control") { await g.conversation.abort(context); g.door.controlExecuted("stop-fixture"); }
      });
    expect(intercepted).toBe(true); expect(g.state.classifications).toBe(0); expect(g.state.images).toBe(0);
    expect(await toolUsage(g)).toEqual({});
  } finally { g.door.controlExecuted("stop-fixture"); await g.close(); }
});

test("an aborted auxiliary call without usage charges nothing and cold recovery never replays it", async () => {
  const started = Promise.withResolvers<void>();
  const g = await setup({ classify: async request => {
    started.resolve(); await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return result({ stopReason: "aborted", usage: undefined, answers: {} });
  } });
  try {
    await invoke(g, g.conversation, "document_route", { text: "page" }, async () => { await started.promise; await g.conversation.abort(context); });
    expect(await toolUsage(g)).toEqual({});
    const count = g.state.classifications; await g.close();
    const read = await Harness.open(await openGroupStorage(g.path), { models: g.view, registry: createRegistry() }, context);
    try { expect((await read.snapshot(UsageDoc, g.conversation.id, context))?.tools ?? {}).toEqual({}); expect(g.state.classifications).toBe(count); }
    finally { await read.close(context); }
  } finally { await g.close(); }
});

test("shared auxiliary budget bounds active work; a queued cancellation sends nothing", async () => {
  const budget = new AuxiliaryBudget(1), first = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const abort = new AbortController(); let active = 0, maximum = 0, queuedSent = false;
  const one = budget.run(new AbortController().signal, async () => { maximum = Math.max(maximum, ++active); first.resolve(); await release.promise; active--; });
  await first.promise;
  const two = budget.run(abort.signal, async () => { queuedSent = true; });
  abort.abort(new Error("cancelled queue")); await expect(two).rejects.toThrow("cancelled queue");
  const three = budget.run(new AbortController().signal, async () => { maximum = Math.max(maximum, ++active); active--; });
  release.resolve(); await Promise.all([one, three]); expect(maximum).toBe(1); expect(queuedSent).toBe(false);
});

test("codemode calls the same bounded model tool; its usage counts once, under the child tool, not under codemode", async () => {
  const g = await setup();
  const ledger = openStatsLedger(statsOf(g.root));
  try {
    const value = await invoke(g, g.conversation, "codemode", { code: 'return await tools.document_route({text:"fixture"});' });
    expect(value.isError).toBe(false); expect(JSON.stringify(value.content)).toContain("ocr");
    expect(value.usage).toBeUndefined(); expect(g.state.classifications).toBe(1);
    expect(Object.keys(await toolUsage(g))).toEqual(["document_route"]);
    const identity = { scope: scopeOf("group-a"), phone: "alice", conversationId: g.conversation.id };
    for (let repeat = 0; repeat < 2; repeat++) {
      await syncMemberStats(ledger, g.harness, identity, context);
      const rows = readLedger(ledger).usage.filter(row => row.bucket === "tools");
      expect(rows.map(({ key, totalTokens }) => ({ key, totalTokens }))).toEqual([{ key: "document_route", totalTokens: 12 }]);
    }
  } finally { ledger.close(); await g.close(); }
});

test("finishing codemode cancels an unawaited auxiliary child while the parent conversation remains live", async () => {
  const started = Promise.withResolvers<void>(); let cancelled = false;
  const g = await setup({ waitForStart: () => started.promise, classify: async request => {
    started.resolve();
    await new Promise<void>(resolve => {
      const abort = () => { cancelled = true; resolve(); };
      request.signal!.addEventListener("abort", abort, { once: true });
      if (request.signal!.aborted) abort();
    });
    return result({ stopReason: "aborted", usage: undefined, answers: {} });
  } });
  try {
    const value = await invoke(g, g.conversation, "codemode", { code:
      'void tools.document_route({text:"fixture"}).catch(() => {}); await tools.wait_for_auxiliary_start({}); return "finished";' });
    expect(value.isError).toBe(false); expect(cancelled).toBe(true);
    expect(value.details).toMatchObject({ calls: [
      { name: "document_route", status: "cancelled" }, { name: "wait_for_auxiliary_start", status: "ok" },
    ] }); expect((value.details as { partial?: true }).partial).toBeUndefined();
    expect(g.state.classifications).toBe(1);
    expect(await toolUsage(g)).toEqual({}); expect(g.reports).toEqual([]);
    const history = (await g.conversation.entries({ order: "ascending" }, 200, undefined, context)).items.flatMap(entry => entry.model ?? []);
    expect(history.filter(message => message.role === "assistant").at(-1)?.content).toEqual([{ type: "text", text: "done" }]);
  } finally { await g.close(); }
}, 15000);

test("an auxiliary reply arriving after the door closes is charged once with its result", async () => {
  const started = Promise.withResolvers<void>(), reply = Promise.withResolvers<ClassifierResult>();
  const g = await setup({ classify: async () => { started.resolve(); return reply.promise; } });
  try {
    const work = invoke(g, g.conversation, "document_route", { text: "late" });
    await started.promise; await g.door.close(); reply.resolve(result()); await work;
    expect(Object.values(await toolUsage(g)).map(used => used.totalTokens)).toEqual([12]); expect(g.reports).toEqual([]);
  } finally { reply.resolve(result()); await g.close(); }
}, 15000);
