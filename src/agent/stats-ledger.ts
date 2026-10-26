// The stats ledger (data/state/stats.sqlite, src/core/layout.ts): who asked how often, and the token usage the models
// returned. Nothing else is kept: no cost, no request counts, no per-question attribution.
//
// Asks. A user message admitted into a member's inbox is one ask, counted once by its requestId (`ask_ids`) on the day it
// was admitted. The service counts it after the admission commit and again from the member's run records at every sync,
// so a failed count catches up while the record still exists (closed records stay at least a day). Counted requestIds
// are kept for ASK_ID_RETENTION_MS; the pruning moves a persisted horizon forward, and an ask from before the horizon is
// never counted again, so a record that outlives the retention (a parked task) cannot count twice.
//
// Tokens. Durable keeps cumulative totals per conversation in `pi.usage` (models: `provider/model`, tools: tool name).
// A sync stores the latest totals per source (space database generation + conversation) and adds the difference to the
// observation day: usage committed while the service was down, or by a background compaction, counts on the day of the
// next sync. A new space database has a new generation and so new sources. A total that went down under the same
// source means an older copy of the database (a restore) whose usage was already counted: the current totals become
// the baseline, nothing is added, and the key is reported. Totals stay a lower bound; a restore never counts twice.
//
// Imported rows (scripts/ops/stats-import.ts, the old webhook ledger) are kept apart by `origin` and read together.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SCHEMA_VERSION = 3;
/** The tables of the current format; data validation reads each once. */
export const STATS_TABLES = ["asks_daily", "ask_ids", "ask_horizon", "usage_sources", "usage_daily", "imports"] as const;
/** How long a counted requestId is remembered (run records are pruned a day after they close). */
export const ASK_ID_RETENTION_MS = 30 * 24 * 3600_000;

export const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
export type TokenTotals = Record<typeof TOKEN_FIELDS[number], number>;
export type UsageBucket = "models" | "tools";
export const emptyTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
export function addTokens(into: TokenTotals, add: Readonly<TokenTotals>): void {
  for (const field of TOKEN_FIELDS) into[field] += add[field];
}

/** 本地时区的 YYYY-MM-DD；汇报材料按自然日和自然月看，不能用 UTC。 */
export function dayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${String(date.getDate()).padStart(2, "0")}`;
}

const hasSchema = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stats_schema'").get();

function assertSchemaVersion(db: Database): void {
  const version = (db.query("SELECT version FROM stats_schema WHERE id = 1").get() as { version: number } | null)?.version;
  if (version !== SCHEMA_VERSION) {
    throw new Error(`统计账本版本 ${version ?? "未知"} 与当前 ${SCHEMA_VERSION} 不一致；请保留 stats.sqlite，旧版统计按 docs/data-migrations.md 用导入工具导入新账本`);
  }
}

const TOKENS_SQL = "input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, total_tokens INTEGER NOT NULL";

/** The ledger at `path`, created with its schema when missing. */
export function openStatsLedger(path: string): Database {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 3000;");
    db.transaction(() => {
      if (hasSchema(db)) { assertSchemaVersion(db); return; }
      db.exec("CREATE TABLE stats_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
      db.exec(`CREATE TABLE asks_daily (day TEXT NOT NULL, space TEXT NOT NULL, user TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('live', 'import')), asks INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
        PRIMARY KEY (day, space, user, origin)) WITHOUT ROWID`);
      db.exec("CREATE TABLE ask_ids (request_id TEXT PRIMARY KEY, space TEXT NOT NULL, user TEXT NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID");
      db.exec("CREATE TABLE ask_horizon (id INTEGER PRIMARY KEY CHECK(id = 1), before INTEGER NOT NULL)");
      db.exec("INSERT INTO ask_horizon (id, before) VALUES (1, 0)");
      db.exec(`CREATE TABLE usage_sources (source TEXT NOT NULL, bucket TEXT NOT NULL CHECK(bucket IN ('models', 'tools')), key TEXT NOT NULL,
        space TEXT NOT NULL, user TEXT NOT NULL, ${TOKENS_SQL}, seen_at INTEGER NOT NULL,
        PRIMARY KEY (source, bucket, key)) WITHOUT ROWID`);
      db.exec(`CREATE TABLE usage_daily (day TEXT NOT NULL, space TEXT NOT NULL, user TEXT NOT NULL,
        bucket TEXT NOT NULL CHECK(bucket IN ('models', 'tools')), key TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('live', 'import')),
        ${TOKENS_SQL}, PRIMARY KEY (day, space, user, bucket, key, origin)) WITHOUT ROWID`);
      db.exec("CREATE TABLE imports (digest TEXT PRIMARY KEY, at INTEGER NOT NULL, asks INTEGER NOT NULL, usage_rows INTEGER NOT NULL) WITHOUT ROWID");
      db.query("INSERT INTO stats_schema (id, version) VALUES (1, ?)").run(SCHEMA_VERSION);
    })();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * 只读入口（stat、TUI）：只读连接、只读版本检查，不建库建表、不改日志模式。
 * 以运维账户身份写库会留下服务写不了的文件，也打不开只读的账本快照。
 */
export function openExistingStatsLedger(path: string): Database | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true, strict: true });
  let ready = false;
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    // 服务刚建文件、还没来得及建表时按空账处理。
    if (!hasSchema(db)) return null;
    assertSchemaVersion(db);
    ready = true;
    return db;
  } finally { if (!ready) db.close(); }
}

/** One admitted user message. `space` and `user` are storage segments (statsSegment, userSegment). */
export interface Ask { requestId: string; space: string; user: string; at: number }

const ADD_ASKS = `INSERT INTO asks_daily (day, space, user, origin, asks, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(day, space, user, origin) DO UPDATE SET asks = asks + excluded.asks,
    first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`;

const horizon = (db: Database) => (db.query("SELECT before FROM ask_horizon WHERE id = 1").get() as { before: number }).before;

/** Count asks not counted yet and not older than the horizon; returns how many were new. */
export function recordAsks(db: Database, asks: readonly Ask[]): number {
  if (!asks.length) return 0;
  return db.transaction(() => {
    const before = horizon(db);
    const seen = db.query("INSERT OR IGNORE INTO ask_ids (request_id, space, user, at) VALUES (?, ?, ?, ?)");
    const add = db.query(ADD_ASKS);
    let added = 0;
    for (const ask of asks) {
      if (ask.at < before || seen.run(ask.requestId, ask.space, ask.user, ask.at).changes === 0) continue;
      add.run(dayKey(ask.at), ask.space, ask.user, "live", 1, ask.at, ask.at);
      added++;
    }
    return added;
  }).immediate();
}

/**
 * The requestIds among `asks` that need their source no more: counted, or older than the horizon (never counted again).
 * The others must keep their run records so a later sync can count them.
 */
export function settledAsks(db: Database, asks: readonly Pick<Ask, "requestId" | "at">[]): Set<string> {
  const settled = new Set<string>();
  if (!asks.length) return settled;
  const before = horizon(db);
  const seen = db.query("SELECT 1 FROM ask_ids WHERE request_id = ?");
  for (const ask of asks) if (ask.at < before || seen.get(ask.requestId) !== null) settled.add(ask.requestId);
  return settled;
}

/** Forget requestIds older than the retention and move the horizon there (never back); returns how many were dropped. */
export function pruneAskIds(db: Database, now = Date.now()): number {
  return db.transaction(() => {
    const before = Math.max(horizon(db), now - ASK_ID_RETENTION_MS);
    db.query("UPDATE ask_horizon SET before = ? WHERE id = 1").run(before);
    return db.query("DELETE FROM ask_ids WHERE at < ?").run(before).changes;
  }).immediate();
}

/** A conversation's usage source: `id` is the space database generation and the conversation id. */
export interface UsageSource { id: string; space: string; user: string }
/** `pi.usage` as stored: a bucket maps each key to cumulative totals (extra counters such as cost are ignored). */
export type UsageState = Record<UsageBucket, Record<string, Partial<Record<typeof TOKEN_FIELDS[number], unknown>>>>;

const tokensOf = (raw: Partial<Record<typeof TOKEN_FIELDS[number], unknown>>): TokenTotals => {
  const totals = emptyTokens();
  for (const field of TOKEN_FIELDS) {
    const value = raw[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) totals[field] = value;
  }
  return totals;
};

/**
 * Store the source's latest totals and add the growth since the previous sync to `now`'s day. Callers serialise syncs of
 * one source and read `state` inside that turn: an older snapshot written after a newer one would read as a regression.
 * Returns the keys whose totals went down; their current totals become the baseline and add nothing.
 */
export function syncUsage(db: Database, source: UsageSource, state: UsageState, now = Date.now()): string[] {
  const regressed: string[] = [];
  db.transaction(() => {
    const prior = db.query(`SELECT input, output, cache_read AS cacheRead, cache_write AS cacheWrite, total_tokens AS totalTokens
      FROM usage_sources WHERE source = ? AND bucket = ? AND key = ?`);
    const store = db.query(`INSERT INTO usage_sources (source, bucket, key, space, user, input, output, cache_read, cache_write, total_tokens, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, bucket, key) DO UPDATE SET input = excluded.input, output = excluded.output,
        cache_read = excluded.cache_read, cache_write = excluded.cache_write, total_tokens = excluded.total_tokens, seen_at = excluded.seen_at`);
    const add = db.query(`INSERT INTO usage_daily (day, space, user, bucket, key, origin, input, output, cache_read, cache_write, total_tokens)
      VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?) ON CONFLICT(day, space, user, bucket, key, origin) DO UPDATE SET
        input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write, total_tokens = total_tokens + excluded.total_tokens`);
    const day = dayKey(now);
    for (const bucket of ["models", "tools"] as const) {
      for (const [key, raw] of Object.entries(state[bucket] ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const current = tokensOf(raw ?? {});
        const last = prior.get(source.id, bucket, key) as TokenTotals | null;
        const delta = emptyTokens();
        const lower = last !== null && TOKEN_FIELDS.some(field => current[field] < last[field]);
        if (lower) regressed.push(`${bucket}:${key}`);
        if (!lower) for (const field of TOKEN_FIELDS) delta[field] = last === null ? current[field] : current[field] - last[field];
        if (last !== null && !lower && TOKEN_FIELDS.every(field => delta[field] === 0)) continue;
        store.run(source.id, bucket, key, source.space, source.user, ...TOKEN_FIELDS.map(field => current[field]), now);
        if (TOKEN_FIELDS.some(field => delta[field] > 0)) add.run(day, source.space, source.user, bucket, key, ...TOKEN_FIELDS.map(field => delta[field]));
      }
    }
  }).immediate();
  return regressed;
}

/** Rows of the old ledger kept by the import tool: daily asks per member, daily tokens per member and model. */
export interface ImportRows {
  asks: { day: string; space: string; user: string; asks: number; firstAt: number; lastAt: number }[];
  usage: ({ day: string; space: string; user: string; key: string } & TokenTotals)[];
}

/**
 * Add an old ledger's rows once, marked as imported. `digest` identifies the source file: the same file again adds
 * nothing ("already"); a second, different file is refused, since two old ledgers may overlap.
 */
export function importRows(db: Database, digest: string, rows: ImportRows, now = Date.now()): "imported" | "already" {
  return db.transaction(() => {
    const done = importedDigests(db);
    if (done.includes(digest)) return "already" as const;
    if (done.length) throw new Error("新账本已导入过另一份旧统计，拒绝再导入，以免重复计数");
    const ask = db.query(ADD_ASKS);
    for (const row of rows.asks) ask.run(row.day, row.space, row.user, "import", row.asks, row.firstAt, row.lastAt);
    const usage = db.query(`INSERT INTO usage_daily (day, space, user, bucket, key, origin, input, output, cache_read, cache_write, total_tokens)
      VALUES (?, ?, ?, 'models', ?, 'import', ?, ?, ?, ?, ?) ON CONFLICT(day, space, user, bucket, key, origin) DO UPDATE SET
        input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write, total_tokens = total_tokens + excluded.total_tokens`);
    for (const row of rows.usage) usage.run(row.day, row.space, row.user, row.key, ...TOKEN_FIELDS.map(field => row[field]));
    db.query("INSERT INTO imports (digest, at, asks, usage_rows) VALUES (?, ?, ?, ?)")
      .run(digest, now, rows.asks.reduce((sum, row) => sum + row.asks, 0), rows.usage.length);
    return "imported" as const;
  }).immediate();
}

/** Digests of the old ledgers imported so far (at most one); read-only. */
export function importedDigests(db: Database): string[] {
  return (db.query("SELECT digest FROM imports").all() as { digest: string }[]).map(row => row.digest);
}

export interface AskRow { group: string; user: string; day: string; asks: number; firstAt: number; lastAt: number }
export interface UsageRow extends TokenTotals { group: string; user: string; day: string; bucket: UsageBucket; key: string }
export interface LedgerRows {
  asks: AskRow[];
  usage: UsageRow[];
  /** 账本里记过的空间（群的存储段，单聊为 direct），即使会话库已被删除也在内。 */
  groups: string[];
}

/** 统计区间按自然日裁剪：账本是日粒度的，比一天更细的边界会被扩到整天。 */
export interface DayWindow { since?: string; until?: string }

export function dayWindow(window: { since?: number; until?: number }): DayWindow {
  return {
    ...(window.since === undefined ? {} : { since: dayKey(window.since) }),
    ...(window.until === undefined ? {} : { until: dayKey(window.until) }),
  };
}

/** 读出区间内的行（导入行与实时行合并）；排序固定，折算结果与平台和写入次序无关。 */
export function readLedger(db: Database, window: DayWindow = {}, group?: string): LedgerRows {
  const filters: string[] = [], args: string[] = [];
  if (group !== undefined) { filters.push("space = ?"); args.push(group); }
  if (window.since !== undefined) { filters.push("day >= ?"); args.push(window.since); }
  if (window.until !== undefined) { filters.push("day <= ?"); args.push(window.until); }
  const clause = filters.length ? " WHERE " + filters.join(" AND ") : "";
  const asks = db.query(`SELECT space AS "group", user, day, SUM(asks) AS asks, MIN(first_at) AS firstAt, MAX(last_at) AS lastAt
    FROM asks_daily${clause} GROUP BY space, user, day ORDER BY space, user, day`).all(...args) as AskRow[];
  const usage = db.query(`SELECT space AS "group", user, day, bucket, key, SUM(input) AS input, SUM(output) AS output,
      SUM(cache_read) AS cacheRead, SUM(cache_write) AS cacheWrite, SUM(total_tokens) AS totalTokens
    FROM usage_daily${clause} GROUP BY space, user, day, bucket, key ORDER BY space, user, day, bucket, key`).all(...args) as UsageRow[];
  const spaceFilter = group === undefined ? "" : " WHERE space = ?";
  const groups = (db.query(`SELECT space FROM asks_daily${spaceFilter} UNION SELECT space FROM usage_daily${spaceFilter} ORDER BY space`)
    .all(...(group === undefined ? [] : [group, group])) as { space: string }[]).map(row => row.space);
  return { asks, usage, groups };
}
