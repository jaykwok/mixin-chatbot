// The request door on the project's Durable modules (D2-1): the D0 P10 checks (start record, fail closed, parity with
// Durable's direct Models call, setup-failure semantics, an abort during an OAuth refresh), the hold for a member's
// pending control, the control registration ownership of q01, and q02's premise that a commit settles only after
// storage did (controlUncertain). D2-5: compaction's summarize requests through the door (gap G4, option A).
// Faux providers only; no network.
import { afterAll, describe, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import {
  type AssistantMessage, createModels, InMemoryCredentialStore, type Message, type Models, type MutableModels, type OAuthCredential,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry, type Conversation, createSession, defineDoc, type Harness, type HarnessSettings, ProviderDoc, type Storage, StorageRejected,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { AttemptsDoc, isNotSent, NOT_SENT } from "../../src/durable/attempts.ts";
import { compactionCost } from "../../src/durable/compaction.ts";
import { type DoorOptions, RequestDoor } from "../../src/durable/door.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, type GroupHarness, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-door-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a";
const SETTINGS: HarnessSettings = { retry: { maxRetries: 2, baseDelayMs: 5, maxAgentDelayMs: 20 } };
let counter = 0;

test.each(["budget", "control"])("an external request rechecks the deadline after waiting for %s", async phase => {
  const { models, model } = fauxModels(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let expired = false, dispatched = 0;
  const opened = await open(models, {
    dispatchError: () => expired ? new Error("synthetic total deadline") : undefined,
    beforeDispatch: phase === "budget" ? async () => { entered.resolve(); await release.promise; } : undefined,
    onHold: () => entered.resolve(),
  });
  const parent = withCancel(context), door = opened.door!;
  const { conversation } = await memberConversation(opened.harness, GROUP, "external-deadline", { model }, context);
  if (phase === "control") door.controlReceived("external-deadline", "deadline-control");
  const work = door.external({ taskId: 998 as never, conversationId: conversation.id }, parent.context,
    async () => { dispatched++; }, parent.context.abortSignal!);
  const result = work.then(() => "sent", error => (error as Error).message);
  try {
    await entered.promise; expired = true; release.resolve(); door.controlExecuted("deadline-control");
    expect(await result).toBe("synthetic total deadline");
    expect(dispatched).toBe(0); expect(opened.reports).toEqual([]);
  } finally { release.resolve(); door.controlExecuted("deadline-control"); parent.cancel(); await result; await opened.close(); }
});

test("a cancelled external child leaves a held gate before its parent control resolves", async () => {
  const { models, model } = fauxModels(), held = Promise.withResolvers<void>();
  const opened = await open(models, { onHold: () => held.resolve() });
  const parent = withCancel(context), child = new AbortController();
  const { conversation } = await memberConversation(opened.harness, GROUP, "external-child", { model }, context);
  const door = opened.door!; door.controlReceived("external-child", "held-external");
  let dispatched = 0;
  const work = door.external({ taskId: 999 as never, conversationId: conversation.id }, parent.context,
    async () => { dispatched++; }, child.signal);
  const state = work.then(() => "dispatched", () => "cancelled");
  try {
    await held.promise; child.abort(new Error("cancelled child"));
    expect(await Promise.race([state, Bun.sleep(1000).then(() => "held")])).toBe("cancelled");
    expect(dispatched).toBe(0); expect(parent.context.abortSignal!.aborted).toBe(false);
    expect(door.pendingControls("external-child")).toBe(1);
  } finally { door.controlExecuted("held-external"); await state; parent.cancel(); await opened.close(); }
});

test("closing the door drains an admitted terminal record before the Harness closes", async () => {
  const { faux, models, model } = fauxModels();
  const response = Promise.withResolvers<AssistantMessage>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let liveSignal: AbortSignal | undefined;
  faux.setResponses([() => response.promise, (_transcript, options) => new Promise<AssistantMessage>((resolve) => {
    liveSignal = options!.signal!;
    liveSignal.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
  })]);
  const opened = await open(models);
  const { conversation } = await memberConversation(opened.harness, GROUP, "close-usage", { model }, context);
  const submit = await conversation.submit({ type: "input", content: "finish", requestId: "close-usage" }, context);
  await until(() => faux.state.callCount === 1, "provider call");
  const live = await memberConversation(opened.harness, GROUP, "close-recover", { model }, context);
  const liveSubmission = await live.conversation.submit({ type: "input", content: "recover", requestId: "close-recover" }, context);
  await until(() => faux.state.callCount === 2, "second provider call");
  const commit = opened.harness.commit.bind(opened.harness);
  let intercepted = false, closed = false;
  opened.harness.commit = ((body: (tx: object) => unknown, commitContext: unknown) => commit((tx) => body(new Proxy(tx, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "doc") return async (...args: unknown[]) => {
        const doc = await (value as (...args: unknown[]) => unknown).apply(target, args);
        if (args[0] === AttemptsDoc && !intercepted) { intercepted = true; entered.resolve(); await release.promise; }
        return doc;
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  })), commitContext as never)) as typeof opened.harness.commit;
  response.resolve(fauxAssistantMessage("finished"));
  const closing = entered.promise.then(() => opened.door!.close()).then(() => { closed = true; });
  try {
    await entered.promise; await Bun.sleep(30);
    expect(closed).toBe(false);
    expect(liveSignal!.aborted).toBe(false);
    release.resolve(); await closing;
    expect((await submit.wait(context)).status).toBe("done");
    const doc = (await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!;
    expect(Object.values(doc.starts)[0]!.outcome).toBe("done");
    expect(Object.values(doc.starts)[0]!.usage!.totalTokens).toBeGreaterThan(0);
    expect(opened.reports).toEqual([]);
    await opened.close();
    const restarted = fauxModels(); restarted.faux.setResponses([fauxAssistantMessage("recovered")]);
    const reopened = await open(restarted.models, {}, opened.path);
    try {
      reopened.harness.resume();
      expect((await (await reopened.harness.submission(liveSubmission.id, context))!.wait(context)).status).toBe("done");
      expect(restarted.faux.state.callCount).toBe(1);
    } finally { await reopened.close(); }
  } finally { response.resolve(fauxAssistantMessage("finished")); release.resolve(); await closing; await opened.close(); }
});

test("closing the door fences late writes while the Harness owns provider cancellation", async () => {
  const { faux, models, model } = fauxModels();
  const sent = Promise.withResolvers<void>(), ended = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  faux.setResponses([(_transcript, options) => new Promise<AssistantMessage>((resolve) => {
    signal = options!.signal!; sent.resolve();
    signal.addEventListener("abort", () => setTimeout(() => { resolve(fauxAssistantMessage("", { stopReason: "aborted" })); ended.resolve(); }, 30), { once: true });
  })]);
  const opened = await open(models);
  const { conversation } = await memberConversation(opened.harness, GROUP, "close-late", { model }, context);
  await conversation.submit({ type: "input", content: "wait", requestId: "close-late" }, context);
  await sent.promise;
  const commit = opened.harness.commit.bind(opened.harness);
  let afterClose = false, lateWrites = 0;
  opened.harness.commit = ((...args: Parameters<typeof commit>) => { if (afterClose) lateWrites++; return commit(...args); }) as typeof commit;
  try {
    await opened.door!.close();
    expect(signal!.aborted).toBe(false);
    afterClose = true;
    await opened.harness.close(context);
    await ended.promise; await Bun.sleep(30);
    expect(lateWrites).toBe(0);
    expect(opened.reports).toEqual([]);
  } finally { await opened.close(); }
});

type Opened = GroupHarness;

function open(models: Models, door: false | Omit<DoorOptions, "memberOf"> = {}, path = join(fixture.root, `db-${++counter}.sqlite`)): Promise<Opened> {
  return openGroupHarness(path, models, { settings: SETTINGS, door, group: GROUP });
}

async function starts(harness: Harness, conversationId: number) {
  const doc = await harness.snapshot(AttemptsDoc, conversationId as never, context);
  return Object.values(doc?.starts ?? {}).sort((a, b) => a.taskId - b.taskId || a.attempt - b.attempt || a.k - b.k)
    .map((start) => ({ attempt: start.attempt, k: start.k, withdrawn: start.withdrawn === true }));
}

/** The conversation's assistant messages, oldest first. */
async function assistants(conversation: Conversation): Promise<AssistantMessage[]> {
  const page = await conversation.entries({}, 200, undefined, context);
  return [...page.items].reverse().filter((entry) => AssistantEntry.is(entry)).map((entry) => entry.model![0] as AssistantMessage);
}

async function until(probe: () => boolean, label: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** Fail transactions that touch the start-record document `times` times (the real commit rolls back). */
function failStartRecords(harness: Harness, times: number) {
  const state = { failed: 0, times };
  const commit = harness.commit.bind(harness) as (body: (tx: object) => unknown, context: unknown) => Promise<unknown>;
  harness.commit = ((body: (tx: object) => unknown, commitContext: unknown) => commit((tx) => body(new Proxy(tx, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "doc") {
        return async (...args: unknown[]) => {
          if (args[0] === AttemptsDoc && state.failed < state.times) {
            state.failed++;
            throw new Error("synthetic start-record failure");
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  })), commitContext)) as typeof harness.commit;
  return state;
}

/** A response that answers only when the request is aborted; `sent` resolves once the provider has it. */
function hanging(): { step: FauxResponseFactory; sent: Promise<void> } {
  const { promise: sent, resolve } = Promise.withResolvers<void>();
  return {
    sent,
    step: (_transcript, options) => new Promise<AssistantMessage>((answer) => {
      resolve();
      options?.signal?.addEventListener("abort", () => answer(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    }),
  };
}

describe("request door: start records (D0 P10 A, B)", () => {
  test("a failed start-record commit is retried and the request goes out only after a durable start; recovery sends it again with its own start", async () => {
    const first = fauxModels();
    const hang = hanging();
    first.faux.setResponses([hang.step]);
    let opened = await open(first.models);
    const { path } = opened;
    const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model: first.model }, context);
    const injected = failStartRecords(opened.harness, 1);
    const submission = await conversation.submit({ type: "input", content: "开始记录失败一次", requestId: "a1" }, context);
    await hang.sent;
    expect(injected.failed).toBe(1);
    expect(opened.reports.map(String).some((report) => report.includes("synthetic start-record failure"))).toBe(true);
    expect(await starts(opened.harness, conversation.id)).toHaveLength(1);
    const dispatched = opened.door!.dispatched;
    await opened.close();

    const second = fauxModels();
    second.faux.setResponses([fauxAssistantMessage("恢复后的回答")]);
    opened = await open(second.models, {}, path);
    try {
      opened.harness.resume();
      const settled = await (await opened.harness.submission(submission.id, context))!.wait(context);
      expect(settled.status).toBe("done");
      expect(first.faux.state.callCount + second.faux.state.callCount).toBe(2);
      expect(dispatched + opened.door!.dispatched).toBe(2);
      // One start per provider call; the recovered request reuses its attempt with the next invocation number.
      const recorded = await starts(opened.harness, conversation.id);
      expect(recorded.map(({ k, withdrawn }) => ({ k, withdrawn }))).toEqual([{ k: 1, withdrawn: false }, { k: 2, withdrawn: false }]);
      expect(recorded[0]!.attempt).toBe(recorded[1]!.attempt);
    } finally { await opened.close(); }
  });

  test("a start record that keeps failing sends nothing: NOT_SENT attempts are retried, then the turn ends; they never reach a later payload", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("不应发出")]);
    const opened = await open(models);
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      const injected = failStartRecords(opened.harness, Number.POSITIVE_INFINITY);
      const failed = await (await conversation.submit({ type: "input", content: "记录一直失败", requestId: "b1" }, context)).wait(context);
      expect({ status: failed.status, reason: "reason" in failed ? failed.reason : undefined }).toEqual({ status: "unanswered", reason: "model_error" });
      expect(faux.state.callCount).toBe(0);
      const entries = await assistants(conversation);
      // Durable's retry policy (2 retries here) retries each NOT_SENT; the door counts every one.
      expect(entries.map((message) => isNotSent(message))).toEqual([true, true, true]);
      expect(opened.door!.notSent).toBe(3);
      expect(await starts(opened.harness, conversation.id)).toEqual([]);

      injected.times = injected.failed;
      let request: Message[] = [];
      faux.setResponses([(transcript) => { request = transcript.messages as Message[]; return fauxAssistantMessage("恢复正常"); }]);
      const next = await (await conversation.submit({ type: "input", content: "下一条", requestId: "b2" }, context)).wait(context);
      expect(next.status).toBe("done");
      expect(faux.state.callCount).toBe(1);
      expect(opened.door!.dispatched).toBe(1);
      expect(await starts(opened.harness, conversation.id)).toHaveLength(1);
      const payload = JSON.stringify(convertMessages({ ...faux.getModel(), api: "openai-completions" } as never, { messages: request } as never, {} as never));
      expect(payload).not.toContain(NOT_SENT);
      expect(payload).toContain("记录一直失败");
      expect(payload).toContain("下一条");
    } finally { await opened.close(); }
  });
});

describe("request door: fail closed and parity (D0 P10 C, E, F)", () => {
  test("a provider call that did not come through a registered generation is not sent", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([fauxAssistantMessage("绕过"), fauxAssistantMessage("绕过")]);
    const opened = await open(models);
    try {
      const transcript = { messages: [{ role: "user" as const, content: "直接调用", timestamp: Date.now() }] };
      const withSignal = await opened.models.streamSimple(faux.getModel(), transcript, { signal: new AbortController().signal }).result();
      const withoutSignal = await opened.models.streamSimple(faux.getModel(), transcript).result();
      expect(faux.state.callCount).toBe(0);
      expect(isNotSent(withSignal)).toBe(true);
      expect(isNotSent(withoutSignal)).toBe(true);
      expect(opened.door!.notSent).toBe(2);
    } finally { await opened.close(); }
  });

  test("through the door the provider gets the same model, transcript and options as from Durable's direct call, with its conversation's pi.provider session id", async () => {
    // Timestamps, the abort signal and the faux api id (random per faux instance) differ by construction.
    const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) =>
      key === "timestamp" || key === "signal" ? undefined
        : key === "api" && typeof item === "string" && item.startsWith("faux:") ? "faux:<instance>"
          : typeof item === "function" ? `<function ${key}>` : item));
    // Credential headers and request headers that differ only in case: the request's replaces the credential's.
    const settings: HarnessSettings = { ...SETTINGS, stream: { headers: { "x-case": "from-request" } } };
    const seenWith = async (door: boolean) => {
      const { faux, models, model } = fauxModels();
      const getAuth = models.getAuth.bind(models);
      (models as MutableModels).getAuth = (async (...args: Parameters<typeof getAuth>) => {
        const resolution = await getAuth(...args);
        return resolution && { ...resolution, auth: { ...resolution.auth, headers: { "X-Case": "from-auth", "X-Auth": "kept" } } };
      }) as typeof models.getAuth;
      let seen: unknown;
      let sessionId: unknown;
      let headers: unknown;
      faux.setResponses([(transcript, options, _state, requestModel) => {
        sessionId = options?.sessionId;
        headers = options?.headers;
        seen = strip({ messages: transcript.messages, options: { ...options, sessionId: "<own>" }, model: requestModel });
        return fauxAssistantMessage("好");
      }]);
      const opened = await openGroupHarness(join(fixture.root, `db-${++counter}.sqlite`), models, { settings, door: door ? {} : false, group: GROUP });
      try {
        const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
        const settled = await (await conversation.submit({ type: "input", content: "同一个请求", requestId: "e1" }, context)).wait(context);
        const own = (await opened.harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId;
        return { settled: settled.status, seen, sessionId, headers, own, dispatched: opened.door?.dispatched };
      } finally { await opened.close(); }
    };
    const through = await seenWith(true);
    const direct = await seenWith(false);
    expect([through.settled, direct.settled]).toEqual(["done", "done"]);
    expect(through.dispatched).toBe(1);
    expect(through.seen).toEqual(direct.seen);
    expect(through.headers).toEqual({ "X-Auth": "kept", "x-case": "from-request" });
    expect(typeof through.own).toBe("string");
    expect(through.sessionId).toBe(through.own);
    expect(direct.sessionId).toBe(direct.own);
    expect(through.sessionId).not.toBe(direct.sessionId);
  });

  /** Faux Models that fail in preparation as `kind` says. */
  function failingSetup(kind: "notConfigured" | "failingAuth" | "unknownProvider" | "notChat") {
    const made = fauxModels();
    const models = made.models as MutableModels;
    if (kind === "notConfigured" || kind === "failingAuth") {
      const resolve = kind === "notConfigured" ? async () => undefined : async () => { throw new Error("fetch failed (synthetic credential endpoint)"); };
      models.setProvider({ ...made.faux.provider, auth: { apiKey: { name: "Faux", resolve } } } as never);
    } else {
      const getModel = models.getModel.bind(models);
      models.getModel = ((provider: string, id: string) => {
        const model = getModel(provider, id);
        return model && (kind === "unknownProvider" ? { ...model, provider: "ghost" } : { ...model, type: "classifier" });
      }) as typeof models.getModel;
    }
    made.faux.setResponses([fauxAssistantMessage("不应发出")]);
    return made;
  }

  test("preparation failures end as Models ends them: same entries, retries and settlement with and without the door; nothing is sent", async () => {
    const run = async (door: boolean, kind: Parameters<typeof failingSetup>[0]) => {
      const { faux, models, model } = failingSetup(kind);
      const opened = await open(models, door ? {} : false);
      try {
        const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
        const settled = await (await conversation.submit({ type: "input", content: "准备失败", requestId: "f1" }, context)).wait(context);
        const entries = (await assistants(conversation)).map((message) =>
          ({ stopReason: message.stopReason, errorMessage: message.errorMessage, provider: message.provider, tokens: message.usage.totalTokens }));
        return { comparable: { settled, entries }, calls: faux.state.callCount, setupFailed: opened.door?.setupFailed, notSent: opened.door?.notSent };
      } finally { await opened.close(); }
    };
    const counts: Record<string, number> = {};
    for (const kind of ["notConfigured", "failingAuth", "unknownProvider", "notChat"] as const) {
      const through = await run(true, kind);
      const direct = await run(false, kind);
      expect(through.comparable).toEqual(direct.comparable);
      expect([through.calls, direct.calls]).toEqual([0, 0]);
      expect(through.notSent).toBe(0);
      expect(through.setupFailed).toBe(through.comparable.entries.length);
      counts[kind] = through.comparable.entries.length;
    }
    // The classification stays Models': only the transient credential failure is retried (2 retries here).
    expect(counts).toEqual({ notConfigured: 1, failingAuth: 3, unknownProvider: 1, notChat: 1 });
  });

  test("a routed (virtual) model is refused by the door without calling the provider; without the door it would be sent", async () => {
    const run = async (door: boolean) => {
      const faux = fauxProvider({ api: "pi-virtual", tokenSize: { min: 50, max: 50 } });
      const { models } = fauxModels();
      (models as MutableModels).setProvider(faux.provider);
      faux.setResponses([fauxAssistantMessage("路由模型的回答")]);
      const opened = await open(models, door ? {} : false);
      try {
        const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
        const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
        const settled = await (await conversation.submit({ type: "input", content: "路由", requestId: "v1" }, context)).wait(context);
        return { status: settled.status, entries: (await assistants(conversation)).map((message) => message.errorMessage ?? ""), calls: faux.state.callCount, door: opened.door };
      } finally { await opened.close(); }
    };
    const through = await run(true);
    expect(through.status).toBe("unanswered");
    expect(through.calls).toBe(0);
    expect(through.entries).toHaveLength(1);
    expect(through.entries[0]).toContain("mixin request door: routed model");
    expect(through.door!.setupFailed).toBe(1);
    expect(through.door!.notSent).toBe(0);
    expect((await run(false)).calls).toBe(1);
  });

  test("a request aborted while its OAuth credential refreshes (pi-ai 1.0.3): it ends aborted at once, without a start or a send; the refresh completes and is stored, and the next request uses it without refreshing", async () => {
    const credentials = new InMemoryCredentialStore();
    const models = createModels({ credentials });
    const faux = fauxProvider({ tokenSize: { min: 50, max: 50 } });
    const refreshing = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const refreshes: { refresh: string; signalAborted?: boolean }[] = [];
    models.setProvider({
      ...faux.provider,
      auth: {
        oauth: {
          name: "Faux OAuth",
          login: async () => { throw new Error("no login in tests"); },
          refresh: async (credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> => {
            const call: (typeof refreshes)[number] = { refresh: credential.refresh };
            refreshes.push(call);
            refreshing.resolve();
            await gate.promise;
            call.signalAborted = signal.aborted;
            return { type: "oauth", refresh: "refresh-2", access: "access-2", expires: Date.now() + 3_600_000 };
          },
          toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
        },
      },
    } as never);
    const provider = faux.getModel().provider;
    await credentials.modify(provider, async () => ({ type: "oauth", refresh: "refresh-1", access: "access-1", expires: Date.now() - 1000 }));
    const keys: (string | undefined)[] = [];
    faux.setResponses([(_transcript, options) => { keys.push(options?.apiKey); return fauxAssistantMessage("新凭据的回答"); }]);
    const opened = await open(models);
    try {
      const model = { provider, modelId: faux.getModel().id };
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      const submission = await conversation.submit({ type: "input", content: "刷新时中止", requestId: "o1" }, context);
      await refreshing.promise;
      await conversation.abort(context);
      // Settles while the refresh is still held: the door does not wait for it.
      const settled = await submission.wait(context);
      expect({ status: settled.status, reason: "reason" in settled ? settled.reason : undefined }).toEqual({ status: "unanswered", reason: "aborted" });
      expect(faux.state.callCount).toBe(0);
      expect(await starts(opened.harness, conversation.id)).toEqual([]);
      expect({ setupFailed: opened.door!.setupFailed, notSent: opened.door!.notSent }).toEqual({ setupFailed: 0, notSent: 0 });
      expect(((await credentials.read(provider)) as OAuthCredential).access).toBe("access-1");
      gate.resolve();
      // The rotated credential is stored although its caller is gone (the refresh ran on its own signal).
      const stored = await credentials.modify(provider, async () => undefined);
      expect(stored).toMatchObject({ type: "oauth", refresh: "refresh-2", access: "access-2" });
      expect(refreshes).toEqual([{ refresh: "refresh-1", signalAborted: false }]);
      const next = await (await conversation.submit({ type: "input", content: "再问一次", requestId: "o2" }, context)).wait(context);
      expect(next.status).toBe("done");
      expect(keys).toEqual(["access-2"]);
      expect(refreshes).toHaveLength(1);
    } finally { gate.resolve(); await opened.close(); }
  });
});

describe("request door: a member's pending control holds its requests", () => {
  test("a request waits while its member has a control, before any start record; another member is not held; execution releases it", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("回答"), fauxAssistantMessage("回答")]);
    const held: number[] = [];
    const opened = await open(models, { onHold: (id) => held.push(id) });
    try {
      const first = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      const other = await memberConversation(opened.harness, GROUP, "m2", { model }, context);
      const door = opened.door!;
      const ticket = door.controlReceived("m1", "stop-1");
      const submission = await first.conversation.submit({ type: "input", content: "等控制命令", requestId: "h1" }, context);
      await until(() => held.includes(first.conversation.id), "the hold");
      expect((await (await other.conversation.submit({ type: "input", content: "别人不受影响", requestId: "h2" }, context)).wait(context)).status).toBe("done");
      expect(faux.state.callCount).toBe(1);
      expect(await starts(opened.harness, first.conversation.id)).toEqual([]);
      door.controlAdmitted(ticket, 7);
      expect(door.controls("m1")).toEqual({ tickets: [], stream: ["stop-1"] });
      expect(faux.state.callCount).toBe(1);
      door.controlExecuted("stop-1");
      expect((await submission.wait(context)).status).toBe("done");
      expect(faux.state.callCount).toBe(2);
      expect(await starts(opened.harness, first.conversation.id)).toEqual([{ attempt: 1, k: 1, withdrawn: false }]);
      expect(held.includes(other.conversation.id)).toBe(false);
    } finally { await opened.close(); }
  });

  test("the control's abort ends a held request: nothing sent, no start, not NOT_SENT", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("不应发出")]);
    const held: number[] = [];
    const opened = await open(models, { onHold: (id) => held.push(id) });
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      opened.door!.controlReceived("m1", "stop-1");
      const submission = await conversation.submit({ type: "input", content: "会被中止", requestId: "h1" }, context);
      await until(() => held.length > 0, "the hold");
      await conversation.abort(context);
      const settled = await submission.wait(context);
      expect({ status: settled.status, reason: "reason" in settled ? settled.reason : undefined }).toEqual({ status: "unanswered", reason: "aborted" });
      expect(faux.state.callCount).toBe(0);
      expect(await starts(opened.harness, conversation.id)).toEqual([]);
      expect(opened.door!.notSent).toBe(0);
    } finally { await opened.close(); }
  });

  test("a control received while the start is committed holds the request after its start: the start is withdrawn, the later send has its own", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("回答")]);
    let receiveDuringStart = false;
    const opened = await open(models);
    const commit = opened.harness.commit.bind(opened.harness);
    // Request timestamps also use the clock at preparation now. Inject on the receipt document itself,
    // independently of how many times the request path reads a clock.
    opened.harness.commit = ((change, ctx) => commit(tx => change(new Proxy(tx, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "doc") return async (...args: unknown[]) => {
        const doc = await value.apply(target, args);
        if (args[0] === AttemptsDoc && receiveDuringStart) { receiveDuringStart = false; opened.door!.controlReceived("m1", "stop-2"); }
        return doc;
      };
      return typeof value === "function" ? value.bind(target) : value;
    } })), ctx)) as typeof opened.harness.commit;
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      receiveDuringStart = true;
      const submission = await conversation.submit({ type: "input", content: "提交开始记录时来了控制命令", requestId: "w1" }, context);
      await until(() => opened.door!.withdrawn === 1, "the withdraw");
      expect(faux.state.callCount).toBe(0);
      expect(await starts(opened.harness, conversation.id)).toEqual([{ attempt: 1, k: 1, withdrawn: true }]);
      opened.door!.controlExecuted("stop-2");
      expect((await submission.wait(context)).status).toBe("done");
      expect(faux.state.callCount).toBe(1);
      expect(await starts(opened.harness, conversation.id)).toEqual([{ attempt: 1, k: 1, withdrawn: true }, { attempt: 1, k: 2, withdrawn: false }]);
    } finally { await opened.close(); }
  });
});

describe("request door: control registrations (D0 q01)", () => {
  const door = () => new RequestDoor({}, { memberOf: async () => "m" });

  test("duplicate admissions of one control make one stream registration, released once by its execution", () => {
    const gate = door();
    const first = gate.controlReceived("m", "same");
    const second = gate.controlReceived("m", "same");
    expect(gate.pendingControls("m")).toBe(2);
    gate.controlAdmitted(first, 1);
    gate.controlAdmitted(second, 1);
    expect(gate.controls("m")).toEqual({ tickets: [], stream: ["same"] });
    gate.controlExecuted("same");
    gate.controlExecuted("same");
    expect(gate.pendingControls("m")).toBe(0);
  });

  test("a duplicate whose admission reply failed resolves by reading the stream and leaves no phantom", async () => {
    const gate = door();
    gate.controlAdmitted(gate.controlReceived("m", "same"), 1);
    const duplicate = gate.controlReceived("m", "same");
    expect(await gate.controlUncertain(duplicate, async () => 1)).toBe("resolved");
    expect(gate.controls("m")).toEqual({ tickets: [], stream: ["same"] });
    gate.controlExecuted("same");
    expect(gate.pendingControls("m")).toBe(0);
  });

  test("a late reply for finished control A neither releases pending control B nor re-adds A", () => {
    const gate = door();
    const a = gate.controlReceived("m", "A");
    gate.controlExecuted("A");
    gate.controlAdmitted(gate.controlReceived("m", "B"), 2);
    gate.controlDropped(a);
    expect(gate.controls("m")).toEqual({ tickets: [], stream: ["B"] });
    gate.controlAdmitted(a, 1);
    expect(gate.controls("m")).toEqual({ tickets: [], stream: ["B"] });
    expect(gate.pendingControls("other")).toBe(0);
  });

  test("an uncertain admission whose reads fail keeps holding and is resolved in the background; close stops the retries", async () => {
    const gate = door();
    const ticket = gate.controlReceived("m", "c1");
    let reads = 0;
    expect(await gate.controlUncertain(ticket, async () => { if (++reads < 3) throw new Error("read failed"); return undefined; })).toBe("retrying");
    expect(gate.pendingControls("m")).toBe(1);
    await until(() => gate.pendingControls("m") === 0, "the background read");
    expect(reads).toBe(3);

    const stuck = gate.controlReceived("m", "c2");
    let attempts = 0;
    expect(await gate.controlUncertain(stuck, async () => { attempts++; throw new Error("read failed"); })).toBe("retrying");
    await gate.close();
    const after = attempts;
    await Bun.sleep(60);
    expect(attempts).toBe(after);
    expect(gate.controls("m")).toEqual({ tickets: ["c2"], stream: [] });
  });

  test("startup loads waiting controls and preserves receipts registered during asynchronous open", () => {
    const gate = door();
    const received = gate.controlReceived("m", "received-while-opening");
    gate.loadControls([{ phone: "m", requestId: "w1", seq: 3 }, { phone: "n", requestId: "w2", seq: 4 }]);
    expect(gate.controls("m")).toEqual({ tickets: ["received-while-opening"], stream: ["w1"] });
    expect(gate.pendingControls("m")).toBe(2);
    gate.controlDropped(received);
    expect(gate.controls("m")).toEqual({ tickets: [], stream: ["w1"] });
    expect(gate.pendingControls("n")).toBe(1);
  });
});

describe("request door: a commit settles only after storage did (D0 q02, project storage)", () => {
  const Doc = defineDoc<{ pending: boolean; seq: number }>({ kind: "test.settlement", version: 1, scope: "session", initial: () => ({ pending: false, seq: 0 }) });

  for (const mode of ["success", "rejected", "landed-error"] as const) {
    test(mode, async () => {
      const path = join(fixture.root, `settlement-${mode}.sqlite`);
      const backing = await openGroupStorage(path);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let armed = false;
      let storageSettled = false;
      let storageSignal: boolean | undefined;
      const storage = new Proxy(backing, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property !== "commit") return typeof value === "function" ? value.bind(target) : value;
          return async (...args: Parameters<Storage["commit"]>) => {
            if (!armed) return target.commit(...args);
            armed = false;
            storageSignal = args[1].abortSignal !== undefined;
            const seq = mode === "rejected" ? undefined : await target.commit(...args);
            entered.resolve();
            await release.promise;
            storageSettled = true;
            if (mode === "rejected") throw new StorageRejected("synthetic rejection: no writes admitted");
            if (mode === "landed-error") throw new Error("synthetic reply failure after the SQLite commit");
            return seq!;
          };
        },
      }) as Storage;
      const session = createSession(storage);
      const gate = new RequestDoor({}, { memberOf: async () => "m" });
      let closed = false;
      try {
        await session.commit(async (tx) => { await tx.doc(Doc); }, context);
        const ticket = gate.controlReceived("m", "ctl");
        const caller = withCancel(context);
        armed = true;
        let state = "pending";
        let early = false;
        const committing = session.commit(async (tx) => { const value = await tx.doc(Doc); value.pending = true; value.seq = 1; }, caller.context)
          .then(() => { state = "fulfilled"; early = !storageSettled; }, () => { state = "rejected"; early = !storageSettled; });
        await entered.promise;
        caller.cancel();
        await Bun.sleep(30);
        // The caller's cancellation neither settles the commit nor reaches storage; the ticket keeps holding.
        expect({ state, pending: gate.pendingControls("m"), storageSignal }).toEqual({ state: "pending", pending: 1, storageSignal: false });
        release.resolve();
        await committing;
        expect(early).toBe(false);
        const read = async () => { const doc = await session.snapshot(Doc, context); return doc?.pending ? doc.seq : undefined; };
        if (mode === "success") {
          expect(state).toBe("fulfilled");
          gate.controlAdmitted(ticket, (await read())!);
          expect(gate.controls("m")).toEqual({ tickets: [], stream: ["ctl"] });
        } else if (mode === "rejected") {
          expect(state).toBe("rejected");
          expect(await gate.controlUncertain(ticket, read)).toBe("resolved");
          expect(gate.pendingControls("m")).toBe(0);
        } else {
          expect(state).toBe("rejected");
          // The session is poisoned: reads fail, so the ticket stays until a later read or the execution resolves it.
          await expect(read()).rejects.toThrow("poisoned");
          expect(await gate.controlUncertain(ticket, read)).toBe("retrying");
          expect(gate.controls("m")).toEqual({ tickets: ["ctl"], stream: [] });
        }
        await gate.close();
        await session.close(context);
        closed = true;
        const reopened = createSession(await openGroupStorage(path));
        try {
          const durable = await reopened.snapshot(Doc, context);
          const recovered = new RequestDoor({}, { memberOf: async () => "m" });
          recovered.loadControls(durable?.pending ? [{ phone: "m", requestId: "ctl", seq: durable.seq }] : []);
          expect(recovered.pendingControls("m")).toBe(mode === "rejected" ? 0 : 1);
        } finally { await reopened.close(context); }
      } finally {
        release.resolve();
        await gate.close();
        if (!closed) await session.close(context);
      }
    }, 15000);
  }
});

describe("request door: compaction's summarize requests (G4 option A, D2-5)", () => {
  // Manual compaction ignores `enabled`; a keep-recent budget of one token leaves the earlier turns to summarise.
  const COMPACTING: HarnessSettings = { ...SETTINGS, compaction: { enabled: false, keepRecentTokens: 1 } };
  const openCompacting = (models: Models, door: Omit<DoorOptions, "memberOf"> = {}, path = join(fixture.root, `db-${++counter}.sqlite`)) =>
    openGroupHarness(path, models, { settings: COMPACTING, door, group: GROUP });

  async function compactionStarts(harness: Harness, conversationId: number) {
    const doc = await harness.snapshot(AttemptsDoc, conversationId as never, context);
    return Object.values(doc?.starts ?? {}).filter((start) => start.kind === "compaction")
      .sort((a, b) => a.taskId - b.taskId || a.attempt - b.attempt || a.k - b.k)
      .map((start) => ({ attempt: start.attempt, k: start.k, withdrawn: start.withdrawn === true, usage: start.usage !== undefined }));
  }

  async function modelTokens(harness: Harness, conversationId: number): Promise<number> {
    const doc = await harness.snapshot(UsageDoc, conversationId as never, context);
    return Object.values(doc?.models ?? {}).reduce((sum, usage) => sum + usage.totalTokens, 0);
  }

  /** Two answered turns, so a manual compaction has a range to summarise. */
  async function twoTurns(faux: ReturnType<typeof fauxModels>["faux"], conversation: Conversation) {
    faux.setResponses([fauxAssistantMessage("第一轮回答"), fauxAssistantMessage("第二轮回答")]);
    for (const [index, content] of ["第一轮", "第二轮"].entries()) {
      expect((await (await conversation.submit({ type: "input", content, requestId: `turn-${index}` }, context)).wait(context)).status).toBe("done");
    }
  }

  const outcome = async (harness: Harness, taskId: Awaited<ReturnType<Conversation["compact"]>>) =>
    (await harness.waitForTask(taskId, context)).state.outcome.status;

  test("a summarize request goes through the door after a compaction start; the start's usage is what pi.usage gained", async () => {
    const { faux, models, model } = fauxModels();
    const opened = await openCompacting(models);
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      await twoTurns(faux, conversation);
      const before = await modelTokens(opened.harness, conversation.id);
      let request: Message[] = [];
      faux.setResponses([(transcript) => { request = transcript.messages as Message[]; return fauxAssistantMessage("对话摘要"); }]);
      expect(await outcome(opened.harness, await conversation.compact(undefined, context))).toBe("completed");
      expect(faux.state.callCount).toBe(3);
      expect(opened.door!.dispatched).toBe(3);
      expect(JSON.stringify(request)).toContain("第一轮");
      expect(await compactionStarts(opened.harness, conversation.id)).toEqual([{ attempt: 1, k: 1, withdrawn: false, usage: true }]);
      // The two generations' starts carry no kind.
      expect(await starts(opened.harness, conversation.id)).toHaveLength(3);
      const cost = await compactionCost(opened.harness, conversation.id, context);
      expect({ sent: cost.sent, known: cost.known }).toEqual({ sent: 1, known: 1 });
      expect(cost.usage.totalTokens).toBeGreaterThan(0);
      expect(cost.usage.totalTokens).toBe(await modelTokens(opened.harness, conversation.id) - before);
    } finally { await opened.close(); }
  });

  test("start records that keep failing send no summarize request: NOT_SENT is retried, then the compaction fails", async () => {
    const { faux, models, model } = fauxModels();
    const opened = await openCompacting(models);
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      await twoTurns(faux, conversation);
      faux.setResponses([fauxAssistantMessage("不应发出")]);
      failStartRecords(opened.harness, Number.POSITIVE_INFINITY);
      expect(await outcome(opened.harness, await conversation.compact(undefined, context))).toBe("failed");
      expect(faux.state.callCount).toBe(2);
      // Durable's retry policy (2 retries here) retries each NOT_SENT summarize attempt.
      expect(opened.door!.notSent).toBe(3);
      expect(await compactionStarts(opened.harness, conversation.id)).toEqual([]);
      expect((await compactionCost(opened.harness, conversation.id, context)).sent).toBe(0);
    } finally { await opened.close(); }
  });

  test("a member's pending control holds a summarize request before its start; the control's execution releases it", async () => {
    const { faux, models, model } = fauxModels();
    const held: number[] = [];
    const opened = await openCompacting(models, { onHold: (id) => held.push(id) });
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      await twoTurns(faux, conversation);
      faux.setResponses([fauxAssistantMessage("对话摘要")]);
      const door = opened.door!;
      const ticket = door.controlReceived("m1", "stop-c");
      const taskId = await conversation.compact(undefined, context);
      await until(() => held.includes(conversation.id), "the hold");
      expect(faux.state.callCount).toBe(2);
      expect(await compactionStarts(opened.harness, conversation.id)).toEqual([]);
      door.controlAdmitted(ticket, 9);
      door.controlExecuted("stop-c");
      expect(await outcome(opened.harness, taskId)).toBe("completed");
      expect(faux.state.callCount).toBe(3);
      expect(await compactionStarts(opened.harness, conversation.id)).toEqual([{ attempt: 1, k: 1, withdrawn: false, usage: true }]);
    } finally { await opened.close(); }
  });

  test("the conversation's abort ends a held summarize request: nothing sent, no start, not NOT_SENT", async () => {
    const { faux, models, model } = fauxModels();
    const held: number[] = [];
    const opened = await openCompacting(models, { onHold: (id) => held.push(id) });
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      await twoTurns(faux, conversation);
      faux.setResponses([fauxAssistantMessage("不应发出")]);
      opened.door!.controlReceived("m1", "stop-d");
      const taskId = await conversation.compact(undefined, context);
      await until(() => held.length > 0, "the hold");
      await conversation.abort(context);
      expect(await outcome(opened.harness, taskId)).toBe("aborted");
      expect(faux.state.callCount).toBe(2);
      expect(await compactionStarts(opened.harness, conversation.id)).toEqual([]);
      expect(opened.door!.notSent).toBe(0);
    } finally { await opened.close(); }
  });

  test("a retryable summarize error has unknown usage; the successful retry has a confirmed bill", async () => {
    const { faux, models, model } = fauxModels();
    const opened = await openCompacting(models);
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model }, context);
      await twoTurns(faux, conversation);
      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }), fauxAssistantMessage("对话摘要")]);
      expect(await outcome(opened.harness, await conversation.compact(undefined, context))).toBe("completed");
      expect(faux.state.callCount).toBe(4);
      expect(await compactionStarts(opened.harness, conversation.id)).toEqual([
        { attempt: 1, k: 1, withdrawn: false, usage: false }, { attempt: 2, k: 1, withdrawn: false, usage: true },
      ]);
      const cost = await compactionCost(opened.harness, conversation.id, context);
      expect(cost.known).toBe(1);
      expect(cost.sent).toBe(2);
    } finally { await opened.close(); }
  });

  test("recovery registers again: a summarize request cut off by close is sent after reopen with the next invocation number", async () => {
    const first = fauxModels();
    let opened = await openCompacting(first.models);
    const { path } = opened;
    const { conversation } = await memberConversation(opened.harness, GROUP, "m1", { model: first.model }, context);
    await twoTurns(first.faux, conversation);
    const hang = hanging();
    first.faux.setResponses([hang.step]);
    const taskId = await conversation.compact(undefined, context);
    await hang.sent;
    await opened.close();

    const second = fauxModels();
    second.faux.setResponses([fauxAssistantMessage("恢复后的摘要")]);
    opened = await openCompacting(second.models, {}, path);
    try {
      opened.harness.resume();
      expect(await outcome(opened.harness, taskId)).toBe("completed");
      expect(second.faux.state.callCount).toBe(1);
      expect(opened.door!.dispatched).toBe(1);
      const recorded = await compactionStarts(opened.harness, conversation.id);
      // The cut-off request's usage write races the close; only the recovered one's is certain.
      expect(recorded.map(({ attempt, k, withdrawn }) => ({ attempt, k, withdrawn }))).toEqual([
        { attempt: 1, k: 1, withdrawn: false }, { attempt: 1, k: 2, withdrawn: false },
      ]);
      expect(recorded[1]!.usage).toBe(true);
    } finally { await opened.close(); }
  });
});
