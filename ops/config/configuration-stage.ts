// 停机前答完的配置：配置向导把读到的现有文件（base）和回答后的文件（next）写进私有暂存目录。部署（应用机器人、模型）由部署
// 快照保存这份暂存，停机后由目标版本的 configuration-install.ts 写入；单独修改配置（命令行的 model-configure、configure-app-bot、
// relay-configure）由运维核心把它当作已确认的网页配置草稿发布。格式与网页配置草稿共用 ConfigurationSnapshot。
// 只引用内置模块和本项目不依赖 npm 包的模块：宿主机上的运维核心在没有 node_modules 时也要解析这个格式。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { publish } from "../../src/lib/atomic-file.ts";
import { configurationFiles, configurationHash, configurationSnapshot, CONFIGURATION_FILES, CONFIGURATION_KINDS, type ConfigurationKind,
  type ConfigurationSnapshot } from "./configuration-form.ts";

/** What a deployment can stage; relay is configured on its own only. */
export const STAGED_KINDS = ["app", "models"] as const;
export type StagedKind = typeof STAGED_KINDS[number];
export interface ConfigurationStage<K extends ConfigurationKind = ConfigurationKind> { version: 1; base: ConfigurationSnapshot<K>; next: ConfigurationSnapshot<K> }
export const stageName = (kind: ConfigurationKind) => `configuration-${kind}.json`;
/** The kind a stage file name stands for, or undefined. */
export const stageKind = (name: string) => CONFIGURATION_KINDS.find(kind => stageName(kind) === name);
const LABEL: Record<ConfigurationKind, string> = { app: "应用机器人配置", models: "模型配置", relay: "外链配置" };
/** next must carry what the service needs to start; the catalogue cache may be absent, and relay.json absent disables relay. */
const REQUIRED: Record<ConfigurationKind, string[]> = { app: ["app"], models: ["models", "settings"], relay: [] };

function snapshotValid(value: unknown, kind: ConfigurationKind, next: boolean): boolean {
  const snapshot = value as ConfigurationSnapshot | null, keys: string[] = configurationFiles(kind);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || Object.keys(snapshot).sort().join(",") !== "binding,files,kind"
    || snapshot.kind !== kind || (snapshot.binding !== null && (typeof snapshot.binding !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.binding)))
    || !snapshot.files || typeof snapshot.files !== "object" || Array.isArray(snapshot.files)
    || Object.keys(snapshot.files).sort().join(",") !== [...keys].sort().join(",")) return false;
  const files = snapshot.files as Record<string, unknown>;
  return keys.every(key => files[key] === null && !(next && REQUIRED[kind].includes(key)) || typeof files[key] === "string");
}

/** Strict, and never quotes the content: the stage holds credentials. */
export function parseConfigurationStage<K extends ConfigurationKind>(raw: string, kind: K): ConfigurationStage<K> {
  let value: ConfigurationStage<K>;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`暂存的${LABEL[kind]}无法读取`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "base,next,version" || value.version !== 1
    || !snapshotValid(value.base, kind, false) || !snapshotValid(value.next, kind, true) || value.base.binding !== value.next.binding)
    throw new Error(`暂存的${LABEL[kind]}格式不支持`);
  return value;
}
export const serializeConfigurationStage = (stage: ConfigurationStage) => JSON.stringify(stage) + "\n";

/** Same application binding and the same bytes in every file of the kind. */
export const sameConfiguration = (a: ConfigurationSnapshot, b: ConfigurationSnapshot) => a.binding === b.binding
  && configurationFiles(a.kind).every(key => configurationHash(a.files[key] ?? null) === configurationHash(b.files[key] ?? null));

/**
 * Publishes next over an unchanged base. Returns false when next was already in place. Compared file by file: an attempt
 * interrupted between two files left some at next and the rest at base, and resuming writes only the rest.
 */
export async function installConfigurationStage(project: string, stage: ConfigurationStage<StagedKind>): Promise<boolean> {
  // The restricted reader refuses a linked ancestor, a non-file or an oversized file before anything is replaced.
  const current = configurationSnapshot(project, stage.base.kind);
  if (sameConfiguration(current, stage.next)) return false;
  const hash = (snapshot: ConfigurationSnapshot, key: keyof typeof CONFIGURATION_FILES) => configurationHash(snapshot.files[key] ?? null);
  const keys = configurationFiles(stage.base.kind);
  if (current.binding !== stage.base.binding || keys.some(key => hash(current, key) !== hash(stage.base, key) && hash(current, key) !== hash(stage.next, key)))
    throw new Error(`${LABEL[stage.base.kind]}在停机前确认之后被改动，没有覆盖`);
  for (const key of keys) {
    if (hash(current, key) === hash(stage.next, key)) continue;
    const path = join(project, CONFIGURATION_FILES[key]), raw = stage.next.files[key] ?? null;
    if (raw === null) await rm(path, { force: true }); else await publish(path, raw);
  }
  if (!sameConfiguration(configurationSnapshot(project, stage.base.kind), stage.next)) throw new Error(`${LABEL[stage.base.kind]}写入后的摘要不符`);
  return true;
}
