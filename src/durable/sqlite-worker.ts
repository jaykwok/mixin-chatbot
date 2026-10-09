// Only SQL connections and synchronous I/O live here; transactions are sequenced by the caller.
import { Database, type Statement } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort } from "node:worker_threads";
import { encodeError, type Command, type Reply, type Request } from "./sqlite-protocol.ts";

if (!parentPort) throw new Error("The SQLite worker must run on a worker thread");
const port = parentPort;
const connections = new Map<number, { db: Database; file: string; statements: Map<string, Statement> }>();
const owners = new Map<string, number>();
const deferred: Request[] = [];
let draining = false;
function execute(command: Command): unknown {
  if (command.kind === "stop") {
    if (connections.size) throw new Error("Cannot stop SQLite while connections are open");
    return undefined;
  }
  if (command.kind === "open") {
    if (connections.has(command.connection)) throw new Error("Duplicate SQLite connection");
    mkdirSync(dirname(command.path), { recursive: true });
    const db = new Database(command.path, { create: true, readwrite: true, strict: true });
    try {
      const info = statSync(command.path, { bigint: true });
      connections.set(command.connection, { db, file: `${info.dev}:${info.ino}`, statements: new Map() });
    } catch (error) { db.close(false); throw error; }
    return undefined;
  }
  const connection = connections.get(command.connection);
  if (!connection) throw new Error("SQLite connection is closed");
  const { db, statements } = connection;
  if (command.kind === "close") {
    // Remove before the checkpoint: a failed checkpoint still closes and releases the handle.
    connections.delete(command.connection);
    try {
      for (const statement of statements.values()) statement.finalize();
      statements.clear();
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(false); }
    return undefined;
  }
  if (command.method === "exec") { db.run(command.sql); return undefined; }
  let statement = statements.get(command.sql);
  if (!statement) { statement = db.query(command.sql); statements.set(command.sql, statement); }
  switch (command.method) {
    case "run": statement.run(...(command.params as never[])); return undefined;
    case "get": return statement.get(...(command.params as never[])) ?? undefined;
    case "all": return statement.all(...(command.params as never[]));
  }
}

function blocked(message: Request): boolean {
  if (message.command.kind !== "sql" && message.command.kind !== "close") return false;
  const connection = connections.get(message.command.connection);
  const owner = connection === undefined ? undefined : owners.get(connection.file);
  return owner !== undefined && owner !== message.command.connection;
}
function dispatch(message: Request): void {
  if (blocked(message)) { deferred.push(message); return; }
  const id = "connection" in message.command ? message.command.connection : undefined;
  const connection = id === undefined ? undefined : connections.get(id);
  let reply: Reply;
  try { reply = { request: message.request, ok: true, value: execute(message.command) }; }
  catch (error) { reply = { request: message.request, ok: false, error: encodeError(error) }; }
  if (connection && id !== undefined) {
    if (connections.has(id) && connection.db.inTransaction) owners.set(connection.file, id);
    else if (owners.get(connection.file) === id) owners.delete(connection.file);
  }
  port.postMessage(reply);
  if (message.command.kind === "stop" && reply.ok) {
    // Natural thread exit, after the acknowledgement and all native handles have closed.
    port.removeAllListeners("message");
    port.close();
  }
  // Another connection must not enter a native busy wait on a lock this same SQL thread owns: its owner's
  // COMMIT/ROLLBACK would be stuck behind that wait. Foreign connections queue until the owner releases it.
  if (!draining) {
    draining = true;
    try {
      for (let i = 0; i < deferred.length;) {
        const waiting = deferred[i]!;
        if (blocked(waiting)) { i++; continue; }
        deferred.splice(i, 1); dispatch(waiting); i = 0;
      }
    } finally { draining = false; }
  }
}
port.on("message", dispatch);
