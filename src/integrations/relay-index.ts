// Durable remote-object ledger backed by Bun's SQLite API. Live rows are never evicted.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { openState } from "../core/state.ts";

export interface RelayIndexEntry {
  key: string; url: string; name: string; size: number; at: string;
  state: "planned" | "uploaded";
  /** Fixed download deadline and independent cleanup deadline; null until upload is verified. */
  expiresAt?: string | null;
  deleteAfter?: string | null;
}
export interface RelayIndex {
  get(key: string): RelayIndexEntry | undefined;
  /** Oldest uploaded row for this URL, breaking ties by key. Planned uploads never qualify. */
  findUploaded(url: string): RelayIndexEntry | undefined;
  /** All live rows ordered by at, then key. */
  entries(): RelayIndexEntry[];
  /** When retiring an earlier generation, moving its key and inserting the new plan are atomic. */
  remember(entry: RelayIndexEntry, retiredKey?: string): Promise<void>;
  forget(key: string): Promise<void>;
  close(): void;
}
export function relayCacheKey(digest: string, filename: string, namespace: string): string {
  return createHash("sha256").update(namespace).digest("hex") + ":" + digest + ":" + filename;
}
/** Known incompatible/corrupt data must not be treated as a transient read failure by configuration tools. */
export class RelayIndexFormatError extends Error {
  override name = "RelayIndexFormatError";
}
function assertRelaySchema(db: Database): void {
  const columns = new Set((db.query("PRAGMA table_info(objects)").all() as { name: string }[]).map(column => column.name));
  if (["key", "url", "name", "size", "at", "state", "expiresAt", "deleteAfter"].some(column => !columns.has(column))) {
    throw new RelayIndexFormatError("外链账本结构无效");
  }
}

/** Validation and configuration previews must not create a ledger. */
export function readRelayIndex(path: string): RelayIndexEntry[] {
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, strict: true });
    if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().length) return [];
    assertRelaySchema(db);
    return db.query("SELECT * FROM objects ORDER BY at, key").all() as RelayIndexEntry[];
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "SQLITE_NOTADB" || code?.startsWith("SQLITE_CORRUPT")) {
      throw new RelayIndexFormatError("外链账本已损坏或不是 SQLite 数据库；请先恢复或核查原账本", { cause: error });
    }
    throw error;
  } finally { db?.close(); }
}
export async function openRelayIndex(path: string): Promise<RelayIndex> {
  const db = openState(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, expiresAt TEXT, deleteAfter TEXT)");
    assertRelaySchema(db);
    db.exec("CREATE INDEX IF NOT EXISTS objects_uploaded_url ON objects(url, at, key) WHERE state = 'uploaded'");
    const insert = db.query("INSERT OR REPLACE INTO objects (key, url, name, size, at, state, expiresAt, deleteAfter) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const uploaded = db.query("SELECT * FROM objects WHERE url = ? AND state = 'uploaded' ORDER BY at, key LIMIT 1");
    return {
      get: (key) => (db.query("SELECT * FROM objects WHERE key = ?").get(key) as RelayIndexEntry | null) ?? undefined,
      findUploaded: (url) => (uploaded.get(url) as RelayIndexEntry | null) ?? undefined,
      entries: () => db.query("SELECT * FROM objects ORDER BY at, key").all() as RelayIndexEntry[],
      async remember(entry, retiredKey) {
        db.transaction(() => {
          if (retiredKey) db.query("UPDATE objects SET key = ? WHERE key = ?").run(retiredKey, entry.key);
          insert.run(entry.key, entry.url, entry.name, entry.size, entry.at, entry.state, entry.expiresAt ?? null, entry.deleteAfter ?? null);
        })();
      },
      async forget(key) { db.query("DELETE FROM objects WHERE key = ?").run(key); },
      close: () => db.close(),
    };
  } catch (error) { db.close(); throw error; }
}
