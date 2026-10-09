import { afterAll, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, defineDoc, StorageRejected, type Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openGroupDatabase } from "../../src/durable/sqlite.ts";
import { DurableStorageFailure, guardStorage } from "../../src/durable/storage-failure.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-storage-failure-");
afterAll(() => fixture.cleanup());
const Counter = defineDoc<{ value: number; text: string }>({ kind: "test.fatal-counter", version: 1, scope: "session", initial: () => ({ value: 0, text: "" }) });
let n = 0;
async function open() {
  const path = join(fixture.root, `db-${++n}.sqlite`), db = await openGroupDatabase(path), storage = await SqliteStorage.open(db);
  const failures: DurableStorageFailure[] = [];
  return { path, db, storage, failures };
}

test("actual SQLITE_FULL fences the Session and requires a cold reopen; callback errors do not trigger it", async () => {
  const { path, db, storage, failures } = await open();
  const guarded = guardStorage(storage, path, (error) => failures.push(error)), session = createSession(guarded);
  try {
    await session.commit(async (tx) => { (await tx.doc(Counter)).value = 1; }, context);
    const callback = new Error("callback failure");
    await expect(session.commit(() => { throw callback; }, context)).rejects.toBe(callback);
    expect(failures).toEqual([]);
    const count = (await db.get<{ page_count: number }>("PRAGMA page_count"))!.page_count;
    await db.exec(`PRAGMA max_page_count=${count}`);
    await expect(session.commit(async (tx) => { (await tx.doc(Counter)).text = "x".repeat(2_000_000); }, context)).rejects.toBeInstanceOf(DurableStorageFailure);
    const cause = failures[0]!.cause;
    const original = cause instanceof AggregateError ? cause.errors[0] : cause;
    expect((original as { code?: string }).code).toBe("SQLITE_FULL");
    expect(failures).toHaveLength(1);
    await expect(guarded.scanConversations({}, 1, undefined, context)).rejects.toBe(failures[0]);
    await expect(session.commit(async (tx) => { (await tx.doc(Counter)).value++; }, context)).rejects.toThrow("poisoned");
  } finally { await session.close(context); }
  const freshDb = await openGroupDatabase(path), fresh = createSession(await SqliteStorage.open(freshDb));
  try { expect((await fresh.snapshot(Counter, context))?.value).toBe(1); } finally { await fresh.close(context); }
});

test("a committed batch whose acknowledgement is lost is fatal, and a cold reopen sees the committed value", async () => {
  const { path, storage, failures } = await open();
  const lost = new Error("simulated lost COMMIT acknowledgement");
  const uncertain = new Proxy(storage, { get(target, key) {
    if (key === "commit") return async (...args: Parameters<Storage["commit"]>) => { await target.commit(...args); throw lost; };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const session = createSession(guardStorage(uncertain, path, (error) => failures.push(error)));
  try {
    await expect(session.commit(async (tx) => { (await tx.doc(Counter)).value = 7; }, context)).rejects.toBeInstanceOf(DurableStorageFailure);
    expect(failures).toHaveLength(1); expect(failures[0]!.cause).toBe(lost);
  } finally { await session.close(context); }
  const fresh = createSession(await SqliteStorage.open(await openGroupDatabase(path)));
  try { expect((await fresh.snapshot(Counter, context))?.value).toBe(7); } finally { await fresh.close(context); }
});

test("StorageRejected proves rollback and does not fence a usable Session", async () => {
  const { path, storage, failures } = await open();
  let reject = true;
  const wrapped = new Proxy(storage, { get(target, key) {
    if (key === "commit") return async (...args: Parameters<Storage["commit"]>) => {
      if (reject) { reject = false; throw new StorageRejected("batch rejected without effect"); }
      return target.commit(...args);
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const session = createSession(guardStorage(wrapped, path, (error) => failures.push(error)));
  try {
    await expect(session.commit(async (tx) => { (await tx.doc(Counter)).value = 1; }, context)).rejects.toBeInstanceOf(StorageRejected);
    await session.commit(async (tx) => { (await tx.doc(Counter)).value = 2; }, context);
    expect((await session.snapshot(Counter, context))?.value).toBe(2); expect(failures).toEqual([]);
  } finally { await session.close(context); }
});
