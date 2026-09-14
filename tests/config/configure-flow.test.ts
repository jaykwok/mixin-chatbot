import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { tempFixture } from "../helpers/temp.ts";

const CONFIGURE = fileURLToPath(new URL("../../scripts/config/configure.ts", import.meta.url));
const VALIDATE = fileURLToPath(new URL("../../scripts/config/validate-models.ts", import.meta.url));
const MODELS_JSON = join("data", "config", "models.json");
const PI_SETTINGS = join("data", "runtime", "pi", "settings.json");
const MODEL_CATALOG = join("data", "runtime", "models-store.json");

/**
 * 子进程只替换交互控件，实际运行 configure 入口并读回它落盘的完整配置。mock 限制在
 * 子进程，不污染同进程里的 SDK 或其他测试。PI_OFFLINE 关掉 Pi 的目录联网刷新。
 */
async function runConfigure(root: string, answers: Record<string, string | boolean>, faults: {
  cancelAt?: string; failPublishTarget?: string;
} = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const preload = join(root, `prompts-${Math.random().toString(36).slice(2)}.ts`);
  await writeFile(preload, `
    import { mock } from "bun:test";
    import * as maintenance from ${JSON.stringify(import.meta.resolve("../../src/core/maintenance.ts"))};
    const answers = ${JSON.stringify(answers)};
    const faults = ${JSON.stringify(faults)};
    const cancelled = Symbol("cancelled");
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
      for (const [key, value] of Object.entries(answers)) if (String(options.message).includes(key)) return value;
      return undefined;
    };
    const fallback = (options) => options.initialValue ?? options.defaultValue;
    const noop = () => {};
    mock.module(${JSON.stringify(import.meta.resolve("@clack/prompts"))}, () => ({
      cancel: noop, intro: noop, note: noop, outro: noop, isCancel: (value) => value === cancelled,
      log: { info: noop, success: noop, warn: (message) => console.log("WARN " + message) },
      password: async () => "test-only-key",
      select: async (options) => pick(options) ?? fallback(options),
      confirm: async (options) => pick(options) ?? fallback(options),
      text: async (options) => pick(options) ?? fallback(options),
    }));
  `);
  const proc = Bun.spawn([process.execPath, "--preload", preload, CONFIGURE], {
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
    };
    await writeFile(join(files.root, MODELS_JSON), JSON.stringify({ providers: {
      "private-gw": { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "original", models: [model] },
    } }));
    const result = await runConfigure(files.root, { "模型接入方式": "custom" });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
    const saved = JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8"));
    expect(saved.providers["private-gw"].models).toEqual([model]);
    expect((await runValidate(files.root)).code).toBe(0);
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

test("重新配置保留手工写的官方字段，只替换向导问过的部分", async () => {
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

    expect(JSON.parse(await readFile(join(files.root, MODELS_JSON), "utf8"))).toEqual({
      providers: {
        "zai-coding-cn": {
          headers: { "X-Tenant": "acme" },
          compat: { supportsMaxOutputTokens: false },
          authHeader: true,
          modelOverrides: { "glm-5.3-flash": { contextWindow: 4096 } },
          apiKey: "test-only-key",
        },
      },
    });
  } finally {
    await files.cleanup();
  }
}, 30000);
