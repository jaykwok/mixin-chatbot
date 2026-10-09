// Frozen historical transformation. Only built-ins and migrations/lib are allowed here.
//
// Statistics ledger schema 1 -> 2. Projection 2 counts what projection 1 ignored on tool results: calls a tool made
// while it ran (`nestedCalls`, kinds `nested` / `nested_incomplete`) and the tool's own usage (usage kind `tool`,
// provider/model unknown). Everything projection 1 counted keeps its meaning, so recomputing a source equals adding the
// rows of those new kinds. A source is supplemented only when its session file is still in place with the ledger's
// identity and the SHA-256 of its ingested prefix matches the cursor; otherwise its rows stay as they are, marked
// projection 1. Cursors, unread tails, bad-line counts and archive marks are never changed.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { info, ordinaryPath } from "./lib/io.ts";
import type { Context, Migration } from "./lib/types.ts";

const LEDGER = "stats.sqlite";
interface Source { id: string; group_segment: string; user_segment: string; identity: string; offset: number; digest: string }
interface Totals { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; missingUsage: number; unknownCost: number; cost: number; firstAt: number; lastAt: number }
interface Supplement { source: Source; tools: Map<string, number>; usage: Map<string, Totals> }

const hasSchema = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stats_schema'").get();
const schemaVersion = (db: Database) => (db.query("SELECT version FROM stats_schema WHERE id = 1").get() as { version: number } | null)?.version;
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Local calendar day, as the ledger buckets it. */
function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The ingested prefix of the source's session file, or null when it cannot be verified in place. */
async function verifiedPrefix(groups: string, source: Source): Promise<Buffer | null> {
  const path = join(groups, source.group_segment, "users", source.user_segment, "session.jsonl");
  try { await ordinaryPath(groups, path); } catch { return null; }
  const observed = await info(path);
  if (!observed?.isFile() || observed.isSymbolicLink()) return null;
  const handle = await open(path, "r");
  try {
    const held = await handle.stat();
    const identity = `${held.dev}:${held.ino}:${held.birthtimeMs}`;
    if (identity !== source.identity || identity !== `${observed.dev}:${observed.ino}:${observed.birthtimeMs}`) return null;
    if (!Number.isSafeInteger(source.offset) || source.offset < 0 || held.size < source.offset) return null;
    const prefix = Buffer.alloc(source.offset);
    for (let filled = 0; filled < prefix.length;) {
      const { bytesRead } = await handle.read(prefix, filled, prefix.length - filled, filled);
      if (!bytesRead) return null;
      filled += bytesRead;
    }
    return createHash("sha256").update(prefix).digest("hex") === source.digest ? prefix : null;
  } finally { await handle.close(); }
}

/** Rows of the new kinds for the tool results in an ingested prefix. */
function supplement(source: Source, prefix: Buffer): Supplement {
  const tools = new Map<string, number>(), usage = new Map<string, Totals>();
  const countTool = (day: string, kind: string, name: string) => {
    const key = JSON.stringify([day, kind, name]);
    tools.set(key, (tools.get(key) ?? 0) + 1);
  };
  for (const line of prefix.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let raw: any;
    try { raw = JSON.parse(line); } catch { continue; }
    if (!raw || typeof raw !== "object" || raw.type !== "message") continue;
    const message = raw.message;
    if (!message || message.role !== "toolResult") continue;
    const at = Date.parse(raw.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    const day = dayKey(at);
    if (message.usage && typeof message.usage === "object") {
      const key = JSON.stringify([day, "tool", "unknown", "unknown"]);
      const total = usage.get(key) ?? { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, missingUsage: 0, unknownCost: 0, cost: 0,
        firstAt: Number.POSITIVE_INFINITY, lastAt: Number.NEGATIVE_INFINITY };
      const recorded = message.usage;
      total.requests++;
      if (!valid(recorded.input) || !valid(recorded.output) || !valid(recorded.cacheRead) || !valid(recorded.cacheWrite)) total.missingUsage++;
      for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) if (valid(recorded[field])) total[field] += recorded[field];
      if (recorded.cost && valid(recorded.cost.total)) total.cost += recorded.cost.total;
      else total.unknownCost++;
      total.firstAt = Math.min(total.firstAt, at);
      total.lastAt = Math.max(total.lastAt, at);
      usage.set(key, total);
    }
    const nested = message.nestedCalls;
    if (nested && typeof nested === "object" && Array.isArray(nested.calls)) {
      for (const call of nested.calls) countTool(day, "nested", typeof call?.name === "string" ? call.name : "unknown");
      if (nested.complete !== true) countTool(day, "nested_incomplete", message.toolName || "unknown");
    }
  }
  return { source, tools, usage };
}

function openLedger(path: string, readonly: boolean): Database {
  const db = new Database(path, readonly ? { readonly: true, strict: true } : { strict: true });
  db.exec("PRAGMA busy_timeout = 3000");
  return db;
}

async function migrateLedger(context: Context): Promise<void> {
  const path = join(context.groups, LEDGER);
  await ordinaryPath(context.groups, path);
  const present = await info(path);
  if (!present) return;
  if (!present.isFile()) throw new Error("统计账本不是普通文件");
  const db = openLedger(path, false);
  try {
    // A file the service created but never got to initialise holds no accounts; the service creates schema 2 itself.
    if (!hasSchema(db)) return;
    const version = schemaVersion(db);
    if (version === 2) return;
    if (version !== 1) throw new Error(`统计账本版本 ${version ?? "未知"} 无法识别，拒绝迁移`);
    const sources = db.query("SELECT id, group_segment, user_segment, identity, offset, digest FROM sources ORDER BY id").all() as Source[];
    const supplements: Supplement[] = [];
    for (const source of sources) {
      const prefix = await verifiedPrefix(context.groups, source);
      if (prefix) supplements.push(supplement(source, prefix));
    }
    context.report?.("statistics", `sources=${sources.length}; verified=${supplements.length}; kept-as-projection-1=${sources.length - supplements.length}`);
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
    db.transaction(() => {
      if (schemaVersion(db) !== 1) throw new Error("统计账本在迁移期间被改动");
      db.exec("ALTER TABLE sources ADD COLUMN projection INTEGER NOT NULL DEFAULT 1");
      for (const { source, tools, usage: totals } of supplements) {
        // The service is stopped; a cursor that moved anyway means the verified prefix is no longer what was ingested.
        const current = db.query("SELECT identity, offset, digest FROM sources WHERE id = ?").get(source.id) as Pick<Source, "identity" | "offset" | "digest"> | null;
        if (!current || current.identity !== source.identity || current.offset !== source.offset || current.digest !== source.digest) throw new Error("统计账本在迁移期间被改动");
        for (const [key, count] of [...tools].sort(([a], [b]) => byKey(a, b))) {
          const [day, kind, name] = JSON.parse(key) as [string, string, string];
          tool.run(source.id, day, kind, name, count);
        }
        for (const [key, total] of [...totals].sort(([a], [b]) => byKey(a, b))) {
          const [day, kind, provider, model] = JSON.parse(key) as [string, string, string, string];
          usage.run(source.id, day, kind, provider, model, total.requests, total.input, total.output, total.cacheRead, total.cacheWrite,
            total.missingUsage, total.unknownCost, total.cost, total.firstAt, total.lastAt);
        }
        db.query("UPDATE sources SET projection = 2 WHERE id = ?").run(source.id);
      }
      db.query("UPDATE stats_schema SET version = 2 WHERE id = 1").run();
    }).immediate();
  } finally { db.close(); }
}

export const v2: Migration = {
  to: 2,
  async preview() {
    return { files: [{ root: "groups", path: LEDGER }], decisions: [],
      steps: ["统计账本升到 schema 2：原件仍在且已入账部分核对一致的会话，补记脚本子调用和工具自身用量；无法核对的保留原账，标为旧口径",
        "完整校验配置与账本，登记项目和群根版本 2"] };
  },
  async apply(context) { await migrateLedger(context); },
  async validate(context) {
    const path = join(context.groups, LEDGER);
    await ordinaryPath(context.groups, path);
    if (!await info(path)) return;
    const db = openLedger(path, true);
    try {
      if (!hasSchema(db)) return;
      if (schemaVersion(db) !== 2) throw new Error("v2 迁移校验失败：统计账本不是 schema 2");
      const invalid = db.query("SELECT COUNT(*) AS count FROM sources WHERE projection NOT IN (1, 2)").get() as { count: number };
      if (invalid.count) throw new Error("v2 迁移校验失败：统计账本含无法识别的口径标记");
    } finally { db.close(); }
  },
};
