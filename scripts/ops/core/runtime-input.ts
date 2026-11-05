import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validateOpsRuntimeDraft, type OpsRuntimeDraft } from "../../../src/contracts/ops-runtime-draft.ts";
import { readConfigurationState } from "../../../src/core/configuration-state.ts";
import { DRAFT_NAME, validateRuntimeDraft } from "../../config/runtime-draft.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function selected(project: string, name: string): string {
  if (!DRAFT_NAME.test(name)) throw new Error("运行参数草稿名称无效");
  for (const path of [join(project, "data"), join(project, "data/config")]) {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("运行参数目录不是普通目录");
  }
  return join(project, "data/config", name);
}
function read(project: string, name: string): { bytes: Buffer; record: OpsRuntimeDraft } {
  const path = selected(project, name), info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 64n * 1024n
    || process.platform !== "win32" && (Number(info.uid) !== process.geteuid!() || (Number(info.mode) & 0o077))) throw new Error("运行参数草稿类型、属主或权限不符");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd, { bigint: true });
    if (actual.dev !== info.dev || actual.ino !== info.ino || actual.size !== info.size) throw new Error("读取前运行参数草稿被替换");
    const buffer = Buffer.alloc(Number(actual.size) + 1); let length = 0, count: number;
    // Even a concurrently growing file can consume only this bounded allocation.
    do { count = readSync(fd, buffer, length, buffer.length - length, length); length += count; } while (count && length < buffer.length);
    const after = fstatSync(fd, { bigint: true });
    if (length !== Number(actual.size) || after.size !== actual.size || after.mtimeNs !== actual.mtimeNs || after.ctimeNs !== actual.ctimeNs) throw new Error("读取期间运行参数草稿变化");
    const bytes = buffer.subarray(0, length);
    return { bytes, record: { name, digest: hash(bytes), dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), phase: "captured" } };
  } finally { closeSync(fd); }
}

export async function captureRuntimeInput(project: string, name: string, save: (record: OpsRuntimeDraft) => Promise<void>) {
  const selectedInput = read(project, name);
  // Parsers may quote JSON fragments or unknown keys. Neither belongs in a durable task result or its logs.
  try { validateRuntimeDraft(JSON.parse(selectedInput.bytes.toString("utf8"))); }
  catch { throw new Error("运行参数草稿无效，请重新打开设置"); }
  await save(selectedInput.record); return { input: selectedInput.bytes, digest: selectedInput.record.digest };
}

export async function removeRuntimeInput(project: string, record: OpsRuntimeDraft, configuration: string, save: (record: OpsRuntimeDraft) => Promise<void>) {
  validateOpsRuntimeDraft(record);
  if (record.phase === "removed") return;
  if (readConfigurationState(project)) throw new Error("配置事务尚未收尾，运行参数草稿已保留");
  const path = selected(project, record.name);
  let actual: ReturnType<typeof read> | undefined;
  try { actual = read(project, record.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (actual) {
    if (["dev", "ino", "uid", "digest"].some(key => actual!.record[key as keyof OpsRuntimeDraft] !== record[key as keyof OpsRuntimeDraft]))
      throw new Error("运行参数草稿已被替换或修改，未删除");
    if (!/^config-[a-f0-9]{32}$/.test(configuration)) throw new Error("运行参数事务身份无效");
    unlinkSync(path);
  }
  await save({ ...record, phase: "removed" });
}
