import { afterAll, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { BunSqliteDatabase, openGroupDatabase } from "../../src/durable/sqlite.ts";
import { sqliteClient, SqliteClient, SqliteWorkerLost } from "../../src/durable/sqlite-client.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-sql-thread-");
afterAll(() => fixture.cleanup());
let counter = 0;
const path = () => join(fixture.root, `db-${++counter}.sqlite`);

test("promise matchers deliver real worker replies and still fail on mismatched values/outcomes", async () => {
  const db = await openGroupDatabase(path());
  try {
    await expect(db.get("SELECT 7 AS n")).resolves.toEqual({ n: 7 });
    await expect(db.exec("this is not SQL")).rejects.toThrow("syntax error");
    let valueFailed = false, outcomeFailed = false;
    try { await expect(db.get("SELECT 7 AS n")).resolves.toEqual({ n: 8 }); } catch { valueFailed = true; }
    try { await expect(db.get("SELECT 7 AS n")).rejects.toThrow(); } catch { outcomeFailed = true; }
    expect(valueFailed).toBe(true); expect(outcomeFailed).toBe(true);
  } finally { await db.close(); }
});

test("a native SQLite busy wait leaves the service thread able to release the writer lock", async () => {
  const file = path(), db = await openGroupDatabase(file);
  const lock = new Database(file, { readwrite: true });
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await db.exec("CREATE TABLE t (value INTEGER)");
    await db.exec("PRAGMA busy_timeout=1000");
    lock.exec("BEGIN IMMEDIATE");
    timer = setTimeout(() => { lock.exec("ROLLBACK"); released = true; }, 100);
    // With SQL on the main thread this hits SQLITE_BUSY after 1 s: the timer cannot release the lock until then.
    await db.run("INSERT INTO t VALUES (7)");
    expect(released).toBe(true);
    expect(await db.get("SELECT value FROM t")).toEqual({ value: 7 });
  } finally {
    clearTimeout(timer);
    if (!released) { try { lock.exec("ROLLBACK"); } catch {} }
    lock.close(false); await db.close();
  }
});

test("connections share one thread; concurrent close/open does not stop a connection still in use", async () => {
  const one = await openGroupDatabase(path()), client = sqliteClient();
  const two = await openGroupDatabase(path());
  try {
    expect(sqliteClient()).toBe(client);
    await one.close();
    expect(await two.get("SELECT 2 AS value")).toEqual({ value: 2 });
    for (let i = 0; i < 12; i++) {
      const closing = two.exec("SELECT 1");
      const other = await openGroupDatabase(path());
      await closing;
      const close = other.close(), next = await openGroupDatabase(path());
      await close; expect(await next.get("SELECT 3 AS value")).toEqual({ value: 3 }); await next.close();
    }
  } finally { await one.close(); await two.close(); }
});

test("connections to the same file wait for their owner transaction without blocking its COMMIT", async () => {
  const file = path(), a = await openGroupDatabase(file), b = await openGroupDatabase(file);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first: Promise<void> | undefined;
  try {
    await a.exec("CREATE TABLE same_file (n INTEGER)"); await b.exec("PRAGMA busy_timeout=100");
    first = a.transaction(async (tx) => { await tx.run("INSERT INTO same_file VALUES (1)"); entered.resolve(); await release.promise; });
    await entered.promise;
    timer = setTimeout(() => release.resolve(), 20);
    await b.transaction(async (tx) => { await tx.run("INSERT INTO same_file VALUES (2)"); });
    await first;
    expect(await b.all("SELECT n FROM same_file ORDER BY n")).toEqual([{ n: 1 }, { n: 2 }]);
  } finally {
    if (timer) clearTimeout(timer); release.resolve(); await first?.catch(() => {}); await a.close(); await b.close();
  }
});

test("last close waits for native handles and natural thread exit, then a fresh connection opens", async () => {
  for (let i = 0; i < 5; i++) {
    const file = path(), db = await openGroupDatabase(file), client = sqliteClient();
    const exit = new Promise<number>((resolve) => client.worker.once("exit", resolve));
    await db.close(); expect(await exit).toBe(0);
    renameSync(file, file + ".moved"); renameSync(file + ".moved", file);
    const fresh = await openGroupDatabase(file);
    try { expect(sqliteClient()).not.toBe(client); expect(await fresh.get("SELECT 1 AS n")).toEqual({ n: 1 }); }
    finally { await fresh.close(); }
  }
});

test("unexpected worker exit fences every connection and notifies their owners without an active request", async () => {
  const client = new SqliteClient(), failures: unknown[] = [];
  const a = new BunSqliteDatabase(client, await client.open(path(), (e) => failures.push(e)));
  const b = new BunSqliteDatabase(client, await client.open(path(), (e) => failures.push(e)));
  try {
    expect(await a.get("SELECT 1 AS n")).toEqual({ n: 1 });
    await client.worker.terminate();
    await expect(b.get("SELECT 1")).rejects.toBeInstanceOf(SqliteWorkerLost);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toBe(failures[1]);
    await expect(a.run("CREATE TABLE never_written (n INTEGER)")).rejects.toBe(failures[0]);
  } finally { await a.close().catch(() => {}); await b.close().catch(() => {}); }
});
