import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { isSlashCommandMessage } from "../../src/agent/commands.ts";

export interface StatsRecord {
  type?: string; timestamp?: string; provider?: string; modelId?: string; usage?: Record<string, unknown>;
  message?: { role?: string; command?: boolean; provider?: string; model?: string; content?: { type: string; name?: string }[];
    usage?: Record<string, unknown>; toolName?: string; isError?: boolean; details?: { fileId?: string } };
}
interface Snapshot {
  identity: string; stamp: string; size: number; offset: number; digest: string;
  records: StatsRecord[]; skipped: number; partial: string; trailing?: StatsRecord;
}
const cache = new Map<string, Snapshot>();
const reading = new Map<string, Promise<{ records: StatsRecord[]; skipped: number }>>();

function project(line: string): StatsRecord {
  const raw = JSON.parse(line);
  if (!raw || typeof raw !== "object") return {};
  const m = raw.message;
  const content = Array.isArray(m?.content) ? m.content : [];
  return { type: raw.type, timestamp: raw.timestamp, provider: raw.provider, modelId: raw.modelId, usage: raw.usage,
    ...(m && { message: { role: m.role, provider: m.provider, model: m.model, usage: m.usage,
      command: m.role === "user" && isSlashCommandMessage(content.find((part: any) => part?.type === "text")?.text ?? ""),
      content: content.filter((part: any) => part?.type === "toolCall" && typeof part.name === "string").map((part: any) => ({ type: "toolCall", name: part.name })),
      toolName: m.toolName, isError: m.isError, details: m.details?.fileId ? { fileId: "confirmed" } : undefined } }),
  };
}

async function refresh(path: string): Promise<{ records: StatsRecord[]; skipped: number }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("会话文件不是普通文件");
  const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  const stamp = `${identity}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const old = cache.get(path);
  if (old?.stamp === stamp) {
    cache.delete(path); cache.set(path, old);
    return { records: old.trailing ? [...old.records, old.trailing] : old.records, skipped: old.skipped + (old.partial.trim() && !old.trailing ? 1 : 0) };
  }
  let offset = 0, records: StatsRecord[] = [], skipped = 0;
  const hash = createHash("sha256");
  if (old && old.identity === identity && info.size > old.size) {
    for await (const chunk of Bun.file(path).slice(0, old.offset).stream()) hash.update(chunk);
    // Verify the entire old prefix: an in-place rewrite followed by append is not mistaken for append-only.
    if (hash.copy().digest("hex") === old.digest) { offset = old.offset; records = [...old.records]; skipped = old.skipped; }
  }
  const bytes = Buffer.from(await Bun.file(path).slice(offset, info.size).arrayBuffer());
  const last = bytes.lastIndexOf(10);
  const complete = bytes.subarray(0, last + 1);
  for (const line of complete.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(project(line)); } catch { skipped++; }
  }
  const partial = bytes.subarray(last + 1).toString("utf8");
  // A valid last line without a newline is shown but never advances the append checkpoint.
  let trailing: StatsRecord | undefined;
  try { if (partial.trim()) trailing = project(partial); } catch { /* unfinished line */ }
  const digest = offset ? hash.update(complete).digest("hex") : createHash("sha256").update(complete).digest("hex");
  cache.delete(path);
  const after = await lstat(path);
  const afterStamp = `${after.dev}:${after.ino}:${after.birthtimeMs}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
  // A writer may append, truncate or replace while we read. Never retain a mixed snapshot.
  if (after.isFile() && !after.isSymbolicLink() && afterStamp === stamp) {
    cache.set(path, { identity, stamp, size: info.size, offset: offset + complete.length, digest, records, skipped, partial, trailing });
  }
  // Cache metadata only, with a bounded entry count and total retained records.
  let count = [...cache.values()].reduce((sum, value) => sum + value.records.length, 0);
  while (cache.size > 256 || count > 100000) {
    const first = cache.keys().next().value!;
    count -= cache.get(first)!.records.length; cache.delete(first);
  }
  return { records: trailing ? [...records, trailing] : records, skipped: skipped + (partial.trim() && !trailing ? 1 : 0) };
}

export function readSessionStats(path: string): Promise<{ records: StatsRecord[]; skipped: number }> {
  const key = resolve(path);
  let job = reading.get(key);
  if (!job) {
    job = refresh(key).catch(error => { cache.delete(key); throw error; }).finally(() => reading.delete(key));
    reading.set(key, job);
  }
  return job;
}
