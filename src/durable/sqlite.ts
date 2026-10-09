// Official SqliteStorage over a queued bun:sqlite connection on a process-wide SQL thread.
// FULL writes, WAL checkpoints and busy waits never run on the service thread. Transaction callbacks remain here;
// the per-connection queue stays held until the native COMMIT/ROLLBACK acknowledgement. Close releases native handles
// before acknowledging and the last connection waits for natural worker exit. The storage algorithm is not forked.
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { sqliteClient, type SqliteWorkerLost } from "./sqlite-client.ts";
import { BunSqliteDatabase } from "./sqlite-facade.ts";
export { BunSqliteDatabase } from "./sqlite-facade.ts";

const BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTOCHECKPOINT_PAGES = 1_000;
const SYNCHRONOUS_FULL = 2;
const ignore = (): void => {};

/** WAL/FULL on every open, including a rolled-back page-write probe for silently read-only SQLite opens. */
export async function openGroupDatabase(path: string, onFailure?: (error: SqliteWorkerLost) => void): Promise<BunSqliteDatabase> {
  let adapter: BunSqliteDatabase | undefined;
  try {
    const client = sqliteClient();
    adapter = new BunSqliteDatabase(client, await client.open(path, onFailure));
    await adapter.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    await adapter.exec("PRAGMA journal_mode = WAL");
    await adapter.exec("PRAGMA synchronous = FULL");
    await adapter.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    const journal = await adapter.get<{ journal_mode: string }>("PRAGMA journal_mode");
    const synchronous = await adapter.get<{ synchronous: number }>("PRAGMA synchronous");
    if (journal?.journal_mode !== "wal") throw new Error(`journal_mode 读回 ${journal?.journal_mode}，应为 wal`);
    if (synchronous?.synchronous !== SYNCHRONOUS_FULL) throw new Error(`synchronous 读回 ${synchronous?.synchronous}，应为 ${SYNCHRONOUS_FULL}（FULL）`);
    try {
      const { user_version } = (await adapter.get<{ user_version: number }>("PRAGMA user_version"))!;
      await adapter.exec("BEGIN IMMEDIATE");
      try { await adapter.exec(`PRAGMA user_version = ${user_version}`); }
      finally { await adapter.exec("ROLLBACK"); }
    } catch (error) { throw new Error("群数据库不可写（只读文件或只读挂载）", { cause: error }); }
    return adapter;
  } catch (error) {
    await adapter?.close().catch(ignore);
    throw new Error(`无法打开群数据库：${path}：${(error as Error).message}`, { cause: error });
  }
}

/** Official Durable storage; a lost SQL thread is an uncertain outcome even when no commit promise is pending. */
export async function openGroupStorage(path: string, onFailure?: (error: SqliteWorkerLost) => void): Promise<SqliteStorage> {
  const db = await openGroupDatabase(path, onFailure);
  try { return await SqliteStorage.open(db); }
  catch (error) { await db.close().catch(ignore); throw error; }
}
