// Plan storage shared by archival and physical reclamation: bounded no-follow reads, root entities, per-member grouping.
// Each protocol keeps its own messages, file names and publication rule (see archive.ts and reclaim.ts).
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** A saved plan, progress or journal: a regular file of at most 32 MiB, opened without following a link. With
 * `private`, Linux also requires the current identity's own 0600-style file. */
export async function readPlanFile(path: string, rule: { private: boolean; message: string }): Promise<any> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024
      || (rule.private && process.platform === "linux" && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0))) throw new Error(rule.message);
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

/** `dev:ino` of a real directory (not a link); plans record it for their root. */
export async function directoryEntity(path: string, message: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(message);
  return `${info.dev}:${info.ino}`;
}

export const exists = (path: string) => lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });

/** Item indexes per member, in plan order: each member is applied under one protected view. */
export function memberIndexes(items: readonly { space: string; user: string }[]): number[][] {
  const members = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = JSON.stringify([item.space, item.user]), indexes = members.get(key) ?? [];
    indexes.push(index); members.set(key, indexes);
  });
  return [...members.values()];
}
