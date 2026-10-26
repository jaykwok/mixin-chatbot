// The stats ledger (src/agent/stats-ledger.ts, schema 3) and the one-off import of the old ledger
// (scripts/ops/stats-import.ts). Synthetic ledgers in temporary directories only.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ASK_ID_RETENTION_MS, dayKey, importRows, openExistingStatsLedger, openStatsLedger, pruneAskIds, readLedger, recordAsks, settledAsks, syncUsage, type UsageState,
} from "../../src/agent/stats-ledger.ts";
import { importDigest, importLegacyStats, previewLegacyStats, readLegacyLedger } from "../../scripts/ops/stats-import.ts";
import { tempFixture } from "../helpers/temp.ts";
import { statsOf } from "../helpers/layout.ts";

const fixture = await tempFixture("stats-ledger-");
afterAll(() => fixture.cleanup());
let counter = 0;
const fresh = () => openStatsLedger(join(fixture.root, `ledger-${++counter}`, "stats.sqlite"));
const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
const tokens = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) =>
  ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });
const state = (models: Record<string, object>, tools: Record<string, object> = {}) => ({ models, tools }) as unknown as UsageState;

describe("asks", () => {
  test("each requestId counts once, on its own day, with the day's first and last ask", () => {
    const db = fresh();
    try {
      const asks = [
        { requestId: "r1", space: "g", user: "u", at: at(6, 9) },
        { requestId: "r2", space: "g", user: "u", at: at(6, 18) },
        { requestId: "r3", space: "g", user: "u", at: at(7) },
      ];
      expect(recordAsks(db, asks)).toBe(3);
      expect(recordAsks(db, asks)).toBe(0);
      expect(recordAsks(db, [{ requestId: "r4", space: "direct", user: "v", at: at(7) }, asks[0]!])).toBe(1);
      const rows = readLedger(db);
      expect(rows.asks).toEqual([
        { group: "direct", user: "v", day: dayKey(at(7)), asks: 1, firstAt: at(7), lastAt: at(7) },
        { group: "g", user: "u", day: dayKey(at(6)), asks: 2, firstAt: at(6, 9), lastAt: at(6, 18) },
        { group: "g", user: "u", day: dayKey(at(7)), asks: 1, firstAt: at(7), lastAt: at(7) },
      ]);
      expect(rows.groups).toEqual(["direct", "g"]);
      expect(readLedger(db, { since: dayKey(at(7)) }, "g").asks.map(row => row.asks)).toEqual([1]);
    } finally { db.close(); }
  });

  test("requestIds are kept for the retention; an ask from before the horizon never counts again, even after the clock goes back", () => {
    const db = fresh();
    try {
      const day = 24 * 3600_000;
      const old = { requestId: "parked", space: "g", user: "u", at: at(1) };
      const recent = { requestId: "recent", space: "g", user: "u", at: at(20) };
      expect(recordAsks(db, [old, recent])).toBe(2);
      // Within the retention nothing goes.
      expect(pruneAskIds(db, at(1) + ASK_ID_RETENTION_MS - day)).toBe(0);
      expect(recordAsks(db, [old])).toBe(0);
      // Past it the old id goes; the parked task's record still names it, yet it is not counted twice.
      const later = at(1) + ASK_ID_RETENTION_MS + day;
      expect(pruneAskIds(db, later)).toBe(1);
      expect(db.query("SELECT request_id FROM ask_ids").all()).toEqual([{ request_id: "recent" }]);
      expect(recordAsks(db, [old, recent])).toBe(0);
      // The horizon never moves back: a pruning with an earlier clock keeps it, and the old ask stays uncounted.
      expect(pruneAskIds(db, at(1))).toBe(0);
      expect(db.query("SELECT before FROM ask_horizon").get()).toEqual({ before: later - ASK_ID_RETENTION_MS });
      expect(recordAsks(db, [old])).toBe(0);
      // New asks after the horizon count as usual.
      expect(recordAsks(db, [{ requestId: "new", space: "g", user: "u", at: later }])).toBe(1);
      expect(readLedger(db).asks.reduce((sum, row) => sum + row.asks, 0)).toBe(3);
    } finally { db.close(); }
  });

  test("an ask is settled once counted or older than the horizon; an uncounted one keeps its source", () => {
    const db = fresh();
    try {
      const day = 24 * 3600_000;
      const counted = { requestId: "counted", space: "g", user: "u", at: at(10) };
      expect(settledAsks(db, [])).toEqual(new Set());
      expect(recordAsks(db, [counted])).toBe(1);
      expect(settledAsks(db, [counted, { requestId: "uncounted", at: at(10) }])).toEqual(new Set(["counted"]));
      // Past the horizon an ask can never count, so its source may go even though its id was forgotten.
      expect(pruneAskIds(db, at(10) + ASK_ID_RETENTION_MS + day)).toBe(1);
      expect(settledAsks(db, [counted, { requestId: "stale", at: at(10) }, { requestId: "fresh", at: at(10) + ASK_ID_RETENTION_MS + day }]))
        .toEqual(new Set(["counted", "stale"]));
    } finally { db.close(); }
  });
});

describe("usage", () => {
  test("growth counts on the sync's day per model and tool; extra counters are ignored; no growth writes nothing", () => {
    const db = fresh();
    try {
      const source = { id: "gen-1:7", space: "g", user: "u" };
      const first = state({ "p/m": { ...tokens(100, 10, 50), cost: { total: 1 } } }, { image: tokens(5, 1) });
      expect(syncUsage(db, source, first, at(6))).toEqual([]);
      expect(syncUsage(db, source, first, at(7))).toEqual([]);
      expect(db.query("SELECT seen_at FROM usage_sources WHERE key = 'p/m'").get()).toEqual({ seen_at: at(6) });
      expect(syncUsage(db, source, state({ "p/m": tokens(130, 12, 50) }, { image: tokens(5, 1) }), at(7))).toEqual([]);
      const rows = readLedger(db).usage.map(({ day, bucket, key, input, output, cacheRead, totalTokens }) =>
        ({ day, bucket, key, input, output, cacheRead, totalTokens }));
      expect(rows).toEqual([
        { day: dayKey(at(6)), bucket: "models", key: "p/m", input: 100, output: 10, cacheRead: 50, totalTokens: 160 },
        { day: dayKey(at(6)), bucket: "tools", key: "image", input: 5, output: 1, cacheRead: 0, totalTokens: 6 },
        { day: dayKey(at(7)), bucket: "models", key: "p/m", input: 30, output: 2, cacheRead: 0, totalTokens: 32 },
      ]);
    } finally { db.close(); }
  });

  test("a total that went down (an older copy) becomes the baseline without counting and is reported; other sources are untouched", () => {
    const db = fresh();
    try {
      const source = { id: "gen-1:7", space: "g", user: "u" };
      syncUsage(db, source, state({ "p/m": tokens(100, 20), "p/n": tokens(10) }), at(6));
      syncUsage(db, { ...source, id: "gen-1:8", user: "v" }, state({ "p/m": tokens(40) }), at(6));
      const before = readLedger(db).usage;
      // One field down is enough: output went up, but the copy is still older than what was counted.
      expect(syncUsage(db, source, state({ "p/m": tokens(30, 25), "p/n": tokens(10) }), at(7))).toEqual(["models:p/m"]);
      expect(readLedger(db).usage).toEqual(before);
      expect(db.query("SELECT input, output FROM usage_sources WHERE source = 'gen-1:7' AND key = 'p/m'").get()).toEqual({ input: 30, output: 25 });
      // Growth from the new baseline counts as usual.
      expect(syncUsage(db, source, state({ "p/m": tokens(35, 25), "p/n": tokens(10) }), at(7))).toEqual([]);
      const day7 = readLedger(db, { since: dayKey(at(7)) }).usage;
      expect(day7.map(({ user, key, input, output }) => ({ user, key, input, output }))).toEqual([{ user: "u", key: "p/m", input: 5, output: 0 }]);
      // A new database is a new generation, hence a new source counted from zero.
      expect(syncUsage(db, { ...source, id: "gen-2:7" }, state({ "p/m": tokens(8) }), at(7))).toEqual([]);
      expect(readLedger(db, { since: dayKey(at(7)) }).usage[0]!.input).toBe(13);
    } finally { db.close(); }
  });
});

describe("ledger file", () => {
  test("a missing ledger reads as none; another schema version is refused with the import hint", async () => {
    expect(openExistingStatsLedger(join(fixture.root, "missing.sqlite"))).toBeNull();
    const dir = join(fixture.root, `old-${++counter}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "stats.sqlite");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE stats_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO stats_schema VALUES (1, 2);");
    old.close();
    expect(() => openExistingStatsLedger(path)).toThrow("导入工具");
    expect(() => openStatsLedger(path)).toThrow("统计账本版本 2");
  });
});

/** How the old ledger sits on disk: rollback journal; WAL mode as the webhook release kept it (checkpointed when it
 * stopped); WAL mode with frames never checkpointed (copied while the writer was open, as after a crash). */
type LegacyMode = "delete" | "wal" | "pending";

/** A schema-2 ledger of the webhook release: only the tables and columns the import reads, plus fields it must drop. */
async function legacyLedger(mode: LegacyMode = "delete"): Promise<string> {
  const dir = join(fixture.root, `legacy-${++counter}`);
  await mkdir(join(dir, "writer"), { recursive: true });
  const path = join(dir, "stats.sqlite");
  const db = new Database(mode === "pending" ? join(dir, "writer", "stats.sqlite") : path, { create: true });
  if (mode !== "delete") db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE stats_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO stats_schema VALUES (1, 2);
    CREATE TABLE sources (id TEXT PRIMARY KEY, group_segment TEXT NOT NULL, user_segment TEXT NOT NULL);
    CREATE TABLE activity (source TEXT NOT NULL, day TEXT NOT NULL, asks INTEGER NOT NULL, replies INTEGER NOT NULL,
      files INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL);
    CREATE TABLE usage_totals (source TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
      cost REAL NOT NULL);`);
  const source = db.query("INSERT INTO sources VALUES (?, ?, ?)");
  source.run("s1", "g", "u");
  source.run("s2", "g", "u");
  source.run("s3", "direct", "v");
  const activity = db.query("INSERT INTO activity VALUES (?, ?, ?, ?, ?, ?, ?)");
  activity.run("s1", "2026-09-01", 2, 2, 1, 100, 200);
  activity.run("s2", "2026-09-01", 1, 1, 0, 50, 150);
  activity.run("s3", "2026-09-02", 0, 3, 0, 300, 300);
  if (mode === "pending") db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0");
  const usage = db.query("INSERT INTO usage_totals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  usage.run("s1", "2026-09-01", "assistant", "p", "m", 2, 10, 5, 20, 1, 0.5);
  usage.run("s2", "2026-09-01", "compaction", "p", "m", 1, 7, 3, 0, 0, 0.1);
  usage.run("s3", "2026-09-02", "assistant", "", "", 1, 4, 0, 0, 0, 0);
  usage.run("s3", "2026-09-02", "interrupted", "q", "x", 1, 0, 0, 0, 0, 0);
  if (mode === "pending") {
    // The usage rows exist only in the -wal: copy both files before the writer's close would checkpoint them.
    copyFileSync(join(dir, "writer", "stats.sqlite"), path);
    copyFileSync(join(dir, "writer", "stats.sqlite-wal"), path + "-wal");
  }
  db.close();
  return path;
}

/** The names and contents of everything in the old ledger's directory. */
function directoryState(path: string): Record<string, string> {
  const dir = dirname(path);
  return Object.fromEntries(readdirSync(dir).filter(name => name !== "writer").sort()
    .map(name => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]));
}

describe("import of the old ledger", () => {
  test.each(["delete", "wal", "pending"] as const)(
    "asks per member day and tokens per member, day and model; everything else is dropped; the old directory is not changed (%s)",
    async mode => {
      const path = await legacyLedger(mode);
      const before = directoryState(path);
      expect(Object.keys(before)).toEqual(mode === "pending" ? ["stats.sqlite", "stats.sqlite-wal"] : ["stats.sqlite"]);
      const rows = readLegacyLedger(path);
      expect(rows.asks).toEqual([{ day: "2026-09-01", space: "g", user: "u", asks: 3, firstAt: 50, lastAt: 200 }]);
      expect(rows.usage).toEqual([
        { day: "2026-09-01", space: "g", user: "u", key: "p/m", input: 17, output: 8, cacheRead: 20, cacheWrite: 1, totalTokens: 46 },
        { day: "2026-09-02", space: "direct", user: "v", key: "unknown/unknown", input: 4, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
      ]);
      // Not even the -shm/-wal a read-only WAL connection would create beside the file.
      expect(directoryState(path)).toEqual(before);
      expect(importDigest(readLegacyLedger(path))).toBe(importDigest(rows));
      const root = join(fixture.root, `root-${++counter}`);
      expect(previewLegacyStats(path, root)).toMatchObject({ asks: 3, usageRows: 2, totalTokens: 50, status: "new" });
      expect(importLegacyStats(path, root).result).toBe("imported");
      expect(directoryState(path)).toEqual(before);
    });

  test("imported rows read together with live ones; the same ledger again adds nothing; a different one is refused", async () => {
    const path = await legacyLedger("wal");
    const root = join(fixture.root, `root-${++counter}`);
    const live = openStatsLedger(statsOf(root));
    try {
      recordAsks(live, [{ requestId: "r1", space: "g", user: "u", at: new Date(2026, 8, 1, 12).getTime() }]);
    } finally { live.close(); }
    expect(importLegacyStats(path, root).result).toBe("imported");
    expect(importLegacyStats(path, root).result).toBe("already");
    const other = await legacyLedger("wal");
    const changed = new Database(other);
    changed.exec("UPDATE activity SET asks = 5 WHERE source = 's1'");
    changed.close();
    expect(() => importLegacyStats(other, root)).toThrow("拒绝再导入");
    expect(() => importLegacyStats(statsOf(root), root)).toThrow("不能是当前数据目录");
    const db = openExistingStatsLedger(statsOf(root))!;
    try {
      const rows = readLedger(db);
      expect(rows.asks.find(row => row.group === "g" && row.day === "2026-09-01")!.asks).toBe(4);
      expect(rows.usage.map(row => row.totalTokens)).toEqual([4, 46]);
      expect(db.query("SELECT asks, usage_rows FROM imports").all()).toEqual([{ asks: 3, usage_rows: 2 }]);
    } finally { db.close(); }
  });

  test("the preview counts what an import adds and tells new, already imported and blocked apart without writing", async () => {
    const path = await legacyLedger();
    const root = join(fixture.root, `root-${++counter}`);
    const expected = { asks: 3, memberDays: 1, usageRows: 2, totalTokens: 50, firstDay: "2026-09-01", lastDay: "2026-09-02" };
    expect(previewLegacyStats(path, root)).toEqual({ ...expected, status: "new" });
    expect(existsSync(statsOf(root))).toBe(false);
    expect(importLegacyStats(path, root).result).toBe("imported");
    expect(previewLegacyStats(path, root)).toEqual({ ...expected, status: "already" });
    const other = await legacyLedger();
    const changed = new Database(other);
    changed.exec("UPDATE activity SET asks = 5 WHERE source = 's1'");
    changed.close();
    expect(previewLegacyStats(other, root).status).toBe("other");
    expect(() => previewLegacyStats(statsOf(root), root)).toThrow("不能是当前数据目录");
  });

  test("a ledger of another schema version is refused", async () => {
    const path = await legacyLedger();
    const db = new Database(path);
    db.exec("UPDATE stats_schema SET version = 3");
    db.close();
    expect(() => readLegacyLedger(path)).toThrow("只接受旧版 schema 2");
  });

  test("an import of no rows still marks the ledger as imported", () => {
    const db = fresh();
    try {
      const empty = { asks: [], usage: [] };
      expect(importRows(db, importDigest(empty), empty, 1)).toBe("imported");
      expect(() => importRows(db, "other", empty, 2)).toThrow("拒绝再导入");
    } finally { db.close(); }
  });
});
