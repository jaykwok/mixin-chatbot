// Durable remote-object ledger backed by Bun's SQLite API. Live rows are never evicted.
import { createHash } from "node:crypto";
import { openState } from "../core/state.ts";

export interface RelayIndexEntry {
  key: string; url: string; name: string; size: number; at: string;
  state: "planned" | "uploaded";
}
export interface RelayIndex {
  get(key: string): RelayIndexEntry | undefined;
  /** Oldest uploaded row for this URL, breaking ties by key. Planned uploads never qualify. */
  findUploaded(url: string): RelayIndexEntry | undefined;
  /** All live rows ordered by at, then key. */
  entries(): RelayIndexEntry[];
  remember(entry: RelayIndexEntry): Promise<void>;
  forget(key: string): Promise<void>;
  close(): void;
}
export function relayCacheKey(digest: string, filename: string, namespace: string): string {
  return createHash("sha256").update(namespace).digest("hex") + ":" + digest + ":" + filename;
}
export async function openRelayIndex(path: string): Promise<RelayIndex> {
  const db = openState(path);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS objects_uploaded_url ON objects(url, at, key) WHERE state = 'uploaded'");
    const insert = db.query("INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?, ?)");
    const uploaded = db.query("SELECT * FROM objects WHERE url = ? AND state = 'uploaded' ORDER BY at, key LIMIT 1");
    return {
      get: (key) => (db.query("SELECT * FROM objects WHERE key = ?").get(key) as RelayIndexEntry | null) ?? undefined,
      findUploaded: (url) => (uploaded.get(url) as RelayIndexEntry | null) ?? undefined,
      entries: () => db.query("SELECT * FROM objects ORDER BY at, key").all() as RelayIndexEntry[],
      async remember(entry) { insert.run(entry.key, entry.url, entry.name, entry.size, entry.at, entry.state); },
      async forget(key) { db.query("DELETE FROM objects WHERE key = ?").run(key); },
      close: () => db.close(),
    };
  } catch (error) { db.close(); throw error; }
}
