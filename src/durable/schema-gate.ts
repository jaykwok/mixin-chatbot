// Durable's official open migrates an older SQLite schema in place (1.4.0 rebuilds the task table for schema 2), and the
// older package cannot read the result. This project supports no in-place upgrade of conversation databases: before any
// official open, a database must be new (no tables at all) or carry exactly the schema this program was built with.
// The check only reads; a refused database is left as it is.
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";

interface SchemaReader { get<T extends object>(sql: string): Promise<T | undefined> | T | undefined }

export function unsupportedSchema(version: number | undefined, path: string): Error {
  const found = version === undefined ? "无法识别（不是本程序的会话库）" : `为 Durable schema ${version}`;
  return new Error(`会话库格式${found}，当前程序只支持 schema ${CURRENT_SQLITE_SCHEMA_VERSION}，不做原地升级；` +
    `未发布的测试数据请在新目录全新部署，现场已保留：${path}`);
}

/** Throws unless the database is new or at the current Durable schema. Never writes. */
export async function assertDurableSchema(db: SchemaReader, path: string): Promise<void> {
  const objects = (await db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master"))?.n ?? 0;
  if (objects === 0) return;
  const table = (await db.get<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'"))?.n ?? 0;
  const version = table ? (await db.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1"))?.version : undefined;
  if (version !== CURRENT_SQLITE_SCHEMA_VERSION) throw unsupportedSchema(version, path);
}
