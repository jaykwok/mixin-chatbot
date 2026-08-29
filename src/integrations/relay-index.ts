// 外链去重索引：内容哈希 -> 已上传的公开地址。
//
// 追加写 JSONL 而不是重写整个 JSON：进程随时可能被杀（云桌面重启、部署脚本重启服务），
// 追加最多丢掉最后一行，而重写会丢掉整份索引。删除用墓碑记录表达，保持全程只追加。
//
// 索引丢失不影响正确性，只是会多传一次，因此放在 data/runtime（可重建）而不是 data/state。
import { createHash } from "node:crypto";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { log } from "../core/log.ts";

/** 超过这个条数就在加载时压实一次，保留最新的部分。 */
const MAX_INDEX_ENTRIES = 20_000;

interface RelayIndexEntry {
  /** 内容哈希 + 文件名，见 relayCacheKey。 */
  key: string;
  url: string;
  name: string;
  size: number;
  at: string;
}

type IndexLine = RelayIndexEntry | { key: string; deleted: true; at: string };

export interface RelayIndex {
  get(key: string): RelayIndexEntry | undefined;
  remember(entry: RelayIndexEntry): Promise<void>;
  forget(key: string): Promise<void>;
  size(): number;
}

/**
 * 同样的字节 + 同样的文件名才算同一次分发。只按哈希会让改名后的文件复用旧链接，
 * 下载下来还是旧名字；多传一次的代价远小于给用户一个名字对不上的文件。
 */
export function relayCacheKey(digest: string, filename: string): string {
  return `${digest}:${filename}`;
}

/** 流式计算 SHA-256，避免把整个文件读进内存。 */
export async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function parseLine(line: string): IndexLine | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.key !== "string") {
      return null;
    }
    if (parsed.deleted === true) {
      return { key: parsed.key, deleted: true, at: String(parsed.at ?? "") };
    }
    if (typeof parsed.url !== "string" || typeof parsed.name !== "string") return null;
    return {
      key: parsed.key,
      url: parsed.url,
      name: parsed.name,
      size: typeof parsed.size === "number" ? parsed.size : 0,
      at: String(parsed.at ?? ""),
    };
  } catch {
    return null;
  }
}

async function loadEntries(path: string): Promise<Map<string, RelayIndexEntry>> {
  const entries = new Map<string, RelayIndexEntry>();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return entries;
    throw error;
  }

  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    if (!parsed) {
      // 进程被杀时最后一行可能只写了一半；跳过坏行而不是让整个索引失效。
      skipped++;
      continue;
    }
    if ("deleted" in parsed) entries.delete(parsed.key);
    else entries.set(parsed.key, parsed);
  }
  if (skipped > 0) log.warn(`外链索引跳过 ${skipped} 行无法解析的记录: ${path}`);
  return entries;
}

/** 原子重写，避免压实过程中被杀导致索引半截。 */
async function rewrite(path: string, entries: Iterable<RelayIndexEntry>): Promise<void> {
  const body = [...entries].map((entry) => JSON.stringify(entry)).join("\n");
  const temp = join(dirname(path), `.relay-index-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temp, body ? `${body}\n` : "", "utf8");
  await rename(temp, path);
}

/**
 * 打开（或创建）一个去重索引。加载是同步阻塞前的一次性成本，之后全在内存里查。
 */
export async function openRelayIndex(path: string): Promise<RelayIndex> {
  mkdirSync(dirname(path), { recursive: true });
  let entries = await loadEntries(path);

  if (entries.size > MAX_INDEX_ENTRIES) {
    const newest = [...entries.values()]
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-MAX_INDEX_ENTRIES);
    await rewrite(path, newest);
    entries = new Map(newest.map((entry) => [entry.key, entry]));
    log.info(`外链索引已压实至 ${entries.size} 条: ${path}`);
  }

  // 追加串行化：并发的 remember/forget 不能交错写进同一行。
  let tail: Promise<void> = Promise.resolve();
  const append = (line: IndexLine): Promise<void> => {
    const next = tail.then(
      () => appendFile(path, `${JSON.stringify(line)}\n`, "utf8"),
      () => appendFile(path, `${JSON.stringify(line)}\n`, "utf8")
    );
    tail = next.then(
      () => {},
      () => {}
    );
    return next;
  };

  return {
    get: (key) => entries.get(key),
    size: () => entries.size,
    async remember(entry) {
      entries.set(entry.key, entry);
      await append(entry);
    },
    async forget(key) {
      if (!entries.delete(key)) return;
      await append({ key, deleted: true, at: new Date().toISOString() });
    },
  };
}
