// 使用统计账本：唯一的统计来源，与会话文件的存亡无关。
//
// 会话历史随时可能被 /clear 或 history clear 归档，统计不能再从 session.jsonl 现算。
// 入账按「世代 + 自然日」聚合：一份会话文件的每一次新建算一个世代（source），同一世代
// 整份重读时先清行再写，所以补跑、重跑、被改写后重读都不会把数字算两遍。
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dataDirectoryNames } from "../../scripts/lib/group-data.ts";
import { countUsageRecord, emptyUsage, type UsageTotals } from "../../scripts/lib/usage.ts";
import { readSessionSlice, SessionFileChangedError, type SessionSlice, type StatsRecord } from "./session-reader.ts";
import { SESSION_FILE } from "./paths.ts";

const SCHEMA_VERSION = 1;

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
  // 原始会话可能已归档或删除；账本必须保留，由离线工具转换未知版本。
  if (version !== SCHEMA_VERSION) {
    throw new Error(`统计账本版本 ${version ?? "未知"} 与当前 ${SCHEMA_VERSION} 不一致；请停机备份并使用对应离线迁移工具，勿删除 stats.sqlite`);
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
        seen_at INTEGER NOT NULL, archived_at INTEGER)`);
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
  pending: number; provider: string; model: string;
}

interface Bucket { asks: number; replies: number; firstAt: number; lastAt: number }
type UsageBucket = UsageTotals & { firstAt: number; lastAt: number };

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 把新增记录折成日粒度的桶。
 *
 * provider/model 是跨行状态：`model_change` 和带模型信息的回复会决定后续记录的归属，
 * 所以增量入账必须把它随游标一起存回账本，否则续读的那一段会被算到 unknown 上。
 */
function fold(records: StatsRecord[], state: { provider: string; model: string }) {
  const activity = new Map<string, Bucket>();
  const tools = new Map<string, number>();
  const usage = new Map<string, UsageBucket>();
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
    if (record.type === "model_change") {
      state.provider = record.provider ?? "unknown";
      state.model = record.modelId ?? "unknown";
      continue;
    }
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
    if (record.type === "compaction" || record.type === "branch_summary") {
      countUsage(day, record.type, at, record.usage);
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
        if (part?.type !== "toolCall" || !part.name) continue;
        const key = JSON.stringify([day, "call", part.name]);
        tools.set(key, (tools.get(key) ?? 0) + 1);
      }
    } else if (role === "toolResult") {
      const message = record.message;
      if (!message.isError && message.details?.fileId && ["send_file", "send_image"].includes(message.toolName ?? "")) {
        const key = JSON.stringify([day, "delivered", message.toolName!]);
        tools.set(key, (tools.get(key) ?? 0) + 1);
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

export interface IngestResult {
  /** 这一世代在账本里的主键。 */
  source: string;
  records: number;
  /** 整份重读过：本世代的旧行已被替换。 */
  reset: boolean;
}

/**
 * 把一份会话文件的新增部分入账；文件不存在时返回 null，已归档世代的账目保持不动。
 * 游标、跨行状态和聚合行在同一个事务里落盘，中途失败下次重来即可。
 */
export function ingestSessionFile(db: Database, root: string, group: string, user: string): Promise<IngestResult | null> {
  return ingestSessionPath(db, join(resolve(root), group, "users", user, SESSION_FILE), group, user);
}

/**
 * 按显式路径入账，归属到指定的群/成员目录段。
 * 回收区里的归档会话只能这样补账：文件名不带群和成员信息。
 *
 * 每日扫描可能与任务结束或 `/clear` 同时入账同一份文件。读文件前记下这份文件在账本里的
 * 那一行，提交时它必须原样未动（首次入账则仍不存在）；别的连接在此期间入账、整份重建或
 * 标记归档，这一轮就作废重读。否则追加的那段会被累加两次，或者较旧的整份重读把新账、
 * 游标和归档标记覆盖回去——文件已归档时再也补不回来。
 */
export async function ingestSessionPath(db: Database, path: string, group: string, user: string): Promise<IngestResult | null> {
  for (let attempt = 1; ; attempt++) {
    const result = await ingestOnce(db, path, group, user);
    if (result !== "conflict") return result;
    if (attempt >= 3) throw new Error("统计入账冲突：同一会话正被反复入账，稍后由下次入账补上");
  }
}

async function ingestOnce(db: Database, path: string, group: string, user: string): Promise<IngestResult | null | "conflict"> {
  let identity: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // 整行取出：提交前按同一个键再取一次比对，任何列变了都说明别人动过。
  const located = () => db.query(`SELECT * FROM sources WHERE group_segment = ? AND user_segment = ? AND identity = ?`)
    .get(group, user, identity) as SourceRow | null;
  const prior = located();
  let slice: SessionSlice;
  try {
    slice = await readSessionSlice(path, prior ? { identity: prior.identity, offset: prior.offset, digest: prior.digest } : undefined);
  } catch (error) {
    if (error instanceof SessionFileChangedError) return "conflict";
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // 以实际读取句柄的身份为准；文件在打开前被换代时重新定位账本，不能套用旧世代游标。
  if (slice.cursor.identity !== identity) return "conflict";
  const continued = !slice.reset && prior !== null;
  // /clear 标记归档之后、移走文件之前仍可能被扫描。没有新增字节或尾行变化就不写库，
  // 保留原来的归档状态；返回 source 让归档调用方仍可标记已经入账过的会话。
  if (continued && slice.cursor.offset === prior.offset && slice.cursor.digest === prior.digest
    && Number(slice.pending) === prior.pending) return { source: prior.id, records: 0, reset: false };
  const id = prior?.id ?? slice.sessionId ?? `file:${group}/${user}:${identity}`;
  const state = { provider: continued ? prior!.provider : "unknown", model: continued ? prior!.model : "unknown" };
  const folded = fold(slice.records, state);
  const now = Date.now();
  // immediate：先拿写锁再核对，跨进程时也不会基于过期快照提交。续读、首次入账和整份重建都要核对。
  const committed = db.transaction(() => {
    if (JSON.stringify(located()) !== JSON.stringify(prior)) return false;
    if (continued) {
      // 普通入账不撤销归档标记；离线重算同一世代时也一样。
      db.query(`UPDATE sources SET offset = ?, digest = ?, bad_lines = bad_lines + ?, pending = ?,
        provider = ?, model = ?, seen_at = ? WHERE id = ?`)
        .run(slice.cursor.offset, slice.cursor.digest, slice.badLines, slice.pending ? 1 : 0,
          state.provider, state.model, now, id);
    } else {
      // 整份重读：先清掉这一世代的旧行，再按新内容写一遍，重复入账不会翻倍。
      for (const table of ["activity", "tool_counts", "usage_totals"]) {
        db.query(`DELETE FROM ${table} WHERE source = ?`).run(id);
      }
      db.query(`INSERT INTO sources (id, group_segment, user_segment, identity, offset, digest,
          bad_lines, pending, provider, model, seen_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET group_segment = excluded.group_segment, user_segment = excluded.user_segment,
          identity = excluded.identity, offset = excluded.offset, digest = excluded.digest,
          bad_lines = excluded.bad_lines, pending = excluded.pending, provider = excluded.provider,
          model = excluded.model, seen_at = excluded.seen_at`)
        .run(id, group, user, slice.cursor.identity, slice.cursor.offset, slice.cursor.digest,
          slice.badLines, slice.pending ? 1 : 0, state.provider, state.model, now);
    }
    apply(db, id, folded);
    return true;
  }).immediate();
  if (!committed) return "conflict";
  return { source: id, records: slice.records.length, reset: slice.reset };
}

/** 一位成员当前会话的增量入账。机器人在该成员的任务队列里调用，与 `/clear` 天然串行。 */
export async function ingestUserSession(root: string, group: string, user: string): Promise<IngestResult | null> {
  const db = openStatsLedger(root);
  try { return await ingestSessionFile(db, root, group, user); } finally { db.close(); }
}

/**
 * 归档前的最后一次入账，并记下归档时间。
 *
 * 定时扫描只是兜底：`/clear` 是群成员随时能发的指令，两次扫描之间清掉的那段历史一旦
 * 进了回收区就再也补不回来，所以归档路径必须先落账再移文件。
 */
export async function ingestBeforeArchive(root: string, group: string, user: string): Promise<void> {
  const db = openStatsLedger(root);
  try {
    const result = await ingestSessionFile(db, root, group, user);
    if (result) db.query("UPDATE sources SET archived_at = ? WHERE id = ?").run(Date.now(), result.source);
  } finally { db.close(); }
}

export interface SweepResult { files: number; records: number; failed: number; skippedFiles: number; skippedDay: boolean }

interface SweepOptions {
  force?: boolean;
  now?: number;
  onError?: (path: string, error: unknown) => void;
}

/** 重试时只比较元数据；摘要仍由真正入账时的 reader 校验。纳秒时间避免把快速改写误判为未变。 */
async function sweepFingerprint(path: string): Promise<string | null> {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) return null;
    return [info.dev, info.ino, info.birthtimeNs, info.size, info.mtimeNs, info.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 全量扫一遍并入账。默认一天只跑一次：当天的数字靠任务结束与归档前的入账，定时扫描是
 * 兜底（崩溃、手工改动、旧文件、任务之间的缓存保温用量），没必要每五分钟把所有会话文件都摸一遍。
 * 部分失败时保留当天已完成文件的指纹，重试只读失败或变化的文件；全部成功才标记当天完成。
 */
export async function sweepSessionStats(root: string, options: SweepOptions = {}): Promise<SweepResult> {
  const base = resolve(root);
  const db = openStatsLedger(base);
  try {
    const today = dayKey(options.now ?? Date.now());
    const last = (db.query("SELECT value FROM meta WHERE key = 'last_sweep_day'").get() as { value: string } | null)?.value;
    if (!options.force && last === today) return { files: 0, records: 0, failed: 0, skippedFiles: 0, skippedDay: true };
    // 使用现有 meta，不改账本 schema；逐文件保存，崩溃或重启不会丢掉这一轮的进度。
    const prefix = "sweep_file:", dayPrefix = today + ":";
    db.transaction(() => {
      if (options.force) {
        db.query("DELETE FROM meta WHERE key GLOB ?").run(prefix + "*");
        db.query("DELETE FROM meta WHERE key = 'last_sweep_day' AND value = ?").run(today);
      } else {
        db.query("DELETE FROM meta WHERE key GLOB ? AND substr(value, 1, 11) <> ?").run(prefix + "*", dayPrefix);
      }
    }).immediate();
    const completed = new Map((db.query("SELECT key, value FROM meta WHERE key GLOB ?").all(prefix + "*") as { key: string; value: string }[])
      .map(row => [row.key, row.value]));
    const checkpoint = db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    let files = 0, records = 0, failed = 0, skippedFiles = 0;
    const fail = (path: string, error: unknown) => {
      failed++;
      if (options.onError) options.onError(path, error);
      else console.warn(`统计账本扫描失败 - 路径: ${path}, 错误: ${String(error)}`);
    };
    const directories = async (path: string): Promise<string[]> => {
      try { return (await dataDirectoryNames(path, base)).sort(byKey); }
      catch (error) { fail(path, error); return []; }
    };
    for (const group of await directories(base)) {
      for (const user of await directories(join(base, group, "users"))) {
        const path = join(base, group, "users", user, SESSION_FILE);
        const key = prefix + JSON.stringify([group, user]);
        try {
          const before = await sweepFingerprint(path);
          if (before === null) continue;
          if (completed.get(key) === dayPrefix + before) { skippedFiles++; continue; }
          const result = await ingestSessionFile(db, base, group, user);
          if (result) { files++; records += result.records; }
          const after = await sweepFingerprint(path);
          // 归档移走的原件无需再读；被换代或追加则留下重试，不能把未确认内容记作完成。
          if (after === null) continue;
          if (after !== before || !result) throw new SessionFileChangedError();
          checkpoint.run(key, dayPrefix + after);
        } catch (error) { fail(path, error); }
      }
    }
    if (failed === 0) db.transaction(() => {
      checkpoint.run("last_sweep_day", today);
      db.query("DELETE FROM meta WHERE key GLOB ? AND substr(value, 1, 11) = ?").run(prefix + "*", dayPrefix);
    }).immediate();
    return { files, records, failed, skippedFiles, skippedDay: false };
  } finally { db.close(); }
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
  return { activity, tools, usage, skipped, groups };
}
