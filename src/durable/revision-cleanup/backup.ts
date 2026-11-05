// A verified copy of a conversation database before the cleanup first changes it (revision-chain plan §4.3). VACUUM INTO
// writes one consistent snapshot (WAL content included) from a read-only connection; the copy is synced, then checked
// on its own: integrity, the Durable metadata and the row count of every table must equal the source.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { integrity, metadata, openReader, tableCounts } from "./inspect.ts";

/** Flushes a file, or a directory's entries; Windows cannot flush a directory handle (NTFS journals the renames). */
export async function syncPath(path: string, directory: boolean): Promise<void> {
  if (directory && process.platform === "win32") return;
  const handle = await open(path, directory ? "r" : "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Writes `target` (which must not exist, or be this run's unfinished copy the caller decided to discard). */
export async function writeBackup(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await rm(target, { force: true });
  const db = openReader(source);
  try {
    // SQLite syncs the VACUUM INTO output unless the source connection runs with synchronous OFF.
    db.exec("PRAGMA synchronous = FULL");
    db.query("VACUUM INTO ?").run(target);
  } finally { db.close(); }
  await chmod(target, 0o600);
  await syncPath(target, false);
  await syncPath(dirname(target), true);
}

export type VerifiedBackup = { bytes: number; sha256: string; counts: Record<string, number> };

/** Checks the copy against the source (read through `source`, which nothing writes meanwhile). Throws on any difference. */
export async function verifyBackup(source: Database, target: string): Promise<VerifiedBackup> {
  const copy = openReader(target);
  let counts: Record<string, number>;
  try {
    const check = integrity(copy);
    if (check !== "ok") throw new Error(`备份的完整性检查未通过：${check}`);
    const want = metadata(source), got = metadata(copy);
    if (want.nextSeq !== got.nextSeq || want.nextId !== got.nextId || want.schema !== got.schema) {
      throw new Error(`备份的 Durable 元数据与会话库不同（next_seq ${got.nextSeq}/${want.nextSeq}，next_id ${got.nextId}/${want.nextId}）`);
    }
    counts = tableCounts(copy);
    const expected = tableCounts(source);
    if (JSON.stringify(counts) !== JSON.stringify(expected)) throw new Error("备份各表的行数与会话库不同");
  } finally { copy.close(); }
  return { bytes: (await stat(target)).size, sha256: await fileDigest(target), counts };
}
