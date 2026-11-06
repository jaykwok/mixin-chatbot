import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { operationArgs, operationCommand, operationScope } from "../../ops/core/operations.ts";
import { operationPreparer } from "../../console/server/prepare-operation.ts";
import { PlanStore } from "../../ops/core/plans.ts";
import { Views } from "../../console/server/views.ts";
import { assertExpectedScope, historyScope, statsFileScope, takeExpected } from "../../src/lib/operation-scope.ts";
import { openStatsLedger, importRows, readLedger } from "../../src/agent/stats-ledger.ts";
import { importStats, previewStatsImport } from "../../ops/tools/stats-import-core.ts";
import { tempFixture } from "../helpers/temp.ts";
import { planDigest as manifestDigest } from "../../src/contracts/maintenance.ts";
import { BackupForms } from "../../console/server/backup-forms.ts";
import { apply as applyBackups } from "../../ops/tools/backup-cleanup.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import { FormRoutes } from "../../console/server/form-routes.ts";
import { AuditLog } from "../../console/server/audit.ts";
import { MemberCodes } from "../../console/server/identity.ts";

const sha = "a".repeat(64);
test("匿名会话压缩预览沿用匿名编号，临时文件范围以会话内随机键传递", async () => {
  const f = await tempFixture("console-private-selection-");
  try {
    const views = new Views(), phone = "13800138000";
    views.add({ id: "view", session: "session", kind: "space", space: "direct", title: "单聊", mode: "anonymous", createdAt: 1,
      generation: "generation", codes: new MemberCodes(), names: new Map(), byConversation: new Map(), lastDocument: 1, truncated: false,
      members: new Map([["opaque", { key: "opaque", phone, conversation: 1, createdAt: 1, lastAt: null, lastEntry: null, opened: false, code: "A7" }]]) });
    mkdirSync(join(f.root, "data/conversations/direct"), { recursive: true });
    const forms = new FormRoutes(f.root, new AuditLog(join(f.root, "audit")));
    const dir = join(f.root, "data/tmp/groups/g+1", phone); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "file.txt"), "fixture");
    const context = { session: { label: "session" }, signal: new AbortController().signal } as RouteContext;
    const response = await forms.routes()["GET /api/storage/scopes"]!.run(context) as { scopes: { key: string; label: string }[] };
    expect(JSON.stringify(response)).not.toContain(phone); expect(response.scopes).toHaveLength(1);
    let argv: string[] = [];
    const prepare = operationPreparer(f.root, views, async (_command, args) => {
      argv = process.platform === "win32" ? (() => {
        const request = JSON.parse(Buffer.from(args.at(-1)!, "base64").toString());
        expect(request.User).toBe(phone); expect(request.Group).toBe("g+1"); expect(request.StorageSegment).toBe(true);
        return ["--plan", request.Plan];
      })() : args;
      if (process.platform !== "win32") {
        expect(args).toContain(`--user=${phone}`); expect(args).toContain("--group=g+1"); expect(args).toContain("--storage-segment");
        argv = ["--plan", args.find(value => value.startsWith("--plan="))!.slice(7)];
      }
      const id = argv[argv.indexOf("--plan") + 1]!, base = { version: 1, id, items: [{ status: "ready", evidence: { bytes: 7 } }] };
      const path = join(f.root, `data/state/reclamation/backup/rm/.tmp-plans/${id}.json`); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ ...base, digest: manifestDigest(base) }));
      return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    }, undefined, undefined, forms);
    const compact = await prepare("history-compact", { view: "view", member: "opaque" }, "session");
    expect(compact.phone).toBe(phone); expect(compact.memberLabel).toBe("成员 A7");
    const preview = await operationScope(f.root, "history-compact", compact);
    expect(preview.summary.join()).toContain("成员 A7"); expect(preview.summary.join()).not.toContain("138");
    await expect(prepare("history-compact", { view: "view", member: "opaque" }, "other")).rejects.toThrow("过期");
    const key = response.scopes[0]!.key;
    await expect(prepare("tmp-purge", { days: 0, scope: key }, "other")).rejects.toThrow("过期");
    const files = await prepare("tmp-purge", { days: 0, scope: key }, "session");
    expect(files.scopeLabel).toContain("群 g+1"); expect(JSON.stringify(files)).not.toContain(phone);
    expect((await operationScope(f.root, "tmp-purge", files)).summary[0]).toContain("群 g+1");
    forms.end("session"); await expect(prepare("tmp-purge", { days: 0, scope: key }, "session")).rejects.toThrow("过期");
  } finally { await f.cleanup(); }
});
test("备份表单默认保留业务归档，只将勾选项交给既有清理协议，变动后不会删除", async () => {
  const f = await tempFixture("console-backup-select-");
  try {
    const path = join(f.root, "backup/rm/1758000000-12345-678-models.json"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{"providers":{}}');
    const forms = new BackupForms(f.root), scan = forms.routes()["POST /api/backups/scan"]!;
    const result = await scan.run({ body: {}, session: { label: "session" } } as RouteContext) as { selection: string; entries: { index: number; category: string; selected: boolean }[] };
    expect(result.entries[0]).toMatchObject({ category: "business", selected: false });
    expect(() => forms.prepare({ selection: result.selection, indexes: [0] }, "other")).toThrow("过期");
    const params = forms.prepare({ selection: result.selection, indexes: [0] }, "session");
    const preview = await operationScope(f.root, "backup-clean", params); expect(preview.summary[0]).toContain("可删除 1 项");
    writeFileSync(path, '{"providers":{"changed":true}}');
    expect((await operationScope(f.root, "backup-clean", params)).scope).not.toBe(preview.scope);
    const applied = applyBackups(f.root, String(params.report), String(params.confirm)); expect(applied.results[0]!.outcome).toBe("changed");
    expect(readFileSync(path, "utf8")).toContain("changed");
    // The current release's snapshot and moved files share one name: both are shown with their area and cannot be ticked.
    const release = "deploy-" + "b".repeat(32);
    for (const area of ["rm", "snapshots"]) mkdirSync(join(f.root, "backup", area, release), { recursive: true });
    mkdirSync(join(f.root, "data/state"), { recursive: true });
    writeFileSync(join(f.root, "data/state/release-data.json"), JSON.stringify({ format: 1, phase: "committed", deployment: release, previous: null }));
    const rescanned = await scan.run({ body: {}, session: { label: "session" } } as RouteContext) as { entries: { name: string; basis: string[]; selectable: boolean }[] };
    const shown = rescanned.entries.filter(entry => entry.name.endsWith(release));
    expect(shown.map(entry => entry.name).sort()).toEqual([`backup/rm/${release}`, `backup/snapshots/${release}`]);
    for (const entry of shown) { expect(entry.selectable).toBe(false); expect(entry.basis.join("；")).toContain("工具不会删除"); }
  } finally { await f.cleanup(); }
});
test("备份预览返回后可改选再预览，只有最新一次可执行；建任务后这次扫描不能再预览", async () => {
  const f = await tempFixture("console-backup-repreview-");
  try {
    for (const name of ["1758000000-12345-678-models.json", "1758000001-12345-678-models.json"]) {
      const path = join(f.root, "backup/rm", name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{"providers":{}}');
    }
    const forms = new BackupForms(f.root), scan = forms.routes()["POST /api/backups/scan"]!;
    const { selection } = await scan.run({ body: {}, session: { label: "session" } } as RouteContext) as { selection: string };
    const first = forms.prepare({ selection, indexes: [0] }, "session");
    expect((await operationScope(f.root, "backup-clean", first)).summary[0]).toContain("可删除 1 项");
    const second = forms.prepare({ selection, indexes: [0, 1] }, "session");
    expect((await operationScope(f.root, "backup-clean", second)).summary[0]).toContain("可删除 2 项");
    await expect(operationScope(f.root, "backup-clean", first)).rejects.toThrow("备份清单已变化");
    forms.bind({ operation: "backup-clean", params: second });
    expect(() => forms.prepare({ selection, indexes: [0] }, "session")).toThrow("过期");
  } finally { await f.cleanup(); }
});
test("临时文件三种清单及外链范围都绑定预览，篡改、增减范围和配置改变拒绝旧计划", async () => {
  const f = await tempFixture("console-manifest-scope-");
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const [operation, location] of [
      ["tmp-purge", `state/reclamation/backup/rm/.tmp-plans/${id}.json`],
      ["tmp-reclaim", `state/reclamation/plans/${id}.json`],
      ["tmp-discard", `state/reclamation/backup/rm/.tmp-plans/${id}.removal.json`],
    ]) {
      const path = join(f.root, "data", location!), base = { version: 1, id, items: [{ status: "ready", evidence: { bytes: 42 } }] };
      const digest = manifestDigest(base); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ ...base, digest }));
      const params = { plan: id, digest }; const preview = await operationScope(f.root, operation!, params);
      expect(preview.summary[0]).toContain("1 项，42 字节"); expect(operationArgs(operation!, params)).toEqual([operation!, "--plan", id, "--digest", digest]);
      const changed = { ...base, items: [...base.items, { status: "ready", evidence: { bytes: 1 } }] };
      writeFileSync(path, JSON.stringify({ ...changed, digest: manifestDigest(changed) }));
      await expect(operationScope(f.root, operation!, params)).rejects.toThrow("摘要已变化");
      writeFileSync(path, JSON.stringify({ ...changed, digest }));
      await expect(operationScope(f.root, operation!, params)).rejects.toThrow();
    }
    const db = new Database(join(f.root, "data/state/relay.sqlite"), { create: true });
    try {
      db.exec("CREATE TABLE objects (key TEXT PRIMARY KEY,url TEXT,name TEXT,size INTEGER,at TEXT,state TEXT,expiresAt TEXT,deleteAfter TEXT)");
      db.exec("INSERT INTO objects VALUES ('a','https://example.test/a','fixture',1,'2026','uploaded',null,null)");
      // Both tasks refuse without relay.json in their own preflight: the preview says so first.
      for (const [operation, params] of [["relay-test", {}], ["relay-purge", { all: true }]] as const) await expect(operationScope(f.root, operation, params)).rejects.toThrow("没有启用外链");
      mkdirSync(join(f.root, "data/config"), { recursive: true }); writeFileSync(join(f.root, "data/config/relay.json"), '{"endpoint":"https://example.test"}');
      const first = await operationScope(f.root, "relay-purge", { all: true });
      expect(first.summary[0]).toContain("全部 1 个外链对象");
      db.exec("INSERT INTO objects VALUES ('b','https://example.test/b','fixture',1,'2026','uploaded',null,null)");
      const second = await operationScope(f.root, "relay-purge", { all: true }); expect(second.scope).not.toBe(first.scope);
      writeFileSync(join(f.root, "data/config/relay.json"), '{"endpoint":"https://other.example.test"}');
      expect((await operationScope(f.root, "relay-purge", { all: true })).scope).not.toBe(second.scope);
      expect(first.summary.join()).not.toContain("https:");
      expect((await operationScope(f.root, "relay-purge", { keyword: "fixture" })).summary[0]).toContain("的 2 个外链");
      await expect(operationScope(f.root, "relay-purge", { keyword: "absent" })).rejects.toThrow("没有匹配");
    } finally { db.close(); }
  } finally { await f.cleanup(); }
});
test("命令白名单拒绝多余字段和扩大范围的缺省值，绑定摘要跨平台传递", () => {
  for (const [op, params] of [["history-clear", {}], ["history-compact", { space: "all", phone: "13800138000" }],
    ["relay-purge", {}], ["relay-purge", { all: true, keyword: "x" }], ["start", { argv: ["--all"] }], ["shell", {}],
    ["tmp-purge", { plan: "../../all", digest: sha }], ["runtime-configure", { draft: "../config.json" }]] as const) {
    expect(() => operationArgs(op, params)).toThrow();
  }
  for (const [op, params] of [["history-clear", { space: "direct" }], ["history-compact", { space: "groups/g1", phone: "13800138000" }],
    ["relay-test", {}], ["relay-purge", { keyword: "--all" }], ["stat-import", { path: join(process.cwd(), "synthetic.sqlite") }]] as const) {
    const argv = operationArgs(op, params, sha);
    expect(argv.slice(-2)).toEqual(["--expect", sha]);
    const command = operationCommand(process.cwd(), op, params, { scope: sha, runState: "stopped", project: process.cwd(), identity: "fixture", platform: process.platform, head: "test", protocol: 1 });
    expect(command.env.MIXIN_OPS_EXPECT_STATE).toBe("stopped");
    if (process.platform === "win32") {
      const request = JSON.parse(Buffer.from(command.args.at(-1)!, "base64").toString());
      expect(request.Expect).toBe(sha);
      if (op === "history-compact") expect(request.User).toBe("13800138000");
      if (op === "relay-purge") expect(request.Target).toBe("--all");
    }
  }
  expect(() => takeExpected(["--expect", sha, "--expect", sha])).toThrow();
  expect(() => takeExpected(["--expect", "--all"])).toThrow();
});

test("会话范围在预览后增加时拒绝执行，单个空间只绑定所选空间和成员", async () => {
  const f = await tempFixture("console-write-scope-");
  try {
    const root = join(f.root, "data"); mkdirSync(join(root, "conversations/direct"), { recursive: true });
    const before = await operationScope(f.root, "history-clear", { space: "all" });
    const direct = await historyScope(root, "direct", "13800138000");
    mkdirSync(join(root, "conversations/groups/g1"), { recursive: true });
    expect(() => assertExpectedScope(before.scope, "different")).toThrow("范围已变化");
    expect((await operationScope(f.root, "history-clear", { space: "all" })).scope).not.toBe(before.scope);
    expect(await historyScope(root, "direct", "13800138000")).toBe(direct);
    expect(await historyScope(root, "direct", "13800138001")).not.toBe(direct);
    const summary = await operationScope(f.root, "history-compact", { space: "direct", phone: "13800138000" });
    expect(summary.summary.join()).not.toContain("13800138000");
  } finally { await f.cleanup(); }
});

test("运行参数只接受表单，草稿绑定旧配置；执行前变更配置和部署状态分别拒绝", async () => {
  const f = await tempFixture("console-runtime-form-");
  try {
    const prepare = operationPreparer(f.root, new Views());
    await expect(prepare("runtime-configure", { draft: "arbitrary" }, "session")).rejects.toThrow("未允许");
    await expect(prepare("runtime-configure", { hash: null, changes: { BOT_PORT: "9999" } }, "session")).rejects.toThrow("不可");
    // Pages name a setting as the form does, in refusals and in the preview (with the value it replaces).
    await expect(prepare("runtime-configure", { hash: null, changes: { BOT_MAX_ACTIVE_REQUESTS: "0" } }, "session")).rejects.toThrow(/^「请求并发上限」/);
    const params = await prepare("runtime-configure", { hash: null, changes: { BOT_MAX_ACTIVE_REQUESTS: "16" } }, "session");
    expect((await operationScope(f.root, "runtime-configure", params)).summary).toEqual([expect.stringMatching(/^请求并发上限：\d+ → 16$/)]);
    let runState = "stopped";
    const plans = new PlanStore(join(f.root, ".console"), async (op, value) => {
      const read = await operationScope(f.root, op, value);
      return { ...read, facts: { project: f.root, platform: process.platform, identity: "fixture", head: "h", protocol: 1, runState, scope: read.scope } };
    });
    const plan = await plans.create("runtime-configure", params);
    await plans.verify(plan.id);
    runState = "running"; await expect(plans.verify(plan.id)).rejects.toThrow("运行状态"); runState = "stopped";
    writeFileSync(join(f.root, "data/config/runtime.json"), '{"BOT_MAX_ACTIVE_REQUESTS":"8"}');
    await expect(plans.verify(plan.id)).rejects.toThrow("运行参数已变化");
    expect(JSON.parse(readFileSync(join(f.root, "data/config/runtime.json"), "utf8"))).toEqual({ BOT_MAX_ACTIVE_REQUESTS: "8" });
  } finally { await f.cleanup(); }
});

test("schema 3 统计在全新部署恢复模型和工具汇总；重复导入和重叠账本受保护，源库含 WAL 仍不改动", async () => {
  const f = await tempFixture("console-stats-restore-");
  const source = join(f.root, "source.sqlite"), db = openStatsLedger(source);
  try {
    importRows(db, "fixture", { asks: [{ day: "2026-10-29", space: "direct", user: "13800138000", asks: 3, firstAt: 1, lastAt: 2 }],
      usage: ["models", "tools"].map(bucket => ({ bucket: bucket as "models" | "tools", day: "2026-10-29", space: "direct", user: "13800138000", key: "fixture", input: 4, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 10 })) });
    const before = statsFileScope(source), expected = readLedger(db), root = join(f.root, "fresh/data");
    expect(previewStatsImport(source, root)).toMatchObject({ asks: 3, usageRows: 2, totalTokens: 20, status: "new" });
    expect((await operationScope(join(f.root, "fresh"), "stat-import", { path: source })).summary[0]).toBe("3 次提问，2 行用量，20 tokens");
    expect(importStats(source, root).result).toBe("imported");
    expect(importStats(source, root).result).toBe("already");
    // The console refuses the preview instead of stopping the bot to count nothing.
    await expect(operationScope(join(f.root, "fresh"), "stat-import", { path: source })).rejects.toThrow("已经导入");
    const target = openStatsLedger(join(root, "state/stats.sqlite"));
    try { expect(readLedger(target)).toEqual(expected); } finally { target.close(); }
    expect(statsFileScope(source)).toBe(before);
    const copy = join(f.root, "copy.sqlite"); copyFileSync(source, copy); copyFileSync(source + "-wal", copy + "-wal");
    expect(statsFileScope(copy)).toBe(before);
    db.exec("UPDATE asks_daily SET asks = asks + 1");
    expect(() => assertExpectedScope(before, statsFileScope(source))).toThrow("范围已变化");
    expect(() => importStats(source, root)).toThrow("拒绝再导入");
    const occupied = join(f.root, "occupied"), busy = openStatsLedger(join(occupied, "state/stats.sqlite"));
    busy.exec("INSERT INTO asks_daily VALUES ('2026-10-29','direct','fixture','live',1,1,2)"); busy.close();
    expect(() => previewStatsImport(source, occupied)).toThrow("空账本");
    expect(() => importStats(source, occupied)).toThrow("空账本");
  } finally { db.close(); await f.cleanup(); }
});
