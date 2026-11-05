import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { stateDatabase } from "../core/state.ts";
import { groupSegment, scopeKey, spaceTmp, userSegment, userTmp, type Layout, type Scope } from "../core/layout.ts";
const initialized = new WeakSet<Database>();

/** Lists the parent on every call. A directory's stat stamp is not proof its entries are unchanged: on Windows it often
 * stays the same right after a child is created, and coarse Linux timestamps can miss a creation in the same tick. */
async function checkExistingSpellings(parent: string, segments: readonly string[]): Promise<void> {
  let names: string[];
  try { names = await readdir(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const spellings = new Map<string, string[]>();
  for (const name of names) {
    const folded = name.toLowerCase(), same = spellings.get(folded);
    if (same) same.push(name); else spellings.set(folded, [name]);
  }
  for (const segment of segments) {
    const alias = spellings.get(segment.toLowerCase())?.find((name) => name !== segment);
    if (alias) throw new Error(`标识大小写与已有目录 ${alias} 冲突，请使用原始群/用户标识`);
  }
}

/** Keep existing readable paths, while refusing aliases even after a service restart. */
export async function ensureStorageIdentity(layout: Pick<Layout, "conversations" | "tmp">, scope: Scope, phone: string,
  db: Database = stateDatabase()): Promise<void> {
  await ensureStorageIdentities(layout, scope, [phone], db);
}

/** `ensureStorageIdentity` for many members of one space (its preparation): each parent is listed once, and the state
 * rows are checked and added in one transaction. */
export async function ensureStorageIdentities(layout: Pick<Layout, "conversations" | "tmp">, scope: Scope, phones: readonly string[],
  db: Database = stateDatabase()): Promise<void> {
  if (!phones.length) return;
  if (scope.kind === "group") {
    const group = groupSegment(scope.groupId);
    await checkExistingSpellings(join(layout.conversations, "groups"), [group]);
    await checkExistingSpellings(join(layout.tmp, "groups"), [group]);
  }
  await checkExistingSpellings(spaceTmp(layout, scope), phones.map(userSegment));
  if (!initialized.has(db)) {
    db.exec("CREATE TABLE IF NOT EXISTS storage_identity (path TEXT PRIMARY KEY COLLATE NOCASE, identity TEXT NOT NULL)");
    initialized.add(db);
  }
  const space = scopeKey(scope);
  db.transaction(() => {
    const read = db.query("SELECT identity FROM storage_identity WHERE path = ?"), add = db.query("INSERT INTO storage_identity VALUES (?, ?)");
    const rows: [string, string][] = [[resolve(spaceTmp(layout, scope)), space]];
    for (const phone of phones) rows.push([resolve(userTmp(layout, scope, phone)), JSON.stringify([space, phone])]);
    for (const [path, identity] of rows) {
      const existing = read.get(path) as { identity: string } | null;
      if (existing && existing.identity !== identity) throw new Error("群/用户标识映射到已有数据目录，已拒绝读取和写入");
      if (!existing) add.run(path, identity);
    }
  })();
}
