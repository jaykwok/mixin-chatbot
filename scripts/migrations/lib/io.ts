import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout } from "node:timers/promises";

export async function info(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function ordinaryPath(root: string, path: string): Promise<void> {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw new Error("迁移路径越界");
  let current = root;
  for (const part of ["", ...rel.split(sep).filter(Boolean)]) {
    current = join(current, part);
    if ((await info(current))?.isSymbolicLink()) throw new Error(`迁移路径经过符号链接或目录联接：${current}`);
  }
}
export async function bytes(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function json(path: string): Promise<Record<string, any> | null> {
  const value = await bytes(path);
  if (!value) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value.toString("utf8").replace(/^\uFEFF/, "")); }
  catch { throw new Error(`JSON 格式无效：${path}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`必须是 JSON 对象：${path}`);
  return parsed;
}
export const digest = (value: Uint8Array | null) => value === null ? null : createHash("sha256").update(value).digest("hex");
export async function fileDigest(path: string): Promise<string | null> {
  const hash = createHash("sha256");
  try { for await (const chunk of createReadStream(path)) hash.update(chunk); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  return hash.digest("hex");
}
export async function publish(path: string, value: Uint8Array | string | AsyncIterable<Uint8Array>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".migration-" + randomUUID();
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      if (typeof value === "string" || value instanceof Uint8Array) await handle.writeFile(value);
      else for await (const chunk of value) await handle.writeFile(chunk);
      await handle.sync();
    } finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await setTimeout(25 * 2 ** attempt);
      }
    }
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export const publishFile = (path: string, source: string) => publish(path, createReadStream(source));
export const publishJson = (path: string, value: unknown) => publish(path, JSON.stringify(value, null, 2) + "\n");
