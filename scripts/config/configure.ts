#!/usr/bin/env bun
// AI 配置 TUI：交互生成 data/models.json（provider + key + model，Pi 原生读取）。
// 通常在容器内运行：
//   docker run --rm -it -v "$(pwd)/data:/app/data" mixin-chatbot bun run configure
// 也可本地 bun run configure。
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
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
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
function bail<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel("已取消");
    process.exit(0);
  }
  return v as T;
}

interface ExistingDoc {
  providers?: Record<string, Record<string, unknown>>;
}
type JsonObject = Record<string, unknown>;

async function loadExisting(): Promise<ExistingDoc> {
  try {
    return JSON.parse(await readFile(MODELS_JSON_PATH, "utf8")) as ExistingDoc;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${MODELS_JSON_PATH} 无法读取或不是有效 JSON`, {
      cause: error,
    });
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
  supports_reasoning?: boolean;
  mode?: string;
}

async function fetchLitellm(): Promise<Record<string, LiteLLMEntry> | null> {
  try {
    const r = await fetch(LITELLM_URL, {
      headers: { "User-Agent": CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
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

export function entryToModel(modelId: string, e: LiteLLMEntry): JsonObject {
  // LiteLLM 是美元/token，Pi 的 Model.cost 是美元/百万 token。
  const perMillion = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value)
      ? value * 1_000_000
      : 0;
  return {
    id: modelId,
    name: modelId,
    contextWindow: e.max_input_tokens ?? e.max_tokens ?? 131072,
    maxTokens: e.max_output_tokens ?? e.max_tokens ?? 8192,
    input: e.supports_vision ? ["text", "image"] : ["text"],
    reasoning: e.supports_reasoning ?? false,
    cost: {
      input: perMillion(e.input_cost_per_token),
      output: perMillion(e.output_cost_per_token),
      cacheRead: perMillion(e.cache_read_input_token_cost),
      cacheWrite: perMillion(e.cache_creation_input_token_cost),
    },
  };
}

function defaultModel(modelId: string): JsonObject {
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
  const firstEntry = firstId ? (existingProviders[firstId] as JsonObject) : null;
  const firstModel = (firstEntry?.models as JsonObject[] | undefined)?.[0];

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
  let entry: JsonObject;

  if (kind === "builtin") {
    const providers = getBuiltinProviders().filter((p) => BUILTIN_WHITELIST.includes(p));
    if (providers.length === 0) throw new Error("Pi 未返回可用的内置 provider");
    providerId = bail<string>(
      await select({
        message: "选择内置 provider",
        initialValue: "qwen-token-plan",
        options: providers.map((p) => ({ value: p, label: p })),
      })
    );
    const modelIds = getBuiltinModels(providerId as never).map((m) => m.id);
    if (modelIds.length === 0) throw new Error(`provider ${providerId} 没有可用模型`);
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
        validate: (v) => (v?.trim() ? undefined : "不能为空"),
      })
    ).trim();
    // 内置 provider：baseUrl/元数据 Pi 目录自带，models.json 只需 key + 模型 id。
    entry = { apiKey, models: [{ id: modelId }] };
  } else {
    providerId = bail<string>(
      await text({
        message: "provider id（自洽即可，如 deepseek）",
        defaultValue: firstId ?? "deepseek",
        initialValue: firstId ?? "deepseek",
        validate: (v) => (v?.trim() ? undefined : "不能为空"),
      })
    ).trim();
    const baseUrl = bail<string>(
      await text({
        message: "baseUrl（openai 兼容端点）",
        defaultValue:
          (firstEntry?.baseUrl as string) ?? "https://api.deepseek.com",
        initialValue:
          (firstEntry?.baseUrl as string) ?? "https://api.deepseek.com",
        validate: (v) => {
          try {
            const protocol = new URL(v ?? "").protocol;
            return protocol === "http:" || protocol === "https:"
              ? undefined
              : "仅支持 http:// 或 https://";
          } catch {
            return "请输入有效 URL";
          }
        },
      })
    ).trim();
    const apiKey = bail<string>(
      await password({
        message: "API Key",
        validate: (v) => (v?.trim() ? undefined : "不能为空"),
      })
    ).trim();
    const modelId = bail<string>(
      await text({
        message: "模型 id",
        defaultValue: (firstModel?.id as string) ?? "deepseek-v4-flash",
        initialValue: (firstModel?.id as string) ?? "deepseek-v4-flash",
        validate: (v) => (v?.trim() ? undefined : "不能为空"),
      })
    ).trim();

    // 从 LiteLLM 抓元数据（自定义 provider 的模型不在 Pi 内置目录）。
    let model: JsonObject = firstModel ? { ...firstModel } : defaultModel(modelId);
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
        validate: (v) => (v && /^[1-9]\d*$/.test(v) ? undefined : "需为正整数"),
      })
    );
    const mt = bail<string>(
      await text({
        message: "maxTokens",
        defaultValue: String(model.maxTokens ?? 8192),
        initialValue: String(model.maxTokens ?? 8192),
        validate: (v) => (v && /^[1-9]\d*$/.test(v) ? undefined : "需为正整数"),
      })
    );
    model.contextWindow = Number(cw);
    model.maxTokens = Number(mt);

    entry = { name: providerId, baseUrl, apiKey, api: "openai-completions", models: [model] };
  }

  const doc = { providers: { [providerId]: entry } };
  await mkdir(dirname(MODELS_JSON_PATH), { recursive: true });
  const tempPath = `${MODELS_JSON_PATH}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, JSON.stringify(doc, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await chmod(tempPath, 0o600).catch(() => {
      // Windows ACL 不使用 POSIX mode；部署脚本仍限制运行身份。
    });
    await rename(tempPath, MODELS_JSON_PATH);
  } finally {
    await unlink(tempPath).catch(() => {});
  }

  note(`已写入 ${MODELS_JSON_PATH}\nprovider=${providerId}`, "完成");
  outro("✅ AI 配置完成。");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
