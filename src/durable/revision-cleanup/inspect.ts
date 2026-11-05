// Read-only views of a conversation database for the revision cleanup: plain SQL on its own connection, never through
// Durable, so every check is independent of the code that wrote the state. Nothing here prints or returns document keys
// except inside the journal identity (the journal is user data, like the database).
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { constants, Database } from "bun:sqlite";
import { CHECKPOINT_INTERVAL } from "../checkpoint.ts";
import { sha256, type StoredRecord } from "./documents.ts";
import type { DocumentRef } from "./journal.ts";

export const openReader = (path: string): Database => new Database(path, { readonly: true, strict: true });

/**
 * A read that writes nothing beside the database, for the preview: the upgrade mounts data/ read-only, where a read-only
 * connection cannot create the -wal and -shm that a cleanly closed WAL database lacks (the service closes idle
 * conversations, and all of them when it stops). Without a -wal every commit is in the database file, which is then
 * read as immutable. The service may open the database meanwhile and checkpoint into the file: a changed size or time
 * (as fine as the file system keeps it) repeats the read, as does a -wal that disappeared before a normal read-only open
 * (the service closed the database). The result is an estimate either way: the cleanup itself reads every database
 * again after the stop, under the lease.
 */
export function readQuietly<T>(path: string, read: (db: Database) => T): T {
  for (let attempt = 1; ; attempt++) {
    const live = existsSync(`${path}-wal`), before = statSync(path, { bigint: true });
    let outcome: { value: T } | { error: unknown };
    try {
      const db = live ? openReader(path)
        : new Database(`${pathToFileURL(path).href}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
      try { outcome = { value: read(db) }; } finally { db.close(); }
    } catch (error) { outcome = { error }; }
    const after = statSync(path, { bigint: true });
    const changed = live ? "error" in outcome && !existsSync(`${path}-wal`)
      : after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ino !== before.ino;
    if (!changed) {
      if ("error" in outcome) throw new Error(`无法只读读取会话库 ${path}：${(outcome.error as Error).message}`, { cause: outcome.error });
      return outcome.value;
    }
    if (attempt === 3) throw new Error(`会话库 ${path} 在读取期间一直在变化，请稍后重试`);
  }
}

/** Identity of the database file: device and file number (Windows: volume serial and file index). */
export type FileIdentity = { dev: string; ino: string };
export function fileIdentity(path: string): FileIdentity {
  const info = statSync(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
}
export const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;

export type Metadata = { nextSeq: number; nextId: string; schema: number };
export function metadata(db: Database): Metadata {
  const row = db.query("SELECT next_seq, next_id FROM durable_metadata WHERE singleton = 1").get() as { next_seq: number; next_id: string } | null;
  const schema = db.query("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number } | null;
  if (!row || !schema) throw new Error("会话库缺少 Durable 元数据");
  return { nextSeq: row.next_seq, nextId: String(row.next_id), schema: schema.version };
}

/** The `documents` row: what the journal records as the document's identity. */
export type DocumentIdentity = {
  id: number; kind: string; family: number; key_value: string; scope_kind: string; owner_id: number; created_at: number;
  retired_at: number | null; record: string;
};
export function documentRow(db: Database, id: number): DocumentIdentity | undefined {
  return (db.query(`SELECT id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record FROM documents
    WHERE id = ?`).get(id) as DocumentIdentity | null) ?? undefined;
}
export const storedRecord = (row: DocumentIdentity): StoredRecord => JSON.parse(row.record) as StoredRecord;

/** The row as the journal names it: the key and the stored record (which holds the key) only by digest. */
export function documentRef(row: DocumentIdentity): DocumentRef {
  return { id: row.id, kind: row.kind, family: row.family, scope_kind: row.scope_kind, owner_id: row.owner_id, created_at: row.created_at,
    key: sha256(String(row.key_value)), record: sha256(row.record) };
}
export const sameRef = (a: DocumentRef, b: DocumentRef): boolean =>
  a.id === b.id && a.kind === b.kind && a.family === b.family && a.scope_kind === b.scope_kind && a.owner_id === b.owner_id &&
  a.created_at === b.created_at && a.key === b.key && a.record === b.record;

export type Chain = { revisions: number; bases: number; first: number | null; latest: number | null };
export function chain(db: Database, id: number): Chain {
  return db.query(`SELECT count(*) AS revisions, coalesce(sum(kind = 'base'), 0) AS bases, min(seq) AS first, max(seq) AS latest
    FROM document_revisions WHERE document_id = ?`).get(id) as Chain;
}

/** A document stored as exactly one base (the state after a cleanup commit); undefined otherwise. */
export function singleBase(db: Database, id: number): { seq: number; version: number; value: Record<string, unknown> } | undefined {
  const rows = db.query("SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? LIMIT 2").all(id) as
    { seq: number; kind: string; version: number; content: string }[];
  if (rows.length !== 1 || rows[0]!.kind !== "base") return undefined;
  return { seq: rows[0]!.seq, version: rows[0]!.version, value: JSON.parse(rows[0]!.content) as Record<string, unknown> };
}

export type Candidate = { row: DocumentIdentity; revisions: number; latest: number };

/** Documents with more revisions than the interval, in id order. Reads the revision index, never the contents. */
export function candidates(db: Database, threshold = CHECKPOINT_INTERVAL): Candidate[] {
  const rows = db.query(`SELECT d.id, d.kind, d.family, d.key_value, d.scope_kind, d.owner_id, d.created_at, d.retired_at, d.record,
      c.revisions, c.latest
    FROM (SELECT document_id, count(*) AS revisions, max(seq) AS latest FROM document_revisions GROUP BY document_id
      HAVING count(*) > ?) c
    JOIN documents d ON d.id = c.document_id ORDER BY d.id`).all(threshold) as (DocumentIdentity & { revisions: number; latest: number })[];
  return rows.map(({ revisions, latest, ...row }) => ({ row, revisions, latest }));
}

export type Pages = { pageSize: number; pages: number; freePages: number };
export function pages(db: Database): Pages {
  const one = (pragma: string) => Object.values(db.query(`PRAGMA ${pragma}`).get() as Record<string, number>)[0]!;
  return { pageSize: one("page_size"), pages: one("page_count"), freePages: one("freelist_count") };
}

type Table = { name: string; sql: string };
const tablesOf = (db: Database) => db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Table[];
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Row counts of every table: what a backup must reproduce. */
export function tableCounts(db: Database): Record<string, number> {
  return Object.fromEntries(tablesOf(db).map(({ name }) => [name, (db.query(`SELECT count(*) AS n FROM ${quote(name)}`).get() as { n: number }).n]));
}

/**
 * A digest of every row of every table, in rowid order (primary key order without a rowid): equal for a copy that holds
 * the same rows, whatever its pages look like. Streams the rows; the values are typed and length-prefixed.
 */
export function tableDigests(db: Database): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const { name, sql } of tablesOf(db)) {
    const keys = /without\s+rowid/i.test(sql)
      ? (db.query(`PRAGMA table_info(${quote(name)})`).all() as { name: string; pk: number }[]).filter(column => column.pk > 0)
        .sort((a, b) => a.pk - b.pk).map(column => quote(column.name)).join(", ")
      : "rowid";
    const hash = createHash("sha256");
    for (const row of db.query(`SELECT * FROM ${quote(name)} ORDER BY ${keys}`).iterate() as Iterable<Record<string, unknown>>) {
      for (const value of Object.values(row)) {
        if (value === null) hash.update("N;");
        else if (value instanceof Uint8Array) { hash.update(`B${value.length};`); hash.update(value); }
        else { const text = String(value); hash.update(`${typeof value === "string" ? "S" : "I"}${text.length};`); hash.update(text); }
      }
      hash.update("\n");
    }
    digests[name] = hash.digest("hex");
  }
  return digests;
}

export function integrity(db: Database): string {
  const rows = db.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
  return rows.map(row => row.integrity_check).join("; ");
}
