// Offline shrink of the conversation databases (revision-chain plan §4.6). The cleanup only frees pages inside a
// database; this writes a compact copy with VACUUM INTO beside it and swaps it in under a recovery record of its own
// (shrink-record.ts), with the replacement protocol of replace.ts. Never part of an upgrade: the caller holds the
// maintenance lease (data/state/service), and the service, the verification instance and the cleanup refuse to start
// while a replacement is unfinished (maintenance-state.ts).
//
// Step 2 here: the copy is written with VACUUM INTO, takes the original's WAL mode and mode bits, and is checked against
// the original: integrity, Durable metadata, every row of every table, no free pages. The .old stays in place until the
// user removes it (`removeKeptOriginals`). Every run first recovers an unfinished replacement (replace.ts `recover`).
import { randomUUID } from "node:crypto";
import { existsSync, statfsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { assessMaintenanceAction, MaintenanceRefused, readMaintenanceState } from "../../core/maintenance-state.ts";
import { spaceDirectories } from "../space-databases.ts";
import { fileDigest, writeBackup } from "./backup.ts";
import { fileIdentity, integrity, metadata, pages, readQuietly, tableCounts, tableDigests } from "./inspect.ts";
import { adoptOriginal, emptyWal, install, openQueryOnly, recover, removeCopy, replacementFiles, sizeOf, type Files, type Recovered,
  type ReplacePoint, type Replacement, type ReplacementHost } from "./replace.ts";
import { databasePath, SPACE_RESERVE, type VolumeNeed } from "./run.ts";
import { archivedShrinkRecords, readShrinkRecord, shrinkHistory, shrinkRecordPath, writeShrinkRecord, type ShrinkRecord, type Shrunk } from "./shrink-record.ts";

export type { Recovered } from "./replace.ts";

/** Databases with less free space than this are left as they are. */
export const SHRINK_MINIMUM = 1_048_576;

export type ShrinkPoint = ReplacePoint;

export interface ShrinkOptions {
  /** The project directory (data/ below it). */
  project: string;
  /** Only these spaces (`direct`, `groups/<segment>`); default every database with free pages to give back. */
  spaces?: string[];
  /** Free bytes to keep on every volume (default SPACE_RESERVE). */
  reserve?: number;
  log?: (line: string) => void;
  /** @internal Tests only: runs between the steps (a test ends the process there). */
  hooks?: { point?: (point: ShrinkPoint) => void | Promise<void> };
}

/** A state none of the steps can leave, or a check that failed: nothing more is changed, the service stays stopped. */
export class ShrinkStopped extends Error {
  override name = "ShrinkStopped";
}

type Paths = { data: string; conversations: string };
const pathsOf = (project: string): Paths => {
  const data = join(resolve(project), "data");
  return { data, conversations: join(data, "conversations") };
};

/** The files of one shrink replacement. */
export const shrinkFiles = (path: string, run: string): Files => replacementFiles(path, "shrink", run);

// ─── Preview ───────────────────────────────────────────────────────────────

export type ShrinkDatabase = {
  space: string;
  bytes: number;
  walBytes: number;
  /** Pages in use × page size: about the size of the copy. */
  usedBytes: number;
  /** Free pages × page size: what the shrink gives back once the kept original is removed. */
  freeBytes: number;
  shrink: boolean;
};
export type ShrinkPreview = {
  databases: ShrinkDatabase[];
  /** Every copy stays next to its kept original until that is removed: all of them count on their volume. */
  volumes: VolumeNeed[];
  /** Why the command would recover first, or refuse. */
  unfinished?: string;
  blocked?: string;
};

const selected = (options: ShrinkOptions, db: ShrinkDatabase) => db.shrink && (!options.spaces || options.spaces.includes(db.space));

/** Read only, also while the service runs. */
export async function previewShrink(options: ShrinkOptions): Promise<ShrinkPreview> {
  const paths = pathsOf(options.project);
  const databases: ShrinkDatabase[] = [];
  for (const space of await spaceDirectories(paths.conversations)) {
    const path = databasePath(paths, space);
    if (!existsSync(path)) continue;
    const info = readQuietly(path, pages), freeBytes = info.freePages * info.pageSize;
    databases.push({ space, bytes: sizeOf(path), walBytes: sizeOf(`${path}-wal`), usedBytes: (info.pages - info.freePages) * info.pageSize,
      freeBytes, shrink: freeBytes >= SHRINK_MINIMUM });
  }
  const unknown = (options.spaces ?? []).filter(space => !databases.some(db => db.space === space));
  if (unknown.length) throw new Error(`没有这些空间的会话库：${unknown.join("、")}`);
  const volumes = new Map<string, VolumeNeed>();
  for (const db of databases.filter(db => selected(options, db))) {
    const directory = dirname(databasePath(paths, db.space)), dev = String(statSync(directory).dev);
    const volume = volumes.get(dev) ?? { path: directory, need: options.reserve ?? SPACE_RESERVE, free: Number(statfsSync(directory).bavail) * statfsSync(directory).bsize };
    volume.need += db.usedBytes + db.walBytes;
    volumes.set(dev, volume);
  }
  const state = readMaintenanceState(options.project), assessment = assessMaintenanceAction(state, "shrink");
  const unfinished = state.shrink.status === "present" && state.shrink.unfinished
    ? `会话库收缩（运行 ${state.shrink.run}）有一个库尚未替换完成（${state.shrink.unfinished.space}，阶段 ${state.shrink.unfinished.state}）` : undefined;
  const blocked = assessment.allowed ? undefined : assessment.reasons.join("；");
  return { databases, volumes: [...volumes.values()], ...(unfinished ? { unfinished } : {}), ...(blocked ? { blocked } : {}) };
}

// ─── Replacement ───────────────────────────────────────────────────────────

class Shrinker {
  readonly paths: Paths;
  constructor(readonly options: ShrinkOptions, public record: ShrinkRecord) { this.paths = pathsOf(options.project); }

  save() { return writeShrinkRecord(this.paths.data, this.record); }

  host(current: Replacement): ReplacementHost {
    const files = shrinkFiles(databasePath(this.paths, current.space), this.record.run);
    return {
      current, files, expected: current.original, words: { record: "收缩记录", kept: "原库" },
      save: () => this.save(),
      point: async point => { await this.options.hooks?.point?.(point); },
      stopped: message => new ShrinkStopped(message),
      finished: async after => {
        this.record.done.push({ space: current.space, before: current.original.bytes, after, ms: Date.now() - current.startedAt, kept: files.old });
        delete this.record.current;
        await this.save();
        this.options.log?.(`${current.space}：${current.original.bytes} → ${after} 字节；原库保留在 ${files.old}`);
      },
      dropped: async () => { delete this.record.current; await this.save(); },
      log: this.options.log,
    };
  }

  /** Steps 1–5 for one database. */
  async replace(space: string): Promise<void> {
    const path = databasePath(this.paths, space), files = shrinkFiles(path, this.record.run);
    for (const file of [files.copy, files.copyWal, files.copyShm, files.old, files.oldWal, files.oldShm]) if (existsSync(file)) throw new ShrinkStopped(`收缩要用的路径已有文件：${file}`);
    const startedAt = Date.now();
    const busy = emptyWal(path, space);
    if (busy) throw new ShrinkStopped(busy);
    const reader = openQueryOnly(path);
    let current: Replacement;
    try {
      const meta = metadata(reader);
      current = { space, state: "writing", original: { file: fileIdentity(path), bytes: sizeOf(path), nextSeq: meta.nextSeq, nextId: meta.nextId }, startedAt };
    } finally { reader.close(); }
    this.record.current = current;
    await this.save();
    const host = this.host(current);
    await host.point("writing");
    // 2. The copy, checked against the original before anything is renamed; a copy that fails goes away again.
    try {
      await writeBackup(path, files.copy);
      await adoptOriginal(path, files.copy, space, message => new ShrinkStopped(message));
      current.copy = { file: fileIdentity(files.copy), ...await verifyCopy(path, files.copy) };
    } catch (error) {
      await removeCopy(files);
      delete this.record.current;
      await this.save();
      throw error;
    }
    current.state = "verified";
    await this.save();
    await host.point("verified");
    await install(host);
  }
}

/** The copy against the original (nothing writes either meanwhile): a full check, every row, no free pages. */
async function verifyCopy(source: string, target: string): Promise<{ bytes: number; sha256: string }> {
  const original = openQueryOnly(source);
  try {
    const copy = openQueryOnly(target);
    try {
      const check = integrity(copy);
      if (check !== "ok") throw new ShrinkStopped(`副本的完整性检查未通过：${check}`);
      const want = metadata(original), got = metadata(copy);
      if (want.nextSeq !== got.nextSeq || want.nextId !== got.nextId || want.schema !== got.schema) throw new ShrinkStopped("副本的 Durable 元数据与原库不同");
      if (JSON.stringify(tableCounts(copy)) !== JSON.stringify(tableCounts(original))) throw new ShrinkStopped("副本各表的行数与原库不同");
      if (pages(copy).freePages !== 0) throw new ShrinkStopped("副本仍有空闲页");
      // Equal rows in every table: every document reads the same through any reader, Durable's included.
      if (JSON.stringify(tableDigests(copy)) !== JSON.stringify(tableDigests(original))) throw new ShrinkStopped("副本的内容与原库不同");
    } finally { copy.close(); }
  } finally { original.close(); }
  for (const file of [`${target}-wal`, `${target}-shm`]) if (existsSync(file)) throw new ShrinkStopped(`关闭副本后仍有 ${file}，没有改动`);
  return { bytes: sizeOf(target), sha256: await fileDigest(target) };
}

// ─── Run ───────────────────────────────────────────────────────────────────

export type ShrinkSummary = { run: string; recovered?: Recovered; done: Shrunk[] };

const newRecord = (): ShrinkRecord => ({
  version: 1, run: `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`, startedAt: new Date().toISOString(), done: [],
});

/** Moves the ended record (no replacement in flight) out of the way of the next run. */
async function archive(data: string, record: ShrinkRecord): Promise<void> {
  if (!record.endedAt) {
    record.endedAt = new Date().toISOString();
    await writeShrinkRecord(data, record);
  }
  await mkdir(shrinkHistory(data), { recursive: true, mode: 0o700 });
  await rename(shrinkRecordPath(data), join(shrinkHistory(data), `${record.run}.json`));
}

/**
 * Recovers an unfinished replacement first, then shrinks the selected databases one by one. Throws MaintenanceRefused (a
 * cleanup document in flight, a restore pending, a state file this version cannot read), ShrinkStopped (the record
 * stays as it was; nothing more is changed), or what failed underneath (running it again recovers).
 */
export async function applyShrink(options: ShrinkOptions): Promise<ShrinkSummary> {
  const paths = pathsOf(options.project);
  const assessment = assessMaintenanceAction(readMaintenanceState(options.project), "shrink");
  if (!assessment.allowed) throw new MaintenanceRefused("shrink", assessment.reasons);
  const previous = readShrinkRecord(paths.data);
  let recovered: Recovered | undefined;
  if (previous?.current) recovered = await recover(new Shrinker(options, previous).host(previous.current));
  if (previous) await archive(paths.data, previous);
  const preview = await previewShrink(options);
  const chosen = preview.databases.filter(db => selected(options, db));
  if (!chosen.length) return { run: "", ...(recovered ? { recovered } : {}), done: [] };
  const short = preview.volumes.filter(volume => volume.need > volume.free);
  if (short.length) throw new ShrinkStopped(`空间不足，收缩没有开始：${short.map(v => `${v.path} 需要 ${v.need} 字节，可用 ${v.free} 字节`).join("；")}`);
  const shrinker = new Shrinker(options, newRecord());
  await shrinker.save();
  for (const db of chosen) await shrinker.replace(db.space);
  shrinker.record.endedAt = new Date().toISOString();
  await shrinker.save();
  return { run: shrinker.record.run, ...(recovered ? { recovered } : {}), done: shrinker.record.done };
}

// ─── Kept originals ────────────────────────────────────────────────────────

export type KeptOriginal = { run: string; space: string; path: string; bytes: number };

/** The originals that finished replacements kept and that are still in place. Read only. */
export function keptOriginals(project: string): KeptOriginal[] {
  const paths = pathsOf(project), current = readShrinkRecord(paths.data);
  const kept: KeptOriginal[] = [];
  for (const record of [...archivedShrinkRecords(paths.data), ...(current ? [current] : [])]) {
    for (const item of record.done) {
      const files = shrinkFiles(databasePath(paths, item.space), record.run);
      if (existsSync(files.old)) kept.push({ run: record.run, space: item.space, path: files.old, bytes: sizeOf(files.old) + sizeOf(files.oldWal) + sizeOf(files.oldShm) });
    }
  }
  return kept;
}

/** Removes the kept originals of finished replacements, with their -wal and -shm (after the user confirmed). */
export async function removeKeptOriginals(project: string): Promise<KeptOriginal[]> {
  const paths = pathsOf(project), kept = keptOriginals(project);
  for (const item of kept) {
    const files = shrinkFiles(databasePath(paths, item.space), item.run);
    for (const file of [files.old, files.oldWal, files.oldShm]) await rm(file, { force: true });
  }
  return kept;
}
