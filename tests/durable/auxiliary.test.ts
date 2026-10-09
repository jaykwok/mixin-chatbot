import { afterAll, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type AssistantImages, type ClassifierModel, type ClassifierOptions, type ClassifierResult, type ImageModel, type ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, type Conversation } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { AuxiliaryBudget, auxiliaryMemberTools } from "../../src/durable/auxiliary.ts";
import { AuxiliaryDoc } from "../../src/durable/auxiliary-records.ts";
import { codemodeExtension } from "../../src/durable/codemode/index.ts";
import { removeCodemodeResults } from "../../src/durable/codemode/results.ts";
import { claimGroup, memberConversation } from "../../src/durable/identity.ts";
import { groupDoor } from "../../src/durable/models.ts";
import { projectConversation } from "../../src/durable/projection.ts";
import { ResultsDoc } from "../../src/durable/result-lifecycle.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { memberPlaces, memberRegistration } from "../../src/durable/tools.ts";
import { fauxModels } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

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
  dispatchError?: () => Error | undefined } = {}) {
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
  const door = groupDoor(holder, { startTries: 1, onReport: e => reports.push(e), dispatchError: options.dispatchError });
  const members = { root, groupId: "group-a" };
  const tools = auxiliaryMemberTools(members, door, { format: 1, classifier: { provider: "aux", modelId: "route" },
    image: { provider: "aux", modelId: "image" }, maxConcurrent: 1, classifierRetries: options.retry ?? 0 }, options.budget ?? new AuxiliaryBudget(1));
  if (options.waitForStart) tools.push({ definition: { name: "wait_for_auxiliary_start", label: "fixture barrier", description: "Wait for the synthetic provider dispatch.",
    parameters: Type.Object({}), execute: async () => { throw new Error("Member invocation required"); } }, replay: "safe", outputLimits: { maxBytes: 1024, maxLines: 10 },
    async run() { await options.waitForStart!(); return { content: [{ type: "text", text: "ready" }], details: undefined }; },
  });
  const registry = createRegistry(); registry.install(door.extension());
  registry.install(defineExtension({ name: "mixin.auxiliary", tools: tools.map(memberRegistration) }));
  registry.install(codemodeExtension({ members, tools: tools.map(tool => ({ extension: "mixin.auxiliary", tool })) }));
  const view = door.wrap(models), path = join(f.root, `db-${n}.sqlite`);
  const harness = await Harness.open(await openGroupStorage(path), { registry, models: view, settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } }, context);
  holder.harness = harness; await claimGroup(harness, "group-a", context);
  const { conversation } = await memberConversation(harness, "group-a", "alice", { model }, context);
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
async function receipts(g: Awaited<ReturnType<typeof setup>>) { return Object.values((await g.harness.snapshot(AuxiliaryDoc, g.conversation.id, context))?.starts ?? {}); }

test("native auxiliary retries have independent starts, confirmed fees count once, images belong to the caller", async () => {
  let calls = 0;
  const g = await setup({ retry: 1, classify: async request => {
    expect(request.apiKey).toBe("fixture-secret"); expect(request.headers).toMatchObject({ "x-fixture": "private" });
    return ++calls === 1 ? result({ stopReason: "error", errorMessage: "server_busy", usage: undefined }) : result();
  } });
  const ledger = openStatsLedger(g.root);
  try {
    const classified = await invoke(g, g.conversation, "document_route", { text: "scanned page", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(classified.isError).toBe(false); expect(JSON.parse((classified.content[0] as { text: string }).text)).toMatchObject({ route: "ocr" }); expect(classified.usage).toBeUndefined();
    expect(g.state.classifications).toBe(2); expect(g.state.maxRetries).toBe(0);
    const generated = await invoke(g, g.conversation, "generate_image", { prompt: "fixture" });
    expect(generated.isError).toBe(false); expect(generated.usage).toBeUndefined();
    expect(generated.durationMs).toBeGreaterThanOrEqual(0);
    const path = generated.content.find(item => item.type === "text" && item.text.startsWith("Image saved to "))!;
    expect(path.type).toBe("text");
    const imagePath = (path as { text: string }).text.slice("Image saved to ".length);
    expect(await readFile(imagePath)).toEqual(Buffer.from(PNG, "base64"));
    expect(imagePath.startsWith(memberPlaces(g.members, g.members.groupId, "alice").tempDir)).toBe(true);
    expect(Object.values((await g.harness.snapshot(ResultsDoc, context))!.calls)).toMatchObject([{ phone: "alice" }]);
    const starts = await receipts(g); expect(starts).toHaveLength(3); expect(starts.filter(start => start.usage)).toHaveLength(2);
    const member = { groupId: "group-a", phone: "alice", conversationId: g.conversation.id };
    await projectConversation(ledger, g.harness, member, context); await projectConversation(ledger, g.harness, member, context);
    const billed = readLedger(ledger).usage.filter(row => row.kind === "auxiliary");
    expect(billed.reduce((sum, row) => sum + row.requests, 0)).toBe(3);
    expect(billed.reduce((sum, row) => sum + row.missingUsage, 0)).toBe(1);
    expect(billed.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(.04);
    const names = Object.keys((await g.harness.snapshot(ResultsDoc, context))!.calls);
    expect(await removeCodemodeResults(memberPlaces(g.members, g.members.groupId, "alice").tempDir, Infinity, {
      registered: new Set(names), protected: new Set(), expire: async () => {},
    })).toEqual(process.platform === "linux" ? [] : names);
    expect(g.reports).toEqual([]);
  } finally { ledger.close(); await g.close(); }
}, 15000);

test.each(["credentials", "image-capability"])("auxiliary setup failure (%s) sends no provider request and no start", async failure => {
  const g = await setup({ credentials: failure !== "credentials", vision: failure !== "image-capability" });
  try {
    const value = await invoke(g, g.conversation, "document_route", { text: "page", images: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    expect(value.isError).toBe(true); expect(g.state.classifications).toBe(0); expect(await receipts(g)).toEqual([]);
  } finally { await g.close(); }
});

test("failed start storage is fail closed, and the tool model view cannot bypass the request door", async () => {
  const g = await setup();
  const commit = g.harness.commit.bind(g.harness);
  g.harness.commit = ((change, ctx) => commit(tx => change(new Proxy(tx, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === "doc") return (...args: unknown[]) => { if (args[0] === AuxiliaryDoc) throw new Error("synthetic auxiliary start failure"); return value.apply(target, args); };
    return typeof value === "function" ? value.bind(target) : value;
  } })), ctx)) as typeof g.harness.commit;
  try {
    expect((await invoke(g, g.conversation, "document_route", { text: "page" })).isError).toBe(true);
    expect(g.state.classifications).toBe(0); expect(await receipts(g)).toEqual([]);
    await expect(g.view.classify(classifier, { state: {}, questions: {} })).rejects.toThrow("explicit Durable tool");
    expect(() => g.view.getProvider("aux")).toThrow("unavailable");
    expect(() => g.view.stream(classifier as never, { messages: [] })).toThrow("unavailable");
    expect(() => g.view.refresh()).toThrow("unavailable");
    expect(() => (g.view as unknown as { getRegisteredProviderConfig(id: string): unknown }).getRegisteredProviderConfig("aux")).toThrow("unavailable");
  } finally { g.harness.commit = commit; await g.close(); }
});

for (const operation of ["classifier", "image"] as const) test.each(["control", "deadline"])(
  `a %s after the ${operation} start commit withdraws it and prevents dispatch`, async cause => {
  let expired = false;
  const g = await setup({ dispatchError: () => expired ? new Error("synthetic total deadline") : undefined });
  const commit = g.harness.commit.bind(g.harness), received = Promise.withResolvers<void>();
  let intercepted = false;
  g.harness.commit = ((change, ctx) => {
    let start = false;
    return commit(tx => change(new Proxy(tx, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "doc") return (...args: unknown[]) => { if (args[0] === AuxiliaryDoc) start = true; return value.apply(target, args); };
      return typeof value === "function" ? value.bind(target) : value;
    } })), ctx).then(value => {
      if (start && !intercepted) {
        intercepted = true;
        if (cause === "deadline") expired = true;
        else g.door.controlReceived("alice", "stop-fixture");
        received.resolve();
      }
      return value;
    });
  }) as typeof g.harness.commit;
  try {
    await invoke(g, g.conversation, operation === "classifier" ? "document_route" : "generate_image",
      operation === "classifier" ? { text: "page" } : { prompt: "fixture" }, async () => {
        await received.promise;
        if (cause === "control") { await g.conversation.abort(context); g.door.controlExecuted("stop-fixture"); }
      });
    expect(g.state.classifications).toBe(0); expect(g.state.images).toBe(0);
    expect(await receipts(g)).toMatchObject([{ withdrawn: true }]);
    expect((await receipts(g))[0]!.usage).toBeUndefined();
  } finally { g.harness.commit = commit; g.door.controlExecuted("stop-fixture"); await g.close(); }
});

test("aborted auxiliary execution keeps an unknown bill and unsafe cold recovery never replays it", async () => {
  const started = Promise.withResolvers<void>();
  const g = await setup({ classify: async request => {
    started.resolve(); await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return result({ stopReason: "aborted", usage: undefined, answers: {} });
  } });
  try {
    await invoke(g, g.conversation, "document_route", { text: "page" }, async () => { await started.promise; await g.conversation.abort(context); });
    expect(await receipts(g)).toMatchObject([{ outcome: "aborted" }]); expect((await receipts(g))[0]!.usage).toBeUndefined();
    const count = g.state.classifications; await g.close();
    const read = await Harness.open(await openGroupStorage(g.path), { models: g.view, registry: createRegistry() }, context);
    try { expect(Object.values((await read.snapshot(AuxiliaryDoc, g.conversation.id, context))!.starts)).toHaveLength(1); expect(g.state.classifications).toBe(count); }
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

test("codemode calls the same bounded model tool and does not add its usage to the parent again", async () => {
  const g = await setup();
  try {
    const value = await invoke(g, g.conversation, "codemode", { code: 'return await tools.document_route({text:"fixture"});' });
    expect(value.isError).toBe(false); expect(JSON.stringify(value.content)).toContain("ocr");
    expect(value.usage).toBeUndefined(); expect(g.state.classifications).toBe(1); expect(await receipts(g)).toHaveLength(1);
  } finally { await g.close(); }
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
    expect(value.details).toMatchObject({ complete: true, calls: [
      { name: "document_route", status: "cancelled" }, { name: "wait_for_auxiliary_start", status: "ok" },
    ] });
    expect(g.state.classifications).toBe(1);
    expect(await receipts(g)).toMatchObject([{ outcome: "aborted" }]);
    expect((await receipts(g))[0]!.usage).toBeUndefined(); expect(g.reports).toEqual([]);
    const history = (await g.conversation.entries({ order: "ascending" }, 200, undefined, context)).items.flatMap(entry => entry.model ?? []);
    expect(history.filter(message => message.role === "assistant").at(-1)?.content).toEqual([{ type: "text", text: "done" }]);
  } finally { await g.close(); }
}, 15000);

test("an auxiliary reply arriving after the door closes keeps its start unknown without a late write", async () => {
  const started = Promise.withResolvers<void>(), reply = Promise.withResolvers<ClassifierResult>();
  const g = await setup({ classify: async () => { started.resolve(); return reply.promise; } });
  try {
    const work = invoke(g, g.conversation, "document_route", { text: "late" });
    await started.promise; await g.door.close(); reply.resolve(result()); await work;
    const starts = await receipts(g); expect(starts).toHaveLength(1);
    expect(starts[0]!.usage).toBeUndefined(); expect(starts[0]!.outcome).toBeUndefined(); expect(g.reports).toEqual([]);
  } finally { reply.resolve(result()); await g.close(); }
}, 15000);
