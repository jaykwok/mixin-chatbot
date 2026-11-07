import { afterAll, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
import { join } from "node:path";
import { BunSqliteDatabase, openGroupDatabase } from "../../src/durable/sqlite.ts";
import { sqliteClient, SqliteClient, SqliteWorkerLost } from "../../src/durable/sqlite-client.ts";
import { slowSqlLog, sqlWatched, watchSql, type SqlRequestTiming, type SqlTiming, type SqlTransactionTiming } from "../../src/durable/sql-timing.ts";
import { tempFixture } from "../helpers/temp.ts";
import { openReadable } from "../../src/lib/sqlite-open.ts";

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

// About 140 ms of CPU on the SQL thread (Windows, 2026-10-29); the checks below compare parts of one run, not clocks.
const SLOW = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000000) SELECT count(*) AS n FROM c";

/** The timings of `files` while `work` runs; the listener is gone afterwards. */
async function timings(files: string[], work: () => Promise<void>): Promise<SqlTiming[]> {
  const seen: SqlTiming[] = [];
  const stop = watchSql((timing) => { if (files.includes(timing.path)) seen.push(timing); });
  try { await work(); } finally { stop(); }
  return seen;
}
const requestFor = (seen: SqlTiming[], file: string, sql: string) =>
  seen.find((timing): timing is SqlRequestTiming => timing.type === "request" && timing.path === file && timing.command.kind === "sql" && timing.command.sql === sql)!;

test("each request reports its wait behind its own connection, behind other databases, and its execution", async () => {
  const fileA = path(), fileB = path(), a = await openGroupDatabase(fileA), b = await openGroupDatabase(fileB);
  try {
    const seen = await timings([fileA, fileB], async () => {
      // A's second request waits in A's own queue; B's waits on the shared thread behind A's statement.
      await Promise.all([a.get(SLOW), a.get("SELECT 1 AS same"), b.get("SELECT 2 AS other")]);
    });
    const slow = requestFor(seen, fileA, SLOW), same = requestFor(seen, fileA, "SELECT 1 AS same"), other = requestFor(seen, fileB, "SELECT 2 AS other");
    expect(slow.exec).toBeGreaterThan(20);
    expect(slow.command).toMatchObject({ kind: "sql", method: "get" });
    expect(same.queued).toBeGreaterThan(slow.exec * 0.8);
    expect(same.waited).toBeLessThan(slow.exec / 2);
    expect(other.queued).toBeLessThan(slow.exec / 2);
    expect(other.waited).toBeGreaterThan(slow.exec * 0.8);
    for (const timing of [slow, same, other]) {
      expect(timing.ok).toBe(true);
      for (const part of [timing.queued, timing.waited, timing.deferred, timing.exec, timing.returned]) expect(part).toBeGreaterThanOrEqual(0);
    }
    // Opening reports too, with its path; a failed statement is reported as failed.
    const failed = await timings([fileA], async () => { await a.exec("not SQL").catch(() => {}); });
    expect(failed).toEqual([expect.objectContaining({ type: "request", ok: false })]);
  } finally { await a.close(); await b.close(); }
});

test("a request held back by another connection's transaction on the same file reports the deferral", async () => {
  const file = path(), a = await openGroupDatabase(file), b = await openGroupDatabase(file);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let first: Promise<void> | undefined;
  try {
    await a.exec("CREATE TABLE held (n INTEGER)");
    const seen = await timings([file], async () => {
      first = a.transaction(async (tx) => { await tx.run("INSERT INTO held VALUES (1)"); entered.resolve(); await release.promise; });
      await entered.promise;
      setTimeout(() => release.resolve(), 80);
      await b.get("SELECT count(*) AS n FROM held");
      await first;
    });
    const read = requestFor(seen, file, "SELECT count(*) AS n FROM held");
    expect(read.deferred).toBeGreaterThan(50);
    const transaction = seen.find((timing): timing is SqlTransactionTiming => timing.type === "transaction")!;
    expect(transaction).toMatchObject({ statements: 1, committed: true });
    expect(transaction.held).toBeGreaterThan(50);
  } finally { release.resolve(); await first?.catch(() => {}); await a.close(); await b.close(); }
});

test("a transaction reports its statements, how long it held the connection and whether it committed", async () => {
  const file = path(), db = await openGroupDatabase(file);
  try {
    await db.exec("CREATE TABLE tx (n INTEGER)");
    const seen = await timings([file], async () => {
      await db.transaction(async (tx) => { await tx.run("INSERT INTO tx VALUES (1)"); await tx.run("INSERT INTO tx VALUES (2)"); await Bun.sleep(30); });
      await db.transaction(async (tx) => { await tx.run("INSERT INTO tx VALUES (3)"); throw new Error("undo"); }).catch(() => {});
    });
    const [committed, rolledBack] = seen.filter((timing): timing is SqlTransactionTiming => timing.type === "transaction");
    expect(committed).toMatchObject({ statements: 2, committed: true });
    expect(committed!.held).toBeGreaterThanOrEqual(25);
    expect(rolledBack).toMatchObject({ statements: 1, committed: false });
    expect(await db.all("SELECT n FROM tx ORDER BY n")).toEqual([{ n: 1 }, { n: 2 }]);
    // BEGIN carries the transaction's wait for the connection; the statements inside it wait for nothing.
    expect(seen.filter((timing) => timing.type === "request" && timing.command.kind === "sql" && timing.command.sql.startsWith("INSERT"))
      .every((timing) => timing.type === "request" && timing.queued === 0)).toBe(true);
  } finally { await db.close(); }
});

test("a reply the busy service thread takes late reports the delay as its return", async () => {
  const file = path(), db = await openGroupDatabase(file);
  try {
    const seen = await timings([file], async () => {
      const reply = db.get("SELECT 3 AS late");
      // Let the request leave before blocking: the queue hands it to the worker on the next microtask.
      await Promise.resolve();
      // Long enough that the worker's answer, slow on a loaded runner, still lands well inside it.
      const until = performance.now() + 250;
      while (performance.now() < until) { /* the service thread is busy */ }
      await reply;
    });
    expect(requestFor(seen, file, "SELECT 3 AS late").returned).toBeGreaterThan(30);
  } finally { await db.close(); }
});

test("the slow-request log names the database and the statement, never the parameters, one line a minute per database", () => {
  const lines: string[] = [];
  let now = 0;
  const log = slowSqlLog((line) => lines.push(line), { now: () => now });
  const request = (path: string, exec: number, queued = 0): SqlRequestTiming => ({ type: "request", path, ok: true, queued, waited: 2, deferred: 0, exec, returned: 1,
    command: { kind: "sql", connection: 1, method: "get", sql: "SELECT value\n  FROM documents WHERE key = ?", params: ["13812345678"] } });
  const direct = join("data", "conversations", "direct", "durable.sqlite"), group = "/srv/data/conversations/groups/g-1/durable.sqlite";
  log(request(direct, 900));
  expect(lines).toEqual([]);
  log(request(direct, 400, 700));
  log(request(direct, 2_000));
  log(request(group, 1_500));
  now = 60_000;
  log(request(direct, 1_200));
  log({ type: "transaction", path: group, queued: 3, held: 1_100, statements: 4, committed: false });
  expect(lines).toEqual([
    "SQL 请求较慢 - 库: direct, 语句: SELECT value FROM documents WHERE key = ?, 共: 1103ms（库内排队 700ms，线程排队 2ms，让行 0ms，执行 400ms，回传 1ms）",
    "SQL 请求较慢 - 库: groups/g-1, 语句: SELECT value FROM documents WHERE key = ?, 共: 1503ms（库内排队 0ms，线程排队 2ms，让行 0ms，执行 1500ms，回传 1ms）",
    "SQL 请求较慢 - 库: direct, 语句: SELECT value FROM documents WHERE key = ?, 共: 1203ms（库内排队 0ms，线程排队 2ms，让行 0ms，执行 1200ms，回传 1ms）；上一行之后另有 1 次未单独记录",
    "SQL 事务占用连接较久 - 库: groups/g-1, 占用: 1100ms, 语句: 4 条, 已回滚, 开始前排队: 3ms",
  ]);
  expect(lines.join("\n")).not.toContain("13812345678");
});

test("closing does not wait for a reader's transaction: the checkpoint is best effort", async () => {
  const file = path(), db = await openGroupDatabase(file);
  const reader = openReadable(file);
  try {
    await db.exec("CREATE TABLE t (value INTEGER)");
    await db.run("INSERT INTO t VALUES (1)");
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM t").get();
    await db.run("INSERT INTO t VALUES (2)");
    const started = performance.now();
    await db.close();
    // With the connection's busy timeout this took over 5 s, with every other space's SQL waiting behind it.
    expect(performance.now() - started).toBeLessThan(4_000);
  } finally { await db.close(); reader.exec("COMMIT"); reader.close(); }
});

test("no listener is left behind by the tests above", () => {
  expect(sqlWatched()).toBe(false);
});
