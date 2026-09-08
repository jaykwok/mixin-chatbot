// Executed in a fresh process: module substitutes cannot leak into the real SDK tests.
import assert from "node:assert/strict";
import { mkdir, writeFile, access } from "node:fs/promises";
import { mock } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { waitFor, application } from "../../src/core/lifecycle.ts";
const sdk = await import("@earendil-works/pi-coding-agent");
const completed: string[] = [];
const delay = () => Bun.sleep(5);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function until(check: () => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!check()) { assert.ok(Date.now() < end, "lifecycle condition timed out"); await delay(); }
}
type Fake = { cwd: string; history: string; state: { errorMessage?: string; messages: unknown[] }; prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>; dispose: () => Promise<void>; subscribe: () => () => void; getLastAssistantText: () => string;
  active: boolean; disposed: boolean; controller?: AbortController; disposeGate?: ReturnType<typeof gate>; disposeError?: Error;
  promptGate?: ReturnType<typeof gate>; abortGate?: ReturnType<typeof gate>;
  emit?: (event: { type: string; [key: string]: unknown }) => void };
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
          if (text.startsWith("block")) { session.promptGate = gate(); await waitFor(session.promptGate.promise, session.controller.signal); }
          if (text === "link") link?.();
        } finally { session.active = false; active--; }
      },
      async abort() { session.controller?.abort(new DOMException("cancel", "AbortError")); await session.abortGate?.promise; await abortGate?.promise; },
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

// A separate process selects this mode with a 10s model idle budget and a 45s task budget.
if (process.argv.includes("--model-idle")) {
  const partial = (responseId: string): AssistantMessage => ({
    role: "assistant", content: [], api: "openai-completions", provider: "fake", model: "fake", responseId,
    stopReason: "pending", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  async function blocked(user: string) {
    const result = request(user, "block-" + user).then(() => undefined, error => error as Error);
    await until(() => prompts.includes("block-" + user));
    return { session: sessions.at(-1)!, result };
  }
  function begin(session: Fake, message: AssistantMessage) {
    session.emit?.({ type: "turn_start" });
    session.emit?.({ type: "message_start", message });
  }
  function delta(session: Fake, message: AssistantMessage, value: string, type = "toolcall_delta") {
    session.emit?.({ type: "message_update", message,
      assistantMessageEvent: { type, contentIndex: 0, delta: value, partial: message } });
  }
  function finish(session: Fake, message: AssistantMessage) {
    message.stopReason = "stop"; message.rawStopReason = "stop";
    session.emit?.({ type: "message_end", message });
    session.promptGate!.release();
  }

  const silent = await blocked("idle-silent");
  silent.session.emit?.({ type: "turn_start" });
  const empty = await blocked("idle-empty");
  const emptyMessage = partial("idle-empty-response");
  empty.session.abortGate = gate();
  begin(empty.session, emptyMessage);
  delta(empty.session, emptyMessage, '{"path": "private-tool-argument"}');
  const emptyTimer = setInterval(() => {
    delta(empty.session, emptyMessage, "");
    delta(empty.session, emptyMessage, " \n");
  }, 50);
  const next = request("idle-empty", "after-idle-cancellation");

  const growing = await blocked("idle-growing");
  const growingMessage = partial("idle-growing-response");
  begin(growing.session, growingMessage);
  const growingTimer = setInterval(() => {
    delta(growing.session, growingMessage, "private-thinking", "thinking_delta");
    delta(growing.session, growingMessage, "private-answer", "text_delta");
    delta(growing.session, growingMessage, "private-argument");
  }, 1_000);

  const tool = await blocked("idle-tool");
  const toolMessage = partial("idle-tool-response");
  begin(tool.session, toolMessage);
  delta(tool.session, toolMessage, '{"path":"file"}');
  toolMessage.stopReason = "toolUse"; toolMessage.rawStopReason = "tool_calls";
  tool.session.emit?.({ type: "message_end", message: toolMessage });
  tool.session.emit?.({ type: "tool_execution_start", toolName: "read" });

  const compaction = await blocked("idle-compaction");
  compaction.session.emit?.({ type: "compaction_start" });
  const retry = await blocked("idle-retry");
  const retryMessage = partial("idle-retry-first");
  begin(retry.session, retryMessage);
  retryMessage.stopReason = "error";
  retry.session.emit?.({ type: "message_end", message: retryMessage });
  retry.session.emit?.({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 12_000, errorMessage: "503: fake retry" });

  finalGate = gate();
  const delivery = await blocked("idle-delivery");
  const deliveryMessage = partial("idle-delivery-response");
  begin(delivery.session, deliveryMessage);
  delta(delivery.session, deliveryMessage, "private-final-answer", "text_delta");
  finish(delivery.session, deliveryMessage);
  await until(() => finalCalls === 1);
  let delivered = false;
  void delivery.result.then(() => { delivered = true; });

  await until(() => !!silent.session.controller?.signal.aborted && !!empty.session.controller?.signal.aborted, 15_000);
  clearInterval(emptyTimer);
  assert.match(String(await silent.result), /模型连续 10 秒无有效进展.*阶段：等待模型响应/);
  assert.equal(prompts.includes("after-idle-cancellation"), false, "next prompt escaped the abort cleanup barrier");
  emptyMessage.stopReason = "aborted";
  empty.session.emit?.({ type: "message_end", message: emptyMessage });
  // Late updates must not revive a cancelled run or hide its cleanup phase.
  empty.session.emit?.({ type: "turn_start" });
  delta(empty.session, emptyMessage, "late-output-must-be-ignored");
  empty.session.emit?.({ type: "tool_execution_start", toolName: "late-tool" });
  await request("idle-empty", "/status");
  assert.match(sent.at(-1)!, /当前阶段：等待取消清理/);
  assert.match(sent.at(-1)!, /模型无进展时限：10 秒/);
  assert.equal(store.pending(JSON.stringify(["group", "idle-empty"])).length, 0, "partial output was persisted as a deliverable");
  empty.session.abortGate!.release();
  assert.match(String(await empty.result), /模型连续 10 秒无有效进展.*阶段：接收模型输出/);
  await until(() => prompts.includes("after-idle-cancellation"));
  completed.push("silent-and-empty-streams-stop-with-cleanup-barrier");

  // These phases have lasted longer than the idle budget and must still be running.
  for (const item of [growing, tool, compaction, retry]) {
    assert.equal(item.session.active, true);
    assert.equal(item.session.controller?.signal.aborted, false);
  }
  assert.equal(delivered, false);
  assert.equal(delivery.session.controller?.signal.aborted, false);
  clearInterval(growingTimer);
  finish(growing.session, growingMessage);
  for (const [item, id] of [[tool, "idle-tool-next"], [compaction, "idle-compaction-next"], [retry, "idle-retry-next"]] as const) {
    const message = partial(id);
    begin(item.session, message);
    delta(item.session, message, "reply-after-pause", "text_delta");
    finish(item.session, message);
  }
  finalGate.release();
  for (const item of [growing, tool, compaction, retry, delivery]) assert.equal(await item.result, undefined);
  await next;
  finalGate = undefined;
  completed.push("growth-tools-compaction-retry-and-delivery-survive");

  await request("idle-empty", "/status");
  assert.match(sent.at(-1)!, /状态：空闲/);
  assert.doesNotMatch(sent.at(-1)!, /任务编号：/);
  await runtime.disposeAllSessions();
  await application.drain();
  stateDatabase().close();
  console.log("HARNESS_RESULT=" + JSON.stringify(completed));
  process.exit(0);
}

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
assert.match(sent.at(-1)!, /最近使用的工具：暂无/);
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
await assert.rejects(request("delivery", "link"), /未能完整发到群里/);
const key = JSON.stringify(["group", "delivery"]);
assert.equal(store.pending(key).length, 1); assert.match(store.pending(key)[0]!.text, /a_b\?sign=x_y/);
failFinal = false;
await request("delivery", "/clear"); assert.equal(store.pending(key).length, 1);
assert.match(sent.at(-1)!, /你在本群的聊天记录已归档/);
assert.match(sent.at(-1)!, /之前已生成但尚未发完/);
failText = true; await assert.rejects(request("delivery", "/deliver"), /补发失败/);
assert.equal(store.pending(key).length, 1);
failText = false; await request("delivery", "/deliver"); assert.equal(store.pending(key).length, 0);
await request("delivery", "/deliver"); assert.equal(sent.at(-1), "你在本群没有待补发的回复。");
await request("delivery", "/stop"); assert.doesNotMatch(sent.at(-1)!, /已保留/);
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
