import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { stateDatabase } from "../core/state.ts";
import { groupSegment, userSegment } from "./paths.ts";

async function checkExistingSpelling(parent: string, segment: string): Promise<void> {
  let names: string[];
  try { names = await readdir(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const alias = names.find((name) => name.toLowerCase() === segment.toLowerCase() && name !== segment);
  if (alias) throw new Error(`标识大小写与已有目录 ${alias} 冲突，请使用原始群/用户标识`);
}

/** Keep existing readable paths, while refusing aliases even after a service restart. */
export async function ensureStorageIdentity(root: string, groupId: string, phone: string, db: Database = stateDatabase()): Promise<void> {
  const group = groupSegment(groupId);
  const user = userSegment(phone);
  await checkExistingSpelling(root, group);
  await checkExistingSpelling(join(root, group, "users"), user);
  db.exec("CREATE TABLE IF NOT EXISTS storage_identity (path TEXT PRIMARY KEY COLLATE NOCASE, identity TEXT NOT NULL)");
  db.transaction(() => {
    for (const [path, identity] of [
      [resolve(root, group), groupId],
      [resolve(root, group, "users", user), JSON.stringify([groupId, phone])],
    ]) {
      const existing = db.query("SELECT identity FROM storage_identity WHERE path = ?").get(path) as { identity: string } | null;
      if (existing && existing.identity !== identity) throw new Error("群/用户标识映射到已有数据目录，已拒绝读取和写入");
      if (!existing) db.query("INSERT INTO storage_identity VALUES (?, ?)").run(path, identity);
    }
  })();
}
