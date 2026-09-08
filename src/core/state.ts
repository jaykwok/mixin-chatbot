import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { STATE_DATABASE_PATH } from "./storage.ts";

export function openState(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 3000;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

let state: Database | undefined;
export function stateDatabase(): Database { return state ??= openState(STATE_DATABASE_PATH); }
