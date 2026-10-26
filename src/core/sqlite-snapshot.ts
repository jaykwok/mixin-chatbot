import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An in-memory copy of what `source` currently reads. sqlite3_deserialize cannot read WAL images, so only the copy's
 * header is set back to the rollback journal (file format bytes 18–19); the source file is never changed. */
export function memorySnapshot(source: Database, options: { readonly?: boolean; strict?: boolean } = {}): Database {
  const bytes = source.serialize();
  bytes[18] = 1; bytes[19] = 1;
  return Database.deserialize(bytes, options);
}

/** A read-only in-memory copy of the SQLite file `path` (with its pending `-wal`) that leaves the file's directory alone:
 * even a read-only connection to a WAL database creates `-shm`/`-wal` beside it, and cannot open in a directory it may
 * not write. The files are copied to a private temporary directory first, read there and removed. */
export function fileSnapshot(path: string): Database {
  const scratch = mkdtempSync(join(tmpdir(), "sqlite-snapshot-"));
  try {
    const copy = join(scratch, "copy.sqlite");
    copyFileSync(path, copy);
    if (existsSync(path + "-wal")) copyFileSync(path + "-wal", copy + "-wal");
    const file = new Database(copy, { readonly: true, strict: true });
    try { return memorySnapshot(file, { readonly: true, strict: true }); } finally { file.close(); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
