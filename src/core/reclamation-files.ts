import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { TreeEvidence } from "../contracts/maintenance.ts";

/** One entry of a walked tree: relative path ("" for the root, then "/name"...), identity, type and, for a file, its
 * size and content hash, for a link its target. */
export type TreeEntry = { path: string; dev: string; ino: string; type: "directory" | "file" | "link"; size?: number; sha256?: string; target?: string };

/** Bounded evidence for an operator-reviewed deletion plan. No symlink or special file is read. `collect` receives
 * every entry of the same walk the fingerprint covers. */
export async function reclamationEvidence(path: string, collect?: (entry: TreeEntry) => void): Promise<TreeEvidence> {
  const hash = createHash("sha256");
  let bytes = 0, files = 0, entries = 0, newest = 0;
  const root = await lstat(path, { bigint: true });
  if (!root.isDirectory() && !root.isFile() && !root.isSymbolicLink()) throw new Error("回收对象必须是目录、普通文件或链接");
  const visit = async (path: string, relative: string, depth: number): Promise<void> => {
    if (++entries > 100_000 || depth > 64) throw new Error("回收预览超过 100000 条目或 64 层，请缩小范围");
    const observed = await lstat(path, { bigint: true });
    if (observed.dev !== root.dev) throw new Error("回收对象跨设备，拒绝遍历");
    newest = Math.max(newest, Number(observed.mtimeMs));
    hash.update(JSON.stringify([relative, String(observed.dev), String(observed.ino), String(observed.mode & 0o170000n), observed.isFile() ? String(observed.size) : null]));
    if (observed.isSymbolicLink()) {
      const target = await readlink(path);
      hash.update(JSON.stringify(target));
      const after = await lstat(path, { bigint: true });
      if (after.dev !== observed.dev || after.ino !== observed.ino || after.ctimeNs !== observed.ctimeNs) throw new Error("回收链接在扫描期间改变");
      collect?.({ path: relative, dev: String(observed.dev), ino: String(observed.ino), type: "link", target });
      return;
    }
    if (!observed.isDirectory() && !observed.isFile()) throw new Error("回收对象包含特殊文件，保留并人工核对");
    let held: FileHandle | undefined;
    try {
      held = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (observed.isDirectory() ? constants.O_DIRECTORY : 0));
      const actual = await held.stat({ bigint: true });
      if (actual.dev !== observed.dev || actual.ino !== observed.ino) throw new Error("回收对象在扫描期间被替换");
      if (actual.isDirectory()) {
        const directory = process.platform === "linux" ? `/proc/self/fd/${held.fd}` : path;
        for (const name of (await readdir(directory)).sort()) await visit(join(directory, name), relative + "/" + name, depth + 1);
        const after = await held.stat({ bigint: true });
        const named = await lstat(path, { bigint: true });
        if (after.mtimeNs !== actual.mtimeNs || after.ctimeNs !== actual.ctimeNs || named.dev !== actual.dev || named.ino !== actual.ino) throw new Error("回收目录在扫描期间改变");
        collect?.({ path: relative, dev: String(actual.dev), ino: String(actual.ino), type: "directory" });
      } else if (actual.isFile()) {
        files++;
        const buffer = Buffer.alloc(65536), own = collect && createHash("sha256"); let position = 0;
        for (;;) {
          const { bytesRead } = await held.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
          position += bytesRead; bytes += bytesRead;
          if (bytes > 4 * 1024 ** 3) throw new Error("单项回收证据超过 4 GiB，请缩小范围");
          hash.update(buffer.subarray(0, bytesRead)); own?.update(buffer.subarray(0, bytesRead));
        }
        const after = await held.stat({ bigint: true });
        if (after.size !== actual.size || after.mtimeNs !== actual.mtimeNs || after.ctimeNs !== actual.ctimeNs) throw new Error("回收文件在扫描期间改变");
        collect?.({ path: relative, dev: String(actual.dev), ino: String(actual.ino), type: "file", size: position, sha256: own!.digest("hex") });
      } else throw new Error("回收对象包含特殊文件，保留并人工核对");
    } finally { await held?.close(); }
  };
  await visit(path, "", 0);
  return { dev: String(root.dev), ino: String(root.ino), uid: Number(root.uid), fingerprint: hash.digest("hex"), bytes, files, newest };
}
