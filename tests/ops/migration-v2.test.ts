import { expect, test } from "bun:test";
import { appendFile, copyFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { migrationBudget } from "../helpers/migration-budget.ts";
import { execute, fixture } from "../helpers/migration-fixture.ts";
import { tempFixture } from "../helpers/temp.ts";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { DATA_VERSION, inspectDataVersion } from "../../src/core/data-version.ts";
import { v2 } from "../../scripts/migrations/v2.ts";
import { ingestBeforeArchive, openStatsLedger, readLedger, sweepSessionStats } from "../../src/agent/stats-ledger.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));

// v2：统计账本 schema 1 → 2。夹具先用当前代码入账，再删去新口径的行和 projection 列退回 schema 1，
// 内容与 v1 时代的账本一致（用旧代码实际建账的对照在开发记录里）。
const minute = (n: number) => new Date(Date.UTC(2026, 8, 20, 1, n)).toISOString();
function conversation(start: number): string[] {
  const quarter = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } };
  return [
    { type: "message", timestamp: minute(start), message: { role: "user", content: [{ type: "text", text: "比较两份资料" }] } },
    { type: "message", timestamp: minute(start + 1), message: { role: "assistant", provider: "zai", model: "plan",
      content: [{ type: "toolCall", id: "s", name: "codemode", arguments: {} }],
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } } },
    { type: "message", timestamp: minute(start + 2), message: { role: "toolResult", toolCallId: "s", toolName: "codemode",
      content: [{ type: "text", text: "ok" }], isError: false, usage: quarter,
      nestedCalls: { calls: [{ id: "n1", name: "document_extract", status: "ok" }, { id: "n2", name: "document_extract", status: "ok" }], complete: true } } },
    { type: "message", timestamp: minute(start + 3), message: { role: "toolResult", toolCallId: "t", toolName: "codemode",
      content: [{ type: "text", text: "Script error" }], isError: true, usage: quarter,
      nestedCalls: { calls: [{ id: "n3", name: "document_patch", status: "unfinished" }], complete: false } } },
  ].map(line => JSON.stringify(line));
}
async function writeConversation(groups: string, group: string, user: string, lines: string[], tail = ""): Promise<string> {
  const path = join(groups, group, "users", user, "session.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [JSON.stringify({ type: "session", version: 3, id: `gen-${user}` }), ...lines].join("\n") + "\n" + tail);
  return path;
}
type Row = Record<string, unknown>;
function ledgerRows(groups: string) {
  const db = new Database(join(groups, "stats.sqlite"));
  try {
    return {
      version: (db.query("SELECT version FROM stats_schema WHERE id = 1").get() as { version: number }).version,
      sources: db.query("SELECT * FROM sources ORDER BY id").all() as Row[],
      activity: db.query("SELECT * FROM activity ORDER BY source, day").all() as Row[],
      tools: db.query("SELECT * FROM tool_counts ORDER BY source, day, kind, tool").all() as Row[],
      usage: db.query("SELECT * FROM usage_totals ORDER BY source, day, kind, provider, model").all() as Row[],
    };
  } finally { db.close(); }
}
type Rows = ReturnType<typeof ledgerRows>;
const projection1 = (rows: Rows, legacy: Set<string>): Rows => ({ ...rows,
  sources: rows.sources.map(source => legacy.has(source.id as string) ? { ...source, projection: 1 } : source),
  tools: rows.tools.filter(row => !legacy.has(row.source as string) || !["nested", "nested_incomplete"].includes(row.kind as string)),
  usage: rows.usage.filter(row => !legacy.has(row.source as string) || row.kind !== "tool") });
const schema1 = (rows: Rows): Rows => {
  const legacy = projection1(rows, new Set(rows.sources.map(source => source.id as string)));
  return { ...legacy, version: 1, sources: legacy.sources.map(({ projection: _, ...source }) => source) };
};
const accountsOf = (rows: Rows, id: string, cursorOnly = false) => {
  const source = rows.sources.find(row => row.id === id)!;
  return { source: cursorOnly ? { offset: source.offset, digest: source.digest, bad_lines: source.bad_lines, pending: source.pending,
    provider: source.provider, model: source.model, projection: source.projection } : source,
    activity: rows.activity.filter(row => row.source === id), tools: rows.tools.filter(row => row.source === id),
    usage: rows.usage.filter(row => row.source === id) };
};

/** v1 已提交的部署：四个世代——原件在且核对一致、已归档、原地改写、入账后又追加。 */
async function legacyLedger() {
  const f = await fixture(), c = f.context;
  try {
    const marker = { dataVersion: 1, transaction: "v1-fixture" };
    await publishJson(join(f.root, "data/config/runtime.json"), { PI_CACHE_RETENTION: "short", GROUP_DATA_ROOT: c.groups });
    await publishJson(join(f.root, "data/state/data-version.json"), marker);
    await publishJson(join(c.groups, "data-version.json"), marker);
    // 坏行与未写完的尾行：游标、坏行数和尾部标记迁移后都不变。
    await writeConversation(c.groups, "g", "kept", [...conversation(0), "{broken"], '{"type":"message"');
    await writeConversation(c.groups, "g", "archived", conversation(10));
    const rewritten = await writeConversation(c.groups, "g", "rewritten", conversation(20));
    const appended = await writeConversation(c.groups, "h", "appended", conversation(30));
    await ingestBeforeArchive(c.groups, "g", "archived");
    expect((await sweepSessionStats(c.groups, { force: true })).failed).toBe(0);
    const current = ledgerRows(c.groups);
    await rm(join(c.groups, "g/users/archived/session.jsonl"));
    const db = new Database(join(c.groups, "stats.sqlite"));
    db.exec(`DELETE FROM tool_counts WHERE kind IN ('nested', 'nested_incomplete'); DELETE FROM usage_totals WHERE kind = 'tool';
      ALTER TABLE sources DROP COLUMN projection; UPDATE stats_schema SET version = 1`);
    db.close();
    // 原地改写同样长度：身份不变，已入账前缀的摘要对不上。
    const text = await readFile(rewritten, "utf8"), changed = Buffer.from(text.replaceAll("资料", "材料"));
    expect(changed.length).toBe(Buffer.byteLength(text));
    const handle = await open(rewritten, "r+");
    try { await handle.write(changed, 0, changed.length, 0); } finally { await handle.close(); }
    await appendFile(appended, conversation(40).join("\n") + "\n");
    return { f, c, marker, current, appended };
  } catch (error) { await f.cleanup(); throw error; }
}

test("v2 只给原件仍在且核对一致的会话补记新口径；中途改动整体放弃，续做与重复执行不重复计数", async () => {
  const { f, c, current, appended } = await legacyLedger();
  try {
    const before = ledgerRows(c.groups);
    expect(before).toEqual(schema1(current));
    const plan = (await preview(c)).plan!;
    expect(plan.kind).toBe("migration");
    // v2 两步，再是 v3、v4、v5 各两步（tests/ops/migration-v3.test.ts 等）。
    expect(plan.steps).toHaveLength(8); expect(plan.steps[0]).toContain("统计账本升到 schema 2");
    expect(plan.files).toContain(join(c.groups, "stats.sqlite"));
    // 核对原件之后、写入之前账本被改动：整个账本事务放弃，schema 1 原样保留。
    const reports: string[] = [];
    const tampered = { ...c, report: (stage: string, detail: string) => {
      reports.push(`${stage}: ${detail}`);
      if (stage !== "statistics") return;
      const db = new Database(join(c.groups, "stats.sqlite"));
      try { db.query("UPDATE sources SET digest = 'tampered' WHERE id = 'gen-kept'").run(); } finally { db.close(); }
    } };
    await expect(apply(tampered, plan)).rejects.toThrow("统计账本在迁移期间被改动");
    expect(reports).toContain("statistics: sources=4; verified=2; kept-as-projection-1=2");
    expect(ledgerRows(c.groups)).toEqual({ ...before, sources: before.sources.map(row => row.id === "gen-kept" ? { ...row, digest: "tampered" } : row) });
    const repair = new Database(join(c.groups, "stats.sqlite"));
    try { repair.query("UPDATE sources SET digest = ? WHERE id = 'gen-kept'").run(before.sources.find(row => row.id === "gen-kept")!.digest as string); }
    finally { repair.close(); }
    expect(ledgerRows(c.groups)).toEqual(before);
    // 账本事务已提交、校验之前中断：续做时 v2 看到 schema 2 直接跳过，不补记第二遍。
    const expected = projection1(current, new Set(["gen-archived", "gen-rewritten"]));
    const validate = v2.validate;
    v2.validate = async () => { throw new Error("fixture interruption"); };
    try { await expect(apply(c)).rejects.toThrow("fixture interruption"); } finally { v2.validate = validate; }
    expect((await json(join(f.root, "data/state/migration.json")))?.phase).toBe("applying");
    expect(ledgerRows(c.groups)).toEqual(expected);
    await apply(c);
    expect(ledgerRows(c.groups)).toEqual(expected);
    await commit(c);
    expect(inspectDataVersion(c.project, c.groups).current).toBe(true);
    await v2.apply(c); await v2.validate(c);
    expect(ledgerRows(c.groups)).toEqual(expected);

    // 服务照常续读：核对过的世代只读新增部分，被改写的整份重算，已归档的保持旧口径。
    expect((await sweepSessionStats(c.groups, { force: true })).failed).toBe(0);
    const after = ledgerRows(c.groups);
    expect(accountsOf(after, "gen-kept")).toEqual(accountsOf(expected, "gen-kept"));
    expect(accountsOf(after, "gen-archived")).toEqual(accountsOf(expected, "gen-archived"));
    expect(after.sources.find(row => row.id === "gen-archived")?.archived_at).toBeNumber();
    expect(after.sources.find(row => row.id === "gen-rewritten")?.projection).toBe(2);
    const fresh = await tempFixture("migrations-fresh-");
    try {
      await mkdir(join(fresh.root, "h/users/appended"), { recursive: true });
      await copyFile(appended, join(fresh.root, "h/users/appended/session.jsonl"));
      expect((await sweepSessionStats(fresh.root, { force: true })).failed).toBe(0);
      expect(accountsOf(after, "gen-appended", true)).toEqual(accountsOf(ledgerRows(fresh.root), "gen-appended", true));
    } finally { await fresh.cleanup(); }
    const db = openStatsLedger(c.groups);
    try { expect(readLedger(db).legacy).toEqual(new Map([["g", 1]])); } finally { db.close(); }
  } finally { await f.cleanup(); }
}, migrationBudget(5));

test("v2 提交前回滚逐字节恢复 schema 1 账本，提交后旧代码拒绝启动", async () => {
  const { f, c, marker } = await legacyLedger();
  try {
    const ledger = join(c.groups, "stats.sqlite"), original = await readFile(ledger);
    expect(await Bun.file(ledger + "-wal").exists()).toBe(false);
    await apply(c, (await preview(c)).plan!);
    expect(ledgerRows(c.groups).version).toBe(2);
    expect(await rollback(c)).toBe(true);
    expect(await readFile(ledger)).toEqual(original);
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(await Bun.file(ledger + suffix).exists()).toBe(false);
    expect(await json(join(c.groups, "data-version.json"))).toEqual(marker);
    expect(await json(join(f.root, "data/state/data-version.json"))).toEqual(marker);
    await apply(c, (await preview(c)).plan!); await commit(c);
    // 数据版本 1 的服务入口：标记已是 2，拒绝启动，不进入业务代码。
    for (const path of ["scripts/lib/operation-log.ts", "scripts/lib/redact.ts", "src/server/index.ts"]) {
      await mkdir(dirname(join(f.root, path)), { recursive: true }); await copyFile(join(project, path), join(f.root, path));
    }
    const gate = await readFile(join(project, "src/core/data-version.ts"), "utf8");
    const old = gate.replace(`export const DATA_VERSION = ${DATA_VERSION};`, `export const DATA_VERSION = ${DATA_VERSION - 1};`);
    expect(old).not.toBe(gate);
    await mkdir(join(f.root, "src/core"), { recursive: true }); await writeFile(join(f.root, "src/core/data-version.ts"), old);
    await writeFile(join(f.root, "src/server/app.ts"), 'console.log("NORMAL_ENTRY")');
    const result = await execute([join(f.root, "src/server/index.ts")], f.root, { GROUP_DATA_ROOT: c.groups });
    expect(result.code, result.text).toBe(1);
    expect(result.text).toContain("禁止降级启动"); expect(result.text).not.toContain("NORMAL_ENTRY");
  } finally { await f.cleanup(); }
}, migrationBudget(6));

test("v2 跳过服务新建的 schema 2 账本，拒绝无法识别的账本版本", async () => {
  const f = await fixture(), c = f.context;
  try {
    await writeConversation(c.groups, "g", "u", conversation(0));
    await sweepSessionStats(c.groups, { force: true });
    const rows = ledgerRows(c.groups);
    await v2.apply(c); await v2.validate(c);
    expect(ledgerRows(c.groups)).toEqual(rows);
    const db = new Database(join(c.groups, "stats.sqlite"));
    try { db.exec("UPDATE stats_schema SET version = 7"); } finally { db.close(); }
    await expect(v2.apply(c)).rejects.toThrow("统计账本版本 7 无法识别");
    await expect(v2.validate(c)).rejects.toThrow("不是 schema 2");
  } finally { await f.cleanup(); }
}, 30000);
