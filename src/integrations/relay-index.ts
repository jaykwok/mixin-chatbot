// Durable remote-object ledger backed by Bun's SQLite API. Live rows are never evicted.
import { createHash } from "node:crypto";
import { openState } from "../core/state.ts";

export interface RelayIndexEntry {
  key: string; url: string; name: string; size: number; at: string;
  state: "planned" | "uploaded";
}
export interface RelayIndex {
  get(key: string): RelayIndexEntry | undefined;
  entries(): RelayIndexEntry[];
  remember(entry: RelayIndexEntry): Promise<void>;
  forget(key: string): Promise<void>;
  size(): number;
  close(): void;
}
export function relayCacheKey(digest: string, filename: string, namespace: string): string {
  return createHash("sha256").update(namespace).digest("hex") + ":" + digest + ":" + filename;
}
export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest("hex");
}
export async function openRelayIndex(path: string): Promise<RelayIndex> {
  const db = openState(path);
  db.exec("CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, url TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL)");
  const insert = db.query("INSERT OR REPLACE INTO objects VALUES (?, ?, ?, ?, ?, ?)");
  return {
    get: (key) => (db.query("SELECT * FROM objects WHERE key = ?").get(key) as RelayIndexEntry | null) ?? undefined,
    entries: () => db.query("SELECT * FROM objects ORDER BY at, key").all() as RelayIndexEntry[],
    async remember(entry) { insert.run(entry.key, entry.url, entry.name, entry.size, entry.at, entry.state); },
    async forget(key) { db.query("DELETE FROM objects WHERE key = ?").run(key); },
    size: () => (db.query("SELECT COUNT(*) AS count FROM objects").get() as { count: number }).count,
    close: () => db.close(),
  };
}
