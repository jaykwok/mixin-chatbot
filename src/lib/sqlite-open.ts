import { constants, Database } from "bun:sqlite";
import { existsSync } from "node:fs";

type Options = ConstructorParameters<typeof Database>[1];

/**
 * A writable connection whose last close removes the -wal and -shm files, as on Linux and Windows. Apple's system SQLite
 * keeps them by default (persistent WAL); the setting belongs to the connection, so every writer opens through here.
 */
export function openWritable(path: string, options: Options): Database {
  const db = new Database(path, options);
  try { db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0); }
  catch (error) { db.close(); throw error; }
  return db;
}

/**
 * A connection that only reads the existing database `path`. Apple's system SQLite cannot open a WAL database read-only
 * while its -wal file is absent, which is how the last writer's close leaves it (openWritable). On macOS such a database
 * is opened read-write with query_only set instead: without a -wal there is nothing to checkpoint, and its close removes
 * the sidecars it made, leaving the file's bytes and time as they were (measured on macOS 15 and 26).
 */
export function openReadable(path: string, options: { strict?: boolean } = {}): Database {
  if (process.platform !== "darwin" || existsSync(path + "-wal")) return new Database(path, { ...options, readonly: true });
  const db = openWritable(path, { ...options, readwrite: true });
  try { db.exec("PRAGMA query_only = 1"); }
  catch (error) { db.close(); throw error; }
  return db;
}
