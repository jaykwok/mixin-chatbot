// Swapping a conversation database for a checked copy under a recovery record (revision-chain plan §4.6, §8.3). Shared by
// the offline shrink (the copy is a compact VACUUM INTO of the database) and the restore from a cleanup backup (the copy
// is the backup). The callers write and check the copy; this module does the rest and recovers an interrupted swap.
//
// The files are all in the database's directory (one volume): durable.sqlite (with -wal and -shm), the copy
// durable.sqlite.<kind>-<run>.new and the kept original durable.sqlite.<kind>-<run>.old (with .old-wal, .old-shm).
//   1. checkpoint (TRUNCATE, busy 0, WAL empty) and close every connection of this process (`emptyWal`);
//   2. the caller writes the copy (in WAL mode, with the original's mode bits) and checks it (`verified`);
//   3. rename the original and its -wal and -shm to .old (`old-kept`);
//   4. rename the copy to durable.sqlite (`installed`);
//   5. check the installed copy: quick_check, WAL mode, the Durable metadata it must carry; then the caller's `finished`.
// Recovery accepts only the combinations of record state and files of the plan's table, by file identity and the copy's
// digest (also once it is installed, with nothing in its WAL); anything else stops and keeps the service stopped.
import { existsSync, statSync } from "node:fs";
import { chmod, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { fileDigest, syncPath } from "./backup.ts";
import { fileIdentity, metadata, sameFile, type FileIdentity } from "./inspect.ts";

/** `writing` → `verified` → `old-kept` → `installed`; a checked replacement leaves its record. */
export type ReplacementState = "writing" | "verified" | "old-kept" | "installed";
export type Replacement = {
  space: string;
  state: ReplacementState;
  original: { file: FileIdentity; bytes: number; nextSeq: number; nextId: string };
  copy?: { file: FileIdentity; bytes: number; sha256: string };
  startedAt: number;
};

/** Points between the steps, for tests that end the process there. */
export type ReplacePoint = "writing" | "verified" | "old-kept" | "installed" | "checked";

export const sizeOf = (path: string): number => existsSync(path) ? statSync(path).size : 0;

/** The files of one replacement; `kind` names the operation in the file names. */
export function replacementFiles(path: string, kind: "shrink" | "restore", run: string) {
  const base = `${path}.${kind}-${run}`;
  return { main: path, wal: `${path}-wal`, shm: `${path}-shm`, copy: `${base}.new`, copyWal: `${base}.new-wal`, copyShm: `${base}.new-shm`,
    old: `${base}.old`, oldWal: `${base}.old-wal`, oldShm: `${base}.old-shm` };
}
export type Files = ReturnType<typeof replacementFiles>;

/** What the recovery of an unfinished replacement did: dropped it, put the original back, or finished it. */
export type Recovered = "void" | "restored" | "done";

export interface ReplacementHost {
  readonly current: Replacement;
  readonly files: Files;
  /** The Durable metadata the installed database must carry. */
  readonly expected: { nextSeq: number; nextId: string };
  /** Names in messages: the record ("收缩记录") and the kept original ("原库"). */
  readonly words: { record: string; kept: string };
  save(): Promise<void>;
  point(point: ReplacePoint): Promise<void>;
  /** The error that stops the operation (nothing more is changed). */
  stopped(message: string): Error;
  /** Step 5 passed: the caller moves the replacement out of its record. */
  finished(after: number): Promise<void>;
  /** The replacement was dropped or the original put back: the caller clears it from its record. */
  dropped(): Promise<void>;
  log?(line: string): void;
}

const identityOf = (path: string): FileIdentity | undefined => existsSync(path) ? fileIdentity(path) : undefined;

/** Renames `from` to `to` when `from` exists; `to` must not. */
async function move(host: ReplacementHost, from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  if (existsSync(to)) throw host.stopped(`无法改名 ${from}：${to} 已存在`);
  await rename(from, to);
}

/**
 * Step 1: nothing of the database may stay in a WAL that is renamed away with the original. Returns the error to throw
 * when the WAL could not be emptied (nothing was changed), or undefined.
 */
export function emptyWal(path: string, space: string): string | undefined {
  const db = new Database(path);
  try {
    const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    if (result.busy !== 0 || sizeOf(`${path}-wal`) !== 0) return `${space} 的 WAL 未能截断（busy ${result.busy}，WAL ${sizeOf(`${path}-wal`)} 字节），没有改动`;
  } finally { db.close(); }
  if (sizeOf(`${path}-wal`) !== 0) return `${space} 关闭连接后 WAL 仍有 ${sizeOf(`${path}-wal`)} 字节，没有改动`;
  return undefined;
}

/**
 * A connection that refuses writes, for reading a WAL database: as the last connection it removes the -wal and -shm on
 * close (a read-only connection creates them and leaves them behind).
 */
export function openQueryOnly(path: string): Database {
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  try { db.exec("PRAGMA query_only = ON"); } catch (error) { db.close(); throw error; }
  return db;
}

/**
 * A copy written by VACUUM INTO or copied from a backup is a rollback-journal database with the backup's permissions: it
 * takes the original's WAL mode and mode bits. It must belong to the same user (the service identity runs the operation)
 * before it can replace it. `stopped` makes the operation's error.
 */
export async function adoptOriginal(source: string, target: string, space: string, stopped: (message: string) => Error): Promise<void> {
  if (process.platform !== "win32") {
    const original = statSync(source), copy = statSync(target);
    if (copy.uid !== original.uid) throw stopped(`${space} 的副本属于用户 ${copy.uid}，原库属于 ${original.uid}：须以服务身份运行，没有改动`);
    await chmod(target, original.mode & 0o777);
  }
  const db = new Database(target, { readwrite: true, create: false });
  try {
    const { journal_mode: mode } = db.query("PRAGMA journal_mode = WAL").get() as { journal_mode: string };
    if (mode !== "wal") throw stopped(`${space} 的副本无法切换到 WAL 模式（${mode}），没有改动`);
  } finally { db.close(); }
}

/** An unreplaced copy, with the -wal and -shm a connection killed with the process may have left. */
export async function removeCopy(files: Files): Promise<void> {
  for (const file of [files.copy, files.copyWal, files.copyShm]) await rm(file, { force: true });
}

/** Steps 3–5 from `verified` or `old-kept`. */
export async function install(host: ReplacementHost): Promise<void> {
  const { current, files } = host;
  if (current.state === "verified") {
    // Nothing may have written since the check: a WAL with frames would go away with the original.
    if (sizeOf(files.wal) !== 0) throw host.stopped(`${current.space} 的 WAL 在校验副本之后有了写入，没有改动`);
    await move(host, files.main, files.old);
    await move(host, files.wal, files.oldWal);
    await move(host, files.shm, files.oldShm);
    await syncPath(dirname(files.main), true);
    current.state = "old-kept";
    await host.save();
    await host.point("old-kept");
  }
  if (current.state === "old-kept") {
    // The original's -wal and -shm were renamed with it: one at the database's path now belongs to no database.
    if (existsSync(files.wal) || existsSync(files.shm)) throw host.stopped(`${current.space} 的路径旁出现了不属于任何库的 -wal 或 -shm`);
    await rename(files.copy, files.main);
    await syncPath(dirname(files.main), true);
    current.state = "installed";
    await host.save();
    await host.point("installed");
  }
  await finish(host);
}

/** Step 5: the installed copy passes quick_check, is in WAL mode and carries the expected Durable metadata. */
async function finish(host: ReplacementHost): Promise<void> {
  const { current, files } = host, kept = `${host.words.kept}保留在 ${files.old}`;
  const db = new Database(files.main);
  try {
    const check = (db.query("PRAGMA quick_check").all() as { quick_check: string }[]).map(row => row.quick_check).join("; ");
    if (check !== "ok") throw host.stopped(`${current.space} 换上的库未通过 quick_check：${check}；${kept}`);
    const { journal_mode: mode } = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    if (mode !== "wal") throw host.stopped(`${current.space} 换上的库不是 WAL 模式（${mode}）；${kept}`);
    const meta = metadata(db);
    if (meta.nextSeq !== host.expected.nextSeq || meta.nextId !== host.expected.nextId) {
      throw host.stopped(`${current.space} 换上的库的 Durable 元数据与预计不同；${kept}`);
    }
  } finally { db.close(); }
  await host.point("checked");
  await host.finished(sizeOf(files.main));
}

/**
 * The copy at the database's path is still the one that was checked: the same file is not the same content, and
 * quick_check and the metadata say nothing about the values. Byte for byte as recorded (the checks of `finish` only
 * read), and no frames in its WAL: anything written since the install would be there or in the file. Otherwise the
 * kept original and the record stay as they are.
 */
async function installedIntact(host: ReplacementHost): Promise<void> {
  const { current, files } = host;
  const keep = `没有改动，${host.words.kept}保留在 ${files.old}，${host.words.record}保留，服务保持停止，请人工处理`;
  const wal = sizeOf(files.wal);
  if (wal !== 0) throw host.stopped(`${current.space} 换上的库旁的 WAL 有 ${wal} 字节：安装之后有过写入，无法确认它仍是校验过的副本；${keep}`);
  if (sizeOf(files.main) !== current.copy!.bytes || await fileDigest(files.main) !== current.copy!.sha256) {
    throw host.stopped(`${current.space} 换上的库与校验过的副本内容不同（摘要不同）；${keep}`);
  }
}

/** The plan's recovery table, by the record state and the identity of the files at the three paths. */
export async function recover(host: ReplacementHost): Promise<Recovered> {
  const { current, files } = host;
  const main = identityOf(files.main), old = identityOf(files.old), copy = identityOf(files.copy);
  const isOriginal = (id?: FileIdentity) => id !== undefined && sameFile(id, current.original.file);
  const isCopy = (id?: FileIdentity) => id !== undefined && current.copy !== undefined && sameFile(id, current.copy.file);
  const where = `${current.space}（阶段 ${current.state}）`;
  host.log?.(`恢复上次未完成的替换：${where}`);
  if ((current.state === "writing" || current.state === "verified") && isOriginal(main) && !old) {
    // Not replaced yet: as if nothing was done.
    await removeCopy(files);
    await host.dropped();
    return "void";
  }
  if ((current.state === "verified" || current.state === "old-kept") && !main && isOriginal(old)) {
    if (isCopy(copy) && await fileDigest(files.copy) === current.copy!.sha256) {
      // A run that ended between the renames of step 3 left the original's -wal and -shm at its path.
      await move(host, files.wal, files.oldWal);
      await move(host, files.shm, files.oldShm);
      current.state = "old-kept";
      await host.save();
      await install(host);
      return "done";
    }
    // The copy is missing or not the verified one: the original goes back.
    await move(host, files.oldWal, files.wal);
    await move(host, files.oldShm, files.shm);
    await rename(files.old, files.main);
    await syncPath(dirname(files.main), true);
    await removeCopy(files);
    await host.dropped();
    return "restored";
  }
  if ((current.state === "old-kept" || current.state === "installed") && isCopy(main) && isOriginal(old) && !copy) {
    await installedIntact(host);
    await finish(host);
    return "done";
  }
  const describe = (name: string, id?: FileIdentity) => `${name}${id ? (isOriginal(id) ? "是原库" : isCopy(id) ? "是副本" : "是其他文件") : "不存在"}`;
  throw host.stopped(`${host.words.record}与文件对不上：${where}；${describe("正式路径", main)}，${describe(".old", old)}，${describe(".new", copy)}。` +
    "没有改动，服务保持停止，请人工处理");
}
