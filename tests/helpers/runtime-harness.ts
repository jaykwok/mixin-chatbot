// Executed in a fresh process: module substitutes cannot leak into the real SDK tests.
import assert from "node:assert/strict";
import { mkdir, writeFile, access } from "node:fs/promises";
import { mock } from "bun:test";
import { waitFor, application } from "../../src/core/lifecycle.ts";
const sdk = await import("@earendil-works/pi-coding-agent");
const completed: string[] = [];
const delay = () => Bun.sleep(5);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) { assert.ok(Date.now() < end, "lifecycle condition timed out"); await delay(); }
}
type Fake = { cwd: string; history: string; state: { errorMessage?: string; messages: unknown[] }; prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>; dispose: () => Promise<void>; subscribe: () => () => void; getLastAssistantText: () => string;
  active: boolean; disposed: boolean; controller?: AbortController; disposeGate?: ReturnType<typeof gate>; disposeError?: Error;
  emit?: (event: { type: string; toolName?: string }) => void };
const sessions: Fake[] = [];
const prompts: string[] = [];
let creating = false;
let creationGate: ReturnType<typeof gate> | undefined;
let abortGate: ReturnType<typeof gate> | undefined;
let finalGate: ReturnType<typeof gate> | undefined;
let finalCalls = 0;
let failFinal = false;
let failText = false;
let blockReceipts = false;
let active = 0;
let peak = 0;
let link: (() => void) | undefined;
const sent: string[] = [];

mock.module("@earendil-works/pi-coding-agent", () => ({ ...sdk,
  ModelRuntime: { create: async () => ({ getError: () => undefined, getModel: () => ({ id: "fake", provider: "fake", api: "openai-responses" }), checkAuth: async () => true }) },
  DefaultResourceLoader: class { async reload() {} },
  SessionManager: { open: (filename: string) => ({ filename }) },
  SettingsManager: { inMemory: () => ({}) },
  createAgentSession: async (options: { cwd: string; sessionManager: { filename: string } }) => {
    creating = true;
    await creationGate?.promise;
    creating = false;
    const history = options.sessionManager.filename;
    await writeFile(history, '{"type":"session","version":3}\n');
    const session: Fake = {
      cwd: options.cwd, history, state: { messages: [] }, active: false, disposed: false,
      async prompt(text) {
        assert.equal(session.active, false, "overlapping prompt on one session");
        assert.equal(session.disposed, false, "prompt started after disposal");
        prompts.push(text); session.active = true; active++; peak = Math.max(peak, active);
        session.controller = new AbortController();
        try {
          if (text.startsWith("block")) await waitFor(gate().promise, session.controller.signal);
          if (text === "link") link?.();
        } finally { session.active = false; active--; }
      },
      async abort() { session.controller?.abort(new DOMException("cancel", "AbortError")); await abortGate?.promise; },
      async dispose() { assert.equal(session.active, false); await session.disposeGate?.promise; if (session.disposeError) throw session.disposeError; session.disposed = true; },
      subscribe: (listener?: Fake["emit"]) => { session.emit = listener; return () => { session.emit = undefined; }; },
      getLastAssistantText: () => "answer:" + prompts.at(-1),
    };
    sessions.push(session);
    return { session };
  },
}));
mock.module("../../src/agent/local-tools.ts", () => ({ buildLocalTools: async () => [] }));
const sendTools = await import("../../src/agent/send-tools.ts");
mock.module("../../src/agent/send-tools.ts", () => ({ ...sendTools,
  buildSendTools: (options: { notes: { add: (note: string) => void } }) => { link = () => options.notes.add("https://files.example/a_b?sign=x_y"); return []; },
}));
mock.module("../../src/integrations/relay.ts", () => ({ getRelayConfig: () => null }));
mock.module("../../src/integrations/im.ts", () => ({
  abortOutboundRequests: () => {}, getOutboundRateStatus: () => ({ used: 0, limit: 20 }),
  sendReplyWithMention: async (text: string, _group: string, _phone: string, _url: string, signal: AbortSignal) => {
    finalCalls++;
    if (finalGate) await waitFor(finalGate.promise, signal);
    sent.push(text); return !failFinal;
  },
  sendText: async (text: string, _group: string, _phone: string, _url: string, options?: { signal?: AbortSignal; traffic?: string }) => {
    if (blockReceipts && options?.traffic !== "status") await waitFor(gate().promise, options?.signal ?? application.signal);
    if (options?.traffic !== "status") sent.push(text);
    return !failText;
  },
}));
await mkdir("data/config", { recursive: true });
await writeFile("data/config/models.json", JSON.stringify({ modelId: "fake", providers: { fake: { apiKey: "test-only" } } }));
const runtime = await import("../../src/agent/runtime.ts");
const { DeliveryStore } = await import("../../src/agent/delivery-store.ts");
const { stateDatabase } = await import("../../src/core/state.ts");
const store = new DeliveryStore();
const callback = (key: string) => "https://im.zdxlz.com/im-external/v1/webhook/send?key=" + key;
const request = (user: string, content: string) => runtime.handleUserMessage(user, "group", content, callback(user));

// Diagnose a silent stream and compaction separately; stale tool state must not leak into the next run.
const observed = request("progress", "block-progress");
await until(() => prompts.includes("block-progress"));
const observedSession = sessions.at(-1)!;
observedSession.emit?.({ type: "turn_start" });
await request("progress", "/status");
assert.match(sent.at(-1)!, /当前阶段：等待模型响应/);
assert.match(sent.at(-1)!, /任务编号：/);
await delay(); // Control receipts coalesce until their asynchronous send finishes.
observedSession.emit?.({ type: "tool_execution_start", toolName: "read" });
observedSession.emit?.({ type: "compaction_start" });
await request("progress", "/status");
assert.match(sent.at(-1)!, /当前阶段：压缩会话历史/);
await delay();
await request("progress", "/stop"); await observed;
const timed = assert.rejects(request("progress", "block-timeout"), /任务总时限 10 秒已到.*阶段：等待模型响应/);
await until(() => prompts.includes("block-timeout"));
observedSession.emit?.({ type: "turn_start" });
await request("progress", "/status");
assert.match(sent.at(-1)!, /最近工具：无/);
await timed;
await request("progress", "/status");
assert.match(sent.at(-1)!, /状态：空闲/);
assert.doesNotMatch(sent.at(-1)!, /任务编号：/);
completed.push("progress-and-task-deadline");

// A final reply waiting on the platform still owns the session queue.
finalGate = gate();
const first = request("fifo", "first");
await until(() => finalCalls === 1);
const second = request("fifo", "second");
await delay(); assert.equal(prompts.includes("second"), false);
finalGate.release(); await Promise.all([first, second]); finalGate = undefined;
assert.deepEqual(prompts.slice(-2), ["first", "second"]); assert.equal(peak, 1);
completed.push("final-delivery-fifo");

// Cancellation cleanup remains a barrier even when two messages arrive during abort.
const blocked = request("race", "block-race");
await until(() => prompts.includes("block-race"));
abortGate = gate();
const stop = request("race", "/stop");
const next = request("race", "next-one"); const last = request("race", "next-two");
await delay(); assert.equal(prompts.includes("next-one"), false);
abortGate.release(); await Promise.all([blocked, stop, next, last]); abortGate = undefined;
assert.equal(peak, 1); completed.push("abort-barrier");

creationGate = gate();
const initial = request("creation", "must-not-run");
await until(() => creating);
const clear = request("creation", "/clear");
const afterClear = request("creation", "after-clear");
creationGate.release(); await Promise.all([initial, clear, afterClear]); creationGate = undefined;
assert.equal(prompts.includes("must-not-run"), false);
assert.equal(sessions.filter(s => s.history.includes("creation")).length, 2);
completed.push("clear-during-creation");

// A duplicate clear must not cancel the first clear's queued disposal barrier.
const webhook = await import("../../src/server/webhook.ts");
creationGate = gate();
const duplicateInitial = request("dup-clear", "must-not-run-either");
await until(() => creating);
for (let i = 0; i < 2; i++) assert.equal(webhook.enqueueUserRequest("/clear", "dup-clear", "group", callback("dup-clear"), "127.0.0.1"), true);
creationGate.release();
await duplicateInitial;
await webhook.drainUserRequests();
creationGate = undefined;
assert.equal(prompts.includes("must-not-run-either"), false);
assert.equal(sessions.find(s => s.history.includes("dup-clear"))!.disposed, true);
await assert.rejects(access("data/groups/group/users/dup-clear/session.jsonl"));
completed.push("duplicate-clear-barrier");

const old = sessions.find(s => s.history.includes("fifo"))!;
old.disposeGate = gate();
const cleanup = runtime.cleanupIdleSessions(Date.now() + 3600000);
await delay();
const count = sessions.length;
const arriving = request("fifo", "after-idle");
await delay(); assert.equal(sessions.length, count);
old.disposeGate.release(); await Promise.all([cleanup, arriving]);
assert.equal(old.disposed, true); assert.equal(peak, 1);
completed.push("idle-disposal-barrier");

await request("dispose-failure", "dispose-failure-request");
await request("dispose-following", "dispose-following-request");
const broken = sessions.find(s => s.history.includes("dispose-failure"))!;
const following = sessions.find(s => s.history.includes("dispose-following"))!;
broken.disposeError = new Error("injected disposal failure");
await runtime.cleanupIdleSessions(Date.now() + 3600000);
assert.equal(broken.disposed, false);
assert.equal(following.disposed, true, "one dispose failure must not skip the remaining idle sessions");
broken.disposeError = undefined;
await runtime.cleanupIdleSessions(Date.now() + 3600000);
assert.equal(broken.disposed, true, "failed disposal remains retryable");
completed.push("idle-disposal-failure-isolation");

failFinal = true;
await assert.rejects(request("delivery", "link"), /未送达/);
const key = JSON.stringify(["group", "delivery"]);
assert.equal(store.pending(key).length, 1); assert.match(store.pending(key)[0]!.text, /a_b\?sign=x_y/);
failFinal = false;
await request("delivery", "/clear"); assert.equal(store.pending(key).length, 1);
failText = true; await assert.rejects(request("delivery", "/deliver"), /补发失败/);
assert.equal(store.pending(key).length, 1);
failText = false; await request("delivery", "/deliver"); assert.equal(store.pending(key).length, 0);
completed.push("durable-delivery-after-clear");

const { createApp } = await import("../../src/server/app.ts");
const httpSignal = new AbortController();
let shutdownRequested = false;
const app = createApp({ signal: httpSignal.signal, webhookSecret: "a".repeat(64), allowInsecure: false,
  isStopping: () => false, adminToken: "admin-test", shutdown: () => { shutdownRequested = true; } });
const post = (text: string) => app.request("/webhook/" + "a".repeat(64), { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "text", textMsg: { content: text }, phone: "control", groupId: "group", callBackUrl: callback("control") }) });
assert.equal((await post("block-http-1")).status, 200);
await until(() => prompts.includes("block-http-1"));
assert.equal(webhook.hasUserRequestCapacity(), false);
for (let i = 0; i < 11; i++) webhook.isRateLimited("control", "group");
webhook.rememberRequest("control", "group", "/stop");
blockReceipts = true;
assert.equal((await post("/stop")).status, 200);
await until(() => !sessions.at(-1)!.active);
await until(() => webhook.hasUserRequestCapacity());
// Start the next turn directly so the intentional inbound rate limit is retained.
const again = request("control", "block-http-2");
await until(() => prompts.includes("block-http-2"));
assert.equal((await post("/stop")).status, 200);
await again;
assert.equal(sessions.at(-1)!.active, false);
completed.push("stop-bypasses-capacity-rate-dedup-and-receipt");

let cancelled = false;
const body = new ReadableStream({ cancel() { cancelled = true; } });
const slow = app.request(new Request("http://localhost/webhook/" + "a".repeat(64), { method: "POST", body, duplex: "half" } as RequestInit));
await delay(); httpSignal.abort();
assert.equal((await slow).status, 408); assert.equal(cancelled, true);
assert.equal((await app.request("/_admin/shutdown", { method: "POST" })).status, 404);
assert.equal(shutdownRequested, false);
assert.equal((await app.request("/_admin/shutdown", { method: "POST", headers: { Authorization: "Bearer admin-test" } })).status, 200);
await delay(); assert.equal(shutdownRequested, true);
completed.push("slow-body-cancellation-and-admin-auth");

await runtime.disposeAllSessions();
await webhook.drainUserRequests();
await application.drain();
await access("data/state/agent.sqlite");
stateDatabase().close();
console.log("HARNESS_RESULT=" + JSON.stringify(completed));
