import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { STATE_DATABASE_PATH } from "./storage.ts";

/** The state database holds a copy of the address book (phone, name, platform ID): owner-only, like the credentials. */
export function openState(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 3000;");
    if (process.platform !== "win32") for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

let state: Database | undefined;
export function stateDatabase(): Database { return state ??= openState(STATE_DATABASE_PATH); }
