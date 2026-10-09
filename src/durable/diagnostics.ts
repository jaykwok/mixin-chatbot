import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ConversationId, type EntryId, type Storage } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage, type SqliteDatabase, type SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { MemberDirectory } from "./identity.ts";

/** Read the source connection only; official migrations/recovery run against a disposable memory snapshot. */
export async function withGroupSnapshot<T>(path: string, read: (harness: Harness, storage: Storage) => Promise<T>): Promise<T> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("诊断只接受普通群数据库文件");
  if (info.size > 256 * 1024 * 1024) throw new Error("群库超过 256 MiB，请先使用离线快照做诊断");
  const source = new Database(path, { readonly: true, strict: true });
  let memory: Database;
  try {
    source.exec("BEGIN");
    const version = (source.query("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number } | null)?.version;
    if (version !== CURRENT_SQLITE_SCHEMA_VERSION) throw new Error("群库 SQLite 版本不匹配，请先升级");
    const bytes = source.serialize();
    if (bytes.length > 256 * 1024 * 1024) throw new Error("群库快照超过诊断内存限额");
    // sqlite3_deserialize cannot read WAL images; only the private snapshot changes its journal header.
    bytes[18] = 1; bytes[19] = 1;
    memory = Database.deserialize(bytes, { strict: true });
  } finally { source.close(); }
  let line: Promise<unknown> = Promise.resolve();
  const queue = <R>(work: () => Promise<R>): Promise<R> => {
    const result = line.then(work); line = result.catch(() => {}); return result;
  };
  const executor: SqliteExecutor = {
    exec: async sql => { memory.exec(sql); },
    run: async (sql, ...params) => { memory.query(sql).run(...params); },
    get: async <R extends object>(sql: string, ...params: Parameters<SqliteExecutor["run"]> extends [string, ...infer P] ? P : never) => (memory.query(sql).get(...params) ?? undefined) as R | undefined,
    all: async <R extends object>(sql: string, ...params: Parameters<SqliteExecutor["run"]> extends [string, ...infer P] ? P : never) => memory.query(sql).all(...params) as R[],
  };
  const adapter: SqliteDatabase = {
    exec: sql => queue(() => executor.exec(sql)), run: (sql, ...params) => queue(() => executor.run(sql, ...params)),
    get: <R extends object>(sql: string, ...params: Parameters<SqliteExecutor["run"]> extends [string, ...infer P] ? P : never) => queue(() => executor.get<R>(sql, ...params)),
    all: <R extends object>(sql: string, ...params: Parameters<SqliteExecutor["run"]> extends [string, ...infer P] ? P : never) => queue(() => executor.all<R>(sql, ...params)),
    transaction: work => queue(async () => {
      memory.exec("BEGIN");
      try { const result = await work(executor); memory.exec("COMMIT"); return result; }
      catch (error) { memory.exec("ROLLBACK"); throw error; }
    }), close: () => queue(async () => { memory.close(true); }),
  };
  let harness: Harness;
  let storage: Storage;
  try {
    storage = await SqliteStorage.open(adapter);
    harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
  } catch (error) { await adapter.close(); throw error; }
  try { return await read(harness, storage); } finally { await harness.close(context); }
}

async function memberId(harness: Harness, phone: string): Promise<ConversationId> {
  const record = await harness.snapshot(MemberDirectory, phone, context);
  if (!record) throw new Error("群库中没有该成员");
  return record.conversationId as ConversationId;
}

/** Same historical model context as fork(at), without creating a fork or sending a request. */
export async function historicalContext(path: string, phone: string, at?: number) {
  if (at !== undefined && (!Number.isSafeInteger(at) || at < 1)) throw new Error("条目编号必须是正整数");
  return withGroupSnapshot(path, async harness => {
    const conversation = await harness.conversation(await memberId(harness, phone), context);
    if (!conversation) throw new Error("会话不存在");
    return conversation.context(context, at === undefined ? undefined : { at: at as EntryId });
  });
}

type DurationBucket = { count: number; known: number; unknown: number; totalMs: number; minMs: number | null; maxMs: number | null; meanMs: number | null };
const empty = (): DurationBucket => ({ count: 0, known: 0, unknown: 0, totalMs: 0, minMs: null, maxMs: null, meanMs: null });
const duration = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
function add(bucket: DurationBucket, value: number | undefined): void {
  bucket.count++;
  if (value === undefined) { bucket.unknown++; return; }
  bucket.known++; bucket.totalMs += value;
  bucket.minMs = Math.min(bucket.minMs ?? value, value); bucket.maxMs = Math.max(bucket.maxMs ?? value, value);
  bucket.meanMs = bucket.totalMs / bucket.known;
}

/** Derived read-only view; costs and entry cursors in stats.sqlite stay authoritative and unchanged. */
export async function conversationTimings(path: string, phone: string) {
  return withGroupSnapshot(path, async (harness, storage) => {
    const conversationId = await memberId(harness, phone);
    const response = empty(), tools: Record<string, DurationBucket> = Object.create(null), taskSpans: Record<string, DurationBucket> = Object.create(null);
    let taskCursor: Parameters<Storage["scanTasks"]>[2];
    for (;;) {
      const page = await storage.scanTasks({ conversationId, order: "ascending" }, 200, taskCursor, context);
      for (const task of page.items) {
        const startedAt = duration(task.startedAt), endedAt = duration(task.endedAt);
        add(taskSpans[task.kind] ??= empty(), startedAt === undefined || endedAt === undefined ? undefined : duration(endedAt - startedAt));
      }
      if (!page.next) break; taskCursor = page.next;
    }
    let entryCursor: Parameters<Storage["scanEntries"]>[2];
    for (;;) {
      const page = await storage.scanEntries({ conversationId, order: "ascending" }, 200, entryCursor, context);
      for (const entry of page.items) for (const message of entry.model ?? []) {
        if (message.role === "assistant") add(response, duration(message.durationMs));
        if (message.role === "toolResult") add(tools[message.toolName] ??= empty(), duration(message.durationMs));
      }
      if (!page.next) break; entryCursor = page.next;
    }
    return { response, tools, taskSpans, note: "响应、工具执行与任务跨度分别统计；跨度含等待/重试，彼此会重叠。旧记录缺字段为未知，不按零补齐。" };
  });
}
