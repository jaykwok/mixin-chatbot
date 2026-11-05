// Application callbacks stay on the main thread; synchronous SQL and FULL commits run on the SQL worker. The time an
// operation waits in its connection's queue, and how long each transaction holds the connection, go to the SQL
// listeners (sql-timing.ts).
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { reportSql, sqlWatched } from "./sql-timing.ts";
import { type SqliteClient } from "./sqlite-client.ts";

const ignore = (): void => {};
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  /** `operation` gets how long it waited behind the earlier ones, in milliseconds. */
  run<T>(operation: (queued: number) => Promise<T>): Promise<T> {
    const enqueued = performance.now();
    const result = this.tail.then(() => operation(performance.now() - enqueued));
    this.tail = result.then(ignore, ignore);
    return result;
  }
}

abstract class Executor implements SqliteExecutor {
  constructor(protected readonly client: SqliteClient, protected readonly connection: number) {}
  exec(sql: string): Promise<void> {
    return this.runOperation((queued) => this.client.request({ kind: "sql", connection: this.connection, method: "exec", sql, params: [] }, queued));
  }
  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation((queued) => this.client.request({ kind: "sql", connection: this.connection, method: "run", sql, params }, queued));
  }
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.runOperation((queued) => this.client.request({ kind: "sql", connection: this.connection, method: "runCounted", sql, params }, queued));
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation((queued) => this.client.request({ kind: "sql", connection: this.connection, method: "get", sql, params }, queued));
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation((queued) => this.client.request({ kind: "sql", connection: this.connection, method: "all", sql, params }, queued));
  }
  protected abstract runOperation<T>(operation: (queued: number) => Promise<T>): Promise<T>;
}

type Scope = { active: boolean; statements: number };

class Transaction extends Executor {
  constructor(client: SqliteClient, connection: number, private readonly scope: Scope) { super(client, connection); }
  protected async runOperation<T>(operation: (queued: number) => Promise<T>): Promise<T> {
    if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
    this.scope.statements++;
    return operation(0);
  }
}

export class BunSqliteDatabase extends Executor implements SqliteDatabase {
  private readonly access = new SerialQueue();
  private closed = false;
  private closing?: Promise<void>;
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.run(async (queued) => {
      this.assertOpen();
      const begun = performance.now();
      await this.client.request({ kind: "sql", connection: this.connection, method: "exec", sql: "BEGIN IMMEDIATE", params: [] }, queued);
      const scope: Scope = { active: true, statements: 0 };
      let committed = false;
      try {
        const result = await callback(new Transaction(this.client, this.connection, scope));
        scope.active = false;
        await this.client.request({ kind: "sql", connection: this.connection, method: "exec", sql: "COMMIT", params: [] });
        committed = true;
        return result;
      } catch (error) {
        scope.active = false;
        try { await this.client.request({ kind: "sql", connection: this.connection, method: "exec", sql: "ROLLBACK", params: [] }); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed"); }
        throw error;
      } finally {
        const path = sqlWatched() ? this.client.pathOf(this.connection) : undefined;
        if (path !== undefined) reportSql({ type: "transaction", path, queued, held: performance.now() - begun, statements: scope.statements, committed });
      }
    });
  }
  close(): Promise<void> {
    return this.closing ??= this.access.run(async () => {
      if (this.closed) return;
      this.closed = true;
      await this.client.close(this.connection);
    });
  }
  protected runOperation<T>(operation: (queued: number) => Promise<T>): Promise<T> {
    return this.access.run(async (queued) => { this.assertOpen(); return operation(queued); });
  }
  private assertOpen(): void { if (this.closed) throw new Error("SQLite connection is closed"); }
}
