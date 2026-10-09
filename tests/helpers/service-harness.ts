// Executed in a fresh process (tests/server/lease-loss.test.ts): the real service entry point src/server/app.ts with its
// real leases, maintenance, Durable message service, statistics ledger, archive and process supervision. Only the model
// (a faux provider instead of models.json), IM sends and the relay are substituted. Synthetic data in the current
// directory, no network.
//
// Three pieces of work wait at one gate, released by creating ./gate.open: a member's run inside its model call, the
// startup maintenance before it records the old session files' statistics, and a /clear of another member before it
// projects that member's conversation into the ledger. A supervised tool process appends a timestamp to a file in the
// group's workspace every 20 ms. Prints SERVICE_READY=<json> once all of them are in place, BLOCKED_ABORTED when the
// waiting model call sees its abort, then keeps serving until the test stops it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mock } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DATA_VERSION, VERSION_FILE } from "../../src/core/data-version.ts";
import { fauxModels } from "./durable.ts";

const gateFile = resolve("gate.open");
const waiting = new Set<string>();
async function gate(signal?: AbortSignal): Promise<void> {
  while (!existsSync(gateFile)) {
    signal?.throwIfAborted();
    await Bun.sleep(20);
  }
}
async function until(check: () => boolean, state: () => unknown, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) { assert.ok(Date.now() < end, "service harness setup timed out: " + JSON.stringify(state())); await Bun.sleep(20); }
}

await mkdir("data/config", { recursive: true });
await mkdir("data/runtime/pi", { recursive: true });
await mkdir("data/state", { recursive: true });
await mkdir("data/groups/group/workspace", { recursive: true });
// The configured model only passes the startup data check (src/core/data-validation.ts); it is never contacted, the
// service gets the faux model below.
await writeFile("data/config/models.json", JSON.stringify({ providers: { fake: {
  baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test-only", models: [{
    id: "fake", name: "fake", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
} } }));
await writeFile("data/config/webhook-secret", "a".repeat(64));
await writeFile("data/runtime/pi/settings.json", JSON.stringify({ defaultProvider: "fake", defaultModel: "fake" }));
const marker = JSON.stringify({ dataVersion: DATA_VERSION, transaction: "service-harness" });
await writeFile(join("data/state", VERSION_FILE), marker);
await writeFile(join("data/groups", VERSION_FILE), marker);

// The model: answers at once, except a message "block", whose call waits at the gate until it is aborted.
const prompts: string[] = [];
const { faux, models, model } = fauxModels();
const respond: FauxResponseFactory = (transcript, options) => {
  // The member's own messages; the service may add context messages after them.
  const text = JSON.stringify(transcript.messages.filter((message) => message.role === "user").map((message) => message.content));
  prompts.push(text);
  if (!text.includes("block")) return fauxAssistantMessage("answer") as AssistantMessage;
  return new Promise<AssistantMessage>((done) => {
    const aborted = () => { console.log("BLOCKED_ABORTED"); done(fauxAssistantMessage("", { stopReason: "aborted" })); };
    if (options?.signal?.aborted) return aborted();
    options?.signal?.addEventListener("abort", aborted, { once: true });
    void gate().then(() => done(fauxAssistantMessage("answer")));
  });
};
faux.setResponses(Array.from({ length: 16 }, () => respond));
const durableModels = await import("../../src/durable/models.ts");
mock.module("../../src/durable/models.ts", () => ({ ...durableModels,
  openModelSelection: async () => ({
    runtime: models, settings: undefined, model: models.getModel(model.provider, model.modelId)!, ref: model, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 } }, notices: [],
  }),
}));
const relay = await import("../../src/integrations/relay.ts");
mock.module("../../src/integrations/relay.ts", () => ({ ...relay, getRelayConfig: () => null }));
const im = await import("../../src/integrations/im.ts");
let replies = 0;
mock.module("../../src/integrations/im.ts", () => ({ ...im, sendReplyWithMention: async () => { replies++; return true; }, sendText: async () => true }));
const ledger = await import("../../src/agent/stats-ledger.ts");
// mock.module rewrites the imported namespace too: keep the real functions before replacing them.
const { sweepSessionStats } = ledger;
mock.module("../../src/agent/stats-ledger.ts", () => ({ ...ledger,
  sweepSessionStats: async (...args: Parameters<typeof sweepSessionStats>) => {
    waiting.add("maintenance");
    await gate();
    return sweepSessionStats(...args);
  },
}));
// The projection is gated as a whole: the ledger write inside it is synchronous, on a database the service closes after it.
const projection = await import("../../src/durable/projection.ts");
const { projectConversation } = projection;
let projectionGated = false;
mock.module("../../src/durable/projection.ts", () => ({ ...projection,
  projectConversation: async (...args: Parameters<typeof projectConversation>) => {
    if (!projectionGated) return projectConversation(...args);
    waiting.add("projection");
    await gate();
    return projectConversation(...args);
  },
}));

// The service itself: leases, data checks, the Durable service, HTTP server, instance file and the startup maintenance.
await import("../../src/server/app.ts");
const { runProcess } = await import("../../src/core/process.ts");
const instance = JSON.parse(readFileSync("data/state/instance.json", "utf8")) as { port: number };
const callback = (key: string) => "https://im.zdxlz.com/im-external/v1/webhook/send?key=" + key;
async function webhook(phone: string, content: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${instance.port}/webhook/${"a".repeat(64)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "text", phone, groupId: "group", textMsg: { content }, callBackUrl: callback(phone) }),
  });
  assert.equal(response.status, 200, await response.text());
}
// A finished turn first, so /clear has a conversation to reset and usage to record.
await webhook("archive", "hello");
// The reply is sent after its usage is recorded.
await until(() => replies === 1, () => ({ replies, prompts }));
projectionGated = true;
await webhook("archive", "/clear");
await webhook("blocked", "block");

const heartbeat = resolve("data/groups/group/workspace/tool-heartbeat.txt");
const pidFile = resolve("tool.pid");
await writeFile("tool.ts", [
  'import { appendFileSync, writeFileSync } from "node:fs";',
  "const [file, pidFile] = process.argv.slice(2);",
  "writeFileSync(pidFile, String(process.pid));",
  'setInterval(() => appendFileSync(file, Date.now() + "\\n"), 20);',
].join("\n"));
void runProcess({ command: process.execPath, args: [resolve("tool.ts"), heartbeat, pidFile], cwd: resolve("data/groups/group/workspace"), timeoutMs: 120_000 })
  .catch(() => {});

const beats = () => existsSync(heartbeat) ? readFileSync(heartbeat, "utf8").split("\n").filter(Boolean).length : 0;
await until(() => prompts.some((text) => text.includes("block")) && waiting.has("maintenance") && waiting.has("projection")
  && existsSync(pidFile) && beats() >= 2, () => ({ prompts, waiting: [...waiting], tool: existsSync(pidFile), beats: beats() }));
console.log("SERVICE_READY=" + JSON.stringify({ tool: Number(readFileSync(pidFile, "utf8")), heartbeat }));
