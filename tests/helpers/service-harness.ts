// Executed in a fresh process (tests/server/lease-loss.test.ts): the real service entry point src/server/app.ts with its
// real leases, maintenance, Durable message service, statistics ledger, archive and process supervision. Only the model
// (a faux provider instead of models.json), the platform (a local fake: event stream, directory, sends) and the relay are
// substituted. Synthetic data in the current directory, no network beyond loopback.
//
// Two pieces of work wait at one gate, released by creating ./gate.open: a member's run inside its model call, and
// a /clear of another member before it syncs that member's statistics into the ledger. A supervised tool process appends a timestamp to a file in the
// shared workspace every 20 ms. Prints SERVICE_READY=<json> once all of them are in place, BLOCKED_ABORTED when the
// waiting model call sees its abort, then keeps serving until the test stops it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mock } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { applicationBinding, VERSION_FILE } from "../../src/core/data-version.ts";
import { APP_VERSION, DATA_VERSION } from "../../src/core/version.ts";
import { fauxModels } from "./durable.ts";
import { FakePlatform } from "./fake-platform.ts";

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
await mkdir("data/workspace", { recursive: true });
// The configured model only passes the startup data check (src/core/data-validation.ts); it is never contacted, the
// service gets the faux model below.
await writeFile("data/config/models.json", JSON.stringify({ providers: { fake: {
  baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test-only", models: [{
    id: "fake", name: "fake", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
} } }));
// The platform: a local fake with two directory members; the service's stream connects to it.
const platform = new FakePlatform();
platform.directory = { children: { "1": [] }, members: { "1": [{ phone: "archive", name: "Archive" }, { phone: "blocked", name: "Blocked" }] },
  ids: { archive: "im-archive", blocked: "im-blocked" } };
await writeFile("data/config/app-bot.json", JSON.stringify(platform.config));
const platformConfig = await import("../../src/integrations/open-platform/config.ts");
mock.module("../../src/integrations/open-platform/config.ts", () => ({ ...platformConfig, platformEndpoints: () => platform.endpoints }));
await writeFile("data/runtime/pi/settings.json", JSON.stringify({ defaultProvider: "fake", defaultModel: "fake" }));
await writeFile(join("data/state", VERSION_FILE), JSON.stringify({ dataVersion: DATA_VERSION, appVersion: APP_VERSION, build: "", transaction: "service-harness",
  application: applicationBinding(platform.config) }));

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
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 } },
  }),
}));
const relay = await import("../../src/integrations/relay.ts");
mock.module("../../src/integrations/relay.ts", () => ({ ...relay, getRelayConfig: () => null }));
// The archive member's statistics sync is gated as a whole: the ledger write inside it is synchronous, on a database the
// service closes after it. Other members' syncs (the blocked member's space open) pass.
const projection = await import("../../src/durable/projection.ts");
const { syncMemberStats } = projection;
let projectionGated = false;
mock.module("../../src/durable/projection.ts", () => ({ ...projection,
  syncMemberStats: async (...args: Parameters<typeof syncMemberStats>) => {
    if (!projectionGated || args[2].phone !== "archive") return syncMemberStats(...args);
    waiting.add("projection");
    await gate();
    return syncMemberStats(...args);
  },
}));

// The service itself: leases, data checks, the Durable service, HTTP server, instance file and the startup maintenance.
await import("../../src/server/app.ts");
const { runProcess } = await import("../../src/core/process.ts");
// The stream is up and the initial directory scan has mapped both members.
await until(() => platform.sockets.size === 1 && platform.requestsTo("/open/applied/v1/user/detailByPhone").length === 2,
  () => ({ sockets: platform.sockets.size, requests: platform.requests.map(request => request.path) }));
const directoryReady = async () => {
  const instance = JSON.parse(readFileSync("data/state/instance.json", "utf8")) as { port: number };
  const health = await (await fetch(`http://127.0.0.1:${instance.port}/health`)).json() as { directory?: { mappings: number; running?: unknown } };
  return health.directory?.mappings === 2 && health.directory.running === undefined;
};
for (const end = Date.now() + 20_000; !await directoryReady();) { assert.ok(Date.now() < end, "directory scan did not finish"); await Bun.sleep(20); }
let serial = 0;
function message(user: string, content: string): void {
  platform.push({ eventType: "callback:alt", groupId: "100", userId: user, msgUid: `uid-${++serial}`, type: "text", content: { content }, extraContent: "" });
}
const replies = () => platform.sent.filter(item => item.body.msg_type === "markdown" && JSON.stringify(item.content).includes("answer")).length;
// A finished turn first, so /clear has a conversation to reset and usage to record.
message("im-archive", "hello");
// The reply is sent after its usage is recorded.
await until(() => replies() === 1, () => ({ replies: replies(), prompts, sent: platform.sent.map(item => item.body.msg_type) }));
projectionGated = true;
message("im-archive", "/clear");
message("im-blocked", "block");

const heartbeat = resolve("data/workspace/tool-heartbeat.txt");
const pidFile = resolve("tool.pid");
await writeFile("tool.ts", [
  'import { appendFileSync, writeFileSync } from "node:fs";',
  "const [file, pidFile] = process.argv.slice(2);",
  "writeFileSync(pidFile, String(process.pid));",
  'setInterval(() => appendFileSync(file, Date.now() + "\\n"), 20);',
].join("\n"));
void runProcess({ command: process.execPath, args: [resolve("tool.ts"), heartbeat, pidFile], cwd: resolve("data/workspace"), timeoutMs: 120_000 })
  .catch(() => {});

const beats = () => existsSync(heartbeat) ? readFileSync(heartbeat, "utf8").split("\n").filter(Boolean).length : 0;
await until(() => prompts.some((text) => text.includes("block")) && waiting.has("projection")
  && existsSync(pidFile) && beats() >= 2, () => ({ prompts, waiting: [...waiting], tool: existsSync(pidFile), beats: beats() }));
console.log("SERVICE_READY=" + JSON.stringify({ tool: Number(readFileSync(pidFile, "utf8")), heartbeat }));
