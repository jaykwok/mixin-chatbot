import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { addAbortSignal } from "node:stream";

export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  if (signal) addAbortSignal(signal, stream);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
