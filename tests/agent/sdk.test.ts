import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSystemPromptTrimExtension } from "../../src/agent/system-prompt-trim.ts";
import { tempFixture } from "../helpers/temp.ts";
import { responsesProvider } from "../../scripts/config/configure.ts";

describe("installed Pi SDK integration", () => {
  test.each(["openai", "test-gateway"])("configured %s has no conflicting provider compat", async (provider) => {
    const files = await tempFixture("pi-compat-");
    try {
      const modelsPath = join(files.root, "models.json");
      await writeFile(modelsPath, JSON.stringify({ providers: {
        [provider]: responsesProvider(provider, "http://127.0.0.1:1/v1", "test-only", {
          id: "gpt-5.2", contextWindow: 8192, maxTokens: 512, reasoning: false,
          compat: { supportsMaxOutputTokens: false },
        }, { supportsMaxOutputTokens: false }, true),
      } }));
      const runtime = await ModelRuntime.create({
        modelsPath, credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
      });
      const model = runtime.getModel(provider, "gpt-5.2")!;
      let captured: unknown;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "test", timestamp: 0 }] }, {
        maxTokens: 128,
        onPayload(body) { captured = body; throw new Error("request captured"); },
      });
      expect(result.errorMessage).toContain("request captured");
      expect(captured).toMatchObject({ max_output_tokens: 128 });
    } finally {
      await files.cleanup();
    }
  });

  test("creates, persists and resumes a session with the official fake provider", async () => {
    const files = await tempFixture("pi-sdk-");
    const cwd = join(files.root, "workspace");
    const agentDir = join(files.root, "pi");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    const faux = fauxProvider({ tokensPerSecond: 0 });
    runtime.registerNativeProvider(faux.provider);
    const history = join(files.root, "session.jsonl");
    const appended = "## 群聊岗位\n按群资料回答，交付文件放当前用户 tmp。";
    const create = async () => {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [createSystemPromptTrimExtension()],
        appendSystemPromptOverride: () => [appended],
      });
      await resourceLoader.reload();
      return (await createAgentSession({
        cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
        tools: [], settingsManager, resourceLoader,
        sessionManager: SessionManager.open(history, undefined, cwd),
      })).session;
    };
    let session: Awaited<ReturnType<typeof create>> | undefined;
    try {
      let prompt = "";
      faux.setResponses([(context) => { prompt = context.systemPrompt ?? ""; return fauxAssistantMessage("已记录"); }]);
      session = await create();
      const id = session.sessionManager.getSessionId();
      await session.prompt("记住项目编号 Q-85");
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
      expect(prompt).toContain(appended);
      expect(prompt).toContain("Guidelines:");
      expect(prompt).not.toContain("Pi documentation (read only when");
      expect(JSON.parse((await readFile(history, "utf8")).split("\n")[0]!)).toMatchObject({ cwd });
      await session.dispose();
      session = undefined;
      const lines = (await readFile(history, "utf8")).split("\n");
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), cwd: join(files.root, "old-host-workspace") });
      await writeFile(history, lines.join("\n"));
      session = await create();
      expect(session.sessionManager.getSessionId()).toBe(id);
      expect(session.sessionManager.getCwd()).toBe(cwd);
      faux.setResponses([(context) => {
        expect(JSON.stringify(context.messages)).toContain("Q-85");
        return fauxAssistantMessage("项目编号 Q-85");
      }]);
      await session.prompt("项目编号是什么？");
      expect(session.messages.at(-1)).toMatchObject({ content: [{ type: "text", text: "项目编号 Q-85" }] });
      expect(faux.state.callCount).toBe(2);
    } finally {
      try {
        await session?.dispose();
      } finally {
        await files.cleanup();
      }
    }
  });

  test.each([undefined, false, true])("Responses max_output_tokens respects compat=%s", async (supports) => {
    const files = await tempFixture("pi-sdk-");
    try {
      const modelsPath = join(files.root, "models.json");
      await writeFile(modelsPath, JSON.stringify({ providers: { "test-gateway": {
        api: "openai-responses", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only",
        compat: { supportsMaxOutputTokens: false },
        models: [{ id: "test-model", contextWindow: 8192, maxTokens: 512, reasoning: false,
          ...(supports === undefined ? {} : { compat: { supportsMaxOutputTokens: supports } }),
        }],
      } } }));
      const runtime = await ModelRuntime.create({
        modelsPath, credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
      });
      const model = runtime.getModel("test-gateway", "test-model")!;
      let payload: Record<string, unknown> | undefined;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, {
        maxTokens: 128,
        onPayload: (body) => {
          payload = body as Record<string, unknown>;
          // 截获真实适配器生成的请求，在发出网络请求前停止。
          throw new Error("request captured");
        },
      });
      expect(result.errorMessage).toContain("request captured");
      expect(payload).toBeDefined();
      if (supports === true) expect(payload!.max_output_tokens).toBe(128);
      else expect(payload).not.toHaveProperty("max_output_tokens");
      expect(model.maxTokens).toBe(512);
    } finally {
      await files.cleanup();
    }
  });
});
