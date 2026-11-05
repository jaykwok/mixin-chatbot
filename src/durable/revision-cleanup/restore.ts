// Restoring one conversation database from its revision-cleanup backup (revision-chain plan §8.3): the way out when a
// committed base differed from the journal (run.ts `mismatch`), which blocks the service and every other maintenance
// action until it is done. Offline only: the caller holds the maintenance lease.
//
// The restore runs only when the live database can be explained completely as the backup plus this run's own commits:
// the same file and Durable schema as journaled; next_id as backed up (the cleanup's commits create nothing); every seq
// from the backup's next_seq up to the live one taken by exactly one commit of this run — the settled documents at their
// journaled seqs, the mismatched one at its own — each of those documents one base at that seq, with the value digest
// the journal recorded for it (the mismatched one: the digest found when the mismatch was detected); and no document
// created or retired since. Replacing such a database with the backup loses nothing but those value-preserving commits.
// Anything else refuses (RestoreRefused) and changes nothing: the restore stays required and the database stays as it
// is, for a person to look at.
//
// The backup is copied byte for byte next to the database and must carry the recorded size and SHA-256; then it takes
// the original's WAL mode and mode bits and is checked (integrity, the Durable metadata as backed up, the row count of
// every table as backed up). It is not compared with the live database, which is what it corrects. The swap is the
// replacement protocol of replace.ts, recorded in the journal's `restore.replacement`; the replaced database stays as
// durable.sqlite.restore-<run>.old. An interrupted swap recovers by the same table as the shrink.
import { randomUUID } from "node:crypto";
import { constants, existsSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assertMaintenanceAction } from "../../core/maintenance-state.ts";
import { fileDigest, syncPath } from "./backup.ts";
import { valueDigest } from "./documents.ts";
import { fileIdentity, integrity, metadata, sameFile, singleBase, tableCounts } from "./inspect.ts";
import { readJournal, writeJournal, type DatabaseRecord, type Journal, type Restore } from "./journal.ts";
import { adoptOriginal, emptyWal, install, openQueryOnly, recover, removeCopy, replacementFiles, sizeOf, type Recovered, type ReplacePoint,
  type Replacement, type ReplacementHost } from "./replace.ts";
import { databasePath } from "./run.ts";

export type RestorePoint = ReplacePoint;

export interface RestoreOptions {
  /** The project directory (data/ below it). */
  project: string;
  /** The space to restore: the one the journal names. */
  space: string;
  log?: (line: string) => void;
  /** @internal Tests only: runs between the steps (a test ends the process there). */
  hooks?: { point?: (point: RestorePoint) => void | Promise<void> };
}

/** A check before the swap failed: nothing was changed, the restore stays required. */
export class RestoreRefused extends Error {
  override name = "RestoreRefused";
}
/** The swap stopped at a state its recovery table does not accept, or a check of it failed: see the message. */
export class RestoreStopped extends Error {
  override name = "RestoreStopped";
}

export type RestoreSummary = { run: string; space: string; recovered?: Recovered; kept?: string; bytes?: number; backup: string };

const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Why the live database is not exactly the backup plus this run's commits, or undefined. Reads only. */
function unexplained(path: string, record: DatabaseRecord, restore: Restore): string | undefined {
  const backup = record.backup!;
  if (!sameFile(fileIdentity(path), record.file) || !sameFile(record.file, backup.source.file)) return "会话库文件与日志记录的不是同一个（文件身份不同）";
  const reader = openQueryOnly(path);
  try {
    const meta = metadata(reader);
    if (meta.schema !== record.schema) return `Durable schema 为 ${meta.schema}，日志记的是 ${record.schema}`;
    if (meta.nextId !== backup.source.nextId) return `next_id 为 ${meta.nextId}，备份时为 ${backup.source.nextId}：备份之后有过别的写入`;
    const from = backup.source.nextSeq;
    const commits = [...record.done.map(item => ({ id: item.id, seq: item.seq, digest: item.digest })),
      { id: restore.document.id, seq: restore.document.seq, digest: restore.document.found }];
    const seqs = commits.map(item => item.seq).sort((a, b) => a - b);
    const expected = Array.from({ length: meta.nextSeq - from }, (_, index) => from + index);
    // Equal counts alone do not prove it: each seq of the range must be one of this run's commits, and each only once.
    if (!sameIds(seqs, expected)) {
      return `提交序号对不上：备份时 next_seq 为 ${from}，现在为 ${meta.nextSeq}，本次整理在这个库的提交为 ${commits.length} 次（序号 ${seqs.join(", ")}）`;
    }
    for (const commit of commits) {
      const base = singleBase(reader, commit.id);
      if (!base || base.seq !== commit.seq) return `文档 ${commit.id} 不是序号 ${commit.seq} 处的单条基准`;
      if (valueDigest(base.value) !== commit.digest) return `文档 ${commit.id} 的值与日志记录的摘要不同`;
    }
    const created = reader.query("SELECT count(*) AS n FROM documents WHERE created_at >= ? OR retired_at >= ?").get(from, from) as { n: number };
    if (created.n) return `有 ${created.n} 份文档在备份之后新建或退役`;
  } finally { reader.close(); }
  return undefined;
}

class Restorer {
  readonly data: string;
  readonly path: string;
  constructor(readonly options: RestoreOptions, readonly journal: Journal, readonly restore: Restore, readonly record: DatabaseRecord) {
    this.data = join(resolve(options.project), "data");
    this.path = databasePath({ conversations: join(this.data, "conversations") }, restore.space);
  }

  save() { return writeJournal(this.data, this.journal); }

  host(run: string, current: Replacement): ReplacementHost {
    const files = replacementFiles(this.path, "restore", run), backup = this.record.backup!;
    return {
      current, files, expected: backup.source, words: { record: "恢复记录", kept: "被替换的库" },
      save: () => this.save(),
      point: async point => { await this.options.hooks?.point?.(point); },
      stopped: message => new RestoreStopped(message),
      finished: async () => {
        this.restore.state = "done";
        this.restore.kept = files.old;
        this.restore.restoredAt = new Date().toISOString();
        delete this.restore.replacement;
        // The database is as it was backed up: none of this run's commits are in it any more, so the run's summary no longer
        // counts its documents as cleaned.
        this.restore.reverted = this.record.done.length;
        this.record.done = [];
        this.record.nextSeq = backup.source.nextSeq;
        delete this.record.finished;
        delete this.record.checkpoint;
        await this.save();
        this.options.log?.(`${this.restore.space} 已从备份恢复：${backup.path}；被替换的库保留在 ${files.old}`);
      },
      dropped: async () => {
        this.restore.state = "required";
        delete this.restore.replacement;
        await this.save();
      },
      log: this.options.log,
    };
  }

  async run(): Promise<RestoreSummary> {
    const backup = this.record.backup!;
    const summary = (run: string, recovered?: Recovered): RestoreSummary => ({
      run, space: this.restore.space, ...(recovered ? { recovered } : {}), backup: backup.path,
      ...(this.restore.kept ? { kept: this.restore.kept, bytes: sizeOf(this.path) } : {}),
    });
    let recovered: Recovered | undefined;
    if (this.restore.state === "replacing" && this.restore.replacement) {
      const { run, current } = this.restore.replacement;
      recovered = await recover(this.host(run, current));
      if (recovered === "done") return summary(run, recovered);
    }
    // A fresh attempt: every check again, then the swap.
    if (!existsSync(this.path)) throw new RestoreRefused(`${this.restore.space} 的会话库不在原路径，没有改动`);
    const busy = emptyWal(this.path, this.restore.space);
    if (busy) throw new RestoreRefused(busy);
    const why = unexplained(this.path, this.record, this.restore);
    if (why) throw new RestoreRefused(`${this.restore.space} 不能自动恢复：${why}。没有改动，会话库保持现状，恢复仍待处理，请人工处理`);
    if (!existsSync(backup.path)) throw new RestoreRefused(`${this.restore.space} 的备份不在了：${backup.path}。没有改动，请人工处理`);
    if (statSync(backup.path).size !== backup.bytes || await fileDigest(backup.path) !== backup.sha256) {
      throw new RestoreRefused(`${this.restore.space} 的备份 ${backup.path} 与记录的摘要不同（已损坏或被替换）。没有改动，请人工处理`);
    }
    const run = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
    const files = replacementFiles(this.path, "restore", run);
    for (const file of [files.copy, files.copyWal, files.copyShm, files.old, files.oldWal, files.oldShm]) {
      if (existsSync(file)) throw new RestoreRefused(`恢复要用的路径已有文件：${file}`);
    }
    const reader = openQueryOnly(this.path);
    let current: Replacement;
    try {
      const meta = metadata(reader);
      current = { space: this.restore.space, state: "writing", startedAt: Date.now(),
        original: { file: fileIdentity(this.path), bytes: sizeOf(this.path), nextSeq: meta.nextSeq, nextId: meta.nextId } };
    } finally { reader.close(); }
    this.restore.state = "replacing";
    this.restore.replacement = { run, current };
    await this.save();
    const host = this.host(run, current);
    await host.point("writing");
    try {
      await copyFile(backup.path, files.copy, constants.COPYFILE_EXCL);
      await syncPath(files.copy, false);
      await syncPath(dirname(files.copy), true);
      if (sizeOf(files.copy) !== backup.bytes || await fileDigest(files.copy) !== backup.sha256) throw new RestoreStopped("从备份复制的副本与记录的摘要不同");
      await adoptOriginal(this.path, files.copy, this.restore.space, message => new RestoreStopped(message));
      current.copy = { file: fileIdentity(files.copy), ...await this.verifyCopy(files.copy) };
    } catch (error) {
      await removeCopy(files);
      await host.dropped();
      throw error;
    }
    current.state = "verified";
    await this.save();
    await host.point("verified");
    await install(host);
    return summary(run, recovered);
  }

  /** The copy in WAL mode against the backup record (not against the live database, which it corrects). */
  async verifyCopy(path: string): Promise<{ bytes: number; sha256: string }> {
    const backup = this.record.backup!;
    const copy = openQueryOnly(path);
    try {
      const check = integrity(copy);
      if (check !== "ok") throw new RestoreStopped(`副本的完整性检查未通过：${check}`);
      const meta = metadata(copy);
      if (meta.nextSeq !== backup.source.nextSeq || meta.nextId !== backup.source.nextId || meta.schema !== this.record.schema) {
        throw new RestoreStopped("副本的 Durable 元数据与备份时不同");
      }
      if (JSON.stringify(tableCounts(copy)) !== JSON.stringify(backup.counts)) throw new RestoreStopped("副本各表的行数与备份记录不同");
    } finally { copy.close(); }
    for (const file of [`${path}-wal`, `${path}-shm`]) if (existsSync(file)) throw new RestoreStopped(`关闭副本后仍有 ${file}，没有改动`);
    return { bytes: sizeOf(path), sha256: await fileDigest(path) };
  }
}

/**
 * Restores the database the journal marks for a restore (`journal.restore`), or finishes an interrupted restore. Throws
 * MaintenanceRefused (nothing to restore, a shrink unfinished, a journal of another format), RestoreRefused (a check
 * before the swap failed; nothing changed) or RestoreStopped (the swap stopped; see the message).
 */
export async function restoreDatabase(options: RestoreOptions): Promise<RestoreSummary> {
  assertMaintenanceAction(options.project, "restore");
  const journal = readJournal(join(resolve(options.project), "data"))!, restore = journal.restore!;
  if (restore.space !== options.space) throw new RestoreRefused(`需要从备份恢复的是 ${restore.space}，不是 ${options.space}`);
  const record = journal.databases.find(db => db.space === restore.space);
  const backup = record?.backup;
  if (!record || backup?.state !== "verified" || !backup.sha256 || backup.bytes === undefined || !backup.counts) {
    throw new RestoreRefused(`${restore.space} 没有已验证的备份记录，不能恢复；请人工处理`);
  }
  return new Restorer(options, journal, restore, record).run();
}
