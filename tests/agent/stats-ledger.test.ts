// 账本是统计的唯一来源，所以这里钉死三件事：清空会话不丢已入账的历史、重复入账不翻倍、
// Pi 的任意用量类型都要落账。
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectGroup } from "../../scripts/ops/stats-admin.ts";
import { ingestBeforeArchive, ingestUserSession, openStatsLedger, statsLedgerPath, sweepSessionStats } from "../../src/agent/stats-ledger.ts";
import { tempFixture } from "../helpers/temp.ts";

const ask = (at: string, text = "在吗") => JSON.stringify({ type: "message", timestamp: at,
  message: { role: "user", content: [{ type: "text", text }] } });
const reply = (at: string, usage?: Record<string, unknown>) => JSON.stringify({ type: "message", timestamp: at,
  message: { role: "assistant", provider: "zai", model: "plan", content: [{ type: "toolCall", id: "x", name: "bash", arguments: {} }], usage } });

async function writeSession(root: string, group: string, user: string, lines: string[], id = "gen-1"): Promise<string> {
  const dir = join(root, group, "users", user);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  await writeFile(path, [JSON.stringify({ type: "session", version: 3, id }), ...lines].join("\n") + "\n");
  return path;
}

test("清空会话历史之后统计仍然在账本里，新会话继续累加", async () => {
  const fixture = await tempFixture("ledger-clear-");
  try {
    const path = await writeSession(fixture.root, "g", "u", [
      ask("2026-09-18T01:00:00Z"),
      reply("2026-09-18T01:00:05Z", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }),
    ]);
    // /clear 与 history clear 都走这一步：先落账，再归档文件。
    await ingestBeforeArchive(fixture.root, "g", "u");
    await rm(path);
    const afterClear = await collectGroup("g", fixture.root);
    expect(afterClear.asks).toBe(1);
    expect(afterClear.replies).toBe(1);
    expect(afterClear.tokens.input).toBe(100);
    expect(afterClear.tokens.cost).toBeCloseTo(0.25, 10);
    expect(afterClear.users[0]!.user).toBe("u");

    // 清空之后 Pi 会新建会话文件并换 id：新世代的数字叠加在老账目上。
    await writeSession(fixture.root, "g", "u", [ask("2026-09-19T01:00:00Z"), reply("2026-09-19T01:00:03Z")], "gen-2");
    await sweepSessionStats(fixture.root, { force: true });
    const afterRestart = await collectGroup("g", fixture.root);
    expect(afterRestart.asks).toBe(2);
    expect(afterRestart.replies).toBe(2);
    expect(afterRestart.days.size).toBe(2);
    expect(afterRestart.tools.get("bash")).toBe(2);
    expect(afterRestart.usage.total.missingUsage).toBe(1);
  } finally { await fixture.cleanup(); }
});

test("重复扫描、追加与原地改写都不会把数字算两遍", async () => {
  const fixture = await tempFixture("ledger-idempotent-");
  try {
    const path = await writeSession(fixture.root, "g", "u", [ask("2026-09-18T01:00:00Z"), reply("2026-09-18T01:00:05Z")]);
    await sweepSessionStats(fixture.root, { force: true });
    await sweepSessionStats(fixture.root, { force: true });
    expect((await collectGroup("g", fixture.root)).asks).toBe(1);

    await appendFile(path, ask("2026-09-18T02:00:00Z") + "\n");
    await sweepSessionStats(fixture.root, { force: true });
    await sweepSessionStats(fixture.root, { force: true });
    const appended = await collectGroup("g", fixture.root);
    expect(appended.asks).toBe(2);
    expect(appended.replies).toBe(1);

    // 同一世代被整份改写：旧行先清掉再按新内容写一遍。
    await writeSession(fixture.root, "g", "u", [ask("2026-09-18T03:00:00Z")]);
    await sweepSessionStats(fixture.root, { force: true });
    const rewritten = await collectGroup("g", fixture.root);
    expect(rewritten.asks).toBe(1);
    expect(rewritten.replies).toBe(0);
  } finally { await fixture.cleanup(); }
});

test("每日扫描与任务结束同时入账同一份会话，追加部分只记一次", async () => {
  const fixture = await tempFixture("ledger-concurrent-");
  try {
    const path = await writeSession(fixture.root, "g", "u", [ask("2026-09-18T01:00:00Z")]);
    await sweepSessionStats(fixture.root, { force: true });
    await appendFile(path, ask("2026-09-18T02:00:00Z") + "\n");
    // 两个连接读到同一个旧游标：后提交的一方必须发现游标已推进并重读，而不是再加一遍。
    await Promise.all([ingestUserSession(fixture.root, "g", "u"), ingestUserSession(fixture.root, "g", "u")]);
    expect((await collectGroup("g", fixture.root)).asks).toBe(2);
  } finally { await fixture.cleanup(); }
});

test("较旧的首次入账或整份重建不能把新账、游标和归档标记覆盖回去", async () => {
  const fixture = await tempFixture("ledger-stale-reset-");
  // 需要把一个连接停在「读完文件、尚未提交」处，替换模块只能在子进程里做。
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/ledger-race-harness.ts", import.meta.url)), fixture.root],
    { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + "\n" + stderr).toBe(0);
    expect(stdout).toContain("HARNESS_RESULT=");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 20_000);

test("只读统计不替服务创建账本", async () => {
  const fixture = await tempFixture("ledger-read-only-");
  try {
    await writeSession(fixture.root, "g", "u", [ask("2026-09-18T01:00:00Z")]);
    expect((await collectGroup("g", fixture.root)).asks).toBe(0);
    expect(await Bun.file(statsLedgerPath(fixture.root)).exists()).toBe(false);
  } finally { await fixture.cleanup(); }
});

test("读取中替换会话文件不会混用新旧世代，归档标记与旧账保持不变", async () => {
  const fixture = await tempFixture("ledger-file-race-");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/session-file-race-harness.ts", import.meta.url)), fixture.root],
    { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + "\n" + stderr).toBe(0);
    expect(stdout).toContain("HARNESS_RESULT=");
  } finally { clearTimeout(timer); child.kill(); await child.exited; await fixture.cleanup(); }
}, 20_000);

test("只读统计用只读连接：不改库头、不生成 WAL，只读快照也能读", async () => {
  const fixture = await tempFixture("ledger-read-only-snapshot-");
  try {
    await writeSession(fixture.root, "g", "u", [ask("2026-09-18T01:00:00Z")]);
    await sweepSessionStats(fixture.root, { force: true });
    const path = statsLedgerPath(fixture.root);
    // 备份快照通常是回滚日志模式的单个文件，而且可能只读。
    const snapshot = new Database(path);
    snapshot.exec("PRAGMA journal_mode = DELETE");
    snapshot.close();
    const before = await readFile(path);
    // 可写的账本：读统计不能把它切成 WAL 或留下旁路文件。
    expect((await collectGroup("g", fixture.root)).asks).toBe(1);
    expect(await readFile(path)).toEqual(before);
    for (const sidecar of ["-wal", "-shm"]) expect(await Bun.file(path + sidecar).exists()).toBe(false);
    await chmod(path, 0o444);
    try {
      expect((await collectGroup("g", fixture.root)).asks).toBe(1);
    } finally { await chmod(path, 0o644); }
  } finally { await fixture.cleanup(); }
});

test("用量条目按自带的 kind 入账，未知类型也不丢账", async () => {
  const fixture = await tempFixture("ledger-usage-kind-");
  try {
    await writeSession(fixture.root, "g", "u", [
      ask("2026-09-18T01:00:00Z"),
      reply("2026-09-18T01:00:05Z", { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } }),
      // Pi 0.86 的缓存保温：不属于任何一次提问，但确实花了钱。
      JSON.stringify({ type: "usage", kind: "cache_warm", timestamp: "2026-09-18T01:30:00Z", provider: "zai", model: "plan",
        usage: { input: 0, output: 1, cacheRead: 5000, cacheWrite: 0, cost: { total: 0.015 } } }),
      JSON.stringify({ type: "compaction", timestamp: "2026-09-18T02:00:00Z",
        usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } }),
    ]);
    await sweepSessionStats(fixture.root, { force: true });
    const stats = await collectGroup("g", fixture.root);
    expect(stats.usage.kinds.get("cache_warm")?.cacheRead).toBe(5000);
    expect(stats.usage.kinds.get("cache_warm")?.requests).toBe(1);
    expect(stats.usage.kinds.get("compaction")?.input).toBe(20);
    expect(stats.usage.total.requests).toBe(3);
    expect(stats.tokens.cost).toBeCloseTo(0.135, 10);
    // 提问数不受用量条目影响。
    expect(stats.asks).toBe(1);
  } finally { await fixture.cleanup(); }
});

test("定时扫描一天只跑一次，force 可以立刻重扫", async () => {
  const fixture = await tempFixture("ledger-sweep-gate-");
  try {
    await writeSession(fixture.root, "g", "u", [ask("2026-09-18T01:00:00Z")]);
    const first = await sweepSessionStats(fixture.root);
    expect(first.skippedDay).toBe(false);
    expect(first.files).toBe(1);
    const second = await sweepSessionStats(fixture.root);
    expect(second.skippedDay).toBe(true);
    expect(second.files).toBe(0);
    expect((await sweepSessionStats(fixture.root, { force: true })).skippedDay).toBe(false);
    // 换一天再跑就不再跳过。
    const tomorrow = await sweepSessionStats(fixture.root, { now: Date.now() + 24 * 60 * 60_000 });
    expect(tomorrow.skippedDay).toBe(false);
    expect(await Bun.file(statsLedgerPath(fixture.root)).exists()).toBe(true);
  } finally { await fixture.cleanup(); }
});

test("持续扫描错误不阻断后续文件，重启后只重读失败或变化的文件", async () => {
  const fixture = await tempFixture("ledger-sweep-retry-");
  try {
    for (const phase of ["seed", "recover"]) {
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../helpers/stats-sweep-harness.ts", import.meta.url)), fixture.root, phase],
        { stdout: "pipe", stderr: "pipe", windowsHide: true });
      const timer = setTimeout(() => child.kill(), 15_000);
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, stdout + "\n" + stderr).toBe(0);
        expect(stdout).toContain("HARNESS_RESULT=" + phase);
      } finally { clearTimeout(timer); child.kill(); await child.exited; }
    }
  } finally { await fixture.cleanup(); }
}, 35_000);

test("独立 usage 使用自身模型，增量续读不污染主对话，context_edit 不冲减原始费用", async () => {
  const fixture = await tempFixture("ledger-attribution-");
  const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: { total: 0.1 } };
  try {
    const path = await writeSession(fixture.root, "g", "u", [
      reply("2026-09-18T01:00:00Z", usage),
      JSON.stringify({ type: "usage", kind: "cache_warm", provider: "other", model: "warmer", timestamp: "2026-09-18T02:00:00Z", usage }),
    ]);
    await sweepSessionStats(fixture.root, { force: true });
    await appendFile(path, [
      { type: "usage", kind: "future-kind", timestamp: "2026-09-19T01:00:00Z", usage },
      { type: "compaction", timestamp: "2026-09-19T02:00:00Z", usage },
      { type: "context_edit", targetId: "earlier-assistant", replacement: null, timestamp: "2026-09-19T03:00:00Z" },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await writeSession(fixture.root, "g", "only-usage", [JSON.stringify({
      type: "usage", kind: "cache_warm", provider: "solo", model: "solo-model", timestamp: "2026-09-19T02:00:00Z", usage,
    })], "gen-only-usage");
    await sweepSessionStats(fixture.root, { force: true });
    const db = openStatsLedger(fixture.root);
    try {
      expect(db.query("SELECT kind, provider, model, requests FROM usage_totals ORDER BY provider, kind").all()).toEqual([
        { kind: "cache_warm", provider: "other", model: "warmer", requests: 1 },
        { kind: "cache_warm", provider: "solo", model: "solo-model", requests: 1 },
        { kind: "future-kind", provider: "unknown", model: "unknown", requests: 1 },
        { kind: "assistant", provider: "zai", model: "plan", requests: 1 },
        { kind: "compaction", provider: "zai", model: "plan", requests: 1 },
      ]);
      expect(db.query("SELECT provider, model FROM sources WHERE id = 'gen-1'").get()).toEqual({ provider: "zai", model: "plan" });
    } finally { db.close(); }
    const stats = await collectGroup("g", fixture.root);
    expect(stats.asks).toBe(0);
    expect(stats.replies).toBe(1);
    expect(stats.tokens.cost).toBeCloseTo(0.5, 10);
  } finally { await fixture.cleanup(); }
});

test("账本版本不认时要求停机备份，禁止删除账本", async () => {
  const fixture = await tempFixture("ledger-version-");
  try {
    const db = openStatsLedger(fixture.root);
    db.query("UPDATE stats_schema SET version = 99 WHERE id = 1").run();
    db.close();
    expect(() => openStatsLedger(fixture.root)).toThrow(/勿删除 stats.sqlite/);
  } finally { await fixture.cleanup(); }
});

const toolResult = (at: string, toolName: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "message", timestamp: at,
  message: { role: "toolResult", toolCallId: "c-" + at, toolName, content: [{ type: "text", text: "ok" }], isError: false, ...extra } });
const scripted = (at: string, names: string[]) => JSON.stringify({ type: "message", timestamp: at,
  message: { role: "assistant", provider: "zai", model: "plan", content: names.map((name, i) => ({ type: "toolCall", id: `t${i}`, name, arguments: {} })),
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } });

test("子调用与工具自身用量：按被调用的工具计数，不完整单独标出，用量只计一次且不归到对话模型", async () => {
  const fixture = await tempFixture("ledger-nested-");
  const quarter = { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } };
  try {
    const path = await writeSession(fixture.root, "g", "u", [
      ask("2026-09-18T01:00:00Z"),
      scripted("2026-09-18T01:00:01Z", ["codemode", "probe"]),
      // SDK 已把子调用的用量并入发起调用的结果；子调用自己的结果不落盘。
      toolResult("2026-09-18T01:00:02Z", "codemode", { usage: quarter, nestedCalls: { complete: true, calls: [
        { id: "t0/1", name: "document_inspect", status: "ok" }, { id: "t0/2", name: "document_extract", status: "ok" },
        { id: "t0/3", name: "document_extract", status: "error" }] } }),
      toolResult("2026-09-18T01:00:03Z", "probe", { usage: quarter }),
      scripted("2026-09-18T01:00:04Z", ["codemode"]),
      toolResult("2026-09-18T01:00:05Z", "codemode", { nestedCalls: { complete: false, calls: [{ id: "t0/1", name: "document_patch", status: "unfinished" }] } }),
      // 不带用量的普通结果不产生用量行；缺字段的用量算「用量不完整」。
      toolResult("2026-09-18T01:00:06Z", "read"),
      toolResult("2026-09-18T01:00:07Z", "probe", { usage: { input: 1 } }),
    ]);
    await ingestUserSession(fixture.root, "g", "u");
    const db = openStatsLedger(fixture.root);
    try {
      expect(db.query("SELECT kind, tool, count FROM tool_counts ORDER BY kind, tool").all()).toEqual([
        { kind: "call", tool: "codemode", count: 2 }, { kind: "call", tool: "probe", count: 1 },
        { kind: "nested", tool: "document_extract", count: 2 }, { kind: "nested", tool: "document_inspect", count: 1 },
        { kind: "nested", tool: "document_patch", count: 1 },
        { kind: "nested_incomplete", tool: "codemode", count: 1 },
      ]);
      expect(db.query(`SELECT kind, provider, model, requests, input, missing_usage AS missing, unknown_cost AS unknown, cost
        FROM usage_totals ORDER BY kind`).all()).toEqual([
        { kind: "assistant", provider: "zai", model: "plan", requests: 2, input: 20, missing: 0, unknown: 0, cost: 0.02 },
        { kind: "tool", provider: "unknown", model: "unknown", requests: 3, input: 9, missing: 1, unknown: 1, cost: 0.5 },
      ]);
      // 工具用量不改变后续记录的模型归属。
      expect(db.query("SELECT provider, model, projection FROM sources").get()).toEqual({ provider: "zai", model: "plan", projection: 2 });
    } finally { db.close(); }

    // 续读只计新增部分。
    await appendFile(path, toolResult("2026-09-19T01:00:00Z", "probe", { usage: quarter }) + "\n");
    await ingestUserSession(fixture.root, "g", "u");
    await ingestUserSession(fixture.root, "g", "u");
    const stats = await collectGroup("g", fixture.root);
    expect(stats.usage.kinds.get("tool")).toMatchObject({ requests: 4, cost: 0.75 });
    expect(stats.usage.models.get(JSON.stringify(["unknown", "unknown"]))?.cost).toBeCloseTo(0.75, 10);
    expect(stats.tokens.cost).toBeCloseTo(0.77, 10);
    expect([...stats.tools]).toEqual([["codemode", 2], ["probe", 1]]);
    expect([...stats.nested].sort()).toEqual([["document_extract", 2], ["document_inspect", 1], ["document_patch", 1]]);
    expect(stats.nestedIncomplete).toBe(1);
    // 新类别不能被当成附件。
    expect(stats.delivered.size).toBe(0);
    expect(stats.legacySources).toBe(0);
  } finally { await fixture.cleanup(); }
});

test("旧口径世代续读时整份重读、按当前口径替换旧行；原件不在的旧口径世代原样保留并计数", async () => {
  const fixture = await tempFixture("ledger-projection-");
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } };
  try {
    const lines = [ask("2026-09-18T01:00:00Z"), scripted("2026-09-18T01:00:01Z", ["codemode"]),
      toolResult("2026-09-18T01:00:02Z", "codemode", { usage, nestedCalls: { complete: true, calls: [{ id: "t0/1", name: "read", status: "ok" }] } })];
    const kept = await writeSession(fixture.root, "g", "u", lines, "gen-kept");
    const gone = await writeSession(fixture.root, "g", "gone", lines, "gen-gone");
    await sweepSessionStats(fixture.root, { force: true });
    const rows = (db: Database, source: string) => ({
      tools: db.query("SELECT day, kind, tool, count FROM tool_counts WHERE source = ? ORDER BY day, kind, tool").all(source),
      usage: db.query("SELECT * FROM usage_totals WHERE source = ? ORDER BY day, kind, provider, model").all(source),
      activity: db.query("SELECT * FROM activity WHERE source = ? ORDER BY day").all(source),
    });
    let db = openStatsLedger(fixture.root);
    const expected = rows(db, "gen-kept");
    // 迁移时原件无法核对的世代：只有投影 1 的行。
    for (const source of ["gen-kept", "gen-gone"]) {
      db.query("DELETE FROM tool_counts WHERE source = ? AND kind IN ('nested', 'nested_incomplete')").run(source);
      db.query("DELETE FROM usage_totals WHERE source = ? AND kind = 'tool'").run(source);
      db.query("UPDATE sources SET projection = 1 WHERE id = ?").run(source);
    }
    const legacyRows = rows(db, "gen-gone");
    db.close();
    await rm(gone);
    expect((await collectGroup("g", fixture.root)).legacySources).toBe(2);

    await appendFile(kept, toolResult("2026-09-19T01:00:00Z", "probe", { usage }) + "\n");
    await ingestUserSession(fixture.root, "g", "u");
    await ingestUserSession(fixture.root, "g", "gone");
    db = openStatsLedger(fixture.root);
    try {
      const after = rows(db, "gen-kept");
      // 整份重读：子调用行回来了，新增的工具结果只带用量，不增加调用次数。
      expect(after.tools).toEqual(expected.tools);
      expect((after.usage as { day: string; kind: string; cost: number }[]).filter((row) => row.kind === "tool")
        .map((row) => [row.day, row.cost])).toEqual([["2026-09-18", 0.25], ["2026-09-19", 0.25]]);
      expect(db.query("SELECT id, projection FROM sources ORDER BY id").all()).toEqual([
        { id: "gen-gone", projection: 1 }, { id: "gen-kept", projection: 2 }]);
      expect(rows(db, "gen-gone")).toEqual(legacyRows);
    } finally { db.close(); }
    const stats = await collectGroup("g", fixture.root);
    expect(stats.legacySources).toBe(1);
    expect(stats.nested.get("read")).toBe(1);
  } finally { await fixture.cleanup(); }
});
