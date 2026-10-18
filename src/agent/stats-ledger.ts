import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { countUsageRecord, emptyUsage, type UsageTotals } from "../../scripts/lib/usage.ts";
import type { StatsRecord } from "./stats-record.ts";

const SCHEMA_VERSION = 2;
/** Durable projection: aborted entries are separate requests, and starts without an entry remain visible. */
export const DURABLE_PROJECTION = 4;
/** Frozen usage of retired requests (`settled:<source>`): never re-projected, so it has no entry projector version.
 * Kept apart from 1, which marks unverifiable pre-upgrade sources in the report. */
const SETTLED_PROJECTION = 0;
/** 工具自身用量不知道来自哪个模型，不能归到对话模型名下。 */
const UNATTRIBUTED = { provider: "unknown", model: "unknown" };

/** 账本跟着群数据走：群数据根可以指到别的磁盘，统计不能留在项目目录里对不上。 */
export function statsLedgerPath(root: string): string {
  return join(resolve(root), "stats.sqlite");
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
  // 原始会话可能已归档或删除；账本必须保留，结构变化时应单独转换备份并核对。
  if (version !== SCHEMA_VERSION) {
    throw new Error(`统计账本版本 ${version ?? "未知"} 与当前 ${SCHEMA_VERSION} 不一致；请保留 stats.sqlite，并按 docs/data-migrations.md 的统计转换说明准备当前格式账本`);
  }
}

export function openStatsLedger(root: string): Database {
  mkdirSync(resolve(root), { recursive: true });
  const db = new Database(statsLedgerPath(root), { create: true, strict: true });
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;");
    db.transaction(() => {
      if (hasSchema(db)) {
        assertSchemaVersion(db);
        return;
      }
      db.exec("CREATE TABLE stats_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec(`CREATE TABLE sources (
        id TEXT PRIMARY KEY, group_segment TEXT NOT NULL, user_segment TEXT NOT NULL,
        identity TEXT NOT NULL, offset INTEGER NOT NULL, digest TEXT NOT NULL,
        bad_lines INTEGER NOT NULL, pending INTEGER NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL,
        seen_at INTEGER NOT NULL, archived_at INTEGER, projection INTEGER NOT NULL)`);
      db.exec("CREATE INDEX sources_location ON sources(group_segment, user_segment, identity)");
      db.exec(`CREATE TABLE activity (
        source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, day TEXT NOT NULL,
        asks INTEGER NOT NULL, replies INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
        PRIMARY KEY (source, day)) WITHOUT ROWID`);
      db.exec(`CREATE TABLE tool_counts (
        source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, day TEXT NOT NULL,
        kind TEXT NOT NULL, tool TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (source, day, kind, tool)) WITHOUT ROWID`);
      db.exec(`CREATE TABLE usage_totals (
        source TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, day TEXT NOT NULL,
        kind TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
        missing_usage INTEGER NOT NULL, unknown_cost INTEGER NOT NULL, cost REAL NOT NULL,
        first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
        PRIMARY KEY (source, day, kind, provider, model)) WITHOUT ROWID`);
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
export function openExistingStatsLedger(root: string): Database | null {
  const path = statsLedgerPath(root);
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

interface SourceRow {
  id: string; identity: string; offset: number; digest: string;
  pending: number; provider: string; model: string; projection: number;
}

interface Bucket { asks: number; replies: number; firstAt: number; lastAt: number }
type UsageBucket = UsageTotals & { firstAt: number; lastAt: number };

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 把新增记录折成日粒度的桶。
 *
 * provider/model 随带模型信息的回复更新，
 * 所以增量入账必须把它随游标一起存回账本，否则续读的那一段会被算到 unknown 上。
 */
function fold(records: StatsRecord[], state: { provider: string; model: string }) {
  const activity = new Map<string, Bucket>();
  const tools = new Map<string, number>();
  const usage = new Map<string, UsageBucket>();
  const countTool = (day: string, kind: string, name: string) => {
    const key = JSON.stringify([day, kind, name]);
    tools.set(key, (tools.get(key) ?? 0) + 1);
  };
  const touch = (day: string): Bucket => {
    const bucket = activity.get(day)
      ?? { asks: 0, replies: 0, firstAt: Number.POSITIVE_INFINITY, lastAt: Number.NEGATIVE_INFINITY };
    activity.set(day, bucket);
    return bucket;
  };
  const countUsage = (day: string, kind: string, at: number, raw?: Record<string, unknown>, attribution = state) => {
    const key = JSON.stringify([day, kind, attribution.provider, attribution.model]);
    const bucket = usage.get(key)
      ?? { ...emptyUsage(), firstAt: Number.POSITIVE_INFINITY, lastAt: Number.NEGATIVE_INFINITY };
    countUsageRecord(bucket, raw);
    bucket.firstAt = Math.min(bucket.firstAt, at);
    bucket.lastAt = Math.max(bucket.lastAt, at);
    usage.set(key, bucket);
  };

  for (const record of records) {
    if (record.type === "message" && record.message?.role === "assistant") {
      state.provider = record.message.provider ?? state.provider;
      state.model = record.message.model ?? state.model;
    }
    const at = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    const day = dayKey(at);
    // Pi 0.86 起用量条目自带 kind（例如 cache_warm）；未知 kind 按普通用量记，不丢账。
    if (record.type === "usage") {
      // 独立调用可来自其他模型，不继承或改变主对话的模型状态。
      const identifier = (value: unknown) => typeof value === "string" && value.trim() ? value : "unknown";
      countUsage(day, record.kind || "usage", at, record.usage,
        { provider: identifier(record.provider), model: identifier(record.model) });
      continue;
    }
    if (record.type !== "message" || !record.message) continue;
    const role = record.message.role;
    if (role === "user") {
      // 指令不算提问：它没有进过模型，只是让机器人停一下或清个历史。
      if (record.message.command) continue;
      touch(day).asks++;
    } else if (role === "assistant") {
      touch(day).replies++;
      countUsage(day, "assistant", at, record.message.usage);
      for (const part of record.message.content ?? []) {
        if (part?.type === "toolCall" && part.name) countTool(day, "call", part.name);
      }
    } else if (role === "toolResult") {
      const message = record.message;
      if (!message.isError && message.details?.fileId && ["send_file", "send_image"].includes(message.toolName ?? "")) {
        countTool(day, "delivered", message.toolName!);
      }
      // 工具自身的用量（含 SDK 并入的子调用用量）每条结果只计一次；子调用结果不落盘，不会重复。
      if (message.usage && typeof message.usage === "object") countUsage(day, "tool", at, message.usage, UNATTRIBUTED);
      if (message.nested) {
        for (const name of message.nested.names) countTool(day, "nested", name);
        if (!message.nested.complete) countTool(day, "nested_incomplete", message.toolName || "unknown");
      }
    } else continue;
    const bucket = touch(day);
    bucket.firstAt = Math.min(bucket.firstAt, at);
    bucket.lastAt = Math.max(bucket.lastAt, at);
  }
  return { activity, tools, usage };
}

function apply(db: Database, source: string, folded: ReturnType<typeof fold>): void {
  const activity = db.query(`INSERT INTO activity (source, day, asks, replies, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, day) DO UPDATE SET asks = asks + excluded.asks, replies = replies + excluded.replies,
      first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`);
  const tool = db.query(`INSERT INTO tool_counts (source, day, kind, tool, count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, day, kind, tool) DO UPDATE SET count = count + excluded.count`);
  const usage = db.query(`INSERT INTO usage_totals (source, day, kind, provider, model, requests, input, output,
      cache_read, cache_write, missing_usage, unknown_cost, cost, first_at, last_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, day, kind, provider, model) DO UPDATE SET requests = requests + excluded.requests,
      input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
      cache_write = cache_write + excluded.cache_write, missing_usage = missing_usage + excluded.missing_usage,
      unknown_cost = unknown_cost + excluded.unknown_cost, cost = cost + excluded.cost,
      first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at)`);
  // 固定写入顺序：同一批数据在任何平台上都按同样的顺序累加浮点费用。
  for (const [day, bucket] of [...folded.activity].sort(([a], [b]) => byKey(a, b))) {
    activity.run(source, day, bucket.asks, bucket.replies, bucket.firstAt, bucket.lastAt);
  }
  for (const [key, count] of [...folded.tools].sort(([a], [b]) => byKey(a, b))) {
    const [day, kind, name] = JSON.parse(key) as [string, string, string];
    tool.run(source, day, kind, name, count);
  }
  for (const [key, bucket] of [...folded.usage].sort(([a], [b]) => byKey(a, b))) {
    const [day, kind, provider, model] = JSON.parse(key) as [string, string, string, string];
    usage.run(source, day, kind, provider, model, bucket.requests, bucket.input, bucket.output,
      bucket.cacheRead, bucket.cacheWrite, bucket.missingUsage, bucket.unknownCost, bucket.cost,
      bucket.firstAt, bucket.lastAt);
  }
}

/** 一段持久会话在账本里的世代：一个成员会话一个 source，游标是已入账的最新条目号。 */
export interface ConversationSource { id: string; group: string; user: string; identity: string; digest?: string }

export function finalizeConversationProjection(db: Database, source: string): void {
  db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, '1')").run("durable_retired:" + source);
}

/** Final usage has no replayable starts. Its format version is independent of the entry projector. */
export function settleConversationUsage(db: Database, source: ConversationSource, records: StatsRecord[]): void {
  if (!records.length) return;
  if (records.some(record => record.type !== "usage")) throw new Error("最终用量只能包含已结算请求");
  const id = "settled:" + source.id, identity = source.identity + ":settled";
  db.transaction(() => {
    const prior = db.query("SELECT group_segment, user_segment, identity, projection FROM sources WHERE id = ?").get(id) as
      { group_segment: string; user_segment: string; identity: string; projection: number } | null;
    if (prior && (prior.group_segment !== source.group || prior.user_segment !== source.user || prior.identity !== identity || prior.projection !== SETTLED_PROJECTION)) {
      throw new Error("最终用量的归属或格式不符，请保留账本并检查");
    }
    db.query(`INSERT INTO sources (id, group_segment, user_segment, identity, offset, digest,
        bad_lines, pending, provider, model, seen_at, archived_at, projection)
      VALUES (?, ?, ?, ?, 1, '', 0, 0, 'unknown', 'unknown', ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET offset = offset + 1, seen_at = excluded.seen_at`)
      .run(id, source.group, source.user, identity, Date.now(), SETTLED_PROJECTION);
    apply(db, id, fold(records, { provider: "unknown", model: "unknown" }));
  }).immediate();
}

/**
 * 持久会话的增量入账：`records` 是条目号 `from` 之后、到 `to` 为止的记录，按条目顺序。
 * 游标、跨行模型状态和聚合行在同一个事务里落盘；账本里的游标不等于 `from`（别处刚入过账）时
 * 不写，返回 false，调用方重读后再来。`replace` 的那一类用量整类重算（压缩用量来自请求门的开始记录，
 * 不随条目增长），先删后写，重复入账不会翻倍。当前会话从条目零开始。
 */
export function ingestConversationRecords(db: Database, source: ConversationSource, from: number, to: number,
  records: StatsRecord[], replace?: { kind: string; records: StatsRecord[] } | { kind: string; records: StatsRecord[] }[],
  floor = 0, expectedDigest?: string): boolean {
  return db.transaction(() => {
    const prior = db.query("SELECT * FROM sources WHERE id = ?").get(source.id) as SourceRow | null;
    if (prior && prior.projection !== DURABLE_PROJECTION) throw new Error("当前会话的统计投影格式不匹配；保留历史账本并检查数据库代际");
    if ((prior?.offset ?? floor) !== from) return false;
    if (expectedDigest !== undefined && (prior?.digest ?? "") !== expectedDigest) return false;
    const state = { provider: prior?.provider ?? "unknown", model: prior?.model ?? "unknown" };
    const folded = fold(records, state);
    const now = Date.now();
    db.query(`INSERT INTO sources (id, group_segment, user_segment, identity, offset, digest,
        bad_lines, pending, provider, model, seen_at, archived_at, projection)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET offset = excluded.offset, provider = excluded.provider, model = excluded.model,
        digest = excluded.digest, projection = excluded.projection, seen_at = excluded.seen_at`)
      .run(source.id, source.group, source.user, source.identity, to, source.digest ?? "", state.provider, state.model, now, DURABLE_PROJECTION);
    apply(db, source.id, folded);
    for (const replacement of replace ? Array.isArray(replace) ? replace : [replace] : []) {
      db.query("DELETE FROM usage_totals WHERE source = ? AND kind = ?").run(source.id, replacement.kind);
      apply(db, source.id, fold(replacement.records, { provider: "unknown", model: "unknown" }));
    }
    return true;
  }).immediate();
}

export interface ActivityRow { group: string; user: string; day: string; asks: number; replies: number; firstAt: number; lastAt: number }
export interface ToolRow { group: string; user: string; day: string; kind: string; tool: string; count: number }
export interface UsageRow {
  group: string; user: string; day: string; kind: string; provider: string; model: string;
  requests: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  missingUsage: number; unknownCost: number; cost: number; firstAt: number; lastAt: number;
}
export interface LedgerRows {
  activity: ActivityRow[];
  tools: ToolRow[];
  usage: UsageRow[];
  /** 每群解析失败或尾部未写完的行数，与统计区间无关。 */
  skipped: Map<string, number>;
  /** 账本里记过的群，即使群目录已被删除也在内。 */
  groups: string[];
  /** 每群区间内有账目、但按旧口径（投影 1，没有子调用和工具自身用量）原样保留的世代数。 */
  legacy: Map<string, number>;
}

/** 统计区间按自然日裁剪：账本是日粒度的，比一天更细的边界会被扩到整天。 */
export interface DayWindow { since?: string; until?: string }

export function dayWindow(window: { since?: number; until?: number }): DayWindow {
  return {
    ...(window.since === undefined ? {} : { since: dayKey(window.since) }),
    ...(window.until === undefined ? {} : { until: dayKey(window.until) }),
  };
}

/** 读出区间内的原始行；排序固定，折算结果与平台和写入次序无关。 */
export function readLedger(db: Database, window: DayWindow = {}, group?: string): LedgerRows {
  const filters: string[] = [], args: string[] = [];
  if (group !== undefined) { filters.push("s.group_segment = ?"); args.push(group); }
  if (window.since !== undefined) { filters.push("r.day >= ?"); args.push(window.since); }
  if (window.until !== undefined) { filters.push("r.day <= ?"); args.push(window.until); }
  const clause = filters.length ? " WHERE " + filters.join(" AND ") : "";
  const rows = (sql: string) => db.query(sql).all(...args);
  const activity = rows(
    `SELECT s.group_segment AS "group", s.user_segment AS user, r.day, r.asks, r.replies,
            r.first_at AS firstAt, r.last_at AS lastAt
     FROM activity r JOIN sources s ON s.id = r.source${clause}
     ORDER BY s.group_segment, s.user_segment, r.day, s.id`) as ActivityRow[];
  const tools = rows(
    `SELECT s.group_segment AS "group", s.user_segment AS user, r.day, r.kind, r.tool, r.count
     FROM tool_counts r JOIN sources s ON s.id = r.source${clause}
     ORDER BY s.group_segment, s.user_segment, r.day, r.kind, r.tool, s.id`) as ToolRow[];
  const usage = rows(
    `SELECT s.group_segment AS "group", s.user_segment AS user, r.day, r.kind, r.provider, r.model,
            r.requests, r.input, r.output, r.cache_read AS cacheRead, r.cache_write AS cacheWrite,
            r.missing_usage AS missingUsage, r.unknown_cost AS unknownCost, r.cost,
            r.first_at AS firstAt, r.last_at AS lastAt
     FROM usage_totals r JOIN sources s ON s.id = r.source${clause}
     ORDER BY s.group_segment, s.user_segment, r.day, r.kind, r.provider, r.model, s.id`) as UsageRow[];
  const sourceFilter = group === undefined ? "" : " WHERE group_segment = ?";
  const sourceArgs = group === undefined ? [] : [group];
  const skipped = new Map<string, number>();
  const totals = db.query(`SELECT group_segment AS "group", SUM(bad_lines + pending) AS total FROM sources${sourceFilter}
    GROUP BY group_segment ORDER BY group_segment`).all(...sourceArgs) as { group: string; total: number }[];
  for (const row of totals) skipped.set(row.group, row.total);
  const groups = (db.query(`SELECT DISTINCT group_segment AS "group" FROM sources${sourceFilter}
    ORDER BY group_segment`).all(...sourceArgs) as { group: string }[]).map(row => row.group);
  const legacy = new Map<string, number>();
  const old = rows(
    `SELECT s.group_segment AS "group", COUNT(DISTINCT s.id) AS sources
     FROM (SELECT source, day FROM activity UNION SELECT source, day FROM usage_totals) r
     JOIN sources s ON s.id = r.source${clause ? clause + " AND" : " WHERE"} s.projection = 1
     GROUP BY s.group_segment ORDER BY s.group_segment`) as { group: string; sources: number }[];
  for (const row of old) legacy.set(row.group, row.sources);
  return { activity, tools, usage, skipped, groups, legacy };
}
