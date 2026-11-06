// Host-safe form projection and edits. Pi remains the authority for model configuration validity.
// Never return a raw configuration object to the browser: unknown fields can contain credentials too.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { applicationBinding, readDataVersion, VERSION_FILE } from "../../src/core/data-version.ts";
import { parseAppBotConfig } from "../../src/integrations/open-platform/config.ts";
import { validateRelayConfig, DEFAULT_RELAY_MAX_BYTES, DEFAULT_RELAY_EXPIRE_HOURS, DEFAULT_RELAY_CLEANUP_GRACE_MINUTES } from "../../src/integrations/relay-s3.ts";
import { normalizeRelayUrlInput } from "./relay-url.ts";

export const CONFIGURATION_KINDS = ["models", "app", "relay"] as const;
export type ConfigurationKind = typeof CONFIGURATION_KINDS[number];
/** Internal runtime publication uses the same storage transaction, without adding another public configuration form. */
export type StoredConfigurationKind = ConfigurationKind | "runtime";
export const CONFIGURATION_FILES = {
  models: "data/config/models.json", settings: "data/runtime/pi/settings.json", catalog: "data/runtime/models-store.json",
  app: "data/config/app-bot.json", relay: "data/config/relay.json", runtime: "data/config/runtime.json",
} as const;
export type ConfigurationFile = keyof typeof CONFIGURATION_FILES;
export const configurationFiles = (kind: StoredConfigurationKind): ConfigurationFile[] => kind === "models" ? ["models", "settings", "catalog"] : [kind];
export type ConfigurationSnapshot<K extends StoredConfigurationKind = ConfigurationKind> = { kind: K; files: Partial<Record<ConfigurationFile, string | null>>; binding: string | null };
type ObjectValue = Record<string, unknown>;

export function configurationHash(value: string | null): string | null { return value === null ? null : createHash("sha256").update(value).digest("hex"); }
export function configurationKind(value: unknown): ConfigurationKind {
  if (!CONFIGURATION_KINDS.includes(value as ConfigurationKind)) throw new Error("配置类型无效");
  return value as ConfigurationKind;
}
export function configurationObject(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置表单应为对象");
  return value as ObjectValue;
}
function only(value: ObjectValue, keys: string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("配置表单含未允许的字段");
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("配置字段应为非空文本，且不能含控制字符");
  return value.trim();
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
function parsed(raw: string | null | undefined): ObjectValue {
  if (raw == null) return {};
  try { return configurationObject(JSON.parse(raw.replace(/^\uFEFF/, ""))); }
  catch { throw new Error("现有配置不是有效 JSON 对象，请先修复文件再打开表单"); }
}

/** Refuse symlinked ancestors, non-files and oversized config files before reading any contents. */
export function readConfigurationFile(project: string, key: ConfigurationFile): string | null {
  const path = resolve(project, CONFIGURATION_FILES[key]), rel = relative(resolve(project), path);
  if (rel.startsWith("..")) throw new Error("配置路径越界");
  for (let parent = dirname(path); parent !== resolve(project); parent = dirname(parent)) {
    try { const stat = lstatSync(parent); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("配置目录不能是链接或文件"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("配置文件类型或大小不受支持");
    return readFileSync(path, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function configurationSnapshot<K extends StoredConfigurationKind>(project: string, kind: K): ConfigurationSnapshot<K> {
  const files: ConfigurationSnapshot["files"] = {};
  for (const key of configurationFiles(kind)) files[key] = readConfigurationFile(project, key);
  const record = readDataVersion(join(project, "data/state", VERSION_FILE));
  return { kind, files, binding: record?.application ?? null };
}
export function assertConfigurationBase(project: string, base: ConfigurationSnapshot<StoredConfigurationKind>): void {
  const current = configurationSnapshot(project, base.kind);
  if (current.binding !== base.binding || configurationFiles(base.kind).some(key => configurationHash(current.files[key]!) !== configurationHash(base.files[key]!))) {
    throw new Error("配置或应用身份已被其他操作修改，请重新读取；本次没有覆盖");
  }
}
function publicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return value; } catch {}
}
function publicModel(value: unknown): ObjectValue {
  const model = configurationObject(value), result: ObjectValue = {};
  for (const key of ["id", "name", "contextWindow", "maxTokens", "reasoning"] as const) {
    const val = model[key]; if (["string", "number", "boolean"].includes(typeof val)) result[key] = val;
  }
  if (Array.isArray(model.input)) result.input = model.input.filter(value => value === "text" || value === "image");
  if (model.cost && typeof model.cost === "object") result.cost = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].flatMap(key => {
    const value = (model.cost as ObjectValue)[key]; return typeof value === "number" ? [[key, value]] : [];
  }));
  return result;
}

/** Safe, deliberately incomplete projection; omitted native fields stay in the host's draft. */
export function configurationForm(snapshot: ConfigurationSnapshot): ObjectValue {
  if (snapshot.kind === "models") {
    const source = parsed(snapshot.files.models), settings = parsed(snapshot.files.settings), providers = configurationObject(source.providers ?? {});
    const string = (value: unknown) => typeof value === "string" ? value : undefined;
    return { kind: snapshot.kind, provider: string(settings.defaultProvider), model: string(settings.defaultModel), thinking: string(settings.defaultThinkingLevel),
      catalogModels: Object.entries(parsed(snapshot.files.catalog)).flatMap(([provider, raw]) => {
        if (!raw || typeof raw !== "object" || !Array.isArray((raw as ObjectValue).models)) return [];
        return ((raw as ObjectValue).models as unknown[]).flatMap(value => {
          if (!value || typeof value !== "object") return [];
          const model = publicModel(value);
          return typeof model.id === "string" && typeof model.contextWindow === "number" && typeof model.maxTokens === "number" ? [{ ...model, provider }] : [];
        });
      }),
      providers: Object.entries(providers).map(([id, raw]) => {
        const provider = configurationObject(raw);
        return { id, custom: typeof provider.baseUrl === "string", api: string(provider.api), baseUrl: publicUrl(provider.baseUrl),
          hasKey: provider.apiKey !== undefined, models: Array.isArray(provider.models) ? provider.models.map(publicModel) : [] };
      }) };
  }
  if (snapshot.kind === "app") {
    const app = snapshot.files.app === null ? undefined : parseAppBotConfig(parsed(snapshot.files.app));
    return { kind: snapshot.kind, appId: app?.appId ?? "", environment: app?.environment ?? "production", hasSecret: !!app?.appSecret, bound: snapshot.binding !== null };
  }
  const source = parsed(snapshot.files.relay), config = snapshot.files.relay === null ? null : validateRelayConfig(source);
  return { kind: snapshot.kind, enabled: config !== null, ...(config ? {
    endpoint: config.endpoint, region: config.region, bucket: config.bucket, prefix: config.prefix, forcePathStyle: config.forcePathStyle,
    maxBytes: config.maxBytes, expireHours: config.expireHours, cleanupGraceMinutes: config.cleanupGraceMinutes,
    hasAccessKey: true, hasSecret: true, hasToken: !!config.sessionToken,
  } : { prefix: "", forcePathStyle: false, maxBytes: DEFAULT_RELAY_MAX_BYTES, expireHours: DEFAULT_RELAY_EXPIRE_HOURS, cleanupGraceMinutes: DEFAULT_RELAY_CLEANUP_GRACE_MINUTES }) };
}

function secret(input: unknown, previous: unknown, canKeep = true, optional = false): unknown {
  const value = configurationObject(input); only(value, ["mode", "value"]);
  if (value.mode === "keep" && value.value === undefined && canKeep && previous !== undefined) return previous;
  if (value.mode === "set") return text(value.value);
  if (optional && value.mode === "clear" && value.value === undefined) return undefined;
  throw new Error("凭据不能沿用；请明确填写新值，或保留同一端点和账户");
}

/** Known-field patch, never a replacement of the raw native file. */
export function editConfiguration(base: ConfigurationSnapshot, input: unknown): ConfigurationSnapshot {
  const patch = configurationObject(input), next = structuredClone(base);
  if (base.kind === "app") {
    only(patch, ["appId", "environment", "secret"]);
    const previous = base.files.app === null ? undefined : parseAppBotConfig(parsed(base.files.app));
    const config = parseAppBotConfig({ appId: patch.appId, environment: patch.environment,
      appSecret: secret(patch.secret, previous?.appSecret, previous?.appId === patch.appId && previous?.environment === patch.environment) });
    if (base.binding !== null && base.binding !== applicationBinding(config)) throw new Error("现有数据属于另一个应用或环境；请在新目录全新部署");
    next.files.app = json(config); return next;
  }
  if (base.kind === "relay") {
    only(patch, ["enabled", "endpoint", "region", "bucket", "prefix", "forcePathStyle", "maxBytes", "expireHours", "cleanupGraceMinutes", "accessKey", "secret", "token"]);
    if (patch.enabled === false) { next.files.relay = null; return next; }
    if (patch.enabled !== true) throw new Error("请明确启用或停用外链");
    const previous = parsed(base.files.relay), endpoint = normalizeRelayUrlInput(patch.endpoint as string);
    const sameEndpoint = previous.endpoint === endpoint;
    const accessKeyId = secret(patch.accessKey, previous.accessKeyId, sameEndpoint);
    const sameAccount = sameEndpoint && previous.accessKeyId === accessKeyId;
    const value: ObjectValue = { ...previous, provider: "s3", endpoint, accessKeyId,
      secretAccessKey: secret(patch.secret, previous.secretAccessKey, sameAccount),
      sessionToken: secret(patch.token, previous.sessionToken, sameAccount, true) };
    for (const key of ["region", "bucket", "prefix", "forcePathStyle", "maxBytes", "expireHours", "cleanupGraceMinutes"]) value[key] = patch[key];
    next.files.relay = json({ ...value, ...validateRelayConfig(value) }); return next;
  }
  only(patch, ["provider", "mode", "api", "baseUrl", "key", "model", "thinking"]);
  const id = text(patch.provider); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("服务商 ID 无效");
  if (!["builtin", "custom"].includes(String(patch.mode))) throw new Error("请选择内置或自定义服务商");
  const source = parsed(base.files.models), providers = configurationObject(source.providers ?? {});
  const previous = Object.hasOwn(providers, id) ? configurationObject(providers[id]) : {};
  const api = patch.mode === "custom" ? text(patch.api) : previous.api;
  const baseUrl = patch.mode === "custom" ? text(patch.baseUrl) : undefined;
  if (baseUrl !== undefined && publicUrl(baseUrl) !== baseUrl) throw new Error("模型端点必须是无账号、查询参数和片段的 HTTP(S) 地址");
  // A native provider may contain arbitrary authentication headers or command references. Do not silently transfer it.
  if (Object.keys(previous).length && (previous.api !== api || previous.baseUrl !== baseUrl)) throw new Error("修改服务协议或端点请使用新的服务商 ID，避免把原有凭据和原生字段带到另一端点");
  const provider: ObjectValue = { ...previous, apiKey: secret(patch.key, previous.apiKey) };
  const model = typeof patch.model === "string" ? { id: text(patch.model) } : configurationObject(patch.model);
  const modelId = text(model.id);
  if (patch.mode === "custom") {
    only(model, ["id", "name", "contextWindow", "maxTokens", "input", "reasoning", "cost"]);
    provider.api = api; provider.baseUrl = baseUrl;
    const models = Array.isArray(previous.models) ? previous.models.map(configurationObject) : [];
    const before = models.find(value => value.id === modelId) ?? {};
    const edited: ObjectValue = { ...before, ...model, id: modelId, name: model.name ?? before.name ?? modelId };
    if (model.cost !== undefined) {
      const cost = configurationObject(model.cost); only(cost, ["input", "output", "cacheRead", "cacheWrite"]);
      const oldCost = before.cost && typeof before.cost === "object" ? before.cost as ObjectValue : {};
      const same = Object.keys(cost).every(key => cost[key] === oldCost[key]);
      edited.cost = same ? { ...oldCost, ...cost } : { ...cost };
    }
    provider.models = [...models.filter(value => value.id !== modelId), edited];
  } else if (typeof patch.model !== "string") throw new Error("内置模型只需选择模型 ID");
  const settings = parsed(base.files.settings), levels = configurationObject(settings.modelThinkingLevels ?? {});
  delete levels[`${id}/${modelId}`];
  const thinking = text(patch.thinking);
  next.files.models = json({ ...source, providers: { ...providers, [id]: provider } });
  next.files.settings = json({ ...settings, defaultProvider: id, defaultModel: modelId, defaultThinkingLevel: thinking, modelThinkingLevels: levels });
  return next;
}
