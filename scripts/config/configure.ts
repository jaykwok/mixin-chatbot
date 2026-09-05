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
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { MODELS_JSON_PATH } from "../../src/core/storage.ts";

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

function isPositiveSafeInteger(value: string | undefined): boolean {
  if (!value || !/^[1-9]\d*$/.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

/** 只接受精确 id；同名模型由管理员选择来源，不能靠子串猜价格和上下文。 */
export function catalogMatches(modelId: string): Model<Api>[] {
  return getBuiltinProviders().flatMap((provider) =>
    getBuiltinModels(provider).filter((model) => model.id === modelId)
  );
}

export function defaultCatalogSource(matches: Model<Api>[], providerId: string, reuseExisting: boolean): number {
  if (reuseExisting || matches.length === 0) return -1;
  const providerMatch = matches.findIndex((model) => model.provider === providerId);
  if (providerMatch !== -1) return providerMatch;
  const responsesMatch = matches.findIndex((model) => model.api === MODEL_API);
  return responsesMatch === -1 ? 0 : responsesMatch;
}

/** 配置器只生成一个模型；compat 合并到模型一级，避免两个层级保存相反值。 */
export function responsesProvider(
  providerId: string, baseUrl: string, apiKey: string, model: JsonObject,
  providerCompat: JsonObject, supportsMaxOutputTokens: boolean
): JsonObject {
  return {
    name: providerId, baseUrl, apiKey, api: MODEL_API,
    models: [{ ...model, compat: {
      ...providerCompat, ...(model.compat as JsonObject | undefined), supportsMaxOutputTokens,
    } }],
  };
}

export function catalogModelMetadata(modelId: string, model: Model<Api>): JsonObject {
  // 只复制模型资料。provider/api/baseUrl/headers/compat 属于原服务商，不能带到中转站。
  return {
    id: modelId,
    name: modelId,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
    reasoning: model.reasoning,
    cost: { ...model.cost }, // Pi 原生单位：美元/百万 token。
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

  // 同步读取 Pi 随包提供的目录，无需联网、认证或另一套元数据格式。
  // 只有仍在编辑原 provider 时才考虑复用旧模型元数据；同名模型在不同端点
  // 可能有不同上下文、能力和价格，不能跨 provider 继承。
  const sameProvider = providerId === firstId && baseUrl === firstEntry?.baseUrl;
  const reuseExisting = sameProvider && firstModel?.id === modelId;
  let model = modelDefaultsForSelection(
    modelId,
    firstModel,
    sameProvider
  );
  const matches = catalogMatches(modelId);
  if (matches.length > 0) {
    const source = bail<number>(await select({
      message: "模型资料来源（中转站的价格和能力可能不同，请核对）",
      initialValue: defaultCatalogSource(matches, providerId, reuseExisting),
      options: [
        { value: -1, label: reuseExisting ? "保留已有资料（下方可编辑）" : "手动填写全部模型资料" },
        ...matches.map((match, index) => ({
          value: index,
          label: `Pi: ${match.provider}/${match.id}（context=${match.contextWindow}, maxOut=${match.maxTokens}, $in/M=${match.cost.input}, $out/M=${match.cost.output}）`,
        })),
      ],
    }));
    if (source !== -1) model = { ...model, ...catalogModelMetadata(modelId, matches[source]!) };
    else if (!reuseExisting) log.warn("尚未采用模型目录资料，请填写实际上下文、输入能力和价格；默认值仅供占位。");
  } else {
    log.warn(`Pi 目录未精确匹配 "${modelId}"，请核对并填写全部模型资料`);
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

  const vision = bail<boolean>(await confirm({
    message: "模型支持图片输入？",
    initialValue: Array.isArray(model.input) && model.input.includes("image"),
  }));
  model.input = vision ? ["text", "image"] : ["text"];
  const previousCost = (model.cost ?? {}) as JsonObject;
  const cost: JsonObject = {};
  for (const [key, label] of [
    ["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读取"], ["cacheWrite", "缓存写入"],
  ] as const) {
    const value = String(previousCost[key] ?? 0);
    cost[key] = Number(bail<string>(await text({
      message: `${label}价格（美元/百万 token，0 表示免费或尚未填写）`,
      initialValue: value, defaultValue: value,
      validate: (raw) => raw?.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0
        ? undefined : "需为非负有限数",
    })));
  }
  const ratesChanged = Object.keys(cost).some((key) => cost[key] !== previousCost[key]);
  if (!ratesChanged && previousCost.tiers) cost.tiers = previousCost.tiers;
  else if (ratesChanged && previousCost.tiers) log.warn("基础价格已修改，已移除原目录的阶梯价格；需要时请在 models.json 中填写实际 tiers。");
  model.cost = cost;
  if (Object.values(cost).every((value) => value === 0)) log.warn("价格全部为 0，费用估算将为零；请确认这是实际价格。");

  const compat = (model.compat ?? {}) as JsonObject;
  const providerCompat = sameProvider
    ? (firstEntry?.compat ?? {}) as JsonObject
    : {};
  const supportsMaxOutputTokens = bail<boolean>(await confirm({
    message: "服务支持 max_output_tokens 参数？（仅在服务明确拒绝该参数时选否）",
    initialValue: (compat.supportsMaxOutputTokens ?? providerCompat.supportsMaxOutputTokens) !== false,
  }));

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

  const entry = responsesProvider(providerId, baseUrl, apiKey, model, providerCompat, supportsMaxOutputTokens);

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
