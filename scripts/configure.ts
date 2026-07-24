#!/usr/bin/env bun
// AI 配置 TUI：交互生成 data/models.json（provider + key + model，Pi 原生读取）。
// 通常在容器内运行：
//   docker run --rm -it -v "$(pwd)/data:/app/data" mixin-chatbot bun run scripts/configure.ts
// 也可本地 bun run scripts/configure.ts。
import {
  cancel,
  confirm,
  intro,
  log,
  note,
  outro,
  password,
  select,
  text,
  isCancel,
} from "@clack/prompts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";

const MODELS_JSON_PATH = "data/models.json";
const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
// raw GitHub 对默认 fetch UA 指纹拦截，必须带浏览器 UA。
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 内置 provider 中面向国内的常用项（其余走「自定义」）。
const BUILTIN_WHITELIST = [
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "deepseek",
  "zai",
  "zai-coding-cn",
  "moonshotai",
  "moonshotai-cn",
  "kimi-coding",
];

// @clack/prompts 取消即退出。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bail<T>(v: T | any): T {
  if (isCancel(v)) {
    cancel("已取消");
    process.exit(0);
  }
  return v as T;
}

interface ExistingDoc {
  providers?: Record<string, Record<string, unknown>>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

async function loadExisting(): Promise<ExistingDoc> {
  try {
    return JSON.parse(await readFile(MODELS_JSON_PATH, "utf8")) as ExistingDoc;
  } catch {
    return {};
  }
}

interface LiteLLMEntry {
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  supports_vision?: boolean;
  mode?: string;
}

async function fetchLitellm(): Promise<Record<string, LiteLLMEntry> | null> {
  try {
    const r = await fetch(LITELLM_URL, { headers: { "User-Agent": CHROME_UA } });
    if (!r.ok) {
      log.warn(`LiteLLM 抓取返回 ${r.status}，将手动填写元数据`);
      return null;
    }
    return (await r.json()) as Record<string, LiteLLMEntry>;
  } catch (e) {
    log.warn(`LiteLLM 抓取失败（${String(e)}），将手动填写元数据`);
    return null;
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s._\-/]/g, "");

function matchLitellm(
  catalog: Record<string, LiteLLMEntry>,
  modelId: string
): [string, LiteLLMEntry] | null {
  const nid = norm(modelId);
  for (const k of Object.keys(catalog)) if (norm(k) === nid) return [k, catalog[k]];
  for (const k of Object.keys(catalog))
    if (norm(k).includes(nid) || nid.includes(norm(k))) return [k, catalog[k]];
  return null;
}

function entryToModel(modelId: string, e: LiteLLMEntry): AnyObj {
  return {
    id: modelId,
    name: modelId,
    contextWindow: e.max_input_tokens ?? e.max_tokens ?? 131072,
    maxTokens: e.max_output_tokens ?? e.max_tokens ?? 8192,
    input: e.supports_vision ? ["text", "image"] : ["text"],
    reasoning: false,
    cost: {
      input: e.input_cost_per_token ?? 0,
      output: e.output_cost_per_token ?? 0,
      cacheRead: e.cache_read_input_token_cost ?? 0,
      cacheWrite: e.cache_creation_input_token_cost ?? 0,
    },
  };
}

function defaultModel(modelId: string): AnyObj {
  return {
    id: modelId,
    name: modelId,
    contextWindow: 131072,
    maxTokens: 8192,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function main(): Promise<void> {
  intro("🤖 AI 配置（生成 data/models.json）");

  const existing = await loadExisting();
  const existingProviders = existing.providers ?? {};
  const firstId = Object.keys(existingProviders)[0];
  const firstEntry = firstId ? (existingProviders[firstId] as AnyObj) : null;
  const firstModel = (firstEntry?.models as AnyObj[] | undefined)?.[0];

  const kind = bail<string>(
    await select({
      message: "选择 provider 类型",
      initialValue: "custom",
      options: [
        {
          value: "builtin",
          label: "内置 provider（qwen-token-plan/deepseek/zai/moonshotai…，元数据 Pi 自带）",
        },
        {
          value: "custom",
          label: "自定义（任意 openai 兼容端点，如 DeepSeek 直连；元数据从 LiteLLM 抓）",
        },
      ],
    })
  );

  let providerId: string;
  let entry: AnyObj;

  if (kind === "builtin") {
    const providers = getBuiltinProviders().filter((p) => BUILTIN_WHITELIST.includes(p));
    providerId = bail<string>(
      await select({
        message: "选择内置 provider",
        initialValue: "qwen-token-plan",
        options: providers.map((p) => ({ value: p, label: p })),
      })
    );
    const modelIds = getBuiltinModels(providerId as never).map((m) => m.id);
    const modelId = bail<string>(
      await select({
        message: `选择模型（${providerId} 目录）`,
        initialValue: modelIds[0],
        options: modelIds.map((m) => ({ value: m, label: m })),
      })
    );
    const apiKey = bail<string>(
      await password({
        message: `输入 ${providerId} 的 API Key`,
        validate: (v) => (v ? undefined : "不能为空"),
      })
    );
    // 内置 provider：baseUrl/元数据 Pi 目录自带，models.json 只需 key + 模型 id。
    entry = { apiKey, models: [{ id: modelId }] };
  } else {
    providerId = bail<string>(
      await text({
        message: "provider id（自洽即可，如 deepseek）",
        defaultValue: firstId ?? "deepseek",
        initialValue: firstId ?? "deepseek",
      })
    );
    const baseUrl = bail<string>(
      await text({
        message: "baseUrl（openai 兼容端点）",
        defaultValue:
          (firstEntry?.baseUrl as string) ?? "https://api.deepseek.com",
        initialValue:
          (firstEntry?.baseUrl as string) ?? "https://api.deepseek.com",
        validate: (v) => (v && v.startsWith("http") ? undefined : "需以 http 开头"),
      })
    );
    const apiKey = bail<string>(
      await password({
        message: "API Key",
        validate: (v) => (v ? undefined : "不能为空"),
      })
    );
    const modelId = bail<string>(
      await text({
        message: "模型 id",
        defaultValue: (firstModel?.id as string) ?? "deepseek-v4-flash",
        initialValue: (firstModel?.id as string) ?? "deepseek-v4-flash",
        validate: (v) => (v ? undefined : "不能为空"),
      })
    );

    // 从 LiteLLM 抓元数据（自定义 provider 的模型不在 Pi 内置目录）。
    let model: AnyObj = firstModel ?? defaultModel(modelId);
    model.id = modelId;
    model.name = modelId;
    const catalog = await fetchLitellm();
    if (catalog) {
      const m = matchLitellm(catalog, modelId);
      if (m) {
        log.info(
          `LiteLLM 命中 "${m[0]}": context=${m[1].max_input_tokens ?? "?"}, maxOut=${m[1].max_output_tokens ?? "?"}, $in/tok=${m[1].input_cost_per_token ?? "?"}`
        );
        const use = bail<boolean>(
          await confirm({ message: "采用 LiteLLM 元数据？", initialValue: true })
        );
        if (use) model = entryToModel(modelId, m[1]);
      } else {
        log.warn(`LiteLLM 未命中 "${modelId}"，手动填写元数据`);
      }
    }

    // 允许手动覆盖 contextWindow / maxTokens。
    const cw = bail<string>(
      await text({
        message: "contextWindow",
        defaultValue: String(model.contextWindow ?? 131072),
        initialValue: String(model.contextWindow ?? 131072),
        validate: (v) => (/^\d+$/.test(v) ? undefined : "需为数字"),
      })
    );
    const mt = bail<string>(
      await text({
        message: "maxTokens",
        defaultValue: String(model.maxTokens ?? 8192),
        initialValue: String(model.maxTokens ?? 8192),
        validate: (v) => (/^\d+$/.test(v) ? undefined : "需为数字"),
      })
    );
    model.contextWindow = Number(cw);
    model.maxTokens = Number(mt);

    entry = { name: providerId, baseUrl, apiKey, api: "openai-completions", models: [model] };
  }

  const doc = { providers: { [providerId]: entry } };
  await mkdir(dirname(join(MODELS_JSON_PATH)), { recursive: true });
  await writeFile(MODELS_JSON_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");

  note(`已写入 ${MODELS_JSON_PATH}\nprovider=${providerId}`, "完成");
  outro("✅ AI 配置完成。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
