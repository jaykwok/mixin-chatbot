import { Database } from "bun:sqlite";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, createSession, Harness, type ConversationId, type EntryId, type Storage, type Tx } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage, type SqliteDatabase, type SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { MemberDirectory } from "./identity.ts";

/** Larger group databases are snapshotted into a private file instead of memory (the service container's /tmp is small). */
const MEMORY_SNAPSHOT_BYTES = 256 * 1024 * 1024;

/** Read the source connection only; official migrations/recovery run against a disposable snapshot (memory, or a private file
 * under the group data root's `.reclamation/snapshots` for large databases). */
export async function withGroupSnapshot<T>(path: string, read: (harness: Harness, storage: Storage, liveWork: boolean,
  commit?: (work: (tx: Tx) => Promise<void>) => Promise<void>) => Promise<T>, exclusive = false, memoryLimit = MEMORY_SNAPSHOT_BYTES): Promise<T> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("诊断只接受普通群数据库文件");
  // Offline reclamation keeps a write reservation until its reference checks and physical
  // operations finish. Opening/recovering the Harness still only changes the memory copy.
  const source = new Database(path, { readonly: !exclusive, strict: true });
  let memory: Database, scratch: string | undefined;
  try {
    source.exec(exclusive ? "BEGIN IMMEDIATE" : "BEGIN");
    const version = (source.query("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number } | null)?.version;
    if (version !== CURRENT_SQLITE_SCHEMA_VERSION) throw new Error("群库 SQLite 版本不匹配，请先升级");
    const pages = source.query("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get() as { bytes: number };
    if (pages.bytes > memoryLimit) {
      // VACUUM INTO cannot run inside the source transaction. Under its write reservation (exclusive) a second
      // connection reads exactly that state; a read-only preview just needs any consistent state.
      scratch = await mkdtemp(join(await snapshotRoot(path), "snapshot-"));
      const file = join(scratch, "group.sqlite"), copier = new Database(path, { readonly: true, strict: true });
      try { copier.query("VACUUM INTO ?").run(file); } finally { copier.close(); }
      memory = new Database(file, { strict: true });
      memory.exec("PRAGMA journal_mode = DELETE");
    } else {
      const bytes = source.serialize();
      // sqlite3_deserialize cannot read WAL images; only the private snapshot changes its journal header.
      bytes[18] = 1; bytes[19] = 1;
      memory = Database.deserialize(bytes, { strict: true });
    }
  } catch (error) { source.close(); await discard(scratch); throw error; }
  const adapter = snapshotAdapter(memory, false);
  let harness: Harness;
  let storage: Storage;
  let liveWork = false;
  try {
    storage = await SqliteStorage.open(adapter);
    // Recovery may change interrupted tasks. Decide protection from the source state first.
    for (const status of ["pending", "running", "waiting", "completing"] as const) {
      if ((await storage.scanTasks({ status }, 1, undefined, context)).items.length) liveWork = true;
    }
    for (const status of ["queued", "placed"] as const) {
      if ((await storage.scanSubmissions({ status }, 1, undefined, context)).items.length) liveWork = true;
    }
    harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
  } catch (error) { try { await adapter.close(); } finally { source.close(); await discard(scratch); } throw error; }
  try {
    // Only explicit offline settlement uses the source session. Harness recovery remains in memory.
    // SAVEPOINTs stay inside the source write reservation; failed callbacks roll back all settlements.
    const session = exclusive ? createSession(await SqliteStorage.open(snapshotAdapter(source, true))) : undefined;
    try {
      const result = await read(harness, storage, liveWork, session ? work => session.commit(work, context) : undefined);
      if (exclusive) source.exec("COMMIT");
      return result;
    } finally { await session?.close(context); }
  } finally { try { await harness.close(context); } finally { source.close(); await discard(scratch); } }
}

/** Private (0700) scratch space on the data volume; each snapshot gets its own directory, removed afterwards. */
async function snapshotRoot(path: string): Promise<string> {
  const groups = await realpath(dirname(dirname(resolve(path)))), root = join(groups, ".reclamation", "snapshots");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error("快照目录不是原位普通目录");
  return root;
}
async function discard(scratch: string | undefined): Promise<void> {
  if (scratch) await rm(scratch, { recursive: true, force: true });
}

function snapshotAdapter(database: Database, nested: boolean): SqliteDatabase {
  let line: Promise<unknown> = Promise.resolve();
  const queue = <R>(work: () => Promise<R>): Promise<R> => {
    const result = line.then(work); line = result.catch(() => {}); return result;
  };
  const executor: SqliteExecutor = {
    exec: async sql => { database.exec(sql); },
    run: async (sql, ...params) => { database.query(sql).run(...params); },
    get: async <R extends object>(sql: string, ...params: Parameters<SqliteExecutor["run"]> extends [string, ...infer P] ? P : never) => (database.query(sql).get(...params) ?? undefined) as R | undefined,
    all: async <R extends object>(sql: string, ...params: Parameters<SqliteExecutor["run"]> extends [string, ...infer P] ? P : never) => database.query(sql).all(...params) as R[],
  };
  return {
    exec: sql => queue(() => executor.exec(sql)), run: (sql, ...params) => queue(() => executor.run(sql, ...params)),
    get: <R extends object>(sql: string, ...params: Parameters<SqliteExecutor["run"]> extends [string, ...infer P] ? P : never) => queue(() => executor.get<R>(sql, ...params)),
    all: <R extends object>(sql: string, ...params: Parameters<SqliteExecutor["run"]> extends [string, ...infer P] ? P : never) => queue(() => executor.all<R>(sql, ...params)),
    transaction: work => queue(async () => {
      database.exec(nested ? "SAVEPOINT reclamation_settlement" : "BEGIN");
      try { const result = await work(executor); database.exec(nested ? "RELEASE reclamation_settlement" : "COMMIT"); return result; }
      catch (error) {
        database.exec(nested ? "ROLLBACK TO reclamation_settlement; RELEASE reclamation_settlement" : "ROLLBACK"); throw error;
      }
    }), close: () => queue(async () => { if (!nested) database.close(true); }),
  };
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
