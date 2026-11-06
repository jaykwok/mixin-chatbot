// The stats ledger (src/agent/stats-ledger.ts, schema 3) and the one-off import of the old ledger
// (ops/tools/stats-import.ts). Synthetic ledgers in temporary directories only.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ASK_ID_RETENTION_MS, dayKey, importRows, openExistingStatsLedger, openStatsLedger, pruneAskIds, readLedger, recordAsks, settledAsks, syncUsage, type UsageState,
} from "../../src/agent/stats-ledger.ts";
import { importDigest, importStats, previewStatsImport, readImport } from "../../ops/tools/stats-import-core.ts";
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
  test("member filtering applies to asks, model/tool usage and known groups together with dates and space", () => {
    const db = fresh(), user = "u' OR 1=1 --";
    try {
      const asks = [
        { requestId: "old", space: "g", user, at: at(6) },
        { requestId: "selected", space: "g", user, at: at(7) },
        { requestId: "other-space", space: "direct", user, at: at(7) },
        { requestId: "other-user", space: "g", user: "v", at: at(7) },
        { requestId: "other-user-space", space: "v-only", user: "v", at: at(7) },
      ];
      recordAsks(db, asks);
      for (const ask of asks) syncUsage(db, { id: ask.requestId, space: ask.space, user: ask.user },
        state({ "p/m": tokens(10, 1) }, { image: tokens(2, 1) }), ask.at);
      syncUsage(db, { id: "only-usage", space: "usage-only", user }, state({ "p/m": tokens(5) }), at(6));
      const selected = readLedger(db, { since: dayKey(at(7)), until: dayKey(at(7)) }, "g", user);
      expect(selected.asks).toEqual([{ group: "g", user, day: dayKey(at(7)), asks: 1, firstAt: at(7), lastAt: at(7) }]);
      expect(selected.usage.map(({ user, bucket, totalTokens }) => ({ user, bucket, totalTokens }))).toEqual([
        { user, bucket: "models", totalTokens: 11 }, { user, bucket: "tools", totalTokens: 3 },
      ]);
      expect(selected.groups).toEqual(["g"]);
      const allSpaces = readLedger(db, { since: dayKey(at(7)) }, undefined, user);
      expect(allSpaces.groups).toEqual(["direct", "g", "usage-only"]);
      expect(allSpaces.asks.map(row => row.group)).toEqual(["direct", "g"]);
      expect(allSpaces.usage.every(row => row.user === user)).toBe(true);
      expect(readLedger(db, {}, undefined, "absent")).toEqual({ asks: [], usage: [], groups: [] });
      expect(readLedger(db).asks.reduce((n, row) => n + row.asks, 0)).toBe(5);
    } finally { db.close(); }
  });

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
      const old = { requestId: "old", space: "g", user: "u", at: at(1) };
      const recent = { requestId: "recent", space: "g", user: "u", at: at(20) };
      expect(recordAsks(db, [old, recent])).toBe(2);
      // Within the retention nothing goes.
      expect(pruneAskIds(db, at(1) + ASK_ID_RETENTION_MS - day)).toBe(0);
      expect(recordAsks(db, [old])).toBe(0);
      // Past it the old id goes; a record that still names it does not count it twice.
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
  test("a missing ledger reads as none; another schema version is refused", async () => {
    expect(openExistingStatsLedger(join(fixture.root, "missing.sqlite"))).toBeNull();
    const dir = join(fixture.root, `old-${++counter}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "stats.sqlite");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE stats_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO stats_schema VALUES (1, 2);");
    old.close();
    expect(() => openExistingStatsLedger(path)).toThrow("请保留 stats.sqlite");
    expect(() => openStatsLedger(path)).toThrow("统计账本版本 2");
  });
});

/** How the saved ledger sits on disk: rollback journal; WAL mode, checkpointed; WAL mode with frames never checkpointed
 * (copied while the writer was open, as after a crash). */
type SavedMode = "delete" | "wal" | "pending";

const DAY = new Date(2026, 8, 1, 12).getTime(), DAY_KEY = "2026-09-01";

/** A ledger of this format with three asks of one member and model and tool usage. */
async function savedLedger(mode: SavedMode = "delete", asks = 3): Promise<string> {
  const dir = join(fixture.root, `saved-${++counter}`);
  await mkdir(join(dir, "writer"), { recursive: true });
  const path = join(dir, "stats.sqlite");
  const db = openStatsLedger(mode === "pending" ? join(dir, "writer", "stats.sqlite") : path);
  db.exec(`PRAGMA journal_mode = ${mode === "delete" ? "DELETE" : "WAL"}`);
  recordAsks(db, Array.from({ length: asks }, (_, index) => ({ requestId: `r${index}`, space: "g", user: "u", at: DAY + index })));
  if (mode === "pending") db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint = 0");
  const usage = db.query(`INSERT INTO usage_daily (day, space, user, bucket, key, origin, input, output, cache_read, cache_write, total_tokens)
    VALUES (?, 'g', 'u', ?, ?, 'live', ?, ?, ?, ?, ?)`);
  usage.run(DAY_KEY, "models", "p/m", 17, 8, 20, 1, 46);
  usage.run(DAY_KEY, "tools", "probe", 4, 0, 0, 0, 4);
  if (mode === "pending") {
    // The usage rows exist only in the -wal: copy both files before the writer's close would checkpoint them.
    copyFileSync(join(dir, "writer", "stats.sqlite"), path);
    copyFileSync(join(dir, "writer", "stats.sqlite-wal"), path + "-wal");
  }
  db.close();
  return path;
}

/** The names and contents of everything in the saved ledger's directory. */
function directoryState(path: string): Record<string, string> {
  const dir = dirname(path);
  return Object.fromEntries(readdirSync(dir).filter(name => name !== "writer").sort()
    .map(name => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]));
}

describe("restore of a saved ledger", () => {
  test.each(["delete", "wal", "pending"] as const)(
    "asks and model and tool tokens are read from a snapshot; the saved directory is not changed (%s)",
    async mode => {
      const path = await savedLedger(mode);
      const before = directoryState(path);
      if (mode === "pending") expect(Object.keys(before)).toEqual(["stats.sqlite", "stats.sqlite-wal"]);
      const rows = readImport(path);
      expect(rows.asks).toEqual([{ day: DAY_KEY, space: "g", user: "u", asks: 3, firstAt: DAY, lastAt: DAY + 2 }]);
      expect(rows.usage.map(({ bucket, key, totalTokens }) => [bucket, key, totalTokens]).sort()).toEqual([["models", "p/m", 46], ["tools", "probe", 4]]);
      // Not even the -shm/-wal a read-only WAL connection would create beside the file.
      expect(directoryState(path)).toEqual(before);
      expect(importDigest(readImport(path))).toBe(importDigest(rows));
      const root = join(fixture.root, `root-${++counter}`);
      expect(previewStatsImport(path, root)).toMatchObject({ asks: 3, usageRows: 2, totalTokens: 50, status: "new" });
      expect(importStats(path, root).result).toBe("imported");
      expect(directoryState(path)).toEqual(before);
    });

  test("restored rows read back; the same ledger again adds nothing; a different one and a ledger with data are refused", async () => {
    const path = await savedLedger("wal");
    const root = join(fixture.root, `root-${++counter}`);
    expect(importStats(path, root).result).toBe("imported");
    expect(importStats(path, root).result).toBe("already");
    const other = await savedLedger("wal", 5);
    expect(() => importStats(other, root)).toThrow("拒绝再导入");
    expect(() => importStats(statsOf(root), root)).toThrow("不能是当前数据目录");
    const db = openExistingStatsLedger(statsOf(root))!;
    try {
      const rows = readLedger(db);
      expect(rows.asks.find(row => row.group === "g" && row.day === DAY_KEY)!.asks).toBe(3);
      expect(rows.usage.map(row => row.totalTokens).sort()).toEqual([4, 46]);
      expect(db.query("SELECT asks, usage_rows FROM imports").all()).toEqual([{ asks: 3, usage_rows: 2 }]);
    } finally { db.close(); }
    const occupied = join(fixture.root, `root-${++counter}`), live = openStatsLedger(statsOf(occupied));
    try { recordAsks(live, [{ requestId: "live", space: "g", user: "u", at: DAY }]); } finally { live.close(); }
    expect(() => importStats(path, occupied)).toThrow("空账本");
  });

  test("the preview counts what an import adds and tells new, already imported and blocked apart without writing", async () => {
    const path = await savedLedger();
    const root = join(fixture.root, `root-${++counter}`);
    const expected = { asks: 3, memberDays: 1, usageRows: 2, totalTokens: 50, firstDay: DAY_KEY, lastDay: DAY_KEY };
    expect(previewStatsImport(path, root)).toEqual({ ...expected, status: "new" });
    expect(existsSync(statsOf(root))).toBe(false);
    expect(importStats(path, root).result).toBe("imported");
    expect(previewStatsImport(path, root)).toEqual({ ...expected, status: "already" });
    expect(previewStatsImport(await savedLedger("delete", 5), root).status).toBe("other");
    expect(() => previewStatsImport(statsOf(root), root)).toThrow("不能是当前数据目录");
  });

  test("a ledger of another schema version is refused", async () => {
    const path = await savedLedger();
    const db = new Database(path);
    db.exec("UPDATE stats_schema SET version = 2");
    db.close();
    expect(() => readImport(path)).toThrow("只接受 schema 3");
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
