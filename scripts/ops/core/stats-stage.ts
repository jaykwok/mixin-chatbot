// A disposable, private copy of one explicitly selected statistics snapshot. No source path or member identity is
// written to recovery metadata. The durable intent precedes directory creation; contents follow its recorded inode.
import { constants, lstatSync, statSync } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { statsFileScope, assertExpectedScope } from "../../lib/operation-scope.ts";
import { appLayout } from "../../../src/core/layout.ts";
import { windowsPrivateOwner } from "../../lib/windows-private-directory.ts";

export interface StatsStageRecord {
  version: 1;
  kind: "stats-import";
  id: string;
  owner: { uid: number; gid: number };
  phase: "prepared" | "created" | "ready" | "removed";
  directory?: { dev: string; ino: string };
  digest?: string;
}
export type SaveStatsStage = (record: StatsStageRecord) => Promise<void>;
export const statsStagePath = (project: string, record: StatsStageRecord) => {
  if (!/^[a-f0-9]{32}$/.test(record.id)) throw new Error("统计副本编号无效");
  return join(resolve(project), "backup", ".stat-import-" + record.id);
};
const identity = (stat: { dev: bigint; ino: bigint }) => ({ dev: String(stat.dev), ino: String(stat.ino) });
async function syncDirectory(path: string) {
  if (process.platform !== "win32") { const fd = await open(path, "r"); try { await fd.sync(); } finally { await fd.close(); } }
}
function parent(project: string): string {
  const path = join(resolve(project), "backup"), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("统计副本的备份目录不是普通目录");
  return path;
}

/** Reject importing this deployment's own live ledger, including an alias/hard link, before creating the copy. */
export function validateStatsSource(project: string, source: string, expected?: string): string {
  const stat = lstatSync(source, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("统计文件必须是普通文件");
  const target = appLayout(join(resolve(project), "data")).stats;
  if (resolve(source) === target) throw new Error("不能导入当前部署的统计账本");
  try {
    const current = statSync(target, { bigint: true });
    if (current.dev === stat.dev && current.ino === stat.ino) throw new Error("不能导入当前部署的统计账本或其别名");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const digest = statsFileScope(source); assertExpectedScope(expected, digest); return digest;
}

async function copyPart(source: string, target: string, owner: StatsStageRecord["owner"], signal?: AbortSignal) {
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("统计文件及 WAL 必须是普通文件");
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await input.stat({ bigint: true });
    if (!held.isFile() || held.dev !== before.dev || held.ino !== before.ino) throw new Error("统计文件在读取前被替换");
    const output = await open(target, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(256 * 1024);
      for (;;) {
        signal?.throwIfAborted(); const { bytesRead } = await input.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        // writeFile on the open handle accounts for partial writes; each read is bounded.
        await output.writeFile(buffer.subarray(0, bytesRead));
      }
      if (process.platform !== "win32") await output.chown(owner.uid, owner.gid);
      await output.sync();
    } finally { await output.close(); }
  } finally { await input.close(); }
}

export async function prepareStatsStage(project: string, record: StatsStageRecord, source: string, digest: string, save: SaveStatsStage, signal?: AbortSignal): Promise<StatsStageRecord> {
  if (record.phase !== "prepared" || record.directory || record.digest) throw new Error("统计副本不是新请求");
  const backup = parent(project), directory = statsStagePath(project, record);
  // Existing paths are not attributed to this operation; refusal happens before its intent is published.
  try { await lstat(directory); throw new Error("统计副本路径已存在，未复用"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await save(record); signal?.throwIfAborted();
  if (process.platform === "win32") windowsPrivateOwner(directory);
  else await mkdir(directory, { mode: 0o700 });
  if (process.platform !== "win32") { await chmod(directory, 0o700); await chown(directory, record.owner.uid, record.owner.gid); }
  await syncDirectory(backup);
  record = { ...record, phase: "created", directory: identity(await lstat(directory, { bigint: true })) }; await save(record);
  await copyPart(source, join(directory, "stats.sqlite"), record.owner, signal);
  let wal = false;
  try { await lstat(source + "-wal"); wal = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (wal) await copyPart(source + "-wal", join(directory, "stats.sqlite-wal"), record.owner, signal);
  await syncDirectory(directory);
  assertExpectedScope(digest, statsFileScope(source)); assertExpectedScope(digest, statsFileScope(join(directory, "stats.sqlite")));
  record = { ...record, phase: "ready", digest }; await save(record); return record;
}

/** Caller holds deploy.lock and has reaped every data writer. Only the recorded directory and exact known files go. */
export async function removeStatsStage(project: string, record: StatsStageRecord, save: SaveStatsStage): Promise<void> {
  const backup = parent(project), directory = statsStagePath(project, record);
  let stat;
  try { stat = await lstat(directory, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await save({ ...record, phase: "removed" }); return; }
  if (record.phase === "removed") throw new Error("已删除的统计副本路径再次出现，未删除新内容");
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((stat.mode & 0o777n) !== 0o700n
    || ![BigInt(record.owner.uid), BigInt(process.geteuid!())].includes(stat.uid)))) throw new Error("统计副本目录身份或权限不符，现场已保留");
  if (record.directory && JSON.stringify(identity(stat)) !== JSON.stringify(record.directory)) throw new Error("统计副本目录已被替换，现场已保留");
  if (process.platform === "win32") windowsPrivateOwner(directory);
  const files = await readdir(directory);
  // Before the inode was saved no content writer was allowed. An empty mkdir is the only uncertain case we settle.
  if (!record.directory && files.length) throw new Error("统计副本尚未记录身份却包含文件，现场已保留");
  if (files.some(name => !["stats.sqlite", "stats.sqlite-wal"].includes(name))) throw new Error("统计副本含有不属于本次操作的文件，现场已保留");
  for (const name of files) {
    const info = await lstat(join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("统计副本文件身份异常，现场已保留");
  }
  for (const name of files) await unlink(join(directory, name));
  await rmdir(directory); await syncDirectory(backup); await save({ ...record, phase: "removed" });
}
