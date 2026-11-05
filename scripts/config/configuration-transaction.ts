// Called under the deployment lock; apply/restore also require the existing service maintenance lease.
import { lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { publish } from "../lib/atomic-file.ts";
import { windowsPrivateOwner } from "../lib/windows-private-directory.ts";
import { assertConfigurationBase, configurationFiles, configurationHash, CONFIGURATION_FILES, configurationSnapshot, readConfigurationFile,
  type ConfigurationSnapshot, type StoredConfigurationKind } from "./configuration-form.ts";
import { CONFIGURATION_STATE_FILE, readConfigurationState, type ConfigurationState } from "../../src/core/configuration-state.ts";

type Hook = (point: string) => Promise<void>;
const marker = (project: string) => join(project, CONFIGURATION_STATE_FILE);
const recoveryDir = (project: string, id: string) => {
  if (!/^config-[a-f0-9]{32}$/.test(id)) throw new Error("配置事务编号无效");
  return join(project, "data/config", "." + id);
};
async function writeState(project: string, value: ConfigurationState): Promise<void> { await publish(marker(project), JSON.stringify(value) + "\n"); }
async function savedFile(project: string, state: ConfigurationState, key: string, side: "before" | "after", expected: string | null): Promise<string | null> {
  if (expected === null) return null;
  const directory = recoveryDir(project, state.id), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("配置恢复目录无效");
  const path = join(directory, `${key}.${side}`), file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 8 * 1024 * 1024) throw new Error("配置恢复文件无效");
  const raw = await readFile(path, "utf8");
  if (configurationHash(raw) !== expected) throw new Error("配置恢复文件摘要不符，已保留现场");
  return raw;
}
async function install(project: string, key: keyof typeof CONFIGURATION_FILES, raw: string | null): Promise<void> {
  const path = join(project, CONFIGURATION_FILES[key]);
  // Check ancestor/file identities via the same restricted reader before any replacement or deletion.
  readConfigurationFile(project, key);
  if (raw === null) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true });
  // The owner of the file it replaces (or of its directory), set before the rename like every other configuration writer.
  const owner = await stat(path).catch(error => { if (error.code === "ENOENT") return stat(dirname(path)); throw error; });
  await publish(path, raw, { owner: { uid: owner.uid, gid: owner.gid } });
}
function active(project: string, id: string): ConfigurationState {
  const state = readConfigurationState(project);
  if (!state || state.id !== id) throw new Error("配置事务记录不匹配，未执行恢复或清理");
  if (configurationSnapshot(project, state.kind).binding !== state.binding) throw new Error("应用身份已变化，不能恢复这份配置");
  return state;
}

export async function applyConfiguration(project: string, id: string, base: ConfigurationSnapshot<StoredConfigurationKind>, next: ConfigurationSnapshot<StoredConfigurationKind>, hook?: Hook): Promise<void> {
  recoveryDir(project, id);
  if (readConfigurationState(project)) throw new Error("存在未结束的配置事务，请先恢复或完成它");
  if (base.kind !== next.kind || base.binding !== next.binding) throw new Error("配置草稿身份不符");
  assertConfigurationBase(project, base);
  const state: ConfigurationState = { version: 1, id, kind: base.kind, phase: "publishing", binding: base.binding,
    rows: configurationFiles(base.kind).map(key => ({ key, before: configurationHash(base.files[key]!), after: configurationHash(next.files[key]!) })) };
  const directory = recoveryDir(project, id);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  // Require a new directory; a previous interrupted staging attempt must be inspected, not overwritten.
  try { await lstat(directory); throw new Error("配置恢复目录已存在，已保留现场"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (process.platform === "win32") windowsPrivateOwner(directory);
  else await mkdir(directory, { mode: 0o700 });
  for (const row of state.rows) {
    if (row.before !== null) await publish(join(directory, `${row.key}.before`), base.files[row.key]!);
    if (row.after !== null) await publish(join(directory, `${row.key}.after`), next.files[row.key]!);
  }
  // Both restoration and next bytes are durable before the first marker permits any official file to change.
  await writeState(project, state); await hook?.("prepared");
  for (const row of state.rows) {
    const current = configurationHash(readConfigurationFile(project, row.key));
    if (current !== row.before) throw new Error("发布期间配置已变化，停止并保留恢复材料");
    await install(project, row.key, await savedFile(project, state, row.key, "after", row.after)); await hook?.(`installed:${row.key}`);
  }
  for (const row of state.rows) if (configurationHash(readConfigurationFile(project, row.key)) !== row.after) throw new Error("配置发布后的摘要不符，已保留恢复材料");
  state.phase = "ready"; await writeState(project, state); await hook?.("ready");
}

/**
 * Read-only: every official file still holds this transaction's old or new bytes. The operator's restore checks this
 * before the stop (configuration-apply.ts restore-check): a restore that could only refuse must neither stop a running
 * bot nor leave the restoring marker that keeps it from starting.
 */
export function assertRestorable(project: string, id: string): void {
  const state = active(project, id);
  for (const row of state.rows) {
    const current = configurationHash(readConfigurationFile(project, row.key));
    if (current !== row.before && current !== row.after) {
      throw new Error(`${CONFIGURATION_FILES[row.key as keyof typeof CONFIGURATION_FILES]} 已被其他操作修改，与这次配置的原文件和新文件都不同，没有覆盖。`
        + `确认现在的配置正确后，删除 ${CONFIGURATION_STATE_FILE} 和 data/config/.${state.id}/ 即可结束这个事务`);
    }
  }
}

/** Idempotent after interruption at any file boundary. Never overwrite a third party's different bytes. */
export async function restoreConfiguration(project: string, id: string, hook?: Hook): Promise<void> {
  const state = active(project, id);
  if (state.phase === "committed") throw new Error("配置已确认完成，不能再回滚这次事务");
  if (state.phase === "rolled-back") return;
  // A recovery failure must remain a startup blocker, including a bad backup or another writer's bytes found before any
  // target is touched: recovering a failed or interrupted change keeps such a deployment stopped.
  state.phase = "restoring"; await writeState(project, state); await hook?.("restoring");
  // Verify every recovery byte and every target before writing the first old file back.
  const originals = new Map<string, string | null>();
  for (const row of state.rows) originals.set(row.key, await savedFile(project, state, row.key, "before", row.before));
  assertRestorable(project, id);
  for (const row of [...state.rows].reverse()) {
    const current = configurationHash(readConfigurationFile(project, row.key));
    if (current !== row.before && current !== row.after) throw new Error("恢复期间配置发生变化，停止恢复");
    if (current !== row.before) await install(project, row.key, originals.get(row.key)!);
    await hook?.(`restored:${row.key}`);
  }
  state.phase = "rolled-back"; await writeState(project, state); await hook?.("rolled-back");
}

/** After readiness succeeded (or restoration completed). No service lease: the bot may already be running again. */
export async function finishConfiguration(project: string, id: string): Promise<void> {
  const state = active(project, id);
  if (!["ready", "committed", "rolled-back"].includes(state.phase)) throw new Error("配置尚未完成发布或恢复，不能删除恢复材料");
  const side = state.phase === "rolled-back" ? "before" : "after";
  for (const row of state.rows) if (configurationHash(readConfigurationFile(project, row.key)) !== row[side]) throw new Error("配置摘要已变化，未清理恢复材料");
  if (state.phase === "ready") { state.phase = "committed"; await writeState(project, state); }
  const directory = resolve(recoveryDir(project, id));
  const info = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("配置恢复目录被替换，未删除");
  await rm(directory, { recursive: true, force: true }); await rm(marker(project));
}
