// First-time cleanup of the revision chains an older release left (revision-chain plan §4, §8.1). Offline only: the
// caller holds the maintenance lease (data/state/service), so no other writer touches the databases while it runs.
//
// Per database: a verified backup before the first change, then one document at a time: read it through the storage
// (record, stored version, value), check that the value survives the JSON encoding unchanged, journal it (identity
// without the key, digest of the value, N0 = durable_metadata.next_seq), and commit one base of that value at the stored
// version straight through the storage: for a current-only document the same commit deletes the old chain. Durable gives
// the commit N0 and moves next_seq to N0 + 1, so the only states the operation can leave are N0 (not committed: the
// chain as journaled) and N0 + 1 (one base at N0). Every step — also the first run of a document — goes through
// `advance`, which reads the state independently (plain SQL), places it on one of those rows and acts; anything else
// stops without writing and keeps the document in flight, which keeps the service stopped. After the commit the base is
// read back twice (plain SQL, then a new storage through Durable): a different value is not written back but marks the
// database for a restore from its backup (`journal.restore`), which blocks the service, every other maintenance action
// and the rollback until restore.ts has run. A run interrupted between documents resumes with its backups only while no
// other writer has touched its databases since; otherwise it is ended as skipped and a new run starts. A resumed run
// checks each backup it reuses against its recorded SHA-256 before that database changes again, and stops when it
// differs (unless the database is still as it was backed up: then the backup is written again).
import { randomUUID } from "node:crypto";
import { existsSync, statfsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { assertMaintenanceAction, assessMaintenanceAction, MaintenanceRefused, readMaintenanceState } from "../../core/maintenance-state.ts";
import { CHECKPOINT_INTERVAL, LEGACY_CHAIN_LIMIT } from "../checkpoint.ts";
import { spaceDirectories } from "../space-databases.ts";
import { openGroupStorage } from "../sqlite.ts";
import { fileDigest, writeBackup, verifyBackup } from "./backup.ts";
import { unsupported, valueDigest } from "./documents.ts";
import { candidates, chain, documentRef, documentRow, fileIdentity, metadata, openReader, pages, readQuietly, sameFile, sameRef, singleBase,
  storedRecord, type Candidate } from "./inspect.ts";
import { archiveJournal, JOURNAL_VERSION, readJournal, writeJournal, type DatabaseRecord, type InFlight, type Journal } from "./journal.ts";

/** Kept free on every volume the cleanup writes to, as the deployment's own checks do (CANDIDATE_DATA_RESERVE_BYTES). */
export const SPACE_RESERVE = 1_073_741_824;

/** Points between the steps, for tests that end the process there. */
export type Point = "backup-started" | "backup-written" | "backup-verified" | "journaled" | "committed";

export interface CleanupOptions {
  /** The project directory (data/ and backup/ below it). */
  project: string;
  /** Default `<project>/backup/revision-cleanup`; each run writes below `<run>/`. */
  backupRoot?: string;
  /** The upgrade transaction this run belongs to. */
  transaction?: string;
  /** Free bytes to keep on every volume (default SPACE_RESERVE). */
  reserve?: number;
  log?: (line: string) => void;
  /**
   * @internal Tests only: `point` runs between the steps (a test ends the process there); `value` may replace the value
   * the base is committed with, so a test can make the committed base differ from the journal.
   */
  hooks?: { point?: (point: Point) => void | Promise<void>; value?: (value: Record<string, unknown>) => Record<string, unknown> | undefined };
}

/** A difference from every state this operation can explain, or a failed check: the run stops (see the journal). */
export class CleanupStopped extends Error {
  override name = "CleanupStopped";
}

type Paths = { project: string; data: string; conversations: string; backupRoot: string };
function pathsOf(options: Pick<CleanupOptions, "project" | "backupRoot">): Paths {
  const project = resolve(options.project), data = join(project, "data");
  return { project, data, conversations: join(data, "conversations"), backupRoot: resolve(options.backupRoot ?? join(project, "backup", "revision-cleanup")) };
}
export const databasePath = (paths: Pick<Paths, "conversations">, space: string): string => join(paths.conversations, ...space.split("/"), "durable.sqlite");
const backupName = (space: string) => `${space.replaceAll("/", "-")}.sqlite`;
const sizeOf = (path: string) => existsSync(path) ? statSync(path).size : 0;

// ─── Preview ───────────────────────────────────────────────────────────────

export type KindCount = { documents: number; revisions: number; longest: number };
export type DatabasePreview = {
  space: string;
  bytes: number;
  walBytes: number;
  /** Pages in use × page size: what a VACUUM INTO copy needs. */
  usedBytes: number;
  freeBytes: number;
  revisions: number;
  /** Documents the cleanup rewrites, by kind. */
  kinds: Record<string, KindCount>;
  /** Long chains it leaves alone (other kinds, retired), by kind. */
  skipped: Record<string, KindCount & { reason: string }>;
  /** Of `kinds`: chains of more than LEGACY_CHAIN_LIMIT revisions, which the service never compacts online. */
  legacy: number;
  /** Estimated WAL for deleting the longest chain in one commit (its share of the pages in use). */
  walEstimate: number;
};
export type Preview = { interval: number; legacyLimit: number; databases: DatabasePreview[]; documents: number; revisions: number; longest: number };

function add(counts: Record<string, KindCount>, kind: string, revisions: number): KindCount {
  const count = counts[kind] ??= { documents: 0, revisions: 0, longest: 0 };
  count.documents++; count.revisions += revisions; count.longest = Math.max(count.longest, revisions);
  return count;
}

const hasRevisions = (reader: Database) =>
  reader.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_revisions'").get() !== null;

function previewDatabase(space: string, path: string, reader: Database): { preview: DatabasePreview; list: Candidate[] } {
  const info = pages(reader);
  const revisions = hasRevisions(reader) ? (reader.query("SELECT count(*) AS n FROM document_revisions").get() as { n: number }).n : 0;
  const kinds: Record<string, KindCount> = {}, skipped: Record<string, KindCount & { reason: string }> = {};
  const list: Candidate[] = [];
  let legacy = 0, longest = 0;
  for (const candidate of hasRevisions(reader) ? candidates(reader) : []) {
    const record = storedRecord(candidate.row), reason = unsupported(record);
    if (reason) {
      const count = skipped[record.kind] ??= { documents: 0, revisions: 0, longest: 0, reason };
      count.documents++; count.revisions += candidate.revisions; count.longest = Math.max(count.longest, candidate.revisions);
      continue;
    }
    list.push(candidate);
    add(kinds, record.kind, candidate.revisions);
    if (candidate.revisions - 1 >= LEGACY_CHAIN_LIMIT) legacy++;
    longest = Math.max(longest, candidate.revisions);
  }
  const usedBytes = (info.pages - info.freePages) * info.pageSize;
  return {
    preview: {
      space, bytes: sizeOf(path), walBytes: sizeOf(`${path}-wal`), usedBytes, freeBytes: info.freePages * info.pageSize, revisions,
      kinds, skipped, legacy, walEstimate: revisions ? Math.ceil(usedBytes * longest / revisions * 1.5) : 0,
    },
    list,
  };
}

/** Read only: what a cleanup would do, database by database. Prints nothing, returns no document keys. */
export async function previewCleanup(options: Pick<CleanupOptions, "project">): Promise<Preview> {
  const paths = pathsOf(options);
  const databases: DatabasePreview[] = [];
  for (const space of await spaceDirectories(paths.conversations)) {
    const path = databasePath(paths, space);
    if (!existsSync(path)) continue;
    databases.push(readQuietly(path, reader => previewDatabase(space, path, reader).preview));
  }
  const all = databases.flatMap(db => Object.values(db.kinds));
  return {
    interval: CHECKPOINT_INTERVAL, legacyLimit: LEGACY_CHAIN_LIMIT, databases,
    documents: all.reduce((n, kind) => n + kind.documents, 0), revisions: all.reduce((n, kind) => n + kind.revisions, 0),
    longest: Math.max(0, ...all.map(kind => kind.longest)),
  };
}

// ─── Space ─────────────────────────────────────────────────────────────────

export type VolumeNeed = { path: string; need: number; free: number };
export class NotEnoughSpace extends Error {
  override name = "NotEnoughSpace";
  constructor(readonly volumes: VolumeNeed[]) {
    super(`空间不足，整理没有开始：${volumes.filter(v => v.need > v.free).map(v => `${v.path} 需要 ${v.need} 字节，可用 ${v.free} 字节`).join("；")}`);
  }
}

function existingAncestor(path: string): string {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/** What a run still has to write: backups of the databases it changes (on the backup volume), the WAL of its largest delete. */
export type Needs = { backupBytes: number; walBytes: number };

function needs(previews: DatabasePreview[], journal: Journal | undefined): Needs {
  const pending = previews.filter(db => Object.keys(db.kinds).length);
  const copies = pending.filter(db => journal?.databases.find(record => record.space === db.space)?.backup?.state !== "verified");
  return { backupBytes: copies.reduce((n, db) => n + db.usedBytes + db.walBytes, 0), walBytes: Math.max(0, ...pending.map(db => db.walEstimate)) };
}

function spaceNeeds(paths: Paths, { backupBytes, walBytes }: Needs, reserve: number): VolumeNeed[] {
  const volumes = new Map<string, VolumeNeed>();
  const need = (path: string, bytes: number) => {
    const existing = existingAncestor(path), dev = String(statSync(existing).dev);
    const volume = volumes.get(dev) ?? { path: existing, need: reserve, free: Number(statfsSync(existing).bavail) * statfsSync(existing).bsize };
    volume.need += bytes;
    volumes.set(dev, volume);
  };
  need(paths.backupRoot, backupBytes);
  need(paths.conversations, walBytes);
  return [...volumes.values()];
}

/**
 * Why an open run cannot be resumed, or undefined: a database it journaled was replaced, removed or written since the
 * run last left it. Only another writer (the service, between two runs of the command) does that; the run's verified
 * backups no longer hold those writes, so a new run starts instead. Read only; not for a run with a document in flight.
 */
function superseded(paths: Paths, journal: Journal): string | undefined {
  for (const record of journal.databases) {
    const path = databasePath(paths, record.space);
    if (!existsSync(path)) return `${record.space} 的会话库已不在`;
    if (!sameFile(record.file, fileIdentity(path))) return `${record.space} 的会话库文件已被替换`;
    if (readQuietly(path, reader => metadata(reader).nextSeq) !== record.nextSeq) return `${record.space} 的会话库在上次整理之后已有其他写入`;
  }
  return undefined;
}

/** The open run `applyCleanup` would resume (a stopped one it refuses), or undefined when it would start a new one. */
function openRun(paths: Paths): Journal | undefined {
  const journal = readJournal(paths.data);
  if (!journal || (journal.state !== "running" && journal.state !== "stopped")) return undefined;
  return journal.state === "stopped" || journal.current || !superseded(paths, journal) ? journal : undefined;
}

/** What `applyCleanup` would still write now (a resumed run keeps its verified backups). Read only. */
export function previewNeeds(options: Pick<CleanupOptions, "project" | "backupRoot">, preview: Preview): Needs & { run?: Pick<Journal, "run" | "state"> } {
  const journal = openRun(pathsOf(options));
  return { ...needs(preview.databases, journal), ...(journal ? { run: { run: journal.run, state: journal.state } } : {}) };
}

/** The space `applyCleanup` would ask for now, by volume. */
export function previewSpace(options: Pick<CleanupOptions, "project" | "backupRoot" | "reserve">, need: Needs): VolumeNeed[] {
  return spaceNeeds(pathsOf(options), need, options.reserve ?? SPACE_RESERVE);
}

/**
 * Rough duration in seconds (R2 on the synthetic large space, the slower of Windows and WSL): 90 ms per document plus
 * 35 ms per 1,000 revisions, and the backups at 30 MB/s including their check. Cold caches and slow disks take longer.
 */
export function estimateSeconds(preview: Pick<Preview, "documents" | "revisions">, need: Pick<Needs, "backupBytes">): number {
  return Math.ceil(preview.documents * 0.09 + preview.revisions * 0.000_035 + need.backupBytes / 30_000_000);
}

// ─── Run ───────────────────────────────────────────────────────────────────

export type Summary = {
  run: string;
  state: Journal["state"] | "nothing";
  documents: number;
  revisions: number;
  ms: number;
  databases: { space: string; documents: number; backup?: { path: string; bytes: number }; checkpoint?: DatabaseRecord["checkpoint"] }[];
  restore?: { space: string; state: NonNullable<Journal["restore"]>["state"] };
};

export function summarize(journal: Journal): Summary {
  const done = journal.databases.flatMap(db => db.done);
  return {
    run: journal.run, state: journal.state, documents: done.length,
    revisions: done.reduce((n, item) => n + item.revisions - 1, 0), ms: done.reduce((n, item) => n + item.ms, 0),
    databases: journal.databases.map(db => ({
      space: db.space, documents: db.done.length,
      ...(db.backup?.state === "verified" ? { backup: { path: db.backup.path, bytes: db.backup.bytes! } } : {}),
      ...(db.checkpoint ? { checkpoint: db.checkpoint } : {}),
    })),
    ...(journal.restore ? { restore: { space: journal.restore.space, state: journal.restore.state } } : {}),
  };
}

/** How a document in flight is settled: a resumed run commits one not yet committed; a skip or rollback leaves it. */
type Settling = "resume" | "end";

type Stored = { version: number; value: Record<string, unknown> };

class Runner {
  readonly paths: Paths;
  constructor(readonly options: CleanupOptions, public journal: Journal) { this.paths = pathsOf(options); }

  log(line: string) { this.options.log?.(line); }
  save() { return writeJournal(this.paths.data, this.journal); }
  async point(point: Point) { await this.options.hooks?.point?.(point); }

  async stop(reason: string): Promise<never> {
    this.journal.state = "stopped";
    this.journal.stop = { at: new Date().toISOString(), reason };
    await this.save();
    throw new CleanupStopped(reason);
  }

  record(space: string): DatabaseRecord {
    const record = this.journal.databases.find(db => db.space === space);
    if (!record) throw new Error(`修订整理日志里没有 ${space}`);
    return record;
  }

  async database(space: string): Promise<void> {
    const path = databasePath(this.paths, space);
    const reader = openReader(path);
    try {
      let record = this.journal.databases.find(db => db.space === space);
      if (!hasRevisions(reader) && !record) return;
      const meta = metadata(reader), file = fileIdentity(path);
      if (record && !sameFile(record.file, file)) await this.stop(`${space} 的会话库文件已被替换（文件身份与日志不同）`);
      if (record && record.schema !== meta.schema) await this.stop(`${space} 的 Durable schema 与日志不同`);
      const list = previewDatabase(space, path, reader).list;
      if (!list.length && (!record || record.finished)) return;
      if (!record) {
        record = { space, file, schema: meta.schema, nextSeq: meta.nextSeq, done: [] };
        this.journal.databases.push(record);
        await this.save();
      }
      if (list.length) await this.backup(record, path, reader);
      // Progress about every 10 s, after every slow document and at the end: one line per document would flood the
      // upgrade's output with thousands of lines.
      let logged = Date.now();
      for (const [index, candidate] of list.entries()) {
        await this.document(record, path, reader, candidate);
        const done = record.done.at(-1)!;
        if (index + 1 === list.length || done.ms >= 1_000 || Date.now() - logged >= 10_000) {
          logged = Date.now();
          this.log(`${space}：已整理 ${index + 1}/${list.length} 份（最近一份 ${done.kind}：${done.revisions} 条修订 → 1 条，${done.ms} ms）`);
        }
      }
    } finally { reader.close(); }
    // The deleted pages stay in the file as free pages for later writes; only the WAL is reset here.
    const record = this.record(space);
    record.checkpoint = checkpoint(path);
    record.finished = true;
    await this.save();
  }

  async backup(record: DatabaseRecord, path: string, reader: Database): Promise<void> {
    const meta = metadata(reader), file = fileIdentity(path);
    const untouched = (source: { file: { dev: string; ino: string }; nextSeq: number; nextId: string }) =>
      sameFile(source.file, file) && source.nextSeq === meta.nextSeq && source.nextId === meta.nextId;
    const previous = record.backup;
    if (previous?.state === "verified") {
      // Checked once each time a run resumes with it, before its database changes again: size and SHA-256 as recorded.
      const problem = !existsSync(previous.path) ? "不在了"
        : statSync(previous.path).size !== previous.bytes || await fileDigest(previous.path) !== previous.sha256 ? "与记录的摘要不同（已损坏或被替换）"
        : undefined;
      if (!problem) return;
      // Written again only from the database exactly as it was backed up; a half-cleaned one must not replace it.
      if (!untouched(previous.source)) await this.stop(`${record.space} 的已验证备份 ${previous.path} ${problem}，而会话库在备份之后已有改动，不能重新备份`);
      this.log(`${record.space} 的已验证备份 ${previous.path} ${problem}；会话库在备份之后没有改动，重新备份`);
    } else if (previous?.state === "writing" && !untouched(previous.source)) {
      await this.stop(`${record.space} 的会话库已有改动，但没有已验证的备份`);
    } else if (!previous && record.done.length) {
      await this.stop(`${record.space} 的会话库已有改动，但没有备份记录`);
    }
    const target = join(this.paths.backupRoot, this.journal.run, backupName(record.space));
    if (!previous && existsSync(target)) await this.stop(`备份路径已有文件：${target}`);
    record.backup = { path: target, state: "writing", source: { file, nextSeq: meta.nextSeq, nextId: meta.nextId } };
    await this.save();
    await this.point("backup-started");
    const started = Date.now();
    await writeBackup(path, target);
    await this.point("backup-written");
    const verified = await verifyBackup(reader, target);
    record.backup = { ...record.backup, state: "verified", ...verified, ms: Date.now() - started };
    await this.save();
    await this.point("backup-verified");
    this.log(`${record.space}：备份已写入并验证（${verified.bytes} 字节）：${target}`);
  }

  /** The document through the storage, with its value checked to survive the JSON encoding the base is stored in. */
  async read(storage: SqliteStorage, space: string, id: number): Promise<Stored> {
    const stored = await storage.document(id as never, "current", context);
    if (!stored) return this.stop(`${space} 的文档 ${id} 经 Durable 读不到`);
    const value = stored.value as Record<string, unknown>;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return this.stop(`${space} 的文档 ${id} 的值不是对象`);
    if (!Bun.deepEquals(JSON.parse(JSON.stringify(value)), value, true)) {
      return this.stop(`${space} 的文档 ${id} 的值经 JSON 编码后会改变，没有写入`);
    }
    return { version: stored.version as number, value };
  }

  /** Journals one document and takes it through `advance`. */
  async document(record: DatabaseRecord, path: string, reader: Database, candidate: Candidate): Promise<void> {
    const storage = await openGroupStorage(path);
    try {
      const id = candidate.row.id;
      const stored = await this.read(storage, record.space, id);
      const now = chain(reader, id), row = documentRow(reader, id), meta = metadata(reader);
      if (!row || !sameRef(documentRef(row), documentRef(candidate.row)) || now.revisions !== candidate.revisions || now.latest !== candidate.latest) {
        await this.stop(`${record.space} 的文档 ${id} 在整理开始后有改动`);
      }
      this.journal.current = {
        space: record.space, document: documentRef(candidate.row), before: { revisions: candidate.revisions, latest: candidate.latest },
        n0: meta.nextSeq, version: stored.version, digest: valueDigest(stored.value), startedAt: Date.now(),
      };
      await this.save();
      await this.point("journaled");
      await this.advance(record, path, reader, "resume", { storage, stored });
    } finally { await storage.close(context); }
  }

  /**
   * Places the in-flight document on one row of the state table and acts, until it is settled. `open` is the storage
   * (and the value read through it) of a document journaled just now; a resumed run opens its own.
   */
  async advance(record: DatabaseRecord, path: string, reader: Database, settling: Settling, open?: { storage: SqliteStorage; stored: Stored }):
      Promise<void> {
    const current = this.journal.current!;
    const where = `${current.space} 的文档 ${current.document.id}`;
    let storage = open?.storage, stored = open?.stored;
    const owned = !storage;
    try {
      for (;;) {
        const seen = await this.observe(record, path, reader, current);
        if (seen.row === "before" && settling === "end") {
          // Nothing was committed: a skip or a rollback writes nothing and forgets the document.
          delete this.journal.current;
          await this.save();
          this.log(`${where} 尚未提交，不再整理`);
          return;
        }
        if (seen.row === "before") {
          storage ??= await openGroupStorage(path);
          stored ??= await this.read(storage, current.space, current.document.id);
          if (stored.version !== current.version || valueDigest(stored.value) !== current.digest) await this.stop(`${where} 的值或版本与日志不同，没有写入`);
          const value = this.options.hooks?.value?.(structuredClone(stored.value)) ?? stored.value;
          const committed = await storage.commit([[{ type: "document.change", id: current.document.id as never, content: { kind: "base", version: current.version, value } }]] as never, () => {}, context);
          if (committed.stored === 0) throw committed.refused;
          await this.point("committed");
          stored = undefined;
          continue;
        }
        if (owned && storage) { await storage.close(context); storage = undefined; }
        // One base at N0: plain SQL found it; a new storage must read the same value through Durable.
        let found = seen.digest;
        if (found === current.digest) found = await this.reread(path, current);
        if (found !== current.digest) return await this.mismatch(current, found);
        await this.settle(record, current);
        return;
      }
    } finally { if (owned) await storage?.close(context); }
  }

  /** The row of the state table the database is on, or a stop. Reads only. */
  async observe(record: DatabaseRecord, path: string, reader: Database, current: InFlight): Promise<{ row: "before" } | { row: "committed"; digest: string }> {
    const where = `${current.space} 的文档 ${current.document.id}`;
    if (!sameFile(record.file, fileIdentity(path))) return this.stop(`${current.space} 的会话库文件已被替换（文件身份与日志不同）`);
    const meta = metadata(reader);
    if (meta.schema !== record.schema) return this.stop(`${current.space} 的 Durable schema 与日志不同`);
    const row = documentRow(reader, current.document.id);
    if (!row || !sameRef(documentRef(row), current.document)) return this.stop(`${where} 的文档行与日志不同`);
    const step = meta.nextSeq - current.n0;
    if (step === 0) {
      const now = chain(reader, current.document.id);
      if (now.revisions !== current.before.revisions || now.latest !== current.before.latest) return this.stop(`${where} 的修订与日志不同`);
      return { row: "before" };
    }
    if (step !== 1) return this.stop(`${where}：库的提交序号为 ${meta.nextSeq}，日志记的起点为 ${current.n0}，不是本次操作能留下的状态`);
    const base = singleBase(reader, current.document.id);
    if (!base || base.seq !== current.n0 || base.version !== current.version) {
      return this.stop(`${where} 不是预计序号 ${current.n0}、版本 ${current.version} 处的单条基准`);
    }
    return { row: "committed", digest: valueDigest(base.value) };
  }

  /** The digest of the value a new storage reads through Durable (undefined value: an empty digest). */
  async reread(path: string, current: InFlight): Promise<string> {
    const storage = await openGroupStorage(path);
    try {
      const stored = await storage.document(current.document.id as never, "current", context);
      return stored ? valueDigest(stored.value) : "";
    } finally { await storage.close(context); }
  }

  /** The committed base differs from the journal: the database waits for a restore from its backup. */
  async mismatch(current: InFlight, found: string): Promise<never> {
    const kind = current.document.kind;
    this.journal.restore = {
      space: current.space, document: { id: current.document.id, kind, seq: current.n0, expected: current.digest, found },
      at: new Date().toISOString(), state: "required",
    };
    delete this.journal.current;
    return this.stop(`${current.space} 的文档 ${current.document.id}（${kind}）提交后的基准与整理前的值不同（摘要 ${found.slice(0, 12)}…，` +
      `应为 ${current.digest.slice(0, 12)}…）。没有写回；这个库需要从备份恢复（revision-cleanup restore --space ${current.space}），` +
      "恢复之前服务、回滚和其他维护都会拒绝");
  }

  async settle(record: DatabaseRecord, current: InFlight): Promise<void> {
    record.done.push({ id: current.document.id, kind: current.document.kind, revisions: current.before.revisions, seq: current.n0,
      digest: current.digest, ms: Date.now() - current.startedAt });
    record.nextSeq = current.n0 + 1;
    delete this.journal.current;
    await this.save();
  }

  /** Settles the document in flight, if any. Runs before anything else a resumed run, a skip or a rollback does. */
  async settleCurrent(settling: Settling): Promise<void> {
    const current = this.journal.current;
    if (!current) return;
    const path = databasePath(this.paths, current.space);
    if (!existsSync(path)) await this.stop(`${current.space} 的会话库不在了`);
    const record = this.record(current.space);
    const reader = openReader(path);
    try {
      this.log(`收尾上次未完成的文档（${current.space}）`);
      await this.advance(record, path, reader, settling);
    } finally { reader.close(); }
  }
}

/** Resets the WAL once every connection of this process is closed (the lease keeps the others out). */
function checkpoint(path: string): NonNullable<DatabaseRecord["checkpoint"]> {
  const db = new Database(path);
  try {
    const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
    return { ...result, walBytes: sizeOf(`${path}-wal`) };
  } finally { db.close(); }
}

function newJournal(options: CleanupOptions): Journal {
  return {
    version: JOURNAL_VERSION, run: `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`,
    ...(options.transaction ? { transaction: options.transaction } : {}), startedAt: new Date().toISOString(),
    interval: CHECKPOINT_INTERVAL, state: "running", databases: [],
  };
}

/**
 * Runs the cleanup, or resumes the run the journal names: the document in flight is settled first; a stopped run is
 * refused (skip or roll back instead), and so is anything the maintenance state refuses (a restore pending, a shrink
 * unfinished, a journal of another format). Throws MaintenanceRefused, CleanupStopped, NotEnoughSpace, or what failed
 * underneath (the journal then stays as it was, and running it again resumes).
 */
export async function applyCleanup(options: CleanupOptions): Promise<Summary> {
  const paths = pathsOf(options);
  const state = readMaintenanceState(paths.project);
  const open = state.cleanup.status === "present" && (state.cleanup.state === "running" || state.cleanup.state === "stopped");
  const intent = open ? "resume" : "cleanup", assessment = assessMaintenanceAction(state, intent);
  if (!assessment.allowed) throw new MaintenanceRefused(intent, assessment.reasons);
  let journal = readJournal(paths.data);
  if (journal && journal.state !== "running" && journal.state !== "stopped") { await archiveJournal(paths.data, journal); journal = undefined; }
  // A resumed run settles the document in flight before anything else.
  if (journal?.current) await new Runner(options, journal).settleCurrent("resume");
  const reason = journal && superseded(paths, journal);
  if (journal && reason) {
    journal.state = "skipped";
    journal.superseded = reason;
    journal.endedAt = new Date().toISOString();
    await writeJournal(paths.data, journal);
    await archiveJournal(paths.data, journal);
    options.log?.(`上次整理（运行 ${journal.run}）不能续做：${reason}。已记为跳过，重新开始整理`);
    journal = undefined;
  }
  const previews = (await previewCleanup(options)).databases;
  if (!journal && !previews.some(db => Object.keys(db.kinds).length)) {
    return { run: "", state: "nothing", documents: 0, revisions: 0, ms: 0, databases: [] };
  }
  const volumes = spaceNeeds(paths, needs(previews, journal), options.reserve ?? SPACE_RESERVE);
  if (volumes.some(volume => volume.need > volume.free)) throw new NotEnoughSpace(volumes);
  const runner = new Runner(options, journal ?? newJournal(options));
  if (!journal) await runner.save();
  for (const space of await spaceDirectories(paths.conversations)) {
    if (existsSync(databasePath(paths, space))) await runner.database(space);
  }
  runner.journal.state = "finished";
  runner.journal.endedAt = new Date().toISOString();
  await runner.save();
  return summarize(runner.journal);
}

/**
 * Ends the run without cleaning the rest: settles the document in flight first — committed, it is checked; not yet
 * committed, it is left as it was — and a failure keeps the journal and the service stopped. `skipped` for "skip the
 * rest", `abandoned` before a rollback. Refused while a restore is pending. Nothing to do without an open run.
 */
export async function endCleanup(options: CleanupOptions, state: "skipped" | "abandoned"): Promise<Summary | undefined> {
  const paths = pathsOf(options);
  assertMaintenanceAction(paths.project, state === "skipped" ? "skip" : "rollback");
  const journal = readJournal(paths.data);
  if (!journal || (journal.state !== "running" && journal.state !== "stopped")) return journal && summarize(journal);
  const runner = new Runner(options, journal);
  if (journal.current) {
    const stop = journal.state === "stopped" ? journal.stop : undefined;
    journal.state = "running";
    try { await runner.settleCurrent("end"); }
    catch (error) {
      // The run stays stopped, with the first reason when the failure gave none.
      if (!(error instanceof CleanupStopped) && stop) { journal.state = "stopped"; journal.stop = stop; await runner.save(); }
      throw error;
    }
  }
  runner.journal.state = state;
  runner.journal.endedAt = new Date().toISOString();
  await runner.save();
  return summarize(runner.journal);
}
