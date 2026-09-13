import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { groupSegment, isPathInside } from "../../src/agent/paths.ts";

export type GroupSelection = "auto" | "id" | "segment";

/** A scanned storage name and an external ID are different namespaces. */
export async function resolveGroupName(value: string, root: string, kind: GroupSelection = "auto"): Promise<string | null> {
  const names = await dataDirectoryNames(root, root);
  const encoded = groupSegment(value);
  const byId = names.includes(encoded) ? encoded : null;
  const bySegment = names.includes(value) ? value : null;
  if (kind === "id") return byId;
  if (kind === "segment") return bySegment;
  if (byId && bySegment && byId !== bySegment) {
    throw new Error("群号与存储目录存在歧义；请使用 --group-id 或 --storage-segment 明确选择");
  }
  return byId ?? bySegment;
}

/** Recheck the root and each directory before moving any user data. */
export async function assertDataDirectory(path: string, root: string): Promise<void> {
  const base = resolve(root);
  let current = resolve(path);
  if (!isPathInside(current, base)) throw new Error("群数据目录越界");
  const canonical = await realpath(base);
  for (;;) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || !isPathInside(await realpath(current), canonical)) {
      throw new Error("群数据路径已改变或包含符号链接，拒绝操作");
    }
    if (current === base) break;
    current = dirname(current);
  }
}

export async function dataDirectoryNames(path: string, root: string): Promise<string[]> {
  try {
    await assertDataDirectory(path, root);
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // Listing never follows an unsafe directory; a clear/purge rechecks before each archive.
    if (String(error).includes("符号链接")) return [];
    throw error;
  }
}
