// The revision cleanup journal, data/state/revision-cleanup.json (revision-chain plan §4.3, §8.1). Written before every
// change it describes (atomic replace, file and directory synced), so a run that was killed resumes from it. It holds
// no document value and no document key: the document in flight is named by its id, its other `documents` columns and
// digests of its key and stored record, and its value only by digest. A format this version does not write (the first,
// unreleased one carried values and temporary keys) is refused everywhere, the rollback path included.
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { publishJson } from "../../../scripts/lib/atomic-file.ts";
import type { FileIdentity } from "./inspect.ts";
import type { Replacement } from "./replace.ts";
import { readStateFile } from "../../core/state-file.ts";

export const JOURNAL_FILE = "revision-cleanup.json";
/** Finished runs, by run id, moved here when the next run starts. */
export const JOURNAL_HISTORY = "revision-cleanup";
export const JOURNAL_VERSION = 2;

/** A `documents` row without its key: the other columns, and SHA-256 digests of `key_value` and `record`. */
export type DocumentRef = {
  id: number; kind: string; family: number; scope_kind: string; owner_id: number; created_at: number; key: string; record: string;
};

export type InFlight = {
  space: string;
  document: DocumentRef;
  before: { revisions: number; latest: number };
  /** `durable_metadata.next_seq` before the commit: the base gets N0, and the database then reads N0 + 1. */
  n0: number;
  /** The stored version of the document: the base keeps it. */
  version: number;
  /** Digest of the value (canonical JSON) the base must carry. */
  digest: string;
  startedAt: number;
};

export type BackupRecord = {
  path: string;
  state: "writing" | "verified";
  /** The database when the backup started: unchanged since, the backup can be written again. */
  source: { file: FileIdentity; nextSeq: number; nextId: string };
  bytes?: number;
  sha256?: string;
  counts?: Record<string, number>;
  ms?: number;
};

/** A compacted document: the seq of its one base and the digest of its value. */
export type Settled = { id: number; kind: string; revisions: number; seq: number; digest: string; ms: number };

export type DatabaseRecord = {
  space: string;
  file: FileIdentity;
  schema: number;
  /**
   * `durable_metadata.next_seq` as this run last left the database (when it was first journaled, then after every settled
   * document). Different when the run resumes: another writer (the service) has written since, so the run is over.
   */
  nextSeq: number;
  backup?: BackupRecord;
  done: Settled[];
  checkpoint?: { busy: number; log: number; checkpointed: number; walBytes: number };
  finished?: true;
};

/**
 * A committed base that differs from the journal (§8.1): the run stops and the database waits for a restore from its
 * backup (`required`), which the restore command takes through `replacing` (the swap's own record) to `done`.
 */
export type Restore = {
  space: string;
  document: { id: number; kind: string; seq: number; expected: string; found: string };
  at: string;
  state: "required" | "replacing" | "done";
  /** The restore's own run id (file names) and the swap under way. */
  replacement?: { run: string; current: Replacement };
  /** After `done`: where the replaced database was kept, and when. */
  kept?: string;
  restoredAt?: string;
  /** After `done`: the documents this run had settled in the database, which the restore undid (no longer in its `done`). */
  reverted?: number;
};

export type JournalState = "running" | "stopped" | "finished" | "skipped" | "abandoned";

export type Journal = {
  version: typeof JOURNAL_VERSION;
  run: string;
  transaction?: string;
  startedAt: string;
  interval: number;
  state: JournalState;
  stop?: { at: string; reason: string };
  /** Why a later run ended this one as skipped instead of resuming it. */
  superseded?: string;
  databases: DatabaseRecord[];
  current?: InFlight;
  restore?: Restore;
  endedAt?: string;
};

export const journalPath = (data: string): string => join(data, "state", JOURNAL_FILE);

/** A journal this version cannot read: never settled, resumed or ended by it. */
export class UnsupportedJournal extends Error {
  override name = "UnsupportedJournal";
}

export function readJournal(data: string): Journal | undefined {
  const path = journalPath(data);
  let journal: Journal;
  try {
    const text = readStateFile(path);
    if (text === undefined) return undefined;
    journal = JSON.parse(text) as Journal;
  }
  catch (error) { throw new UnsupportedJournal(`修订整理日志无法解析：${path}：${(error as Error).message}`); }
  const version = (journal as { version?: unknown } | null)?.version;
  if (version !== JOURNAL_VERSION) {
    throw new UnsupportedJournal(`修订整理日志的格式不受支持（格式 ${JSON.stringify(version ?? null)}，本版本只处理格式 ${JOURNAL_VERSION}）：${path}。` +
      "它不是本版本写出的（格式 1 只出现在未发布的开发版本中），本版本不收尾、不续做、也不在回滚时结束它，请人工处理");
  }
  if (typeof journal.run !== "string" || !Array.isArray(journal.databases) || typeof journal.state !== "string") {
    throw new UnsupportedJournal(`修订整理日志无法识别：${path}`);
  }
  return journal;
}

export const writeJournal = (data: string, journal: Journal): Promise<void> => publishJson(journalPath(data), journal);

/** Moves an ended run (no document in flight, no restore pending) out of the way of the next one. */
export async function archiveJournal(data: string, journal: Journal): Promise<string> {
  if (journal.current || journal.state === "running" || journal.state === "stopped" || (journal.restore && journal.restore.state !== "done")) {
    throw new Error("修订整理日志尚未结束，不能归档");
  }
  const directory = join(data, "state", JOURNAL_HISTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${journal.run}.json`);
  await rename(journalPath(data), target);
  return target;
}
