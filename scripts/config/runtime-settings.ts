import { createHash, randomUUID } from "node:crypto";
import { chown, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  ADVANCED_RUNTIME_KEYS, RUNTIME_DEFAULTS, RUNTIME_KEYS, RUNTIME_RANGES, validateRuntimeConfig,
  type AdvancedRuntimeKey, type RuntimeConfig,
} from "../../src/core/runtime-schema.ts";
import { RUNTIME_CONFIG_PATH } from "../../src/core/storage.ts";

export interface RuntimeSnapshot { hash: string | null; values: RuntimeConfig }
export type RuntimeChanges = Partial<Record<AdvancedRuntimeKey, string | null>>;
interface RuntimeDraft { expectedHash: string | null; changes: RuntimeChanges }
const DRAFT_NAME = /^\.runtime-draft-[a-f0-9-]{36}\.json$/;
const fingerprint = (raw: string | null) => raw === null ? null : createHash("sha256").update(raw).digest("hex");

async function currentFile(path: string, signal?: AbortSignal): Promise<string | null> {
  try { return await readFile(path, { encoding: "utf8", signal }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** TUI 只在进入此设置时读取；不导入 config.ts，不加载模型、数据库或维护依赖。 */
export async function readRuntimeSettings(path = RUNTIME_CONFIG_PATH, signal?: AbortSignal): Promise<RuntimeSnapshot> {
  const raw = await currentFile(path, signal);
  return { hash: fingerprint(raw), values: validateRuntimeConfig(raw === null ? {} : JSON.parse(raw)) };
}

function validateChanges(value: unknown): RuntimeChanges {
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

export async function writeRuntimeDraft(snapshot: RuntimeSnapshot, changes: RuntimeChanges, path = RUNTIME_CONFIG_PATH): Promise<string> {
  const draft: RuntimeDraft = { expectedHash: snapshot.hash, changes: validateChanges(changes) };
  const target = join(dirname(path), ".runtime-draft-" + randomUUID() + ".json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(draft) + "\n", { mode: 0o600, flag: "wx" });
  return target;
}

/** 失败且尚未恢复时保留回滚材料；普通取消或失败只移除本次草稿。 */
export async function discardRuntimeDraft(path: string): Promise<void> {
  if (!DRAFT_NAME.test(basename(path))) throw new Error("运行参数草稿路径无效");
  if (await currentFile(path + ".rollback") === null) await rm(path, { force: true });
}

async function writeAtomic(path: string, raw: string): Promise<void> {
  const { replaceFile } = await import("../../src/core/maintenance.ts");
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), ".runtime-" + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") {
      const owner = await stat(path).catch(error => {
        if (error.code === "ENOENT") return stat(dirname(path));
        throw error;
      });
      await chown(temporary, owner.uid, owner.gid);
    }
    await replaceFile(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Persist explicit deployment settings, including supported values inherited from the shell. */
export async function saveRuntimeSettings(path = RUNTIME_CONFIG_PATH, env = process.env): Promise<void> {
  const settings = (await readRuntimeSettings(path)).values;
  for (const name of RUNTIME_KEYS) if (env[name]?.trim()) settings[name] = env[name]!.trim();
  await writeAtomic(path, JSON.stringify(validateRuntimeConfig(settings), null, 2) + "\n");
}

async function readDraft(name: string): Promise<{ path: string; draft: RuntimeDraft }> {
  if (!DRAFT_NAME.test(name)) throw new Error("运行参数草稿名称无效，请重新打开设置");
  const path = join(dirname(RUNTIME_CONFIG_PATH), name);
  const draft = JSON.parse(await readFile(path, "utf8")) as RuntimeDraft;
  if (!draft || (draft.expectedHash !== null &&
      (typeof draft.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(draft.expectedHash)))) {
    throw new Error("运行参数草稿无效，请重新打开设置");
  }
  return { path, draft: { expectedHash: draft.expectedHash, changes: validateChanges(draft.changes) } };
}

async function checkDraft(name: string) {
  const { path, draft } = await readDraft(name);
  const raw = await currentFile(RUNTIME_CONFIG_PATH);
  if (fingerprint(raw) !== draft.expectedHash) {
    throw new Error("runtime.json 已被其他操作修改；本次未覆盖配置，请放弃草稿并重新读取");
  }
  const config = mergeChanges(validateRuntimeConfig(raw === null ? {} : JSON.parse(raw)), draft.changes);
  for (const key of Object.keys(draft.changes) as AdvancedRuntimeKey[]) {
    const override = process.env[key]?.trim();
    if (!override) continue;
    const desired = config[key] ?? RUNTIME_DEFAULTS[key];
    const actual = validateRuntimeConfig({ [key]: override })[key];
    const numeric = key in RUNTIME_RANGES;
    if (numeric ? Number(actual) !== Number(desired) : actual !== desired) {
      throw new Error(key + " 被显式环境变量覆盖，请先移除该环境覆盖后再保存；配置尚未写入");
    }
  }
  return { path, draft, raw, next: JSON.stringify(config, null, 2) + "\n" };
}

async function applyDraft(name: string): Promise<void> {
  const { withMaintenance } = await import("../../src/core/maintenance.ts");
  await withMaintenance(async () => {
    const { path, raw, next } = await checkDraft(name);
    // 先持久化恢复材料；停机、发布或健康检查失败均可恢复原文件（含原格式）。
    await writeFile(path + ".rollback", JSON.stringify({ previous: raw, appliedHash: fingerprint(next) }) + "\n",
      { mode: 0o600, flag: "wx" });
    await writeAtomic(RUNTIME_CONFIG_PATH, next);
    console.log("高级运行参数已保存。");
  });
}

async function rollbackDraft(name: string): Promise<void> {
  const { withMaintenance } = await import("../../src/core/maintenance.ts");
  await withMaintenance(async () => {
    const { path, draft } = await readDraft(name);
    const receipt = await currentFile(path + ".rollback");
    if (receipt === null) return;
    const saved = JSON.parse(receipt) as { previous: string | null; appliedHash: string };
    if (!saved || (saved.previous !== null && typeof saved.previous !== "string") ||
        fingerprint(saved.previous) !== draft.expectedHash) throw new Error("运行参数恢复材料无效，已保留现场");
    const previous = validateRuntimeConfig(saved.previous === null ? {} : JSON.parse(saved.previous));
    const expectedApplied = fingerprint(JSON.stringify(mergeChanges(previous, draft.changes), null, 2) + "\n");
    if (saved.appliedHash !== expectedApplied) throw new Error("运行参数恢复材料不匹配，已保留现场");
    const currentHash = fingerprint(await currentFile(RUNTIME_CONFIG_PATH));
    if (currentHash !== draft.expectedHash) {
      if (currentHash !== saved.appliedHash) throw new Error("runtime.json 又被修改，未覆盖新配置，已保留恢复材料");
      if (saved.previous === null) await rm(RUNTIME_CONFIG_PATH, { force: true });
      else await writeAtomic(RUNTIME_CONFIG_PATH, saved.previous);
    }
    await rm(path + ".rollback", { force: true });
    console.log("已恢复原运行参数。");
  });
}

if (import.meta.main) {
  try {
    const [mode, name, extra] = process.argv.slice(2);
    if (!mode) {
      const { withMaintenance } = await import("../../src/core/maintenance.ts");
      await withMaintenance(() => saveRuntimeSettings());
      console.log("运行配置已保存到 " + RUNTIME_CONFIG_PATH);
    } else if (!name || extra) throw new Error("请从「系统 → 设置 → 高级运行参数」编辑并保存");
    else if (mode === "--check") { await checkDraft(name); console.log("运行参数校验通过，准备应用。"); }
    else if (mode === "--apply") await applyDraft(name);
    else if (mode === "--rollback") await rollbackDraft(name);
    else throw new Error("无法识别的运行参数操作");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
