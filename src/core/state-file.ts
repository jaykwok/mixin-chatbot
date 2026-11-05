import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

/** Missing is the only permissive read failure. In particular, existsSync hides access errors and dangling links. */
export function readStateFile(path: string): string | undefined {
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("状态记录不是普通文件：" + path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("状态记录不是普通文件：" + path);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
