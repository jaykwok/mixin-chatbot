// The bot's read-only thread for the host console. One operation at a time, each on its own read-only connection and in
// one read transaction that ends with it; never on the shared write thread (sqlite-client.ts). A database is only opened
// when it is a regular file inside the conversations root: nothing is created, migrated or recovered.
import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { assertDataDirectory } from "../../lib/group-data.ts";
import { groupSegment } from "../../core/layout.ts";
import { assertDurableSchema } from "../schema-gate.ts";
import { missing, spaceDirectories } from "../space-databases.ts";
import { encodeError } from "../sqlite-protocol.ts";
import { READ_ERRORS, READ_LIMITS, type ReadMessage, type ReadOp, type WorkerInit } from "./protocol.ts";
import * as q from "./queries.ts";

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

if (!parentPort) throw new Error("The read worker must run on a worker thread");
const port = parentPort;
const init = workerData as WorkerInit;
const flags = new Int32Array(init.cancel);
const BUSY_TIMEOUT_MS = 1_000;

function guard(message: ReadMessage): q.Guard {
  return () => {
    if (Atomics.load(flags, message.slot) !== 0) throw named(READ_ERRORS.cancelled, "读取已取消");
    if (Date.now() > message.deadline) throw named(READ_ERRORS.expired, "读取超过期限");
  };
}

/** A read transaction on a read-only connection; the connection closes with it. */
function withReader<T>(path: string, read: (db: Database) => T | Promise<T>): Promise<T> {
  const db = new Database(path, { readonly: true, strict: true });
  return (async () => {
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec("BEGIN");
      try { return await read(db); }
      finally { db.exec("COMMIT"); }
    } finally { db.close(); }
  })();
}

const schema = (db: Database, path: string) =>
  assertDurableSchema({ get: <T extends object>(sql: string) => (db.query(sql).get() as T | null) ?? undefined }, path);

async function spaceFile(space: string): Promise<string | undefined> {
  const path = join(init.conversations, space, "durable.sqlite");
  try {
    await assertDataDirectory(dirname(path), init.conversations);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`会话库路径不是普通文件：${space}`);
    return path;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function onSpace<T>(op: Extract<ReadOp, { space: string }>, check: q.Guard, read: (db: Database) => T): Promise<T> {
  const path = await spaceFile(op.space);
  if (!path) throw named(READ_ERRORS.absent, "会话空间不存在");
  check();
  return withReader(path, async db => {
    await schema(db, path);
    const identity = q.spaceIdentity(db);
    if (identity?.generation !== op.generation) throw named(READ_ERRORS.changed, "会话库已更换，请重新打开");
    return read(db);
  });
}

async function execute(message: ReadMessage): Promise<unknown> {
  const { op } = message, check = guard(message);
  check();
  switch (op.op) {
    case "spaces": {
      const spaces = [];
      for (const space of (await spaceDirectories(init.conversations)).slice(0, READ_LIMITS.spaces)) {
        check();
        const path = await spaceFile(space);
        if (!path) { spaces.push({ space, state: "empty" as const }); continue; }
        try {
          spaces.push(await withReader(path, async db => {
            await schema(db, path);
            const info = q.spaceInfo(db);
            if (!info) return { space, state: "empty" as const };
            // `key` is the scope key the database records (`direct`, `group:<id>`); `space` its storage path.
            const { space: key, ...rest } = info;
            return { space, state: "ready" as const, key, ...rest };
          }));
        } catch (error) { spaces.push({ space, state: "unreadable" as const, error: (error as Error).message }); }
      }
      return { spaces, observedAt: Date.now() };
    }
    case "members": return onSpace(op, check, db => q.members(db, op.after, op.limit, check));
    case "activity": return onSpace(op, check, db => ({ items: q.activity(db, op.conversations, check), observedAt: Date.now() }));
    case "bounds": return onSpace(op, check, db => ({ upper: q.bounds(db, op.conversations, check), observedAt: Date.now() }));
    case "entries": return onSpace(op, check, db => q.entries(db, op.conversation,
      { older: op.older, cursor: op.cursor, upper: op.upper, limit: op.limit, budget: READ_LIMITS.entryBudget }));
    case "entry": return onSpace(op, check, db => ({ entry: q.entry(db, op.conversation, op.id) ?? null }));
    case "boundaries": return onSpace(op, check, db => q.boundaries(db, op.conversation, op.after, op.limit));
    case "search": return onSpace(op, check, db => q.search(db, { conversationId: op.conversation, text: op.text, kinds: op.kinds ?? null,
      from: op.from ?? null, to: op.to ?? null, cursor: op.cursor, upper: op.upper, scan: READ_LIMITS.searchScan, hits: READ_LIMITS.searchHits }, check));
    case "requests": return onSpace(op, check, db => ({ ...q.requests(db, op.phone, op.conversation, READ_LIMITS.requests, check), observedAt: Date.now() }));
    case "names": {
      if (!await stateFile()) return { found: [], observedAt: Date.now() };
      return withReader(init.state, db => {
        const rows = db.query(`SELECT phone, name, last_verified_at AS verifiedAt FROM member_directory WHERE phone IN (${op.phones.map(() => "?").join(", ")})`)
          .all(...op.phones) as { phone: string; name: string; verifiedAt: number }[];
        return { found: rows, observedAt: Date.now() };
      });
    }
    case "groups": {
      if (!await stateFile()) return { groups: [], observedAt: Date.now() };
      return withReader(init.state, db => {
        // The table appears with the push store; a database from before it has no names.
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_groups'").get()) return { groups: [], observedAt: Date.now() };
        const rows = db.query("SELECT group_id AS id, name FROM chat_groups WHERE name IS NOT NULL").all() as { id: string; name: string }[];
        return { groups: rows.map(row => ({ segment: groupSegment(row.id), name: row.name })), observedAt: Date.now() };
      });
    }
  }
}

/** The state database is there (a regular file); false before the first start. */
async function stateFile(): Promise<boolean> {
  let info;
  try { info = await lstat(init.state); }
  catch (error) { if (missing(error)) return false; throw error; }
  if (!info.isFile()) throw new Error("状态库路径不是普通文件");
  return true;
}

// One at a time, in arrival order: a second message waits until the current operation has replied.
let line = Promise.resolve();
port.on("message", (message: ReadMessage) => {
  line = line.then(async () => {
    try { port.postMessage({ request: message.request, ok: true, value: await execute(message) }); }
    catch (error) { port.postMessage({ request: message.request, ok: false, error: encodeError(error) }); }
  });
});
