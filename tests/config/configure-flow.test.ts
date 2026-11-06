import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { tempFixture } from "../helpers/temp.ts";
import { CURRENT_APPLICATION } from "../helpers/current-config.ts";
import { installConfigurationStage, parseConfigurationStage } from "../../ops/config/configuration-stage.ts";

const CONFIGURE = fileURLToPath(new URL("../../ops/config/configure.ts", import.meta.url));
const VALIDATE = fileURLToPath(new URL("../../ops/config/validate-models.ts", import.meta.url));
const MODELS_JSON = join("data", "config", "models.json");
const PI_SETTINGS = join("data", "runtime", "pi", "settings.json");
const MODEL_CATALOG = join("data", "runtime", "models-store.json");
const APP_BOT = join("data", "config", "app-bot.json");

/**
 * 子进程只替换交互控件，实际运行 configure 入口并读回它落盘的完整配置。mock 限制在
 * 子进程，不污染同进程里的 SDK 或其他测试。PI_OFFLINE 关掉 Pi 的目录联网刷新。
 * 应用机器人凭据只在缺少时询问；除 askAppBot 外预先放好，取 token 的平台请求由 mock 应答，不联网。
 */
async function runConfigure(root: string, answers: Record<string, string | boolean | string[]>, faults: {
  cancelAt?: string; failPublishTarget?: string; askAppBot?: boolean;
  /** Another wizard entry (configure-app-bot.ts), and the arguments it is run with. */
  script?: string; args?: string[];
} = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!faults.askAppBot && !existsSync(join(root, APP_BOT))) {
    await mkdir(join(root, "data", "config"), { recursive: true });
    await writeFile(join(root, APP_BOT), JSON.stringify({ environment: "production", appId: "test-app", appSecret: "test-only-secret" }));
  }
  const preload = join(root, `prompts-${Math.random().toString(36).slice(2)}.ts`);
  await writeFile(preload, `
    import { mock } from "bun:test";
    import * as maintenance from ${JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts"))};
    import * as client from ${JSON.stringify(import.meta.resolve("../../src/integrations/open-platform/client.ts"))};
    const answers = ${JSON.stringify(answers)};
    const faults = ${JSON.stringify(faults)};
    const cancelled = Symbol("cancelled");
    mock.module(${JSON.stringify(import.meta.resolve("../../src/integrations/open-platform/client.ts"))}, () => ({ ...client,
      PlatformClient: class { appToken = { get: async () => "fixture-token" }; close() {} },
    }));
    if (faults.failPublishTarget) {
      const replace = maintenance.replaceFile;
      let failed = false;
      mock.module(${JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts"))}, () => ({ ...maintenance,
        replaceFile: async (source, target) => {
          if (!failed && target === faults.failPublishTarget) {
            failed = true;
            throw new Error("injected publish failure");
          }
          return replace(source, target);
        },
      }));
    }
    // 按 message 子串匹配，测试里不用重复向导的完整提示文案。
    const pick = (options) => {
      if (options.message === faults.cancelAt) return cancelled;
      // An array answers the same prompt several times, in order.
      for (const [key, value] of Object.entries(answers)) if (String(options.message).includes(key)) return Array.isArray(value) ? value.shift() : value;
      return undefined;
    };
    const fallback = (options) => options.initialValue ?? options.defaultValue;
    const noop = () => {};
    mock.module(${JSON.stringify(import.meta.resolve("@clack/prompts"))}, () => ({
      cancel: noop, intro: noop, note: noop, outro: noop, isCancel: (value) => value === cancelled,
      log: { info: noop, step: noop, success: noop, warn: (message) => console.log("WARN " + message), error: (message) => console.log("ERROR " + message) },
      // answers.AppSecret (an array) answers the AppSecret prompts in order; otherwise a fixed secret.
      password: async (options) => !String(options.message).startsWith("AppSecret") ? "test-only-key"
        : Array.isArray(answers.AppSecret) ? answers.AppSecret.shift() : "fixture-app-secret",
      select: async (options) => pick(options) ?? fallback(options),
      confirm: async (options) => pick(options) ?? fallback(options),
      text: async (options) => pick(options) ?? fallback(options),
    }));
  `);
  const proc = Bun.spawn([process.execPath, "--preload", preload, faults.script ?? CONFIGURE, ...faults.args ?? []], {
    cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0", PI_OFFLINE: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** 部署和 doctor 用的同一条离线校验，确认向导写出的配置真能解析出模型。 */
async function runValidate(root: string, denyLocks = false): Promise<{ stdout: string; code: number }> {
  const args = [process.execPath];
  if (denyLocks) {
    const preload = join(root, "read-only-audit.ts");
    await writeFile(preload, `
      import { mock } from "bun:test";
      import lockfile from ${JSON.stringify(import.meta.resolve("proper-lockfile"))};
      const deny = () => { throw Object.assign(new Error("EROFS: audit mount is read-only"), { code: "EROFS" }); };
      const readonly = { ...lockfile, lock: deny, lockSync: deny };
      mock.module(${JSON.stringify(import.meta.resolve("proper-lockfile"))}, () => ({ ...readonly, default: readonly }));
    `);
    args.push("--preload", preload);
  }
  const proc = Bun.spawn([...args, VALIDATE], {
    cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0", PI_OFFLINE: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout: stdout + stderr, code };
}

test("内置方式只写凭证，模型资料全部来自 Pi 随包目录", async () => {
  const files = await tempFixture("pi-configure-builtin-");
  try {
    const source = getBuiltinModels("zai-coding-cn").find((model) => model.id === "glm-5.3-flash")!;
    expect(source).toBeDefined();
    const result = await runConfigure(files.root, {
      "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash",
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });

    // models.json 只有凭证：地址、协议和模型定义一个都不复制，升级 Pi 即随之更新。
    expect(JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8"))).toEqual({
      providers: { "zai-coding-cn": { apiKey: "test-only-key" } },
    });
    // 选型落在 Pi 原生 settings.json，不再是自定义的顶层字段。
    expect(JSON.parse(await readFile(join(files.root, PI_SETTINGS), "utf8"))).toMatchObject({
      defaultProvider: "zai-coding-cn", defaultModel: "glm-5.3-flash",
    });

    const validated = await runValidate(files.root);
    expect(validated.code).toBe(0);
    expect(validated.stdout).toContain(`zai-coding-cn/glm-5.3-flash (api=${source.api}`);
  } finally {
    await files.cleanup();
  }
}, 30000);

test("缺少应用机器人凭据时先填写 AppID/AppSecret，再配置模型；凭据不出现在输出里", async () => {
  const files = await tempFixture("pi-configure-app-bot-");
  try {
    const result = await runConfigure(files.root, {
      "AppID": "fixture-app", "平台环境": "staging",
      "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash",
    }, { askAppBot: true });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(await readFile(join(files.root, APP_BOT), "utf8"))).toEqual({
      environment: "staging", appId: "fixture-app", appSecret: "fixture-app-secret",
    });
    expect(result.stdout).not.toContain("fixture-app-secret");
    expect(JSON.parse(await readFile(join(files.root, PI_SETTINGS), "utf8"))).toMatchObject({ defaultModel: "glm-5.3-flash" });
  } finally {
    await files.cleanup();
  }
}, 30000);

test("已部署的目录只接受原应用：另一个 AppID 被拒绝并重新填写，部署记录不变", async () => {
  const files = await tempFixture("pi-configure-app-bot-bound-");
  try {
    const record = JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "", transaction: "deploy-bound", application: CURRENT_APPLICATION });
    await mkdir(join(files.root, "data", "state"), { recursive: true });
    await writeFile(join(files.root, "data", "state", "data-version.json"), record);
    const result = await runConfigure(files.root, {
      "AppID": ["another-app", "test-app"], "平台环境": "production",
      "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash",
    }, { askAppBot: true });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout).toContain("ERROR 这个目录的数据登记在另一个应用或平台环境下");
    expect(JSON.parse(await readFile(join(files.root, APP_BOT), "utf8"))).toMatchObject({ environment: "production", appId: "test-app" });
    expect(await readFile(join(files.root, "data", "state", "data-version.json"), "utf8")).toBe(record);
  } finally {
    await files.cleanup();
  }
}, 30000);

async function existingConfiguration(root: string): Promise<Map<string, string>> {
  const originals = new Map([
    [MODELS_JSON, JSON.stringify({ providers: { openai: { apiKey: "original-fixture-key" } } })],
    [PI_SETTINGS, JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.2", defaultThinkingLevel: "low" })],
    [MODEL_CATALOG, JSON.stringify({ "unused-fixture-provider": { models: [], checkedAt: 123 } })],
  ]);
  await mkdir(join(root, "data/config"), { recursive: true });
  await mkdir(join(root, "data/runtime/pi"), { recursive: true });
  for (const [path, contents] of originals) await writeFile(join(root, path), contents);
  return originals;
}

test.each(["模型", "thinkingLevel"])("在 %s 步骤取消时保留整套配置与缓存", async (cancelAt) => {
  const files = await tempFixture("pi-configure-cancel-");
  try {
    const originals = await existingConfiguration(files.root);
    const result = await runConfigure(files.root, {
      "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash",
    }, { cancelAt });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    for (const [path, contents] of originals) expect(await readFile(join(files.root, path), "utf8")).toBe(contents);
    // The draft holds copies of the credentials: it is deleted, never archived.
    expect(existsSync(join(files.root, "backup"))).toBe(false);
    expect((await readdir(join(files.root, "data/runtime/pi"))).filter(name => name.startsWith(".configure-"))).toEqual([]);
    expect((await runValidate(files.root)).code).toBe(0);
  } finally { await files.cleanup(); }
}, 30000);

test.each([true, false])("提交中途失败后恢复原文件或原本不存在的状态（已有配置=%s）", async (existing) => {
  const files = await tempFixture("pi-configure-rollback-");
  try {
    const originals = existing ? await existingConfiguration(files.root) : new Map<string, string>();
    const result = await runConfigure(files.root, {
      "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash",
    }, { failPublishTarget: MODEL_CATALOG });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("injected publish failure");
    for (const path of [MODELS_JSON, PI_SETTINGS, MODEL_CATALOG]) {
      const file = Bun.file(join(files.root, path));
      if (existing) expect(await file.text()).toBe(originals.get(path)!);
      else expect(await file.exists()).toBe(false);
    }
    if (existing) expect((await runValidate(files.root)).code).toBe(0);
    // The restore finished: the draft and the staged and recovery copies hold credentials and are deleted, not archived.
    expect(existsSync(join(files.root, "backup"))).toBe(false);
    for (const directory of ["data/config", "data/runtime", "data/runtime/pi"]) {
      expect((await readdir(join(files.root, directory))).filter(name => name.startsWith(".configure-"))).toEqual([]);
    }
  } finally { await files.cleanup(); }
}, 30000);

test("重跑自定义配置保留模型级 headers、推理映射、采样参数和名称", async () => {
  const files = await tempFixture("pi-configure-model-fields-");
  try {
    await mkdir(join(files.root, "data/config"), { recursive: true });
    const model = {
      id: "house-model", name: "Private model", reasoning: true, input: ["text"],
      contextWindow: 8192, maxTokens: 512,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      headers: { "X-Model-Tenant": "fixture-tenant" },
      thinkingLevelMap: { low: "low", high: "high" },
      samplingParams: { temperature: 0.5 }, compat: { supportsStore: false },
      inputLimits: { images: { resize: { maxWidth: 1280, maxHeight: 1280, maxBytes: 2000000, jpegQuality: 80 } } },
      promptCache: { short: 300, long: 1800 },
    };
    await writeFile(join(files.root, MODELS_JSON), JSON.stringify({ providers: {
      "private-gw": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "original", models: [model] },
    } }));
    const result = await runConfigure(files.root, { "模型接入方式": "custom" });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const saved = JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8"));
    expect(saved.providers["private-gw"].models).toEqual([model]);
    // The previous configuration's copies hold its credentials: a commit deletes them.
    expect(existsSync(join(files.root, "backup"))).toBe(false);
    expect((await runValidate(files.root)).code).toBe(0);
  } finally { await files.cleanup(); }
}, 30000);

test("重跑自定义配置：其他服务商原样保留；同一端点整条保留（服务商级字段、其他模型），换端点不带原生字段", async () => {
  const files = await tempFixture("pi-configure-providers-");
  try {
    await mkdir(join(files.root, "data/config"), { recursive: true });
    const model = { id: "house-model", name: "Private model", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 512,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    const other = { ...model, id: "house-other", name: "Other model" };
    const gateway = { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "original", headers: { "X-Tenant": "fixture-tenant" },
      authHeader: true, modelOverrides: { "house-other": { contextWindow: 4096 } }, models: [model, other] };
    // For example the provider an auxiliary.json classifier refers to.
    const auxiliary = { apiKey: "auxiliary-fixture-key" };
    await writeFile(join(files.root, MODELS_JSON), JSON.stringify({ providers: { "private-gw": gateway, openai: auxiliary } }));
    const saved = async () => JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8")).providers;
    let result = await runConfigure(files.root, { "模型接入方式": "custom" });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(await saved()).toEqual({ "private-gw": { ...gateway, apiKey: "test-only-key" }, openai: auxiliary });
    expect((await runValidate(files.root)).code).toBe(0);

    result = await runConfigure(files.root, { "模型接入方式": "custom", "baseUrl": "http://127.0.0.1:2/v1", "模型 id": "house-model",
      "contextWindow": "65536", "maxTokens": "8192", "输入价格": "0.5", "输出价格": "1.5" });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout).toContain("不带到新端点");
    expect(await saved()).toEqual({ openai: auxiliary, "private-gw": { api: "openai-completions", baseUrl: "http://127.0.0.1:2/v1", apiKey: "test-only-key",
      models: [{ id: "house-model", name: "house-model", contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoning: false,
        cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 } }] } });
  } finally { await files.cleanup(); }
}, 30000);

test("向导的推理级别替换所选模型的覆盖，保留其他模型的覆盖", async () => {
  const files = await tempFixture("pi-configure-thinking-");
  try {
    await existingConfiguration(files.root);
    await writeFile(join(files.root, PI_SETTINGS), JSON.stringify({
      defaultProvider: "zai-coding-cn", defaultModel: "glm-5.3-flash", defaultThinkingLevel: "high",
      modelThinkingLevels: { "zai-coding-cn/glm-5.3-flash": "high", "openai/gpt-5.2": "high" },
    }));
    const result = await runConfigure(files.root, {
      "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash", "thinkingLevel": "low",
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const saved = JSON.parse(await readFile(join(files.root, PI_SETTINGS), "utf8"));
    expect(saved.defaultThinkingLevel).toBe("low");
    expect(saved.modelThinkingLevels).toEqual({ "openai/gpt-5.2": "high" });
    const checked = await runValidate(files.root);
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("thinkingLevel=low");
  } finally { await files.cleanup(); }
}, 30000);

test("向导保存后两个配置文件的 $schema 和本项目运行策略原样保留，只读校验通过", async () => {
  const files = await tempFixture("pi-configure-schema-");
  try {
    await existingConfiguration(files.root);
    const MODELS_SCHEMA = "https://pi.dev/schemas/models.schema.json", SETTINGS_SCHEMA = "./settings.schema.json";
    await writeFile(join(files.root, MODELS_JSON), JSON.stringify({ $schema: MODELS_SCHEMA, providers: { openai: { apiKey: "original-fixture-key" } } }));
    const durable = { retry: { maxRetries: 2 }, progress: { outputIntervalMs: 50 } };
    await writeFile(join(files.root, PI_SETTINGS), JSON.stringify({
      $schema: SETTINGS_SCHEMA, format: 1, defaultProvider: "openai", defaultModel: "gpt-5.2", defaultThinkingLevel: "low", durable,
    }));
    const result = await runConfigure(files.root, {
      "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash", "thinkingLevel": "high",
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const settings = JSON.parse(await readFile(join(files.root, PI_SETTINGS), "utf8"));
    expect(settings).toMatchObject({ $schema: SETTINGS_SCHEMA, format: 1, defaultProvider: "zai-coding-cn", defaultModel: "glm-5.3-flash", defaultThinkingLevel: "high", durable });
    expect(JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8")).$schema).toBe(MODELS_SCHEMA);
    expect((await runValidate(files.root)).code).toBe(0);
  } finally { await files.cleanup(); }
}, 30000);

test("只读校验从缓存恢复动态目录，不创建锁或读取磁盘 auth.json", async () => {
  const files = await tempFixture("pi-configure-readonly-");
  try {
    await existingConfiguration(files.root);
    const source = getBuiltinModels("openai").find((model) => model.id === "gpt-5.2")!;
    const cached = { ...source, provider: "radius", id: "cached-only-model" };
    await writeFile(join(files.root, MODELS_JSON), JSON.stringify({ providers: { radius: { apiKey: "fixture-only" } } }));
    await writeFile(join(files.root, PI_SETTINGS), JSON.stringify({ defaultProvider: "radius", defaultModel: cached.id }));
    const cache = JSON.stringify({ radius: { models: [cached], checkedAt: 123 } });
    await writeFile(join(files.root, MODEL_CATALOG), cache);
    const authPath = join(files.root, "data/runtime/pi/auth.json");
    await writeFile(authPath, "not JSON: this credential store must never be read");
    const before = (await readdir(join(files.root, "data"), { recursive: true })).sort();
    const result = await runValidate(files.root, true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("radius/cached-only-model");
    expect((await readdir(join(files.root, "data"), { recursive: true })).sort()).toEqual(before);
    expect(await readFile(join(files.root, MODEL_CATALOG), "utf8")).toBe(cache);
    expect(await readFile(authPath, "utf8")).toBe("not JSON: this credential store must never be read");
  } finally { await files.cleanup(); }
}, 30000);

test("自定义方式按端点返回的清单选模型，并用 Pi 目录预填同名模型的资料", async () => {
  const files = await tempFixture("pi-configure-custom-");
  const source = getBuiltinModels("openai").find((model) => model.id === "gpt-5.2")!;
  expect(source).toBeDefined();
  let listed = 0;
  const endpoint = Bun.serve({
    port: 0,
    fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/models")) return new Response("no", { status: 404 });
      listed += 1;
      return Response.json({ data: [{ id: "gpt-5.2" }, { id: "house-only" }] });
    },
  });
  try {
    const baseUrl = `${endpoint.url.origin}/v1`;
    const result = await runConfigure(files.root, {
      "模型接入方式": "custom", "provider id": "my-gateway",
      "服务协议": "openai-responses", "baseUrl": baseUrl,
      "模型（来自端点返回的清单）": "gpt-5.2",
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(listed).toBe(1);

    const entry = JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8")).providers["my-gateway"];
    expect(entry).toMatchObject({ api: "openai-responses", baseUrl, apiKey: "test-only-key" });
    // 预填来自 Pi 目录里同名模型的资料；传输设置不跟着过来。
    expect(entry.models).toEqual([{
      id: "gpt-5.2", name: "gpt-5.2",
      contextWindow: source.contextWindow, maxTokens: source.maxTokens,
      input: source.input, reasoning: source.reasoning, cost: source.cost,
    }]);
    expect(entry).not.toHaveProperty("compat");

    const validated = await runValidate(files.root);
    expect(validated.code).toBe(0);
    expect(validated.stdout).toContain("my-gateway/gpt-5.2 (api=openai-responses");
  } finally {
    await endpoint.stop(true);
    await files.cleanup();
  }
}, 30000);

test("端点列不出清单时退回手填 id；Pi 不认识的模型要自己填资料", async () => {
  const files = await tempFixture("pi-configure-manual-");
  try {
    const result = await runConfigure(files.root, {
      "模型接入方式": "custom", "provider id": "offline-gw",
      "服务协议": "openai-completions", "baseUrl": "http://127.0.0.1:1/v1",
      "模型 id": "house-only-model", "contextWindow": "65536", "maxTokens": "8192",
      "输入价格": "0.5", "输出价格": "1.5",
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout).toContain("未能从端点获取模型清单");
    expect(result.stdout).toContain("Pi 目录里没有这个 id");

    const entry = JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8")).providers["offline-gw"];
    expect(entry.models).toEqual([{
      id: "house-only-model", name: "house-only-model",
      contextWindow: 65536, maxTokens: 8192, input: ["text"], reasoning: false,
      cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
    }]);
    expect((await runValidate(files.root)).code).toBe(0);
  } finally {
    await files.cleanup();
  }
}, 30000);

test("重新配置内置服务商清除过时 overrides，使用当前官方元数据", async () => {
  const files = await tempFixture("pi-configure-preserve-");
  try {
    await mkdir(join(files.root, "data", "config"), { recursive: true });
    await writeFile(join(files.root, MODELS_JSON), JSON.stringify({
      providers: {
        "zai-coding-cn": {
          apiKey: "stale-key",
          headers: { "X-Tenant": "acme" },
          compat: { supportsMaxOutputTokens: false },
          authHeader: true,
          modelOverrides: { "glm-5.3-flash": { contextWindow: 4096 } },
        },
      },
    }));
    const result = await runConfigure(files.root, {
      "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash",
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });

    expect(JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8"))).toEqual({ providers: { "zai-coding-cn": { apiKey: "test-only-key" } } });
  } finally {
    await files.cleanup();
  }
}, 30000);

const CONFIGURE_APP_BOT = fileURLToPath(new URL("../../ops/config/configure-app-bot.ts", import.meta.url));
const BUILTIN = { "模型接入方式": "builtin", "内置服务商": "zai-coding-cn", "模型": "glm-5.3-flash" };

test("部署停机前的模型向导只写暂存：项目文件不变，不取维护租约；基准是现有文件和登记的应用，暂存装上后通过只读校验", async () => {
  const files = await tempFixture("pi-configure-stage-");
  try {
    const originals = await existingConfiguration(files.root), stage = join(files.root, "stage");
    const record = JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "", transaction: "deploy-bound", application: CURRENT_APPLICATION });
    await mkdir(join(files.root, "data", "state"), { recursive: true }); await mkdir(stage);
    await writeFile(join(files.root, "data", "state", "data-version.json"), record);
    const result = await runConfigure(files.root, BUILTIN, { args: ["--stage", stage] });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    for (const [path, contents] of originals) expect(await readFile(join(files.root, path), "utf8")).toBe(contents);
    // No service lease (it lives in data/state) and no draft left behind.
    expect(await readdir(join(files.root, "data", "state"))).toEqual(["data-version.json"]);
    expect(await readdir(stage)).toEqual(["configuration-models.json"]);
    const staged = parseConfigurationStage(await readFile(join(stage, "configuration-models.json"), "utf8"), "models");
    expect(staged.base).toEqual({ kind: "models", binding: CURRENT_APPLICATION, files: { models: originals.get(MODELS_JSON), settings: originals.get(PI_SETTINGS),
      catalog: originals.get(MODEL_CATALOG) } });
    // The existing provider stays; the chosen built-in one gets only its key.
    expect(JSON.parse(staged.next.files.models!)).toEqual({ providers: { openai: { apiKey: "original-fixture-key" }, "zai-coding-cn": { apiKey: "test-only-key" } } });
    expect(JSON.parse(staged.next.files.settings!)).toMatchObject({ defaultProvider: "zai-coding-cn", defaultModel: "glm-5.3-flash" });
    expect(await installConfigurationStage(files.root, staged)).toBe(true);
    const validated = await runValidate(files.root);
    expect(validated.code).toBe(0); expect(validated.stdout).toContain("zai-coding-cn/glm-5.3-flash");
  } finally { await files.cleanup(); }
}, 30000);

test("应用机器人向导：AppID 或平台环境变了时留空的 AppSecret 被拒绝，不沿用旧值；都不变时留空沿用", async () => {
  const files = await tempFixture("pi-configure-app-secret-");
  try {
    await mkdir(join(files.root, "data", "config"), { recursive: true });
    const existing = JSON.stringify({ environment: "production", appId: "test-app", appSecret: "saved-only-secret" });
    await writeFile(join(files.root, APP_BOT), existing);
    const stage = join(files.root, "stage"); await mkdir(stage);
    const read = async () => JSON.parse(parseConfigurationStage(await readFile(join(stage, "configuration-app.json"), "utf8"), "app").next.files.app!);
    // Blank for staging (refused), then a typed secret for staging.
    let result = await runConfigure(files.root, { "AppID": ["test-app", "test-app"], "平台环境": "staging", "AppSecret": ["", "staging-secret"] },
      { script: CONFIGURE_APP_BOT, args: ["--stage", stage] });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout).toContain("ERROR 换了 AppID 或平台环境，请填写这组凭据的 AppSecret");
    expect(await read()).toEqual({ environment: "staging", appId: "test-app", appSecret: "staging-secret" });
    // Same application and environment: blank keeps the saved secret.
    await rm(join(stage, "configuration-app.json"));
    result = await runConfigure(files.root, { "AppID": "test-app", "平台环境": "production", "AppSecret": [""] }, { script: CONFIGURE_APP_BOT, args: ["--stage", stage] });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout).not.toContain("ERROR");
    expect(await read()).toEqual({ environment: "production", appId: "test-app", appSecret: "saved-only-secret" });
  } finally { await files.cleanup(); }
}, 30000);

test("首次部署停机前先暂存应用机器人凭据、再暂存模型配置：项目里不写任何文件，凭据不出现在输出里", async () => {
  const files = await tempFixture("pi-configure-stage-first-");
  try {
    const stage = join(files.root, "stage"); await mkdir(stage);
    const result = await runConfigure(files.root, { "AppID": "fixture-app", "平台环境": "staging", ...BUILTIN }, { askAppBot: true, args: ["--stage", stage] });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout).not.toContain("fixture-app-secret");
    expect(existsSync(join(files.root, "data"))).toBe(false);
    expect((await readdir(stage)).sort()).toEqual(["configuration-app.json", "configuration-models.json"]);
    const app = parseConfigurationStage(await readFile(join(stage, "configuration-app.json"), "utf8"), "app");
    expect(app).toEqual({ version: 1, base: { kind: "app", binding: null, files: { app: null } }, next: { kind: "app", binding: null,
      files: { app: JSON.stringify({ environment: "staging", appId: "fixture-app", appSecret: "fixture-app-secret" }, null, 2) + "\n" } } });
    const models = parseConfigurationStage(await readFile(join(stage, "configuration-models.json"), "utf8"), "models");
    expect(models.base.files).toEqual({ models: null, settings: null, catalog: null });
  } finally { await files.cleanup(); }
}, 30000);

test("单独暂存应用机器人凭据：已部署的目录只接受原应用，基准是现有文件，项目文件不变", async () => {
  const files = await tempFixture("pi-configure-stage-app-");
  try {
    const record = JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "", transaction: "deploy-bound", application: CURRENT_APPLICATION });
    await mkdir(join(files.root, "data", "state"), { recursive: true });
    await writeFile(join(files.root, "data", "state", "data-version.json"), record);
    await mkdir(join(files.root, "data", "config"), { recursive: true });
    const existing = JSON.stringify({ environment: "production", appId: "test-app", appSecret: "test-only-secret" });
    await writeFile(join(files.root, APP_BOT), existing);
    const stage = join(files.root, "stage"); await mkdir(stage);
    const result = await runConfigure(files.root, { "AppID": ["another-app", "test-app"], "平台环境": "production" },
      { script: CONFIGURE_APP_BOT, args: ["--stage", stage] });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    expect(result.stdout).toContain("ERROR 这个目录的数据登记在另一个应用或平台环境下");
    expect(await readFile(join(files.root, APP_BOT), "utf8")).toBe(existing);
    const staged = parseConfigurationStage(await readFile(join(stage, "configuration-app.json"), "utf8"), "app");
    expect(staged.base).toEqual({ kind: "app", binding: CURRENT_APPLICATION, files: { app: existing } });
    expect(JSON.parse(staged.next.files.app!)).toEqual({ environment: "production", appId: "test-app", appSecret: "fixture-app-secret" });
  } finally { await files.cleanup(); }
}, 30000);

test("向导的暂存参数严格；暂存时取消不留下暂存文件或草稿", async () => {
  const files = await tempFixture("pi-configure-stage-args-");
  try {
    const stage = join(files.root, "stage"); await mkdir(stage);
    for (const [script, args] of [[CONFIGURE, ["--stage"]], [CONFIGURE, ["--stage", stage, "extra"]], [CONFIGURE, ["--project", stage]],
      [CONFIGURE_APP_BOT, ["--stage"]], [CONFIGURE_APP_BOT, ["--bogus", stage]], [CONFIGURE_APP_BOT, ["--stage", stage, "--project", stage]]] as const) {
      const result = await runConfigure(files.root, BUILTIN, { script, args: [...args] });
      expect(result.code, args.join(" ")).toBe(1); expect(result.stderr).toContain("用法");
    }
    const cancelled = await runConfigure(files.root, BUILTIN, { cancelAt: "模型", args: ["--stage", stage] });
    expect(cancelled.code).toBe(0); expect(await readdir(stage)).toEqual([]);
  } finally { await files.cleanup(); }
}, 30000);
