// Where the conversation databases are, and whether this program can open them: shared by the service's discovery and by
// the release checks (service start, verification instance, commit), so both see the same databases.
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { assertDataDirectory } from "../../scripts/lib/group-data.ts";
import { isSegment } from "../core/layout.ts";
import { assertDurableSchema } from "./schema-gate.ts";

export const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Entries of a data directory; a missing one has none, an unsafe or unreadable one fails. */
async function entries(path: string, root: string): Promise<Dirent[]> {
  try {
    await assertDataDirectory(path, root);
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

/**
 * The space directories below the conversations root, as `spacePath` names (`direct`, `groups/<segment>`), sorted. Names
 * that are no space are skipped; a symbolic link where a space could be fails: a space behind it cannot be checked, and
 * the admin tools refuse to follow one too.
 */
export async function spaceDirectories(root: string): Promise<string[]> {
  const names: string[] = [];
  const link = (path: string) => new Error(`会话目录下有符号链接，无法确认其中的会话库，发现不完整：${path}`);
  for (const entry of await entries(root, root)) {
    if (entry.name !== "direct" && entry.name !== "groups") continue;
    if (entry.isSymbolicLink()) throw link(join(root, entry.name));
    if (!entry.isDirectory()) continue;
    if (entry.name === "direct") { names.push("direct"); continue; }
    for (const group of await entries(join(root, "groups"), root)) {
      if (!isSegment(group.name)) continue;
      if (group.isSymbolicLink()) throw link(join(root, "groups", group.name));
      if (group.isDirectory()) names.push(`groups/${group.name}`);
    }
  }
  return names.sort();
}

/**
 * Before a release is committed or the service opens anything: every existing conversation database under `root` must
 * be one this program opens without an in-place upgrade (new, or at the current Durable schema; see schema-gate.ts).
 * Missing databases are fine. Reads only, through read-only connections; an unreadable database, a database path that
 * is no file, or a directory that cannot be listed fails, so the check never passes on an incomplete view.
 */
export async function assertSpaceSchemas(root: string): Promise<void> {
  for (const directory of await spaceDirectories(root)) {
    const path = join(root, directory, "durable.sqlite");
    const info = await lstat(path).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw new Error(`无法确认会话库是否存在：${path}`, { cause: error });
    });
    if (info === undefined) continue;
    if (!info.isFile()) throw new Error(`会话库路径不是普通文件：${path}`);
    let db: Database;
    try { db = new Database(path, { readonly: true, strict: true }); }
    catch (error) { throw new Error(`无法读取会话库 ${path}：${(error as Error).message}`, { cause: error }); }
    try {
      await assertDurableSchema({ get: <T extends object>(sql: string) => (db.query(sql).get() as T | null) ?? undefined }, path);
    } catch (error) {
      if ((error as Error).message.startsWith("会话库格式")) throw error;
      throw new Error(`无法读取会话库 ${path}：${(error as Error).message}`, { cause: error });
    } finally { db.close(); }
  }
}
