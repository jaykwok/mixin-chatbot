import { afterAll, describe, it, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { chmodSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { openGroupDatabase, openGroupStorage } from "../../src/durable/sqlite.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-sqlite-");
afterAll(() => fixture.cleanup());
let counter = 0;
const nextPath = () => join(fixture.root, `db-${++counter}`, "durable.sqlite");
// Root ignores file modes on POSIX; Windows has no read-only directories.
const asRoot = process.getuid?.() === 0;

// Durable's own storage suite against the project's wiring: bun:sqlite facade, FULL, write probe.
registerStorageConformance({ describe, expect, it }, "official storage conformance (openGroupStorage)", async (use) => {
  const storage = await openGroupStorage(nextPath());
  try { await use(storage); } finally { await storage.close(BACKGROUND_CONTEXT); }
});

describe("group database facade", () => {
  test("every open sets and reads back WAL and synchronous=FULL", async () => {
    const path = nextPath();
    for (let open = 0; open < 5; open++) {
      const db = await openGroupDatabase(path);
      try {
        expect(await db.get<{ journal_mode: string }>("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
        expect(await db.get<{ synchronous: number }>("PRAGMA synchronous")).toEqual({ synchronous: 2 });
        expect(await db.get<{ timeout: number }>("PRAGMA busy_timeout")).toEqual({ timeout: 5000 });
        expect(await db.get<{ wal_autocheckpoint: number }>("PRAGMA wal_autocheckpoint")).toEqual({ wal_autocheckpoint: 1000 });
      } finally { await db.close(); }
    }
  });

  test("transactions run one at a time in call order; plain calls made meanwhile wait behind them", async () => {
    const db = await openGroupDatabase(nextPath());
    try {
      await db.exec("CREATE TABLE log (step TEXT)");
      const { promise: gate, resolve: open } = Promise.withResolvers<void>();
      const first = db.transaction(async (tx) => {
        await tx.run("INSERT INTO log VALUES (?)", "first-start");
        await gate;
        await tx.run("INSERT INTO log VALUES (?)", "first-end");
      });
      const plain = db.run("INSERT INTO log VALUES (?)", "plain");
      const second = db.transaction(async (tx) => { await tx.run("INSERT INTO log VALUES (?)", "second"); });
      await Bun.sleep(20);
      open();
      await Promise.all([first, plain, second]);
      expect((await db.all<{ step: string }>("SELECT step FROM log ORDER BY rowid")).map((row) => row.step))
        .toEqual(["first-start", "first-end", "plain", "second"]);
    } finally { await db.close(); }
  });

  test("a failing callback rolls back, rejects with its error, and its handle is dead afterwards", async () => {
    const db = await openGroupDatabase(nextPath());
    try {
      await db.exec("CREATE TABLE t (v INTEGER)");
      let handle: Parameters<Parameters<typeof db.transaction>[0]>[0] | undefined;
      const failure = new Error("callback failed");
      await expect(db.transaction(async (tx) => {
        handle = tx;
        await tx.run("INSERT INTO t VALUES (1)");
        throw failure;
      })).rejects.toBe(failure);
      expect(await db.get<{ n: number }>("SELECT count(*) AS n FROM t")).toEqual({ n: 0 });
      await expect(handle!.run("INSERT INTO t VALUES (2)")).rejects.toThrow("no longer active");
      // A committed transaction's handle is dead too.
      await db.transaction(async (tx) => { handle = tx; await tx.run("INSERT INTO t VALUES (3)"); });
      await expect(handle!.get("SELECT 1")).rejects.toThrow("no longer active");
      expect(await db.get<{ n: number }>("SELECT count(*) AS n FROM t")).toEqual({ n: 1 });
    } finally { await db.close(); }
  });

  test("a failed rollback rejects with both errors and leaves the connection usable", async () => {
    const db = await openGroupDatabase(nextPath());
    try {
      const failure = new Error("callback failed");
      const rejected = await db.transaction(async (tx) => {
        await tx.exec("ROLLBACK"); // ends the transaction under the facade, so its own ROLLBACK fails
        throw failure;
      }).catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(AggregateError);
      expect((rejected as AggregateError).errors[0]).toBe(failure);
      expect(String((rejected as AggregateError).errors[1])).toContain("no transaction is active");
      await db.transaction(async (tx) => { await tx.exec("CREATE TABLE after_failure (v INTEGER)"); });
      expect(await db.get("SELECT count(*) AS n FROM after_failure")).toEqual({ n: 0 });
    } finally { await db.close(); }
  });

  test("close checkpoints, releases the file at once and is idempotent; later calls reject", async () => {
    const path = nextPath();
    const db = await openGroupDatabase(path);
    await db.exec("CREATE TABLE t (v TEXT)");
    await db.run("INSERT INTO t VALUES (?)", "kept");
    await db.close();
    await db.close();
    await expect(db.get("SELECT 1")).rejects.toThrow();
    expect(existsSync(`${path}-wal`)).toBe(false);
    // Windows refuses to rename a file another handle still holds (Bun's node:sqlite does until GC, gap G1).
    renameSync(path, `${path}.moved`);
    renameSync(`${path}.moved`, path);
    const reopened = await openGroupDatabase(path);
    try { expect(await reopened.get("SELECT v FROM t")).toEqual({ v: "kept" }); } finally { await reopened.close(); }
  });

  test.skipIf(asRoot)("a read-only database file is refused at open, not at the first commit", async () => {
    const path = nextPath();
    await (await openGroupDatabase(path)).close();
    chmodSync(path, 0o444);
    try {
      await expect(openGroupDatabase(path)).rejects.toThrow("群数据库不可写");
      // The refused open closed its connection: the file can still be moved.
      renameSync(path, `${path}.moved`);
      renameSync(`${path}.moved`, path);
    } finally { chmodSync(path, 0o644); }
  });

  test.skipIf(asRoot || process.platform === "win32")("a database in a read-only directory is refused at open", async () => {
    const path = nextPath();
    await (await openGroupDatabase(path)).close();
    const directory = join(path, "..");
    chmodSync(directory, 0o555);
    try { await expect(openGroupDatabase(path)).rejects.toThrow("无法打开群数据库"); }
    finally { chmodSync(directory, 0o755); }
  });

  test("records FULL commit latency of small Durable commits", async () => {
    const storage = await openGroupStorage(nextPath());
    const samples: number[] = [];
    try {
      const { createSession, defineDoc } = await import("@earendil-works/pi-durable");
      const Counter = defineDoc<{ n: number }>({ kind: "test.counter", version: 1, scope: "session", initial: () => ({ n: 0 }) });
      const session = createSession(storage);
      try {
        for (let i = 0; i < 40; i++) {
          const started = performance.now();
          await session.commit(async (tx) => { (await tx.doc(Counter)).n++; }, BACKGROUND_CONTEXT);
          samples.push(performance.now() - started);
        }
        expect(await session.snapshot(Counter, BACKGROUND_CONTEXT)).toEqual({ n: 40 });
      } finally { await session.close(BACKGROUND_CONTEXT); }
    } finally { await storage.close(BACKGROUND_CONTEXT); }
    samples.sort((a, b) => a - b);
    const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]!.toFixed(2);
    console.log(`durable commit latency (synchronous=FULL, ${process.platform}): p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`);
  });
});
