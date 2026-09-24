// Contract tests use the installed SDK and its faux provider; no paid/network requests.
import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore, InMemoryModelsStore, Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { openSettings } from "../../src/core/model-config.ts";
import { cancelCacheWarming } from "../../src/agent/session-control.ts";
import { tempFixture } from "../helpers/temp.ts";

async function setup(extra: Record<string, unknown> = {}, promptCache = { short: 300, long: 1800 }) {
  const files = await tempFixture("pi-upgrade-");
  const cwd = join(files.root, "workspace"), agentDir = join(files.root, "pi"), history = join(files.root, "session.jsonl");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const settingsPath = join(agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ compaction: { reserveTokens: 1024, keepRecentTokens: 1 }, ...extra }));
  const runtime = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false });
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const model = faux.getModel();
  model.promptCache = promptCache;
  model.cost = { input: 100, output: 2, cacheRead: 1, cacheWrite: 100 };
  runtime.registerNativeProvider(faux.provider);
  const sessions: AgentSession[] = [];
  const create = async (instructions = "SYSTEM_V1", toolName = "lookup_v1") => {
    const settingsManager = openSettings(settingsPath);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPromptOverride: () => instructions, appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
      settingsManager, resourceLoader, thinkingLevel: "off", sessionManager: SessionManager.open(history, undefined, cwd),
      tools: [toolName], customTools: [{ name: toolName, label: toolName, description: "fixture lookup", parameters: Type.Object({}),
        async execute() { return { content: [{ type: "text", text: "found" }], details: { found: true } }; } }],
    });
    sessions.push(session);
    return session;
  };
  return { ...files, history, faux, model, create,
    cleanup: async () => { for (const session of sessions) await session.dispose(); await files.cleanup(); } };
}

test("0.85.1 history survives resume, native compaction and new system/tool declarations", async () => {
  const f = await setup();
  try {
    await copyFile(new URL("../fixtures/pi-0.85.1-session.jsonl", import.meta.url), f.history);
    let session = await f.create();
    const id = session.sessionManager.getSessionId();
    f.faux.setResponses([context => {
      expect(JSON.stringify(context.messages)).toContain("LEGACY_0851");
      expect(getCurrentSystemPrompt(context.messages)).toContain("SYSTEM_V1");
      expect(getCurrentTools(context.messages)?.map(t => t.name)).toEqual(["lookup_v1"]);
      return fauxAssistantMessage("continued");
    }]);
    await session.prompt("continue legacy");
    f.faux.setResponses([fauxAssistantMessage("SUMMARY_0851: keep LEGACY_0851"), fauxAssistantMessage("SUMMARY_0851: recent turn")]);
    await session.compact();
    const compaction = session.sessionManager.getEntries().find(e => e.type === "compaction");
    expect(compaction).toHaveProperty("systemMessage");
    await session.dispose();
    session = await f.create("SYSTEM_V2", "lookup_v2");
    expect(session.sessionManager.getSessionId()).toBe(id);
    f.faux.setResponses([context => {
      expect(JSON.stringify(context.messages)).toContain("SUMMARY_0851");
      expect(getCurrentSystemPrompt(context.messages)).toContain("SYSTEM_V2");
      expect(getCurrentTools(context.messages)?.map(t => t.name)).toEqual(["lookup_v2"]);
      return fauxAssistantMessage("resumed after compaction");
    }]);
    await session.prompt("check updated instructions");
    const raw = await readFile(f.history, "utf8");
    expect(raw).toContain('"version":3');
    expect(raw).toContain("LEGACY_0851");
    expect(raw).toContain("SYSTEM_V1");
    expect(raw).toContain("SYSTEM_V2");
  } finally { await f.cleanup(); }
});

test("retry omissions persist across restart while raw failure and usage remain", async () => {
  const f = await setup();
  try {
    let session = await f.create();
    f.faux.setResponses([
      fauxAssistantMessage("FAILED_ATTEMPT_CONTENT", { stopReason: "error", errorMessage: "503 service unavailable" }),
      context => {
        expect(JSON.stringify(context.messages)).not.toContain("FAILED_ATTEMPT_CONTENT");
        return fauxAssistantMessage("RECOVERED");
      },
    ]);
    await session.prompt("retry once");
    expect(f.faux.state.callCount).toBe(2);
    const entries = session.sessionManager.getEntries();
    expect(entries.some(e => e.type === "context_edit" && e.replacement === null)).toBe(true);
    expect(entries.some(e => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "error")).toBe(true);
    await session.dispose();
    session = await f.create();
    f.faux.setResponses([context => {
      expect(JSON.stringify(context.messages)).not.toContain("FAILED_ATTEMPT_CONTENT");
      expect(JSON.stringify(context.messages)).toContain("RECOVERED");
      return fauxAssistantMessage("restart confirmed");
    }]);
    await session.prompt("after restart");
    expect(await readFile(f.history, "utf8")).toContain("FAILED_ATTEMPT_CONTENT");
  } finally { await f.cleanup(); }
});

test("recoverable length stops are durably omitted before native recovery compaction", async () => {
  const f = await setup();
  try {
    let session = await f.create();
    f.faux.setResponses([fauxAssistantMessage("background history")]);
    await session.prompt("an earlier complete turn");
    f.faux.setResponses([
      fauxAssistantMessage("TRUNCATED_ATTEMPT", { stopReason: "length" }),
      fauxAssistantMessage("RECOVERY_SUMMARY"), fauxAssistantMessage("RECOVERY_RESULT"),
      fauxAssistantMessage("RECOVERY_RESULT"),
    ]);
    await session.prompt("retry this partial answer");
    const entries = session.sessionManager.getEntries();
    const failed = entries.find(e => e.type === "message" && e.message.role === "assistant" && e.message.stopReason === "length")!;
    expect(failed).toBeDefined();
    expect(entries.some(e => e.type === "context_edit" && e.targetId === failed.id && e.replacement === null)).toBe(true);
    expect(entries.some(e => e.type === "compaction")).toBe(true);
    await session.dispose();
    session = await f.create();
    f.faux.setResponses([context => {
      expect(JSON.stringify(context.messages)).not.toContain("TRUNCATED_ATTEMPT");
      return fauxAssistantMessage("restart after recovery");
    }]);
    await session.prompt("verify restart");
    expect(await readFile(f.history, "utf8")).toContain("TRUNCATED_ATTEMPT");
  } finally { await f.cleanup(); }
});

test.each(["short", "long"])("native %s retention drives warming TTL; abort and dispose cancel timers", async retention => {
  const previous = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = retention;
  const f = await setup({ cacheWarming: "idle" });
  try {
    const session = await f.create();
    const response = () => {
      const message = fauxAssistantMessage("warmable reply");
      message.usage.input = 10000;
      message.usage.totalTokens = 10000;
      return message;
    };
    f.faux.setResponses([response(), response()]);
    const before = Date.now();
    await session.prompt("first");
    expect(session.cacheWarmingStatus?.state).toBe("scheduled");
    const delay = session.cacheWarmingStatus!.nextWarmAt! - before;
    const expected = retention === "long" ? 1620000 : 270000;
    expect(delay).toBeGreaterThanOrEqual(expected);
    expect(delay).toBeLessThan(expected + 5000);
    cancelCacheWarming(session);
    await session.abort();
    expect(session.cacheWarmingStatus?.state).toBe("inactive");
    await session.prompt("second");
    expect(session.cacheWarmingStatus?.state).toBe("scheduled");
    await session.dispose();
    expect(session.cacheWarmingStatus?.state).toBe("inactive");
    expect(f.faux.state.callCount).toBe(2);
  } finally {
    if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = previous;
    await f.cleanup();
  }
});

test("native warm requests persist independent usage and stop after cancellation", async () => {
  const f = await setup({ cacheWarming: "idle" }, { short: 11, long: 11 }); // one-second refresh
  try {
    const session = await f.create();
    const paid = () => { const m = fauxAssistantMessage("fixture"); m.usage.input = 10000; m.usage.totalTokens = 10000; return m; };
    f.faux.setResponses([paid(), paid()]);
    // Faux computes actual usage from the context; make the native economics check pass.
    await session.prompt("start " + "known prompt ".repeat(2500));
    const deadline = Date.now() + 2500;
    while (!session.sessionManager.getEntries().some(e => e.type === "usage") && Date.now() < deadline) await Bun.sleep(20);
    const entry = session.sessionManager.getEntries().find(e => e.type === "usage");
    expect(entry, JSON.stringify(session.cacheWarmingStatus)).toMatchObject({ kind: "cache_warm", provider: f.model.provider, model: f.model.id });
    cancelCacheWarming(session);
    await session.abort();
    await Bun.sleep(1100);
    expect(f.faux.state.callCount).toBe(2);
  } finally { await f.cleanup(); }
}, 5000);

test("cancelling native retry backoff settles promptly without another model call", async () => {
  const f = await setup();
  try {
    const session = await f.create();
    const cancellations: Promise<void>[] = [];
    session.subscribe(event => {
      if (event.type !== "auto_retry_start") return;
      expect(event.delayMs).toBeLessThanOrEqual(5000);
      queueMicrotask(() => { cancelCacheWarming(session); cancellations.push(session.abort()); });
    });
    f.faux.setResponses([fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "503 service unavailable" })]);
    const start = Date.now();
    await session.prompt("cancel during backoff");
    await Promise.all(cancellations);
    expect(Date.now() - start).toBeLessThan(900);
    expect(f.faux.state.callCount).toBe(1);
    expect(session.isIdle).toBe(true);
  } finally { await f.cleanup(); }
});
