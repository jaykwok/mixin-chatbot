#!/usr/bin/env bun
// AI 配置 TUI：交互生成 data/config/models.json（provider + key + model，Pi 原生读取）。
// 通常在容器内运行：
//   docker run --rm -it --user "$(stat -c '%u:%g' data)" -v "$(pwd)/data:/app/data" mixin-chatbot bun run configure
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
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODELS_JSON_PATH } from "../../src/core/storage.ts";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
// raw GitHub 对默认 fetch UA 指纹拦截，必须带浏览器 UA。
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const MODEL_API = "openai-responses" as const;

// @clack/prompts 取消即退出。
function bail<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel("已取消");
    process.exit(0);
  }
  return v as T;
}

interface ExistingDoc {
  thinkingLevel?: ModelThinkingLevel;
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
      await r.body?.cancel().catch(() => {});
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

function isPositiveSafeInteger(value: string | undefined): boolean {
  if (!value || !/^[1-9]\d*$/.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

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

/** 只有模型 id 未改变时才沿用旧元数据，避免换模型后继承错误的价格/能力。 */
export function modelDefaultsForSelection(
  modelId: string,
  existing?: JsonObject,
  sameProvider = true
): JsonObject {
  if (sameProvider && existing?.id === modelId) {
    return { ...existing, id: modelId, name: modelId };
  }
  return defaultModel(modelId);
}

export function defaultThinkingLevel(
  supportsReasoning: boolean,
  existing?: ModelThinkingLevel
): ModelThinkingLevel {
  return supportsReasoning ? (existing ?? "low") : "off";
}

async function main(): Promise<void> {
  intro(`🤖 AI 配置（生成 ${MODELS_JSON_PATH}）`);

  const existing = await loadExisting();
  const existingProviders = existing.providers ?? {};
  const firstId = Object.keys(existingProviders)[0];
  const firstEntry = firstId ? (existingProviders[firstId] as JsonObject) : null;
  const firstModel = (firstEntry?.models as JsonObject[] | undefined)?.[0];

  const providerId = bail<string>(
    await text({
      message: "Responses provider id（自洽即可，如 openai）",
      defaultValue: firstId ?? "openai",
      initialValue: firstId ?? "openai",
      validate: (v) => (v?.trim() ? undefined : "不能为空"),
    })
  ).trim();
  const baseUrl = bail<string>(
    await text({
      message: "baseUrl（必须实现 OpenAI Responses API）",
      defaultValue:
        (firstEntry?.baseUrl as string) ?? "https://api.openai.com/v1",
      initialValue:
        (firstEntry?.baseUrl as string) ?? "https://api.openai.com/v1",
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
      defaultValue: (firstModel?.id as string) ?? "gpt-5.2",
      initialValue: (firstModel?.id as string) ?? "gpt-5.2",
      validate: (v) => (v?.trim() ? undefined : "不能为空"),
    })
  ).trim();

  // 从 LiteLLM 抓元数据（自定义 provider 的模型不在 Pi 内置目录）。
  // 只有仍在编辑原 provider 时才考虑复用旧模型元数据；同名模型在不同端点
  // 可能有不同上下文、能力和价格，不能跨 provider 继承。
  let model = modelDefaultsForSelection(
    modelId,
    firstModel,
    providerId === firstId
  );
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
      validate: (v) =>
        isPositiveSafeInteger(v) ? undefined : "需为正安全整数",
    })
  );
  const mt = bail<string>(
    await text({
      message: "maxTokens",
      defaultValue: String(model.maxTokens ?? 8192),
      initialValue: String(model.maxTokens ?? 8192),
      validate: (v) => {
        if (!isPositiveSafeInteger(v)) return "需为正安全整数";
        return Number(v) <= Number(cw)
          ? undefined
          : "不能大于 contextWindow";
      },
    })
  );
  model.contextWindow = Number(cw);
  model.maxTokens = Number(mt);

  const supportsReasoning = bail<boolean>(
    await confirm({
      message: "模型支持思考模式？",
      initialValue: model.reasoning === true,
    })
  );
  model.reasoning = supportsReasoning;
  let thinkingLevel = defaultThinkingLevel(
    supportsReasoning,
    existing.thinkingLevel
  );
  if (supportsReasoning) {
    thinkingLevel = bail<ModelThinkingLevel>(
      await select({
        message: "thinkingLevel",
        initialValue: thinkingLevel,
        options: [
          { value: "off", label: "off（关闭）" },
          { value: "minimal", label: "minimal（最低）" },
          { value: "low", label: "low（低）" },
          { value: "medium", label: "medium（中）" },
          { value: "high", label: "high（高）" },
        ],
      })
    );
  }

  const entry: JsonObject = {
    name: providerId,
    baseUrl,
    apiKey,
    api: MODEL_API,
    models: [model],
  };

  const doc = { thinkingLevel, providers: { [providerId]: entry } };
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

  note(
    `已写入 ${MODELS_JSON_PATH}\nprovider=${providerId}\nthinkingLevel=${thinkingLevel}`,
    "完成"
  );
  outro("✅ AI 配置完成。");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
