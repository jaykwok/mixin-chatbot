// Where the time of the service's SQL requests goes. The SQL thread (sqlite-worker.ts) stamps when it received, started
// and ended each request; the connection's queue (sqlite-facade.ts) adds how long the request waited behind the same
// database's earlier operation or open transaction. Listeners see every request and transaction: the space-open timing
// (spaces.ts), the slow-request log (src/server/app.ts) and the load tools. Nothing is kept here.
import type { Command } from "./sqlite-protocol.ts";

/** One request of the shared SQL thread, in milliseconds. */
export type SqlRequestTiming = {
  type: "request";
  /** The database file, as it was opened. */
  path: string;
  command: Exclude<Command, { kind: "stop" }>;
  /** Behind the same connection's earlier operation or open transaction (none for statements inside a transaction). */
  queued: number;
  /** From sending until the SQL thread received it: other databases' requests ahead of it, and the message passing. */
  waited: number;
  /** Held back on the SQL thread while another connection to the same file had a transaction open. */
  deferred: number;
  exec: number;
  /** From the end of execution until the service thread took the reply: its event-loop delay. */
  returned: number;
  ok: boolean;
};
/** One transaction: its wait for the connection, and how long it then held it, from `BEGIN` until the
 *  `COMMIT`/`ROLLBACK` reply (its callback runs on the service thread meanwhile). */
export type SqlTransactionTiming = { type: "transaction"; path: string; queued: number; held: number; statements: number; committed: boolean };
export type SqlTiming = SqlRequestTiming | SqlTransactionTiming;

const listeners = new Set<(timing: SqlTiming) => void>();

/** Calls `listener` (which must be quick) for every request and transaction until the returned function is called. */
export function watchSql(listener: (timing: SqlTiming) => void): () => void {
  const own = (timing: SqlTiming) => listener(timing);
  listeners.add(own);
  return () => { listeners.delete(own); };
}

/** Whether anyone listens: without listeners nothing is computed. */
export function sqlWatched(): boolean { return listeners.size > 0; }

export function reportSql(timing: SqlTiming): void {
  for (const listener of listeners) {
    try { listener(timing); } catch {}
  }
}

export type SqlTotals = { requests: number; queued: number; waited: number; exec: number; transactions: number; held: number };

/** Totals of one database's requests and transactions from now until the returned function is called. */
export function countSql(path: string): () => SqlTotals {
  const totals: SqlTotals = { requests: 0, queued: 0, waited: 0, exec: 0, transactions: 0, held: 0 };
  const stop = watchSql((timing) => {
    if (timing.path !== path) return;
    if (timing.type === "transaction") { totals.transactions++; totals.held += timing.held; return; }
    totals.requests++;
    totals.queued += timing.queued;
    totals.waited += timing.waited + timing.deferred;
    totals.exec += timing.exec;
  });
  return () => { stop(); return totals; };
}

/** A database as the logs name it: `direct` or `groups/<segment>` below conversations/, else the path. */
export function databaseLabel(path: string): string {
  const normal = path.replace(/\\/g, "/");
  const below = /\/conversations\/(.+)\/durable\.sqlite$/.exec(normal);
  return below?.[1] ?? normal;
}

/** The start of the statement, without its parameters. */
function statement(command: SqlRequestTiming["command"]): string {
  return command.kind === "sql" ? command.sql.replace(/\s+/g, " ").trim().slice(0, 60) : command.kind;
}

const ms = (value: number) => `${Math.round(value)}ms`;

/**
 * A listener for the service log: a request that took `thresholdMs` or more in all (its wait for the connection
 * included), or a transaction that held its connection that long. At most one line per database every `intervalMs`;
 * the next line says how many were left out meanwhile. Parameters are never written.
 */
export function slowSqlLog(warn: (line: string) => void, { thresholdMs = 1_000, intervalMs = 60_000, now = () => Date.now() } = {}): (timing: SqlTiming) => void {
  const quiet = new Map<string, { until: number; skipped: number }>();
  return (timing) => {
    const total = timing.type === "transaction" ? timing.held
      : timing.queued + timing.waited + timing.deferred + timing.exec + timing.returned;
    if (total < thresholdMs) return;
    const database = databaseLabel(timing.path), at = now(), state = quiet.get(database);
    if (state !== undefined && at < state.until) { state.skipped++; return; }
    const skipped = state?.skipped ? `；上一行之后另有 ${state.skipped} 次未单独记录` : "";
    quiet.set(database, { until: at + intervalMs, skipped: 0 });
    warn(timing.type === "transaction"
      ? `SQL 事务占用连接较久 - 库: ${database}, 占用: ${ms(timing.held)}, 语句: ${timing.statements} 条, ${timing.committed ? "已提交" : "已回滚"}, 开始前排队: ${ms(timing.queued)}${skipped}`
      : `SQL 请求较慢 - 库: ${database}, 语句: ${statement(timing.command)}, 共: ${ms(total)}（库内排队 ${ms(timing.queued)}，线程排队 ${ms(timing.waited)}，让行 ${ms(timing.deferred)}，执行 ${ms(timing.exec)}，回传 ${ms(timing.returned)}）${timing.ok ? "" : "，失败"}${skipped}`);
  };
}
