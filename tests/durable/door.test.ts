// The request door on the project's Durable modules: requests find their member by the conversation's provider session
// (first conversation, restart recovery, forks, forged identities, conflicting sessions, a failing lookup), parity with
// Durable's direct Models call, setup-failure semantics, an abort during an OAuth refresh, the hold for a member's
// pending control (also while credentials resolve), the control registration ownership of q01, q02's premise that a
// commit settles only after storage did (controlUncertain), and compaction's summarize requests (manual, background,
// overflow, retried, recovered). Faux providers only; no network.
import { afterAll, describe, spyOn, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { getEventListeners } from "node:events";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import {
  type AssistantMessage, createModels, InMemoryCredentialStore, type Message, type Models, type MutableModels, type OAuthCredential,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  AssistantEntry, type Conversation, configure, createSession, defineDoc, type Harness, type HarnessSettings, LiveDoc, ProviderDoc,
  SessionFailed, type Storage, UsageDoc,
} from "@earendil-works/pi-durable";
import { type DoorOptions, NOT_SENT, RequestDoor } from "../../src/durable/door.ts";
import { IdentityDoc, MemberDirectory, memberConversation } from "../../src/durable/identity.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, type GroupHarness, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";

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
  const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "external-deadline", { model }, context);
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
  const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "external-child", { model }, context);
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

test("closing the door leaves a dispatched request to the Harness and writes nothing late", async () => {
  const { faux, models, model } = fauxModels();
  const sent = Promise.withResolvers<void>(), ended = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  faux.setResponses([(_transcript, options) => new Promise<AssistantMessage>((resolve) => {
    signal = options!.signal!; sent.resolve();
    signal.addEventListener("abort", () => setTimeout(() => { resolve(fauxAssistantMessage("", { stopReason: "aborted" })); ended.resolve(); }, 30), { once: true });
  })]);
  const opened = await open(models);
  const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "close-late", { model }, context);
  const submission = await conversation.submit({ type: "input", content: "wait", requestId: "close-late" }, context);
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

  // The request cut off by the close is recovered after reopening and sent once more.
  const restarted = fauxModels(); restarted.faux.setResponses([fauxAssistantMessage("recovered")]);
  const reopened = await open(restarted.models, {}, opened.path);
  try {
    await reopened.door!.loadSessions(context);
    reopened.harness.resume();
    expect((await (await reopened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
    expect(restarted.faux.state.callCount).toBe(1);
  } finally { await reopened.close(); }
});

type Opened = GroupHarness;

function open(models: Models, door: false | Omit<DoorOptions, "sessions"> = {}, path = join(fixture.root, `db-${++counter}.sqlite`)): Promise<Opened> {
  return openGroupHarness(path, models, { settings: SETTINGS, door, group: GROUP });
}

/** The conversation's assistant messages, oldest first. */
async function assistants(conversation: Conversation): Promise<AssistantMessage[]> {
  const page = await conversation.entries({}, 200, undefined, context);
  return [...page.items].reverse().filter((entry) => AssistantEntry.is(entry)).map((entry) => entry.model![0] as AssistantMessage);
}

const notSent = (message: AssistantMessage | undefined) => message?.stopReason === "error" && message.errorMessage?.startsWith(NOT_SENT) === true;

async function until(probe: () => boolean, label: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** Fail the door's member-directory reads `times` times (only the door reads the directory here). */
function failSessionReads(harness: Harness, times: number) {
  const state = { failed: 0, times };
  const snapshot = harness.snapshot.bind(harness) as (...args: unknown[]) => Promise<unknown>;
  harness.snapshot = (async (...args: unknown[]) => {
    if (args[0] === MemberDirectory && state.failed < state.times) {
      state.failed++;
      throw new Error("synthetic member lookup failure");
    }
    return snapshot(...args);
  }) as typeof harness.snapshot;
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

describe("request door: member sessions", () => {
  test("a first conversation's request goes out with its own session; after a restart the recovered request finds its member again", async () => {
    const first = fauxModels();
    const hang = hanging();
    const sessions: unknown[] = [];
    first.faux.setResponses([(transcript, options, state, model) => { sessions.push(options?.sessionId); return hang.step(transcript, options, state, model); }]);
    let opened = await open(first.models);
    const { path } = opened;
    const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model: first.model }, context);
    await opened.door!.bind(conversation.id, context);
    const own = (await opened.harness.snapshot(ProviderDoc, conversation.id, context))!.sessionId;
    const submission = await conversation.submit({ type: "input", content: "第一次", requestId: "a1" }, context);
    await hang.sent;
    expect(sessions).toEqual([own]);
    await opened.close();

    for (const preload of [true, false]) {
      const second = fauxModels();
      const hangAgain = hanging();
      second.faux.setResponses(preload ? [(transcript, options, state, model) => { sessions.push(options?.sessionId); return hangAgain.step(transcript, options, state, model); }]
        : [(_transcript, options) => { sessions.push(options?.sessionId); return fauxAssistantMessage("恢复后的回答"); }]);
      opened = await open(second.models, {}, path);
      try {
        // As the service does before scheduling; without it, the unknown session is read once from the directory.
        if (preload) await opened.door!.loadSessions(context);
        opened.harness.resume();
        if (preload) { await hangAgain.sent; continue; }
        expect((await (await opened.harness.submission(submission.id, context))!.wait(context)).status).toBe("done");
        expect(opened.door!.dispatched).toBe(1);
        expect(opened.reports).toEqual([]);
      } finally { await opened.close(); }
    }
    expect(sessions).toEqual([own, own, own]);
  });

  test("a request without a session, or with one no member conversation has, is not sent", async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([fauxAssistantMessage("绕过"), fauxAssistantMessage("绕过"), fauxAssistantMessage("绕过")]);
    let reported = 0;
    const opened = await open(models, { onNotSent: () => { reported++; } });
    try {
      const transcript = { messages: [{ role: "user" as const, content: "直接调用", timestamp: Date.now() }] };
      const withSignal = await opened.models.streamSimple(faux.getModel(), transcript, { signal: new AbortController().signal }).result();
      const withoutSignal = await opened.models.streamSimple(faux.getModel(), transcript).result();
      const unknown = await opened.models.streamSimple(faux.getModel(), transcript, { signal: new AbortController().signal, sessionId: "ghost" }).result();
      expect(faux.state.callCount).toBe(0);
      expect([withSignal, withoutSignal, unknown].map(notSent)).toEqual([true, true, true]);
      expect(unknown.errorMessage).toContain("no verified member");
      expect(opened.door!.notSent).toBe(3);
      expect(reported).toBe(3);
    } finally { await opened.close(); }
  });

  test("a fork and a conversation whose identity the directory does not confirm get no member: their requests are not sent", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("第一轮回答"), fauxAssistantMessage("不应发出"), fauxAssistantMessage("不应发出")]);
    const opened = await open(models);
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      expect((await (await conversation.submit({ type: "input", content: "第一轮", requestId: "k1" }, context)).wait(context)).status).toBe("done");
      const entry = (await conversation.entries({}, 1, undefined, context)).items[0]!;
      const fork = await conversation.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
      // A forged copy of m1's identity on a conversation the directory does not point to.
      const space = (await opened.harness.snapshot(IdentityDoc, conversation.id, context))!.space;
      const forged = await opened.harness.commit(async (tx) => {
        const record = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await configure(tx, record.id, { model, thinkingLevel: "off" });
        Object.assign(await tx.doc(IdentityDoc, record.id), { space, phone: "m1" });
        return record.id;
      }, context);
      for (const other of [fork, (await opened.harness.conversation(forged, context))!]) {
        const settled = await (await other.submit({ type: "input", content: "没有成员", requestId: `x-${other.id}` }, context)).wait(context);
        expect({ status: settled.status, reason: "reason" in settled ? settled.reason : undefined }).toEqual({ status: "unanswered", reason: "model_error" });
        expect((await assistants(other)).slice(-3).map(notSent)).toEqual([true, true, true]);
      }
      expect(faux.state.callCount).toBe(1);
      await expect(opened.door!.bind(fork.id, context)).rejects.toThrow("no verified member session");
    } finally { await opened.close(); }
  });

  test("a session claimed by two conversations is sent for neither", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("不应发出")]);
    let opened = await open(models);
    const { path } = opened;
    const a = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
    const b = await memberConversation(opened.harness, scopeOf(GROUP), "m2", { model }, context);
    const shared = (await opened.harness.snapshot(ProviderDoc, a.conversation.id, context))!.sessionId;
    await opened.harness.commit(async (tx) => { (await tx.doc(ProviderDoc, b.conversation.id)).sessionId = shared; }, context);
    await opened.close();
    opened = await open(models, {}, path);
    try {
      await opened.door!.loadSessions(context);
      expect(opened.reports.map(String).some((report) => report.includes("is the same"))).toBe(true);
      const again = (await opened.harness.conversation(a.conversation.id, context))!;
      const settled = await (await again.submit({ type: "input", content: "重复的会话", requestId: "d1" }, context)).wait(context);
      expect(settled.status).toBe("unanswered");
      expect(faux.state.callCount).toBe(0);
      await expect(opened.door!.bind(b.conversation.id, context)).rejects.toThrow("claimed twice");
    } finally { await opened.close(); }
  });

  test("a member lookup that keeps failing sends nothing: NOT_SENT attempts are retried, then the turn ends; they never reach a later payload", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("不应发出")]);
    const opened = await open(models);
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      const injected = failSessionReads(opened.harness, Number.POSITIVE_INFINITY);
      const failed = await (await conversation.submit({ type: "input", content: "查找一直失败", requestId: "b1" }, context)).wait(context);
      expect({ status: failed.status, reason: "reason" in failed ? failed.reason : undefined }).toEqual({ status: "unanswered", reason: "model_error" });
      expect(faux.state.callCount).toBe(0);
      // Durable's retry policy (2 retries here) retries each NOT_SENT; the door counts every one.
      expect((await assistants(conversation)).map(notSent)).toEqual([true, true, true]);
      expect(opened.door!.notSent).toBe(3);
      expect(opened.reports.map(String).some((report) => report.includes("synthetic member lookup failure"))).toBe(true);

      injected.times = injected.failed;
      let request: Message[] = [];
      faux.setResponses([(transcript) => { request = transcript.messages as Message[]; return fauxAssistantMessage("恢复正常"); }]);
      const next = await (await conversation.submit({ type: "input", content: "下一条", requestId: "b2" }, context)).wait(context);
      expect(next.status).toBe("done");
      expect(faux.state.callCount).toBe(1);
      expect(opened.door!.dispatched).toBe(1);
      const payload = JSON.stringify(convertMessages({ ...faux.getModel(), api: "openai-completions" } as never, { messages: request } as never, {} as never));
      expect(payload).not.toContain(NOT_SENT);
      expect(payload).toContain("查找一直失败");
      expect(payload).toContain("下一条");
    } finally { await opened.close(); }
  });

  test("concurrent members each go out with their own session; one member's control holds only that member", async () => {
    const { faux, models, model } = fauxModels();
    const seen = new Map<string, unknown>();
    const reply: FauxResponseFactory = (transcript, options) => {
      const last = transcript.messages.at(-1) as { content: unknown };
      seen.set(JSON.stringify(last.content), options?.sessionId);
      return fauxAssistantMessage("好");
    };
    faux.setResponses([reply, reply, reply]);
    const held: number[] = [];
    const opened = await open(models, { onHold: (id) => held.push(id) });
    try {
      const members = await Promise.all(["m1", "m2", "m3"].map((phone) => memberConversation(opened.harness, scopeOf(GROUP), phone, { model }, context)));
      const own = await Promise.all(members.map(async ({ conversation }) => (await opened.harness.snapshot(ProviderDoc, conversation.id, context))!.sessionId));
      opened.door!.controlReceived("m2", "stop-m2");
      const submissions = await Promise.all(members.map(({ conversation }, index) =>
        conversation.submit({ type: "input", content: `成员${index + 1}`, requestId: `c${index}` }, context)));
      expect((await submissions[0]!.wait(context)).status).toBe("done");
      expect((await submissions[2]!.wait(context)).status).toBe("done");
      await until(() => held.includes(members[1]!.conversation.id), "m2's hold");
      expect(faux.state.callCount).toBe(2);
      opened.door!.controlExecuted("stop-m2");
      expect((await submissions[1]!.wait(context)).status).toBe("done");
      expect(members.map((_, index) => seen.get(JSON.stringify(`成员${index + 1}`)) ?? seen.get(JSON.stringify([{ type: "text", text: `成员${index + 1}` }])))).toEqual(own);
      expect(new Set(held)).toEqual(new Set([members[1]!.conversation.id]));
    } finally { await opened.close(); }
  });
});

describe("request door: fail closed and parity (D0 P10 C, E, F)", () => {
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
        const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
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
        const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
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
        const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
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

  test("a request aborted while its OAuth credential refreshes (pi-ai 1.0.3): it ends aborted at once, without a send; the refresh completes and is stored, and the next request uses it without refreshing", async () => {
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
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      const submission = await conversation.submit({ type: "input", content: "刷新时中止", requestId: "o1" }, context);
      await refreshing.promise;
      await conversation.abort(context);
      // Settles while the refresh is still held: the door does not wait for it.
      const settled = await submission.wait(context);
      expect({ status: settled.status, reason: "reason" in settled ? settled.reason : undefined }).toEqual({ status: "unanswered", reason: "aborted" });
      expect(faux.state.callCount).toBe(0);
      expect({ setupFailed: opened.door!.setupFailed, notSent: opened.door!.notSent, dispatched: opened.door!.dispatched }).toEqual({ setupFailed: 0, notSent: 0, dispatched: 0 });
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
  test("a request waits while its member has a control; another member is not held; execution releases it", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("回答"), fauxAssistantMessage("回答")]);
    const held: number[] = [];
    const opened = await open(models, { onHold: (id) => held.push(id) });
    try {
      const first = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      const other = await memberConversation(opened.harness, scopeOf(GROUP), "m2", { model }, context);
      const door = opened.door!;
      const ticket = door.controlReceived("m1", "stop-1");
      const submission = await first.conversation.submit({ type: "input", content: "等控制命令", requestId: "h1" }, context);
      await until(() => held.includes(first.conversation.id), "the hold");
      expect((await (await other.conversation.submit({ type: "input", content: "别人不受影响", requestId: "h2" }, context)).wait(context)).status).toBe("done");
      expect(faux.state.callCount).toBe(1);
      door.controlAdmitted(ticket, 7);
      expect(door.controls("m1")).toEqual({ tickets: [], stream: ["stop-1"] });
      expect(faux.state.callCount).toBe(1);
      door.controlExecuted("stop-1");
      expect((await submission.wait(context)).status).toBe("done");
      expect(faux.state.callCount).toBe(2);
      expect(held.includes(other.conversation.id)).toBe(false);
    } finally { await opened.close(); }
  });

  test("the control's abort ends a held request: nothing sent, not NOT_SENT", async () => {
    const { faux, models, model } = fauxModels();
    faux.setResponses([fauxAssistantMessage("不应发出")]);
    const held: number[] = [];
    const opened = await open(models, { onHold: (id) => held.push(id) });
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      opened.door!.controlReceived("m1", "stop-1");
      const submission = await conversation.submit({ type: "input", content: "会被中止", requestId: "h1" }, context);
      await until(() => held.length > 0, "the hold");
      await conversation.abort(context);
      const settled = await submission.wait(context);
      expect({ status: settled.status, reason: "reason" in settled ? settled.reason : undefined }).toEqual({ status: "unanswered", reason: "aborted" });
      expect(faux.state.callCount).toBe(0);
      expect(opened.door!.notSent).toBe(0);
    } finally { await opened.close(); }
  });

  /** Faux Models whose credential resolution runs `during` once, on the first request. */
  function duringAuth(during: () => void) {
    const made = fauxModels();
    const getAuth = made.models.getAuth.bind(made.models);
    let pending = true;
    (made.models as MutableModels).getAuth = (async (...args: Parameters<typeof getAuth>) => {
      const resolution = await getAuth(...args);
      if (pending) { pending = false; during(); }
      return resolution;
    }) as typeof made.models.getAuth;
    return made;
  }

  test("a control received while credentials resolve holds the request at the final check; its execution lets it go out once", async () => {
    let door: RequestDoor | undefined;
    const held: number[] = [];
    const { faux, models, model } = duringAuth(() => door!.controlReceived("m1", "stop-auth"));
    faux.setResponses([fauxAssistantMessage("回答")]);
    const opened = await open(models, { onHold: (id) => held.push(id) });
    door = opened.door!;
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      const submission = await conversation.submit({ type: "input", content: "凭据解析时来了控制命令", requestId: "w1" }, context);
      await until(() => held.length > 0, "the hold");
      expect(faux.state.callCount).toBe(0);
      door.controlExecuted("stop-auth");
      expect((await submission.wait(context)).status).toBe("done");
      expect(faux.state.callCount).toBe(1);
      expect(door.dispatched).toBe(1);
    } finally { await opened.close(); }
  });

  test("a deadline passed while credentials resolve ends the request aborted at the final check; nothing is sent", async () => {
    let expired = false;
    const { faux, models, model } = duringAuth(() => { expired = true; });
    faux.setResponses([fauxAssistantMessage("不应发出")]);
    const opened = await open(models, { dispatchError: () => expired ? new Error("synthetic total deadline") : undefined });
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      const submission = await conversation.submit({ type: "input", content: "凭据解析时到期", requestId: "t1" }, context);
      const settled = await submission.wait(context);
      expect(settled.status).toBe("unanswered");
      expect(faux.state.callCount).toBe(0);
      expect(opened.door!.dispatched).toBe(0);
      expect(opened.door!.notSent).toBe(0);
    } finally { await opened.close(); }
  });
});

describe("request door: control registrations (D0 q01)", () => {
  const door = () => new RequestDoor({}, { sessions: async () => [] });

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

  test("background reads that recover leave no abort listener behind on the door's lifetime signal", async () => {
    const gate = door();
    const signals = new Set<AbortSignal>(), original = AbortSignal.prototype.addEventListener;
    const spy = spyOn(AbortSignal.prototype, "addEventListener").mockImplementation(function (this: AbortSignal, ...args) {
      if (args[0] === "abort") signals.add(this);
      return Reflect.apply(original, this, args);
    });
    try {
      const ticket = gate.controlReceived("m", "c1");
      let reads = 0;
      expect(await gate.controlUncertain(ticket, async () => { if (++reads < 5) throw new Error("read failed"); return undefined; })).toBe("retrying");
      await until(() => gate.pendingControls("m") === 0, "the background reads");
      expect(reads).toBe(5);
      expect(signals.size).toBeGreaterThan(0);
      expect([...signals].map(signal => getEventListeners(signal, "abort").length)).toEqual([...signals].map(() => 0));
    } finally { spy.mockRestore(); await gate.close(); }
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
  const Doc = defineDoc<{ pending: boolean; seq: number }>({ kind: "test.settlement", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ pending: false, seq: 0 }) });

  for (const mode of ["success", "landed-error"] as const) {
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
            const seq = await target.commit(...args);
            entered.resolve();
            await release.promise;
            storageSettled = true;
            if (mode === "landed-error") throw new Error("synthetic reply failure after the SQLite commit");
            return seq!;
          };
        },
      }) as Storage;
      const session = createSession(storage);
      const gate = new RequestDoor({}, { sessions: async () => [] });
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
        } else {
          expect(state).toBe("rejected");
          // The Session failed: reads fail, so the ticket stays until a later read or the execution resolves it.
          await expect(read()).rejects.toBeInstanceOf(SessionFailed);
          expect(await gate.controlUncertain(ticket, read)).toBe("retrying");
          expect(gate.controls("m")).toEqual({ tickets: ["ctl"], stream: [] });
        }
        await gate.close();
        await session.close(context);
        closed = true;
        const reopened = createSession(await openGroupStorage(path));
        try {
          const durable = await reopened.snapshot(Doc, context);
          const recovered = new RequestDoor({}, { sessions: async () => [] });
          recovered.loadControls(durable?.pending ? [{ phone: "m", requestId: "ctl", seq: durable.seq }] : []);
          expect(recovered.pendingControls("m")).toBe(1);
        } finally { await reopened.close(context); }
      } finally {
        release.resolve();
        await gate.close();
        if (!closed) await session.close(context);
      }
    }, 15000);
  }
});

describe("request door: compaction's summarize requests", () => {
  // Manual compaction ignores `enabled`; a keep-recent budget of one token leaves the earlier turns to summarise.
  const COMPACTING: HarnessSettings = { ...SETTINGS, compaction: { enabled: false, keepRecentTokens: 1 } };
  const openCompacting = (models: Models, door: Omit<DoorOptions, "sessions"> = {}, path = join(fixture.root, `db-${++counter}.sqlite`), settings = COMPACTING) =>
    openGroupHarness(path, models, { settings, door, group: GROUP });

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

  test("a summarize request goes through the door with the conversation's session; pi.usage gains its usage", async () => {
    const { faux, models, model } = fauxModels();
    const opened = await openCompacting(models);
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      await twoTurns(faux, conversation);
      const before = await modelTokens(opened.harness, conversation.id);
      const own = (await opened.harness.snapshot(ProviderDoc, conversation.id, context))!.sessionId;
      let request: Message[] = [], sessionId: unknown;
      faux.setResponses([(transcript, options) => { request = transcript.messages as Message[]; sessionId = options?.sessionId; return fauxAssistantMessage("对话摘要"); }]);
      expect(await outcome(opened.harness, await conversation.compact(undefined, context))).toBe("completed");
      expect(faux.state.callCount).toBe(3);
      expect(opened.door!.dispatched).toBe(3);
      expect(sessionId).toBe(own);
      expect(JSON.stringify(request)).toContain("第一轮");
      expect(await modelTokens(opened.harness, conversation.id)).toBeGreaterThan(before);
    } finally { await opened.close(); }
  });

  test("a background compaction's summarize request goes through the door and holds for the member's control", async () => {
    const { faux, models, model } = fauxModels();
    const held: number[] = [];
    // Faux usage is estimated from the text (4 characters a token): the first answer is about 12,000 tokens, over the
    // background threshold (8,000) and under the blocking one (20,000).
    const BACKGROUND: HarnessSettings = { ...SETTINGS, compaction: { enabled: true, reserveTokens: 128_000 - 20_000, keepRecentTokens: 100, backgroundTokens: 12_000 } };
    const opened = await openCompacting(models, { onHold: (id) => held.push(id) }, undefined, BACKGROUND);
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      const own = (await opened.harness.snapshot(ProviderDoc, conversation.id, context))!.sessionId;
      let summarized: unknown;
      // The summarize request is the one Durable sends without prompt caching; the next turn's request runs beside it.
      const answer: FauxResponseFactory = (_transcript, options) => {
        if (options?.cacheRetention !== "none") return fauxAssistantMessage("第二轮回答");
        summarized = options.sessionId;
        return fauxAssistantMessage("后台摘要");
      };
      faux.setResponses([fauxAssistantMessage("x".repeat(48_000)), answer, answer]);
      expect((await (await conversation.submit({ type: "input", content: "长回答", requestId: "bg1" }, context)).wait(context)).status).toBe("done");
      // The next turn's preparation starts the background compaction; both its requests wait for the member's control.
      opened.door!.controlReceived("m1", "stop-bg");
      const next = await conversation.submit({ type: "input", content: "第二轮", requestId: "bg2" }, context);
      await until(() => held.filter((id) => id === conversation.id).length >= 2, "both holds");
      expect(faux.state.callCount).toBe(1);
      opened.door!.controlExecuted("stop-bg");
      expect((await next.wait(context)).status).toBe("done");
      await until(() => faux.state.callCount === 3, "the background summarize request");
      expect(summarized).toBe(own);
      expect(opened.door!.dispatched).toBe(3);
    } finally { await opened.close(); }
  });

  test("an overflow error compacts through the door, then the request is sent again", async () => {
    const { faux, models, model } = fauxModels();
    const ENABLED: HarnessSettings = { ...SETTINGS, compaction: { enabled: true, keepRecentTokens: 1 } };
    const opened = await openCompacting(models, {}, undefined, ENABLED);
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      await twoTurns(faux, conversation);
      const sessions: unknown[] = [];
      const record = (answer: AssistantMessage): FauxResponseFactory => (_transcript, options) => { sessions.push(options?.sessionId); return answer; };
      faux.setResponses([
        record(fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" })),
        record(fauxAssistantMessage("溢出后的摘要")),
        record(fauxAssistantMessage("第三轮回答")),
      ]);
      expect((await (await conversation.submit({ type: "input", content: "第三轮", requestId: "ov1" }, context)).wait(context)).status).toBe("done");
      const own = (await opened.harness.snapshot(ProviderDoc, conversation.id, context))!.sessionId;
      expect(sessions).toEqual([own, own, own]);
      expect(opened.door!.dispatched).toBe(5);
      expect(opened.door!.notSent).toBe(0);
    } finally { await opened.close(); }
  });

  test("a member lookup that keeps failing sends no summarize request: NOT_SENT is retried, then the compaction fails", async () => {
    const { faux, models, model } = fauxModels();
    let opened = await openCompacting(models);
    const { path } = opened;
    const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
    await twoTurns(faux, conversation);
    await opened.close();
    // A new door knows no session yet; every read of the directory fails.
    opened = await openCompacting(models, {}, path);
    try {
      faux.setResponses([fauxAssistantMessage("不应发出")]);
      failSessionReads(opened.harness, Number.POSITIVE_INFINITY);
      opened.harness.resume();
      const again = (await opened.harness.conversation(conversation.id, context))!;
      expect(await outcome(opened.harness, await again.compact(undefined, context))).toBe("failed");
      expect(faux.state.callCount).toBe(2);
      // Durable's retry policy (2 retries here) retries each NOT_SENT summarize attempt.
      expect(opened.door!.notSent).toBe(3);
    } finally { await opened.close(); }
  });

  test("a member's pending control holds a summarize request; the control's execution releases it", async () => {
    const { faux, models, model } = fauxModels();
    const held: number[] = [];
    const opened = await openCompacting(models, { onHold: (id) => held.push(id) });
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      await twoTurns(faux, conversation);
      faux.setResponses([fauxAssistantMessage("对话摘要")]);
      const door = opened.door!;
      const ticket = door.controlReceived("m1", "stop-c");
      const taskId = await conversation.compact(undefined, context);
      await until(() => held.includes(conversation.id), "the hold");
      expect(faux.state.callCount).toBe(2);
      door.controlAdmitted(ticket, 9);
      door.controlExecuted("stop-c");
      expect(await outcome(opened.harness, taskId)).toBe("completed");
      expect(faux.state.callCount).toBe(3);
    } finally { await opened.close(); }
  });

  test("the conversation's abort ends a held summarize request: nothing sent, not NOT_SENT", async () => {
    const { faux, models, model } = fauxModels();
    const held: number[] = [];
    const opened = await openCompacting(models, { onHold: (id) => held.push(id) });
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      await twoTurns(faux, conversation);
      faux.setResponses([fauxAssistantMessage("不应发出")]);
      opened.door!.controlReceived("m1", "stop-d");
      const taskId = await conversation.compact(undefined, context);
      await until(() => held.length > 0, "the hold");
      await conversation.abort(context);
      expect(await outcome(opened.harness, taskId)).toBe("aborted");
      expect(faux.state.callCount).toBe(2);
      expect(opened.door!.notSent).toBe(0);
    } finally { await opened.close(); }
  });

  test("a retryable summarize error is retried through the door", async () => {
    const { faux, models, model } = fauxModels();
    const opened = await openCompacting(models);
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model }, context);
      await twoTurns(faux, conversation);
      faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" }), fauxAssistantMessage("对话摘要")]);
      expect(await outcome(opened.harness, await conversation.compact(undefined, context))).toBe("completed");
      expect(faux.state.callCount).toBe(4);
      expect(opened.door!.dispatched).toBe(4);
    } finally { await opened.close(); }
  });

  test("recovery: a summarize request cut off by close is sent again after reopen, with the conversation's session", async () => {
    const first = fauxModels();
    let opened = await openCompacting(first.models);
    const { path } = opened;
    const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model: first.model }, context);
    await twoTurns(first.faux, conversation);
    const own = (await opened.harness.snapshot(ProviderDoc, conversation.id, context))!.sessionId;
    const hang = hanging();
    first.faux.setResponses([hang.step]);
    const taskId = await conversation.compact(undefined, context);
    await hang.sent;
    await opened.close();

    const second = fauxModels();
    let sessionId: unknown;
    second.faux.setResponses([(_transcript, options) => { sessionId = options?.sessionId; return fauxAssistantMessage("恢复后的摘要"); }]);
    opened = await openCompacting(second.models, {}, path);
    try {
      await opened.door!.loadSessions(context);
      opened.harness.resume();
      expect(await outcome(opened.harness, taskId)).toBe("completed");
      expect(second.faux.state.callCount).toBe(1);
      expect(opened.door!.dispatched).toBe(1);
      expect(sessionId).toBe(own);
    } finally { await opened.close(); }
  });

  // Durable 1.4.0: a retry backoff is a `sleeping` task, which holds no invocation and survives a close.
  test("a summarize retry asleep across a close runs once after reopen", async () => {
    const SLOW: HarnessSettings = { ...COMPACTING, retry: { maxRetries: 2, baseDelayMs: 1500, maxAgentDelayMs: 1500 } };
    const first = fauxModels();
    let opened = await openGroupHarness(join(fixture.root, `db-${++counter}.sqlite`), first.models, { settings: SLOW, group: GROUP });
    const { path } = opened;
    const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), "m1", { model: first.model }, context);
    await twoTurns(first.faux, conversation);
    first.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" })]);
    const taskId = await conversation.compact(undefined, context);
    for (let deadline = Date.now() + 5000; (await opened.harness.getTask(taskId, context))?.state.status !== "sleeping";) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the backoff");
      await Bun.sleep(5);
    }
    expect((await opened.harness.snapshot(LiveDoc, conversation.id, context))?.compactions?.[0]?.retry?.error).toContain("503");
    await opened.close();
    expect(first.faux.state.callCount).toBe(3);
    const stored = await openGroupStorage(path);
    try {
      const task = (await stored.scanTasks({ status: "sleeping" }, 10, undefined, context)).items;
      // Still asleep, and a close is no crash: no restart counted.
      expect(task.map((record) => ({ id: record.id, restarts: record.restarts }))).toEqual([{ id: taskId, restarts: undefined }]);
    } finally { await stored.close(context); }

    const second = fauxModels();
    second.faux.setResponses([fauxAssistantMessage("恢复后的摘要")]);
    opened = await openGroupHarness(path, second.models, { settings: SLOW, group: GROUP });
    try {
      opened.harness.resume();
      expect(await outcome(opened.harness, taskId)).toBe("completed");
      expect(second.faux.state.callCount).toBe(1);
      expect(opened.door!.dispatched).toBe(1);
    } finally { await opened.close(); }
  });
});
