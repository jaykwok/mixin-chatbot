import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openSettings, resolveModelSelection } from "../../src/core/model-config.ts";
import { tempFixture } from "../helpers/temp.ts";

/** 用 Pi 真实的加载器建运行时，但凭证和目录缓存留在内存里，不碰仓库的 data/。 */
async function runtimeFor(modelsJson: unknown | undefined, root: string): Promise<ModelRuntime> {
  let modelsPath: string | null = null;
  if (modelsJson !== undefined) {
    modelsPath = join(root, "models.json");
    await writeFile(modelsPath, JSON.stringify(modelsJson));
  }
  return ModelRuntime.create({
    modelsPath, credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
  });
}

async function settingsAt(root: string, contents: string | undefined): Promise<string> {
  const path = join(root, "pi", "settings.json");
  if (contents !== undefined) {
    await mkdir(join(root, "pi"), { recursive: true });
    await writeFile(path, contents);
  }
  return path;
}

describe("Pi 原生设置视图", () => {
  test("真实 SDK 资源重载和设置写入后仍保留固定运行策略", async () => {
    const files = await tempFixture("pi-settings-");
    try {
      const path = await settingsAt(files.root, JSON.stringify({
        defaultProvider: "openai", defaultModel: "gpt-5.2", defaultThinkingLevel: "low",
        retry: { enabled: false, maxRetries: 99, provider: { timeoutMs: 1 } },
        compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 2048 },
        enableAnalytics: true, enableInstallTelemetry: true, enableSkillCommands: true,
      }));
      const settings = openSettings(path);
      expect(settings.getDefaultProvider()).toBe("openai");
      expect(settings.getDefaultModel()).toBe("gpt-5.2");
      expect(settings.getDefaultThinkingLevel()).toBe("low");
      const loader = new DefaultResourceLoader({
        cwd: files.root, agentDir: dirname(path), settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      });
      const checkPolicy = () => {
        expect(settings.getRetrySettings()).toEqual({ enabled: true, maxRetries: 1, baseDelayMs: 1000 });
        expect(settings.getProviderRetrySettings()).toEqual({ timeoutMs: 120000, maxRetries: 1, maxRetryDelayMs: 5000 });
        expect(settings.getCompactionSettings()).toEqual({ enabled: true, reserveTokens: 1024, keepRecentTokens: 2048 });
        expect(settings.getGlobalSettings()).toMatchObject({
          enableAnalytics: false, enableInstallTelemetry: false, enableSkillCommands: false,
        });
        expect(settings.isProjectTrusted()).toBe(false);
      };
      checkPolicy();
      await loader.reload();
      checkPolicy();
      settings.setDefaultThinkingLevel("high");
      await settings.flush();
      checkPolicy();
      await Promise.all([loader.reload(), settings.reload()]);
      checkPolicy();
      expect(JSON.parse(await Bun.file(path).text()).retry.maxRetries).toBe(99);
    } finally {
      await files.cleanup();
    }
  });

  test("文件缺失时是空设置，损坏时直接报错而不是退回默认模型", async () => {
    const files = await tempFixture("pi-settings-bad-");
    try {
      const missing = openSettings(join(files.root, "pi", "settings.json"));
      expect(missing.getDefaultModel()).toBeUndefined();
      const broken = await settingsAt(files.root, "{ not json");
      expect(() => openSettings(broken)).toThrow(/settings\.json/);
    } finally {
      await files.cleanup();
    }
  });

  test("只读视图不写文件，也不在配置目录里留锁文件", async () => {
    const files = await tempFixture("pi-settings-ro-");
    try {
      const path = await settingsAt(files.root, JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.2" }));
      const settings = openSettings(path);
      settings.setDefaultThinkingLevel("high");
      await settings.flush();
      expect(await Bun.file(path).text()).toBe(JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.2" }));
      expect(await Bun.file(`${path}.lock`).exists()).toBe(false);
    } finally {
      await files.cleanup();
    }
  });

  test("群工作区里的 .pi/settings.json 不参与解析", async () => {
    const files = await tempFixture("pi-settings-project-");
    try {
      // 项目作用域的路径由 cwd 决定，而 cwd 是群成员能传文件的共享工作区。
      await mkdir(join(files.root, ".pi"), { recursive: true });
      await writeFile(join(files.root, ".pi", "settings.json"), JSON.stringify({ defaultModel: "attacker-model" }));
      const path = await settingsAt(files.root, JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.2" }));
      expect(openSettings(path).getDefaultModel()).toBe("gpt-5.2");
    } finally {
      await files.cleanup();
    }
  });
});

describe("解析本实例固定使用的模型", () => {
  test("内置服务商只需凭证；地址、协议和资料都来自 Pi 随包目录", async () => {
    const files = await tempFixture("pi-selection-builtin-");
    try {
      const runtime = await runtimeFor({ providers: { "zai-coding-cn": { apiKey: "test-only" } } }, files.root);
      const path = await settingsAt(files.root, JSON.stringify({
        defaultProvider: "zai-coding-cn", defaultModel: "glm-5.3-flash", defaultThinkingLevel: "low",
      }));
      const { model, thinkingLevel } = await resolveModelSelection(runtime, openSettings(path));
      expect(model.provider).toBe("zai-coding-cn");
      expect(model.baseUrl).toContain("bigmodel.cn");
      expect(thinkingLevel).toBe("low");
    } finally {
      await files.cleanup();
    }
  });

  test("thinkingLevel 按模型能力收敛，缺省跟随 Pi 的 medium", async () => {
    const files = await tempFixture("pi-selection-thinking-");
    try {
      const runtime = await runtimeFor({ providers: { "test-gw": {
        api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "test-only",
        models: [{ id: "no-thinking", contextWindow: 8192, maxTokens: 512, reasoning: false }],
      } } }, files.root);
      // 不支持思考的模型，写多高都要被压回 off。
      const high = await settingsAt(files.root, JSON.stringify({
        defaultProvider: "test-gw", defaultModel: "no-thinking", defaultThinkingLevel: "high",
      }));
      expect((await resolveModelSelection(runtime, openSettings(high))).thinkingLevel).toBe("off");
      // 没写就跟 Pi 的缺省值，同样受模型能力约束。
      const none = await settingsAt(files.root, JSON.stringify({ defaultProvider: "test-gw", defaultModel: "no-thinking" }));
      expect((await resolveModelSelection(runtime, openSettings(none))).thinkingLevel).toBe("off");
    } finally {
      await files.cleanup();
    }
  });

  test("配置不全、模型不存在或凭证缺失都要报错，不换一个模型继续跑", async () => {
    const files = await tempFixture("pi-selection-bad-");
    try {
      const runtime = await runtimeFor(undefined, files.root);
      const empty = await settingsAt(files.root, "{}");
      expect(resolveModelSelection(runtime, openSettings(empty))).rejects.toThrow(/defaultProvider\/defaultModel/);

      const halfway = await settingsAt(files.root, JSON.stringify({ defaultProvider: "openai" }));
      expect(resolveModelSelection(runtime, openSettings(halfway))).rejects.toThrow(/defaultProvider\/defaultModel/);

      const unknown = await settingsAt(files.root, JSON.stringify({ defaultProvider: "openai", defaultModel: "nope" }));
      expect(resolveModelSelection(runtime, openSettings(unknown))).rejects.toThrow(/未提供 openai\/nope/);

      // 模型存在但没有任何凭证来源：内存凭证库是空的，环境变量也没配。
      const noCredential = await settingsAt(files.root, JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.2" }));
      expect(resolveModelSelection(runtime, openSettings(noCredential))).rejects.toThrow(/未配置可用凭证/);
    } finally {
      await files.cleanup();
    }
  });
});
