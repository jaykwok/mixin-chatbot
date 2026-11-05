#!/usr/bin/env bun
// Internal stdin/stdout protocol. The web host has no Pi dependency; this runs in the deployed runtime.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseAppBotConfig } from "../../src/integrations/open-platform/config.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { relayBackendId, validateRelayConfig } from "../../src/integrations/relay-s3.ts";
import { readRelayIndex, RelayIndexFormatError } from "../../src/integrations/relay-index.ts";
import { readAuxiliaryConfig } from "../../src/core/auxiliary-config.ts";
import { randomUUID } from "node:crypto";
import { windowsPrivateOwner } from "../lib/windows-private-directory.ts";
import { configurationKind, configurationFiles, configurationObject, type ConfigurationSnapshot } from "./configuration-form.ts";

export interface ConfigurationCheckResult {
  protocol: "mixin-configuration"; version: 1; success: true; summary: string[];
  /** Host-only directory cache, never forwarded to the browser. */
  catalog?: string;
}
interface CheckOptions {
  network?: boolean;
  /** Explicit model directory refresh for the selected provider only. */
  refresh?: boolean;
  root?: string;
  temporaryRoot?: string;
}
const doc = (value: string | null | undefined) => configurationObject(JSON.parse(value ?? "{}"));
// Pi is about 1,860 modules: only the models kind and the catalogue load it, not every process that imports this file.
const loadModelConfig = () => import("../../src/core/model-config.ts");

/** Existing app/relay parsers and the exact Pi startup resolver, on private temporary files only. */
export async function checkConfiguration(snapshot: ConfigurationSnapshot, options: CheckOptions = {}): Promise<ConfigurationCheckResult> {
  const kind = configurationKind(snapshot.kind), root = resolve(options.root ?? ".");
  if (!snapshot.files || Object.keys(snapshot.files).some(key => !configurationFiles(kind).includes(key as keyof typeof snapshot.files))) throw new Error("配置校验请求无效");
  const result: ConfigurationCheckResult = { protocol: "mixin-configuration", version: 1, success: true, summary: [] };
  if (kind === "app") {
    const config = parseAppBotConfig(doc(snapshot.files.app));
    if (options.network) {
      const client = new PlatformClient(config, { timeoutMs: 15_000, retryDelaysMs: [] });
      try { await client.appToken.get(); } catch { throw new Error("应用 token 验证失败，请检查应用凭据、环境和网络；尚未写入配置"); }
      finally { client.close(); }
    }
    result.summary.push(`应用：${config.appId}；环境：${config.environment}`, options.network ? "凭据已通过应用 token 验证；没有连接 Stream。" : "已通过格式校验，尚未在线验证应用凭据。");
    return result;
  }
  if (kind === "relay") {
    const config = snapshot.files.relay === null ? null : validateRelayConfig(doc(snapshot.files.relay));
    const backend = config ? relayBackendId(config) : null;
    let stranded = 0;
    try { stranded = readRelayIndex(join(root, "data/state/relay.sqlite")).filter(row => !backend || !row.key.startsWith(backend + ":")).length; }
    catch (error) {
      if (config && error instanceof RelayIndexFormatError) throw new Error("外链账本格式不受支持，不能启用新配置");
      result.summary.push("外链账本无法核验，请检查原存储是否仍有对象。");
    }
    result.summary.push(config ? `外链：${config.endpoint}；桶：${config.bucket}；有效期 ${config.expireHours} 小时。` : "停用外链；保留账本和云端文件。",
      "只校验配置，没有向云端上传或删除对象。", ...(stranded ? [`有 ${stranded} 个在册对象不属于新设置；切换后无法自动清理。`] : []));
    return result;
  }
  const { openModelRuntime, openSettings, resolveModelSelection } = await loadModelConfig();
  // Startup also resolves auxiliary.json's references (data-validation.ts); its own errors name the file and fields only.
  const auxiliary = readAuxiliaryConfig(join(root, "data/config/auxiliary.json"));
  let missing: string[] = [];
  const parent = options.temporaryRoot ?? tmpdir(); await mkdir(parent, { recursive: true });
  // chmod cannot protect a Windows directory. Install its private DACL before writing the first credential byte,
  // even when a scheduled task's TEMP is a shared system directory.
  const dir = process.platform === "win32" ? join(parent, ".console-validation-" + randomUUID()) : await mkdtemp(join(parent, ".console-validation-"));
  if (process.platform === "win32") windowsPrivateOwner(dir); else await chmod(dir, 0o700);
  try {
    const paths = { models: join(dir, "models.json"), settings: join(dir, "settings.json"), catalog: join(dir, "models-store.json") };
    for (const key of ["models", "settings", "catalog"] as const) {
      if (snapshot.files[key] !== null) await writeFile(paths[key], snapshot.files[key] ?? "{}", { mode: 0o600, flag: "wx" });
    }
    const runtime = await openModelRuntime({ modelsPath: paths.models, modelsStorePath: paths.catalog, writableCatalog: options.refresh === true });
    const settings = openSettings(paths.settings), provider = settings.getDefaultProvider();
    if (options.refresh) {
      if (!options.network || !provider) throw new Error("联网刷新需要明确授权并选择服务商");
      const refreshed = await runtime.refresh({ providers: [provider], allowNetwork: true, force: true });
      if (refreshed.errors.has(provider)) throw new Error("所选服务商的模型目录刷新失败");
    }
    const selected = await resolveModelSelection(runtime, settings, { signal: AbortSignal.timeout(30_000) });
    missing = (["classifier", "image"] as const).flatMap(type => {
      const ref = auxiliary?.[type];
      return ref && !runtime.getModelOfType(type, ref.provider, ref.modelId) ? [`${type} 模型 ${ref.provider}/${ref.modelId}`] : [];
    });
    result.summary.push(`模型：${selected.model.provider}/${selected.model.id}`, `协议：${selected.model.api}；上下文 ${selected.model.contextWindow}，输出上限 ${selected.model.maxTokens}。`,
      `推理级别：${selected.thinkingLevel}；Pi 校验通过，未发起模型推理。`);
    if (options.refresh) result.catalog = await readFile(paths.catalog, "utf8");
  } catch {
    // Pi's schema/credential errors can quote native field values or command output. Never forward those to the page/log.
    throw new Error("模型配置未通过 Pi 校验；请检查服务商、模型资料、选型和凭据引用。正式配置未修改");
  } finally { await rm(dir, { recursive: true, force: true }); }
  // Outside the catch: a reference names a provider and a model id, never a credential.
  if (missing.length) throw new Error(`新的模型配置里没有 auxiliary.json 引用的 ${missing.join("、")}，服务启动会拒绝；请保留它的服务商或先修改 auxiliary.json。正式配置未修改`);
  return result;
}

/** Bundled provider catalogue only; no network, user keys or existing configuration are read. */
export async function configurationCatalog() {
  const [{ openModelRuntime }, { builtinProviders }, { getApiProviders }, { getSupportedThinkingLevels }] = await Promise.all([loadModelConfig(),
    import("@earendil-works/pi-ai/providers/all"), import("@earendil-works/pi-ai/compat"), import("@earendil-works/pi-ai")]);
  const dir = await mkdtemp(join(tmpdir(), "mixin-configuration-catalog-"));
  try {
  const runtime = await openModelRuntime({ modelsPath: join(dir, "absent-models.json"), modelsStorePath: join(dir, "absent-cache.json") });
  const providers = builtinProviders().filter(value => value.auth.apiKey).map(value => ({ id: value.id, name: value.name }));
  return { providers, apis: getApiProviders().map(value => value.api), models: runtime.getModels().map(model => ({ provider: model.provider, id: model.id,
    name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, input: model.input, reasoning: model.reasoning,
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite }, thinking: getSupportedThinkingLevels(model) })) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const [action, project, extra] = process.argv.slice(2);
    if (extra || !["check", "catalog"].includes(action ?? "")) throw new Error("配置校验动作无效");
    if (project) { if (project.startsWith("-")) throw new Error("配置校验项目无效"); process.chdir(project); }
    if (action === "catalog") console.log(JSON.stringify({ protocol: "mixin-configuration-catalog", version: 1, ...await configurationCatalog() }));
    else {
      let body = "", bytes = 0; const decoder = new TextDecoder();
      for await (const chunk of Bun.stdin.stream()) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error("配置校验请求过大"); body += decoder.decode(chunk, { stream: true }); }
      body += decoder.decode();
      const request = JSON.parse(body);
      if (request.version !== 1 || !request.snapshot || Object.keys(request).some(key => !["version", "snapshot", "network", "refresh"].includes(key))
        || (request.network !== undefined && typeof request.network !== "boolean") || (request.refresh !== undefined && typeof request.refresh !== "boolean")) throw new Error("配置校验请求无效");
      console.log(JSON.stringify(await checkConfiguration(request.snapshot, { network: request.network, refresh: request.refresh })));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "配置校验失败"); process.exitCode = 1;
  }
}
