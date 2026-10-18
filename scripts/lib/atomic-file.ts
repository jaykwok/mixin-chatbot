import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";

export async function publish(path: string, value: Uint8Array | string | AsyncIterable<Uint8Array>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".atomic-" + randomUUID();
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
export const publishJson = (path: string, value: unknown) => publish(path, JSON.stringify(value, null, 2) + "\n");

export const digest = (value: Uint8Array | null) => value === null ? null : createHash("sha256").update(value).digest("hex");
