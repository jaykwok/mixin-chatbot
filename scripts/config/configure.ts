#!/usr/bin/env bun
// AI 配置向导。两种接入方式：Pi 内置服务商，和自定义服务商。
//
// 向导自己收集管理员的输入，不调用 Pi 的交互流程（/login、/model 那一套）；产出是 Pi 自己
// 的两个配置文件——models.json 放服务商、凭证和模型，settings.json 记录选中的模型与推理
// 级别。两个文件的格式、解析和校验都归 Pi。
//
// 内置方式只写 API Key，地址、协议、工具兼容和模型资料全部用 Pi 随包的目录。自定义方式
// 填地址和 Key，向导按端点自己返回的清单列出模型；选中的 id 如果在 Pi 目录里有资料，就用
// 它预填上下文、能力和价格，管理员核对后落盘。
//
// models.json 里向导没问过的官方字段（headers、compat、authHeader、modelOverrides）在重新
// 配置时原样保留。部署脚本在停止旧实例后调用；本地停机时也可运行 bun run configure。
import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
  select,
  text,
} from "@clack/prompts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { getApiProviders } from "@earendil-works/pi-ai/compat";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { SettingsManager, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openModelRuntime, openSettings, resolveModelSelection } from "../../src/core/model-config.ts";
import { MODELS_JSON_PATH, PI_SETTINGS_PATH } from "../../src/core/storage.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { withModelConfigurationDraft, type ModelConfigurationDraft } from "./model-config-draft.ts";

type JsonObject = Record<string, unknown>;
/** 向导之外手工调过的官方 provider 字段，重新配置时按原样带回。 */
const PRESERVED_PROVIDER_FIELDS = ["headers", "compat", "authHeader", "modelOverrides"] as const;
/** 列模型清单的等待上限；失败就退回手填 id，不阻塞配置。 */
const DISCOVERY_TIMEOUT_MS = 15_000;

// @clack/prompts 取消即退出。
function bail<T>(v: T | symbol): T {
  if (isCancel(v)) {
    cancel("已取消");
    throw new DOMException("配置已取消", "AbortError");
  }
  return v as T;
}

function requireText(value: string | undefined): string | undefined {
  return value?.trim() ? undefined : "不能为空";
}

function requireHttpUrl(value: string | undefined): string | undefined {
  try {
    const protocol = new URL(value ?? "").protocol;
    return protocol === "http:" || protocol === "https:" ? undefined : "仅支持 http:// 或 https://";
  } catch {
    return "请输入有效 URL";
  }
}

function positiveInteger(value: string | undefined): string | undefined {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return "需为正安全整数";
  return undefined;
}

async function askText(message: string, previous: string | undefined, validate: (value: string | undefined) => string | undefined): Promise<string> {
  return bail<string>(await text({
    message, defaultValue: previous ?? "", initialValue: previous ?? "", validate,
  })).trim();
}

async function askApiKey(): Promise<string> {
  // ASCII mask: clack's default ▪ is outside the GBK console code page and shows as "?" on Windows.
  const key = bail<string>(await password({ message: "API Key", mask: "*", validate: requireText })).trim();
  log.info("Key 会写进 models.json。也可以改填 $ENV_VAR 或 !command，由 Pi 在启动时解析。");
  return key;
}

/**
 * 让端点自己报出可用模型。OpenAI 兼容服务是 GET {baseUrl}/models，Anthropic 是
 * GET {baseUrl}/v1/models。这一步只为省去手抄 id，拿不到就退回手填。
 */
export async function discoverModelIds(api: string, baseUrl: string, apiKey: string): Promise<string[]> {
  const anthropic = api === "anthropic-messages";
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/${anthropic ? "v1/models" : "models"}`);
  const headers: Record<string, string> = anthropic
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${apiKey}` };
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const body = await response.json() as { data?: { id?: unknown }[]; models?: { name?: unknown }[] };
  const ids = [
    // OpenAI 与 Anthropic 都是 data[].id；Google 是 models[].name，带 "models/" 前缀。
    ...(body.data ?? []).map((entry) => entry.id),
    ...(body.models ?? []).map((entry) => typeof entry.name === "string" ? entry.name.replace(/^models\//, "") : entry.name),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0))].sort();
}

/** 自定义端点的模型 id：优先让端点自己列，列不出来就手填。 */
async function askCustomModelId(api: string, baseUrl: string, apiKey: string, previous?: string): Promise<string> {
  let ids: string[] = [];
  try {
    ids = await discoverModelIds(api, baseUrl, apiKey);
    if (ids.length === 0) log.warn("端点返回的模型清单为空，请手动填写模型 id。");
  } catch (error) {
    log.warn(`未能从端点获取模型清单（${error instanceof Error ? error.message : String(error)}），请手动填写模型 id。`);
  }
  if (ids.length === 0) return askText("模型 id", previous, requireText);
  const MANUAL = "\u0000manual";
  const picked = bail<string>(await select({
    message: "模型（来自端点返回的清单）",
    initialValue: previous && ids.includes(previous) ? previous : ids[0]!,
    options: [...ids.map((id) => ({ value: id, label: id })), { value: MANUAL, label: "手动填写其他 id" }],
  }));
  return picked === MANUAL ? await askText("模型 id", previous, requireText) : picked;
}

/**
 * 在 Pi 已知的模型里按 id 精确找同名的，用来预填自定义端点的模型资料。
 *
 * 只认精确 id：靠子串猜会把价格和上下文填错，比留空更糟。不排除正在配置的 provider——
 * 自定义 id 取成内置 id（中转某家厂商时很常见）时，那份官方资料正是最该拿来预填的。
 */
export function catalogMatches(runtime: ModelRuntime, modelId: string): Model<Api>[] {
  return runtime.getModels()
    .filter((item) => item.id === modelId)
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** 只复制模型资料。provider/api/baseUrl/headers/compat 属于原服务商，不能带到中转站。 */
export function catalogDefaults(source: Model<Api>): JsonObject {
  return {
    contextWindow: source.contextWindow,
    maxTokens: source.maxTokens,
    input: [...source.input],
    reasoning: source.reasoning,
    cost: { ...source.cost }, // Pi 原生单位：美元/百万 token。
  };
}

/** 手填模型资料。每个字段都是 models.json 的官方字段，向导不替 Pi 猜任何一个。 */
async function describeCustomModel(
  runtime: ModelRuntime, modelId: string, previous: JsonObject | undefined
): Promise<JsonObject> {
  let defaults: JsonObject = previous?.id === modelId ? { ...previous } : {};
  const matches = catalogMatches(runtime, modelId);
  if (matches.length > 0) {
    const KEEP = -1;
    const chosen = bail<number>(await select({
      message: "模型资料来源（中转站的价格和能力可能不同，请核对）",
      initialValue: Object.keys(defaults).length > 0 ? KEEP : 0,
      options: [
        { value: KEEP, label: Object.keys(defaults).length > 0 ? "保留已有资料（下方可改）" : "全部手动填写" },
        ...matches.map((match, index) => ({
          value: index,
          label: `Pi: ${match.provider}/${match.id}（context=${match.contextWindow}, maxOut=${match.maxTokens}, $in/M=${match.cost.input}, $out/M=${match.cost.output}）`,
        })),
      ],
    }));
    if (chosen !== KEEP) defaults = { ...defaults, ...catalogDefaults(matches[chosen]!) };
  } else if (Object.keys(defaults).length === 0) {
    log.warn("Pi 目录里没有这个 id，下面的上下文、能力和价格请按服务商文档填写。");
  }

  const contextWindow = await askText("contextWindow", String(defaults.contextWindow ?? 128000), positiveInteger);
  const maxTokens = await askText("maxTokens", String(defaults.maxTokens ?? 16384),
    (value) => positiveInteger(value) ?? (Number(value) <= Number(contextWindow) ? undefined : "不能大于 contextWindow"));
  const vision = bail<boolean>(await confirm({
    message: "模型支持图片输入？",
    initialValue: Array.isArray(defaults.input) && (defaults.input as string[]).includes("image"),
  }));
  const reasoning = bail<boolean>(await confirm({
    message: "模型支持思考模式？", initialValue: defaults.reasoning === true,
  }));
  const previousCost = (defaults.cost ?? {}) as JsonObject;
  const cost: JsonObject = {};
  for (const [key, label] of [
    ["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读取"], ["cacheWrite", "缓存写入"],
  ] as const) {
    const value = String(previousCost[key] ?? 0);
    cost[key] = Number(await askText(`${label}价格（美元/百万 token，0 表示免费或尚未填写）`, value,
      (raw) => raw?.trim() && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? undefined : "需为非负有限数"));
  }
  const ratesChanged = Object.keys(cost).some((key) => cost[key] !== previousCost[key]);
  if (!ratesChanged && previousCost.tiers) cost.tiers = previousCost.tiers;
  else if (ratesChanged && previousCost.tiers) log.warn("基础价格已修改，原有阶梯价格已移除；需要时请在 models.json 的 cost.tiers 中填写。");
  if (Object.values(cost).every((value) => value === 0)) log.warn("价格全部为 0，费用统计将始终为零；请确认这是实际价格。");
  return {
    // defaults 只会继承同一端点、同一模型的原条目；保留向导未询问的原生字段。
    ...defaults,
    id: modelId, name: defaults.name ?? modelId,
    contextWindow: Number(contextWindow), maxTokens: Number(maxTokens),
    input: vision ? ["text", "image"] : ["text"],
    reasoning,
    cost,
  };
}

async function selectBuiltinModel(runtime: ModelRuntime, providerId: string, previousId?: string): Promise<string> {
  const models = runtime.getModels(providerId);
  if (models.length === 0) {
    throw new Error(`${providerId} 当前没有可用模型。动态目录服务商需要有效凭证并联网刷新，请检查 Key 与网络后重试。`);
  }
  return bail<string>(await select({
    message: "模型",
    initialValue: models.find((item) => item.id === previousId)?.id ?? models[0]!.id,
    options: models.map((item) => ({
      value: item.id,
      label: `${item.id}（context=${item.contextWindow}, maxOut=${item.maxTokens}, $in/M=${item.cost.input}, $out/M=${item.cost.output}）`,
    })),
  }));
}

async function selectThinkingLevel(model: Model<Api>, previous?: ModelThinkingLevel): Promise<ModelThinkingLevel> {
  const levels = getSupportedThinkingLevels(model);
  const initial = clampThinkingLevel(model, previous ?? "medium");
  if (levels.length <= 1) return initial;
  return bail<ModelThinkingLevel>(await select({
    message: "thinkingLevel", initialValue: initial,
    options: levels.map((value) => ({ value, label: value })),
  }));
}

/**
 * 让刚写入的 models.json 生效：Pi 的 refresh() 会重新读一遍配置并重组这个 provider。
 * 联网与否听 Pi 自己的 PI_OFFLINE 开关；离线时退回随包目录和本地缓存。
 */
async function reloadProvider(runtime: ModelRuntime, providerId: string): Promise<void> {
  const allowNetwork = process.env.PI_OFFLINE === undefined;
  const { errors } = await runtime.refresh({ providers: [providerId], allowNetwork, force: allowNetwork });
  const configError = runtime.getError();
  if (configError) throw new Error(configError);
  const failure = errors.get(providerId);
  if (failure) log.warn(`模型目录刷新失败，改用随包目录和本地缓存：${failure.message}`);
}

async function loadProviders(path: string): Promise<Record<string, JsonObject>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { providers?: Record<string, JsonObject> };
    return parsed.providers ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${MODELS_JSON_PATH} 无法读取或不是有效 JSON`, { cause: error });
  }
}

function preserved(previous: JsonObject | undefined): JsonObject {
  const kept: JsonObject = {};
  for (const field of PRESERVED_PROVIDER_FIELDS) if (previous?.[field] !== undefined) kept[field] = previous[field];
  return kept;
}

async function main(draft: ModelConfigurationDraft): Promise<void> {
  // No emoji in console output: Windows Server consoles render them as "??".
  intro(`AI 配置（写入 ${MODELS_JSON_PATH} 与 ${PI_SETTINGS_PATH}）`);

  // 先离线建运行时：随包目录足够列出内置服务商，选定之后只刷新那一个。
  const runtime = await openModelRuntime({ ...draft, writableCatalog: true });
  const settings = SettingsManager.create(".", draft.agentDir, { projectTrusted: false });
  const initialErrors = settings.drainErrors();
  if (initialErrors.length) throw new Error(`${PI_SETTINGS_PATH}: ${initialErrors.map((item) => item.error.message).join("; ")}`);
  const previousProviders = await loadProviders(draft.modelsPath);
  const previousProviderId = settings.getDefaultProvider() ?? Object.keys(previousProviders)[0];
  const previousModelId = settings.getDefaultModel();

  const mode = bail<string>(await select({
    message: "模型接入方式",
    initialValue: previousProviders[previousProviderId ?? ""]?.baseUrl ? "custom" : "builtin",
    options: [
      { value: "builtin", label: "Pi 内置服务商", hint: "填 API Key、选模型；地址、协议和模型资料用 Pi 内置" },
      { value: "custom", label: "自定义服务商", hint: "填地址和 Key，按端点返回的清单选模型" },
    ],
  }));

  // 自定义方式在写盘前就定下了模型 id；内置方式要等目录刷新后才从清单里选。
  let providerId: string;
  let declaredModelId: string | undefined;
  const providers: Record<string, JsonObject> = {};
  if (mode === "builtin") {
    const candidates = builtinProviders().filter((provider) => provider.auth.apiKey).sort((a, b) => a.id.localeCompare(b.id));
    providerId = bail<string>(await select({
      message: "Pi 内置服务商",
      initialValue: candidates.find((item) => item.id === previousProviderId)?.id ?? "openai",
      options: candidates.map((item) => ({ value: item.id, label: `${item.name} (${item.id})` })),
    }));
    providers[providerId] = { ...preserved(previousProviders[providerId]), apiKey: await askApiKey() };
  } else {
    providerId = await askText("自定义 provider id（如 custom-gateway）", previousProviderId, requireText);
    const previousEntry = previousProviders[providerId];
    const apis = getApiProviders().map((item) => item.api);
    const api = bail<string>(await select({
      message: "服务协议（Pi 已注册的 api 实现）",
      initialValue: apis.find((value) => value === previousEntry?.api) ?? "openai-completions",
      options: apis.map((value) => ({ value, label: value })),
    }));
    const baseUrl = await askText("baseUrl（对应所选协议的服务地址）",
      (previousEntry?.baseUrl as string) ?? (api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1"),
      requireHttpUrl);
    const apiKey = await askApiKey();
    // 换了端点就不能沿用旧模型资料：同名模型在不同服务上的上下文、能力和价格都可能不同。
    const sameEndpoint = previousEntry?.baseUrl === baseUrl && previousEntry?.api === api;
    const previousModels = sameEndpoint ? (previousEntry?.models as JsonObject[] | undefined) ?? [] : [];
    const previousId = providerId === previousProviderId ? previousModelId : undefined;
    declaredModelId = await askCustomModelId(api, baseUrl, apiKey, previousId ?? previousModels[0]?.id as string | undefined);
    const previousModel = previousModels.find((item) => item.id === declaredModelId);
    const model = await describeCustomModel(runtime, declaredModelId, previousModel);
    providers[providerId] = { ...preserved(previousEntry), api, baseUrl, apiKey, models: [model] };
  }

  await writeFile(draft.modelsPath, JSON.stringify({ providers }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await reloadProvider(runtime, providerId);
  const modelId = declaredModelId ?? await selectBuiltinModel(runtime, providerId, previousModelId);

  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error(`Pi 未提供 ${providerId}/${modelId}，请检查 ${MODELS_JSON_PATH}`);
  const thinkingLevel = await selectThinkingLevel(model,
    settings.getModelThinkingLevel(providerId, model.id) ?? settings.getDefaultThinkingLevel());

  settings.setDefaultModelAndProvider(providerId, model.id);
  settings.setDefaultThinkingLevel(thinkingLevel);
  settings.removeModelThinkingLevel(providerId, model.id);
  await settings.flush();
  const failures = settings.drainErrors();
  if (failures.length) throw new Error(`${PI_SETTINGS_PATH} 写入失败：${failures.map((item) => item.error.message).join("; ")}`);
  // 从草稿文件重新走服务端的只读启动路径，确认落盘结果与选择一致，再一起提交。
  await resolveModelSelection(await openModelRuntime(draft), openSettings(join(draft.agentDir, "settings.json")));
  await draft.commit();

  note(
    `provider=${providerId}\n模型=${model.id}\nthinkingLevel=${thinkingLevel}\n` +
    `地址=${model.baseUrl}\n协议=${model.api}\n上下文=${model.contextWindow}\n输出上限=${model.maxTokens}`,
    "完成"
  );
  log.info("需要更细的服务商设置时，可按 Pi 的 models.json 格式手工添加 headers、compat、authHeader 或 modelOverrides；重新运行本向导不会覆盖它们。");
  outro("AI 配置完成。");
}

if (import.meta.main) {
  withMaintenance(() => withModelConfigurationDraft(main)).catch((e) => {
    if (e instanceof Error && e.name === "AbortError") return;
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
