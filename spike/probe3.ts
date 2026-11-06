// macOS spike 3 (2026-11-07): read-only SQLite connections once the last writer removed -wal/-shm, deserialize of a
// WAL image, and st_nlink of a held directory after rmdir.
import { constants, Database } from "bun:sqlite";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, realpathSync, rmdirSync, statSync, fstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = realpathSync(mkdtempSync(join(tmpdir(), "spike3-")));
const report: Record<string, unknown> = {};
const sidecars = (path: string) => ["-wal", "-shm"].filter(suffix => existsSync(path + suffix));
const attempt = (label: string, run: () => unknown) => {
  try { report[label] = run() ?? "ok"; } catch (error) { report[label] = `error: ${String(error)}`; }
};

function writer(name: string, persist: boolean): string {
  const path = join(work, name), db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);");
  if (!persist) db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  db.close();
  return path;
}
const count = (db: Database) => (db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n;

{
  const path = writer("plain-ro.sqlite", false);
  report.afterWriterClose = sidecars(path);
  attempt("readonly", () => { const db = new Database(path, { readonly: true }); try { return count(db); } finally { db.close(); } });
  report.afterReadonly = sidecars(path);
  attempt("readonlyUri", () => { const db = new Database(`file:${path}?mode=ro`, { readonly: true }); try { return count(db); } finally { db.close(); } });
  attempt("readonlyShm", () => { const db = new Database(`file:${path}?readonly_shm=1`, { readonly: true }); try { return count(db); } finally { db.close(); } });
  attempt("readwriteQueryOnly", () => {
    const before = readFileSync(path), mtime = statSync(path).mtimeMs;
    const db = new Database(path, { readwrite: true });
    try {
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0); db.exec("PRAGMA query_only = 1");
      return { n: count(db), sidecarsWhileOpen: sidecars(path) };
    } finally { db.close(); report.readwriteQueryOnlyAfter = { sidecars: sidecars(path), sameBytes: Buffer.compare(before, readFileSync(path)) === 0, sameMtime: statSync(path).mtimeMs === mtime }; }
  });
}
{
  // A writer kept open: its sidecars exist while a reader opens.
  const path = join(work, "open-writer.sqlite"), w = new Database(path, { create: true, strict: true });
  w.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);");
  w.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  attempt("readonlyWithOpenWriter", () => { const db = new Database(path, { readonly: true }); try { return count(db); } finally { db.close(); } });
  w.close();
  report.openWriterAfter = sidecars(path);
}
{
  // An empty -wal made beforehand (as a writer leaves it truncated), no -shm.
  const path = writer("empty-wal.sqlite", false);
  writeFileSync(path + "-wal", "");
  attempt("readonlyEmptyWal", () => { const db = new Database(path, { readonly: true }); try { return count(db); } finally { db.close(); } });
  report.emptyWalAfter = sidecars(path);
}
{
  // Persisted sidecars (Apple's default) read back read-only.
  const path = writer("persisted.sqlite", true);
  report.persistedAfterClose = sidecars(path);
  attempt("readonlyPersisted", () => { const db = new Database(path, { readonly: true }); try { return count(db); } finally { db.close(); } });
}
{
  // sqlite3_deserialize of a serialized WAL database (header bytes 18–19 set back to 1).
  const path = writer("serialize.sqlite", true);
  const source = new Database(path, { readonly: true }), bytes = source.serialize(); source.close();
  report.serializedHeader = [bytes[18], bytes[19], bytes.byteLength];
  const fixed = Uint8Array.from(bytes); fixed[18] = 1; fixed[19] = 1;
  for (const [label, options] of [["default", {}], ["readonly", { readonly: true }], ["strict", { strict: true }], ["readonlyStrict", { readonly: true, strict: true }]] as const) {
    attempt(`deserialize-${label}`, () => { const db = Database.deserialize(fixed, options as never); try { return count(db); } finally { db.close(); } });
    attempt(`deserializeBuffer-${label}`, () => { const db = Database.deserialize(Buffer.from(fixed), options as never); try { return count(db); } finally { db.close(); } });
  }
  attempt("deserialize-unfixed", () => { const db = Database.deserialize(bytes); try { return count(db); } finally { db.close(); } });
}
{
  // st_nlink of an open directory after it is removed by name.
  const lib = dlopen("/usr/lib/libSystem.B.dylib", { open: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols;
  const dir = join(work, "held"); mkdirSync(dir); mkdirSync(join(dir, "sub")); rmdirSync(join(dir, "sub"));
  const fd = lib.open(ptr(Buffer.from(dir + "\0")), 0x100000, 0);
  report.nlinkBefore = fstatSync(fd).nlink;
  rmdirSync(dir);
  report.nlinkAfter = fstatSync(fd).nlink;
  closeSync(fd);
  const file = join(work, "file"); writeFileSync(file, "x"); const ffd = openSync(file, "r");
  report.fileNlinkBefore = fstatSync(ffd).nlink;
  require("node:fs").unlinkSync(file);
  report.fileNlinkAfter = fstatSync(ffd).nlink; closeSync(ffd);
}
console.log(JSON.stringify(report, null, 2));
await Bun.write(process.env.SPIKE_REPORT3 ?? join(work, "report3.json"), JSON.stringify(report, null, 2));
