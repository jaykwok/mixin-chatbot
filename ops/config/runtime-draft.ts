// Host-safe runtime form and draft helpers. runtime-apply.ts applies a draft inside a configuration transaction (the ops
// core's runtime-configure step).
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ADVANCED_RUNTIME_KEYS, RUNTIME_DEFAULTS, RUNTIME_RANGES, validateRuntimeConfig, type AdvancedRuntimeKey, type RuntimeConfig } from "../../src/core/runtime-schema.ts";
import { RUNTIME_CONFIG_PATH } from "../../src/core/storage.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { runtimeDigest } from "./runtime-values.ts";
export interface RuntimeSnapshot { hash: string | null; values: RuntimeConfig }
export type RuntimeChanges = Partial<Record<AdvancedRuntimeKey, string | null>>;
export interface RuntimeDraft { expectedHash: string | null; changes: RuntimeChanges }
export const DRAFT_NAME = /^\.runtime-draft-[a-f0-9-]{36}\.json$/;

export async function currentFile(path: string, signal?: AbortSignal): Promise<string | null> {
  try { return await readFile(path, { encoding: "utf8", signal }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** 控制台按需读取；不导入 config.ts，不加载模型、数据库或维护依赖。 */
export async function readRuntimeSettings(path = RUNTIME_CONFIG_PATH, signal?: AbortSignal): Promise<RuntimeSnapshot> {
  const raw = await currentFile(path, signal);
  return { hash: runtimeDigest(raw), values: validateRuntimeConfig(raw === null ? {} : JSON.parse(raw)) };
}

export function validateChanges(value: unknown): RuntimeChanges {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) {
    throw new Error("没有待保存的运行参数");
  }
  const changes: RuntimeChanges = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!(ADVANCED_RUNTIME_KEYS as readonly string[]).includes(key)) throw new Error("此设置不可在高级运行参数中修改：" + key);
    const name = key as AdvancedRuntimeKey;
    changes[name] = setting === null ? null : validateRuntimeConfig({ [key]: setting })[name]!;
  }
  return changes;
}

function mergeChanges(values: RuntimeConfig, changes: RuntimeChanges): RuntimeConfig {
  const next = { ...values };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key as AdvancedRuntimeKey];
    else next[key as AdvancedRuntimeKey] = value;
  }
  return validateRuntimeConfig(next);
}

export function validateRuntimeDraft(value: unknown): RuntimeDraft {
  const draft = value as RuntimeDraft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft) || Object.keys(draft).sort().join(",") !== "changes,expectedHash"
    || draft.expectedHash !== null && (typeof draft.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(draft.expectedHash)))
    throw new Error("运行参数草稿无效，请重新打开设置");
  return { expectedHash: draft.expectedHash, changes: validateChanges(draft.changes) };
}

/** Keep the same explicit environment override rule in deployment tools and the shared host workflow. */
export function nextRuntimeDraft(raw: string | null, draft: RuntimeDraft, env: NodeJS.ProcessEnv): string {
  if (runtimeDigest(raw) !== draft.expectedHash) throw new Error("runtime.json 已被其他操作修改；本次未覆盖配置，请放弃草稿并重新读取");
  const config = mergeChanges(validateRuntimeConfig(raw === null ? {} : JSON.parse(raw)), draft.changes);
  for (const key of Object.keys(draft.changes) as AdvancedRuntimeKey[]) {
    const override = env[key]?.trim(); if (!override) continue;
    const desired = config[key] ?? RUNTIME_DEFAULTS[key], actual = validateRuntimeConfig({ [key]: override })[key];
    if (key in RUNTIME_RANGES ? Number(actual) !== Number(desired) : actual !== desired)
      throw new Error(key + " 被显式环境变量覆盖，请先移除该环境覆盖后再保存；配置尚未写入");
  }
  return JSON.stringify(config, null, 2) + "\n";
}

export async function writeRuntimeDraft(snapshot: RuntimeSnapshot, changes: RuntimeChanges, path = RUNTIME_CONFIG_PATH): Promise<string> {
  const draft: RuntimeDraft = { expectedHash: snapshot.hash, changes: validateChanges(changes) };
  const target = join(dirname(path), ".runtime-draft-" + randomUUID() + ".json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(draft) + "\n", { mode: 0o600, flag: "wx" });
  return target;
}

/** 预览有效 10 分钟；留一天余量，接单后排队的任务仍能读到自己的草稿。 */
const DRAFT_KEEP_MS = 24 * 3600_000;

/**
 * 控制台每次预览运行参数都写一份草稿，放弃的预览不会再回来取；下次预览时删掉一天前的草稿。
 * 运维核心已接单、尚未收尾的草稿留给核心按记录清理。
 */
export async function sweepRuntimeDrafts(path = RUNTIME_CONFIG_PATH, now = Date.now()): Promise<void> {
  const dir = dirname(path), record = readOpsMaintenanceRecord(dirname(dirname(dir)));
  const owned = record && !record.result ? record.runtimeDraft?.name : undefined;
  let names: string[];
  try { names = await readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const name of names) {
    if (!DRAFT_NAME.test(name) || name === owned) continue;
    const info = await lstat(join(dir, name)).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > DRAFT_KEEP_MS) await rm(join(dir, name), { force: true });
  }
}

