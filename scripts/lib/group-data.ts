import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isPathInside } from "../../src/agent/paths.ts";

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
