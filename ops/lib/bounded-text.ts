// A small file read whole as strict UTF-8. Links, other file types and files over the limit are refused before any
// content is read, so callers never follow a planted link or buffer an unbounded file. Built-ins only.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

/** Null when the path does not exist; any other problem throws, and callers report it in their own words. */
export function readBoundedText(path: string, max: number): string | null {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error("not a regular file within the limit");
  // Judged again on what was opened: O_NOFOLLOW refuses a link swapped in after lstat, O_NONBLOCK keeps a FIFO from
  // blocking the open, and the read stops past the limit even if the file grows.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > max) throw new Error("not a regular file within the limit");
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(Math.max(opened.size - length, 0) + 1, max + 1 - length, 1024 * 1024));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read)); length += read;
      if (length > max) throw new Error("not a regular file within the limit");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } finally { closeSync(fd); }
}
