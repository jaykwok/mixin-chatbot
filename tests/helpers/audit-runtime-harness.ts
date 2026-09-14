// Real app/runtime/queues, delivery database and relay adapter; all network transport is fake.
import assert from "node:assert/strict";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mock } from "bun:test";
import { application, waitFor } from "../../src/core/lifecycle.ts";
const sdk = await import("@earendil-works/pi-coding-agent");
const relay = await import("../../src/integrations/relay.ts");
const config = { webdavUrl: "https://dav.invalid/files/", publicBaseUrl: "https://files.invalid/d/files/",
  maxBytes: 64 * 1024 * 1024, expireHours: 1, signSecret: "synthetic-key", signPathPrefix: "/files/" };
const size = 26 * 1024 * 1024;
let headStatus = 200, heads = 0;
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  if (init?.method === "PUT" || init?.method === "MKCOL") return new Response(null, { status: 201 });
  if (init?.method === "HEAD") { heads++; return new Response(null, { status: headStatus, headers: { "content-length": String(size) } }); }
  throw new Error("Unexpected network request");
}) as typeof fetch;
mock.module("../../src/integrations/relay.ts", () => ({ ...relay, getRelayConfig: () => config }));
mock.module("../../src/agent/local-tools.ts", () => ({ buildLocalTools: async () => [] }));
const prompts: string[] = [], sent: { user: string; text: string }[] = [];
const sessions: { release?: () => void; controller?: AbortController }[] = [];
mock.module("../../src/integrations/im.ts", () => ({
  abortOutboundRequests() {}, getOutboundRateStatus: () => ({ used: 0, limit: 20 }),
  sendReplyWithMention: async (_text: string, _group: string, user: string) => user !== "link-user",
  sendText: async (text: string, _group: string, user: string, _url: string, options?: { traffic?: string }) => {
    if (options?.traffic !== "status") sent.push({ user, text }); return true;
  },
  uploadAttachment: async () => { throw new Error("Unexpected IM upload"); }, sendFile: async () => false, sendImage: async () => false,
}));
// SettingsManager 不替换：选型走真实的 Pi 设置读取，由下面写的 settings.json 驱动。
mock.module("@earendil-works/pi-coding-agent", () => ({ ...sdk,
  ModelRuntime: { create: async () => ({ getError: () => undefined,
    getModel: () => ({ id: "fake", provider: "fake", api: "openai-responses", reasoning: false }), checkAuth: async () => true }) },
  DefaultResourceLoader: class { async reload() {} },
  SessionManager: { open: (filename: string) => ({ filename }) },
  createAgentSession: async (options: any) => {
    await writeFile(options.sessionManager.filename, '{"type":"session","version":3}\n');
    const session = { state: { messages: [] }, controller: undefined as AbortController | undefined, release: undefined as (() => void) | undefined,
      async prompt(text: string) {
        prompts.push(text); session.controller = new AbortController();
        if (text.startsWith("block-")) await waitFor(new Promise<void>(resolve => { session.release = resolve; }), session.controller.signal);
        if (text === "make-file-link") {
          const file = join(dirname(options.sessionManager.filename), "tmp/fixture.bin");
          const handle = await open(file, "w");
          try { await handle.truncate(size); } finally { await handle.close(); }
          await options.customTools.find((tool: any) => tool.name === "send_file").execute("fixture", { source: file }, session.controller.signal);
        }
      },
      async abort() { session.controller?.abort(new DOMException("cancel", "AbortError")); },
      async dispose() {}, subscribe: () => () => {}, getLastAssistantText: () => "完整回答",
    };
    sessions.push(session); return { session };
  },
}));
await mkdir("data/config", { recursive: true });
await mkdir("data/runtime/pi", { recursive: true });
await writeFile("data/config/models.json", JSON.stringify({ providers: { fake: { apiKey: "fixture-only" } } }));
await writeFile("data/runtime/pi/settings.json", JSON.stringify({ defaultProvider: "fake", defaultModel: "fake" }));
const runtime = await import("../../src/agent/runtime.ts");
const webhook = await import("../../src/server/webhook.ts");
const { createApp } = await import("../../src/server/app.ts");
const { DeliveryStore } = await import("../../src/agent/delivery-store.ts");
const { stateDatabase } = await import("../../src/core/state.ts");
if (process.argv[2] === "legacy-schema") {
  const db = stateDatabase();
  db.exec("CREATE TABLE deliveries (id TEXT PRIMARY KEY, session TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)");
  await assert.rejects(runtime.initializeAgentRuntime(), /需要迁移/);
  assert.equal((db.query("PRAGMA table_info(deliveries)").all() as { name: string }[]).some(column => column.name === "attachments"), false);
  db.close(); console.log("AUDIT_REGRESSIONS_PASSED"); process.exit(0);
}
const app = createApp({ signal: application.signal, webhookSecret: "fixture", allowInsecure: false,
  isStopping: () => false, adminToken: "fixture", shutdown() {} });
const callback = "https://im.zdxlz.com/im-external/v1/webhook/send?key=fixture";
async function post(user: string, content: string) {
  const response = await app.request("http://fixture.invalid/webhook/fixture", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "text", phone: user,
      groupId: "group", callBackUrl: callback, textMsg: { content } }) });
  assert.equal(response.status, 200);
}
async function until(check: () => boolean) {
  const deadline = performance.now() + 4000;
  while (!check()) { assert.ok(performance.now() < deadline, "fixture timed out"); await Bun.sleep(5); }
}
try {
  for (const control of ["/stop", "/clear"]) {
    const user = control.slice(1) + "-user", content = "block-" + user;
    await post(user, content); await until(() => prompts.includes(content));
    await post(user, control); await webhook.drainUserRequests();
    assert.equal(webhook.isDuplicate(user, "group", content), false);
    await post(user, content); await until(() => prompts.filter(value => value === content).length === 2);
    await post(user, "/stop"); await webhook.drainUserRequests();
  }
  await post("queue-user", "block-queue"); await until(() => prompts.includes("block-queue"));
  for (let i = 0; i < 8; i++) await post("queue-user", "queued-" + i);
  await post("queue-user", "retry-refused");
  await until(() => sent.some(message => message.user === "queue-user" && message.text.includes("8 条消息")));
  assert.equal(webhook.isDuplicate("queue-user", "group", "retry-refused"), false);
  sessions.at(-1)!.release!(); await webhook.drainUserRequests();
  assert.equal(prompts.includes("retry-refused"), false);
  // Exercise admission again without the independent 10/min HTTP rate limiter.
  assert.equal(webhook.enqueueUserRequest("retry-refused", "queue-user", "group", callback, "fixture"), true);
  await webhook.drainUserRequests();
  assert.ok(prompts.includes("retry-refused"));
  const oldRelease = webhook.rememberRequest("generation", "group", "same");
  const newRelease = webhook.rememberRequest("generation", "group", "same");
  oldRelease(); assert.equal(webhook.isDuplicate("generation", "group", "same"), true);
  newRelease(); assert.equal(webhook.isDuplicate("generation", "group", "same"), false);

  const store = new DeliveryStore(), key = JSON.stringify(["group", "link-user"]);
  await assert.rejects(runtime.handleUserMessage("link-user", "group", "make-file-link", callback), /回复未能完整/);
  const original = store.pending(key)[0]!;
  assert.equal(original.attachments.length, 1);
  const signed = original.text.match(/https:\/\/[^\s]+/)![0];
  assert.ok(signed.includes("sign="));
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600000;
  try {
    config.signSecret = "rotated-fixture-key";
    await runtime.handleUserMessage("link-user", "group", "/deliver", callback);
    const delivered = sent.findLast(message => message.user === "link-user")!.text;
    assert.ok(!delivered.includes(signed));
    assert.ok(delivered.includes(relay.publicUrlFor(config, original.attachments[0]!.reference.url)));
    assert.equal(store.pending(key).length, 0);
    // Duplicate generated notes share one explicit reference and one probe.
    const note = original.attachments[0]!.original;
    store.save(key, "duplicate\n" + note + "\n" + note, undefined, original.attachments);
    const before = heads;
    await runtime.handleUserMessage("link-user", "group", "/deliver", callback);
    assert.equal(heads - before, 1);
    assert.ok(!sent.at(-1)!.text.includes(signed));
    // Partial delivery acknowledges only completed rows.
    store.save(key, "first plain answer");
    store.save(key, original.text, undefined, original.attachments);
    headStatus = 404;
    await assert.rejects(runtime.handleUserMessage("link-user", "group", "/deliver", callback), /已从后端删除/);
    assert.equal(store.pending(key).length, 1);
    assert.equal(store.pending(key)[0]!.text, original.text);
    headStatus = 200;
    await runtime.handleUserMessage("link-user", "group", "/deliver", callback);
    assert.equal(store.pending(key).length, 0);
    // A failing attachment probe must not discard the final model answer.
    headStatus = 404;
    await assert.rejects(runtime.handleUserMessage("probe-user", "group", "make-file-link", callback), /已从后端删除/);
    assert.ok(store.pending(JSON.stringify(["group", "probe-user"]))[0]!.text.includes("完整回答"));
  } finally { Date.now = realNow; }
  console.log("AUDIT_REGRESSIONS_PASSED");
} finally {
  await runtime.disposeAllSessions(); await webhook.drainUserRequests(); await application.drain(); stateDatabase().close();
}
