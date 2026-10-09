// Application callbacks stay on the main thread; synchronous SQL and FULL commits run on the SQL worker.
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/pi-durable/storage/sqlite";
import { type SqliteClient } from "./sqlite-client.ts";

const ignore = (): void => {};
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(ignore, ignore);
    return result;
  }
}

abstract class Executor implements SqliteExecutor {
  constructor(protected readonly client: SqliteClient, protected readonly connection: number) {}
  exec(sql: string): Promise<void> {
    return this.runOperation(() => this.client.request({ kind: "sql", connection: this.connection, method: "exec", sql, params: [] }));
  }
  run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.runOperation(() => this.client.request({ kind: "sql", connection: this.connection, method: "run", sql, params }));
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.runOperation(() => this.client.request({ kind: "sql", connection: this.connection, method: "get", sql, params }));
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.runOperation(() => this.client.request({ kind: "sql", connection: this.connection, method: "all", sql, params }));
  }
  protected abstract runOperation<T>(operation: () => Promise<T>): Promise<T>;
}

class Transaction extends Executor {
  constructor(client: SqliteClient, connection: number, private readonly scope: { active: boolean }) { super(client, connection); }
  protected async runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.scope.active) throw new Error("SQLite transaction handle is no longer active");
    return operation();
  }
}

export class BunSqliteDatabase extends Executor implements SqliteDatabase {
  private readonly access = new SerialQueue();
  private closed = false;
  private closing?: Promise<void>;
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.access.run(async () => {
      this.assertOpen();
      await this.client.request({ kind: "sql", connection: this.connection, method: "exec", sql: "BEGIN IMMEDIATE", params: [] });
      const scope = { active: true };
      try {
        const result = await callback(new Transaction(this.client, this.connection, scope));
        scope.active = false;
        await this.client.request({ kind: "sql", connection: this.connection, method: "exec", sql: "COMMIT", params: [] });
        return result;
      } catch (error) {
        scope.active = false;
        try { await this.client.request({ kind: "sql", connection: this.connection, method: "exec", sql: "ROLLBACK", params: [] }); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "SQLite transaction failed and rollback failed"); }
        throw error;
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
  protected runOperation<T>(operation: () => Promise<T>): Promise<T> {
    return this.access.run(async () => { this.assertOpen(); return operation(); });
  }
  private assertOpen(): void { if (this.closed) throw new Error("SQLite connection is closed"); }
}
