// A process-wide SQL thread, with connections reserved before opening and released after native close.
import { Worker } from "node:worker_threads";
import { decodeError, type Command, type Reply } from "./sqlite-protocol.ts";

export class SqliteWorkerLost extends Error {
  constructor(cause: unknown) { super("SQLite worker stopped before an operation was acknowledged", { cause }); }
}

type Pending = { resolve(value: unknown): void; reject(error: unknown): void };
let current: SqliteClient | undefined;
export function sqliteClient(): SqliteClient {
  return current ??= new SqliteClient();
}

export class SqliteClient {
  readonly worker = new Worker(new URL("./sqlite-worker.ts", import.meta.url));
  private readonly pending = new Map<number, Pending>();
  private readonly references = new Map<number, ((error: SqliteWorkerLost) => void) | undefined>();
  private nextRequest = 0;
  private nextConnection = 0;
  private stopping = false;
  private failure?: SqliteWorkerLost;
  private readonly exited = Promise.withResolvers<number>();
  private retiring?: Promise<void>;
  private termination?: Promise<number>;

  constructor() {
    this.worker.on("message", (reply: Reply) => {
      const waiting = this.pending.get(reply.request);
      if (!waiting) return this.fail(new Error("Unexpected SQLite response identity"));
      this.pending.delete(reply.request);
      if (reply.ok) waiting.resolve(reply.value);
      else waiting.reject(decodeError(reply.error));
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      this.exited.resolve(code);
      if (!this.stopping || this.pending.size) this.fail(new Error(`SQLite worker exited with code ${code}`));
    });
  }

  request<T>(command: Command): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.stopping && command.kind !== "stop") return Promise.reject(new Error("SQLite worker is closing"));
    const request = ++this.nextRequest;
    const result = Promise.withResolvers<unknown>();
    this.pending.set(request, result);
    try { this.worker.postMessage({ request, command }); }
    catch (error) { this.fail(error); }
    return result.promise as Promise<T>;
  }

  async open(path: string, onFailure?: (error: SqliteWorkerLost) => void): Promise<number> {
    if (this.stopping || this.failure) throw this.failure ?? new Error("SQLite worker is closing");
    const connection = ++this.nextConnection;
    this.references.set(connection, onFailure);
    try { await this.request({ kind: "open", connection, path }); return connection; }
    catch (error) {
      this.references.delete(connection);
      await this.retire().catch(() => {});
      throw error;
    }
  }

  async close(connection: number): Promise<void> {
    let failed = false, original: unknown;
    try { await this.request({ kind: "close", connection }); }
    catch (error) { failed = true; original = error; }
    this.references.delete(connection);
    try { await this.retire(); }
    catch (error) {
      if (failed) throw new AggregateError([original, error], "Closing SQLite and stopping its worker both failed");
      throw error;
    }
    if (failed) throw original;
  }

  private retire(): Promise<void> {
    if (this.references.size) return Promise.resolve();
    if (this.retiring) return this.retiring;
    // No await between publishing retirement and clearing the global slot: a concurrent open gets a new worker.
    this.stopping = true;
    if (current === this) current = undefined;
    this.retiring = (async () => {
      if (this.failure) { await this.forceStop(); return; }
      await this.request({ kind: "stop" });
      const code = await this.exited.promise;
      if (code !== 0) throw new SqliteWorkerLost(new Error(`SQLite worker exited with code ${code}`));
    })();
    return this.retiring;
  }

  private fail(cause: unknown): void {
    if (this.failure) return;
    this.failure = new SqliteWorkerLost(cause);
    if (current === this) current = undefined;
    for (const waiting of this.pending.values()) waiting.reject(this.failure);
    this.pending.clear();
    for (const report of this.references.values()) {
      try { report?.(this.failure); } catch {}
    }
    // Only the broken transport path needs forced termination; normal close uses parentPort.close and waits for exit.
    void this.forceStop().catch(() => {});
  }
  private forceStop(): Promise<number> { return this.termination ??= this.worker.terminate(); }
}
