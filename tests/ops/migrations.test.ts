import { expect, test } from "bun:test";
import { appendFile, copyFile, cp, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { executeProcess } from "../../scripts/lib/process.ts";
import { CLI_ACTION_MS, migrationBudget } from "../helpers/migration-budget.ts";
import { lock } from "proper-lockfile";
import { tempFixture } from "../helpers/temp.ts";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { DATA_VERSION, GROUP_ROOT_LEASE, inspectDataVersion } from "../../src/core/data-version.ts";
import { acquireGroupRootLease } from "../../src/core/maintenance.ts";
import { v1 } from "../../scripts/migrations/v1.ts";
import { v2 } from "../../scripts/migrations/v2.ts";
import { describeMigrations, previewContext } from "../../scripts/migrations/lib/preview.ts";
import { ingestBeforeArchive, openStatsLedger, readLedger, sweepSessionStats } from "../../src/agent/stats-ledger.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
async function fixture(retention = "short") {
  const files = await tempFixture("migrations-");
  const groups = join(files.root, "external-groups");
  const context = { project: files.root, groups, decisions: {} };
  await mkdir(groups);
  await publishJson(join(files.root, "data/config/runtime.json"), { BOT_MODEL_CACHE_RETENTION: retention, GROUP_DATA_ROOT: groups });
  await publishJson(join(files.root, "data/config/models.json"), { providers: { fixture: {
    baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-key", models: [{
      id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } });
  await publishJson(join(files.root, "data/runtime/pi/settings.json"), { defaultProvider: "fixture", defaultModel: "test" });
  await mkdir(join(files.root, "data/state"), { recursive: true });
  return { ...files, context };
}
async function execute(args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = await executeProcess({ command: process.execPath, args, cwd, env: { ...process.env, ...env }, timeoutMs: CLI_ACTION_MS });
  return { code: result.exitCode, text: result.stdout + result.stderr };
}

test.each(["committed", "validated"])("a %s receipt permits a new group root without restoring the old root", async phase => {
  const f = await fixture(), c = f.context;
  try {
    await apply(c, (await preview(c)).plan!);
    const next = { ...c, groups: join(f.root, "replacement-groups") };
    await mkdir(next.groups);
    await expect(preview(next)).rejects.toThrow("群挂载");
    await commit(c);
    const receipt = (await json(join(f.root, "data/state/migration.json")))!;
    await publishJson(join(f.root, "data/state/migration.json"), { ...receipt, phase });
    await rename(c.groups, c.groups + "-offline");
    await publishJson(join(next.groups, "data-version.json"), { dataVersion: DATA_VERSION, transaction: "restored-root" });
    const ledger = openStatsLedger(next.groups); ledger.close();
    const before = await readFile(join(next.groups, "stats.sqlite"));
    expect(await rollback(next)).toBe(false);
    const plan = (await preview(next)).plan!;
    expect(plan.kind).toBe("registration");
    await apply(next, plan); await commit(next);
    expect(inspectDataVersion(next.project, next.groups).current).toBe(true);
    expect(await readFile(join(next.groups, "stats.sqlite"))).toEqual(before);
    expect((await json(join(next.project, "data/state/migration.json")))?.groups).toBe(next.groups);
  } finally { await f.cleanup(); }
}, migrationBudget(7));

test("a committed migration can initialize a completely empty replacement group root", async () => {
  const f = await fixture(), c = f.context;
  try {
    await apply(c, (await preview(c)).plan!); await commit(c);
    const next = { ...c, groups: join(f.root, "empty-groups") };
    await mkdir(next.groups);
    await rename(c.groups, c.groups + "-offline");
    expect(inspectDataVersion(next.project, next.groups).current).toBe(false);
    const result = await preview(next);
    expect(result.decisions).toEqual([]);
    expect(result.plan?.kind).toBe("migration");
    // 未登记的群根从头走一遍：v1 三步、v2 两步、v3 两步（没有会话可导入，也没有保温设置要改）。
    expect(result.plan?.steps).toHaveLength(9);
    expect(await readdir(next.groups)).toEqual([]);
    await apply(next, result.plan!); await commit(next);
    expect(inspectDataVersion(next.project, next.groups).current).toBe(true);
    expect(await readdir(next.groups)).toEqual(["data-version.json"]);
    expect(await json(join(next.groups, "data-version.json"))).toEqual(await json(join(f.root, "data/state/data-version.json")));
    expect((await preview(next)).plan?.kind).toBe("verification");
  } finally { await f.cleanup(); }
}, migrationBudget(7));

test("migration decisions and diagnostics work with the original updater export manifest", async () => {
  const f = await fixture("none");
  try {
    const stage = join(f.root, "export");
    // Migration preview can use only the built-ins and paths in the updater exports (Windows and the Linux
    // UPGRADER_EXPORT_PATHS); the orchestrators and Dockerfile in those exports are not needed by preview.
    for (const path of ["scripts/lib", "scripts/migrations", "src/core/data-version.ts"]) {
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await cp(join(project, path), join(stage, path), { recursive: true });
    }
    const result = await execute([join(stage, "scripts/migrations/run.ts"), "preview", "--decisions-only", "--project", f.root, "--groups", f.context.groups], f.root);
    expect(result.code, result.text).toBe(2);
    expect(result.text).toContain("--accept-native-cache");
    const logs = await readdir(join(f.root, "logs/operations")); expect(logs).toHaveLength(1);
    expect(await readFile(join(f.root, "logs/operations", logs[0]!), "utf8")).toContain("migration-finished: exit=2");
    expect(await json(join(f.root, "data/state/migration.json"))).toBeNull();
  } finally { await f.cleanup(); }
}, migrationBudget(1));

test("migration failure diagnostics survive rollback and recovery journal removal", async () => {
  const f = await fixture();
  try {
    const runtimePath = join(f.root, "data/config/runtime.json"), original = await readFile(runtimePath);
    const planPath = join(f.root, "plan.json"), name = "upgrade-20260925T000000Z-fixture.log";
    const command = (action: string) => execute([join(project, "scripts/migrations/run.ts"), action, "--project", f.root,
      "--groups", f.context.groups, "--plan", planPath], f.root, { BOT_OPERATION_LOG: name });
    for (const action of ["preview", "apply"]) { const result = await command(action); expect(result.code, result.text).toBe(0); }
    await writeFile(runtimePath, "invalid-json");
    const failed = await command("commit"); expect(failed.code, failed.text).toBe(1);
    const restored = await command("rollback"); expect(restored.code, restored.text).toBe(0);
    expect(await json(join(f.root, "data/state/migration.json"))).toBeNull();
    expect(await readFile(runtimePath)).toEqual(original);
    expect(await readdir(join(f.root, "logs/operations"))).toEqual([name]);
    const text = await readFile(join(f.root, "logs/operations", name), "utf8");
    for (const phase of ["spawn-request", "spawned", "entry-ready", "imports-ready", "config", "stats", "delivery", "result", "exit", "stdio-close", "reaped"]) expect(text).toContain("validation-" + phase + ":");
    expect(text).toContain("state=failed; code=");
    expect(text).toContain("code=1; signal=");
    expect(text).toContain("当前版本完整校验失败"); expect(text).toContain("migration-finished: exit=1");
    expect(text).toContain("rollback-complete: transaction="); expect(text).toContain("backup=");
    expect(text).not.toContain("fixture-key");
  } finally { await f.cleanup(); }
}, migrationBudget(4));

test.each(["auto", "short", "long"])("legacy %s and partially migrated settings converge without repeated writes", async retention => {
  const f = await fixture(retention);
  try {
    expect((await v1.preview(previewContext(f.context))).decisions).toEqual([]);
    await v1.apply(f.context);
    await v1.validate(f.context);
    const settings = await readFile(join(f.root, "data/runtime/pi/settings.json"));
    const runtime = await readFile(join(f.root, "data/config/runtime.json"));
    const after = (await json(join(f.root, "data/config/runtime.json")))!;
    expect(after.PI_CACHE_RETENTION).toBe(retention === "auto" ? undefined : retention);
    expect((await v1.preview(previewContext(f.context))).files).toEqual([]);
    await v1.apply(f.context);
    expect(await readFile(join(f.root, "data/runtime/pi/settings.json"))).toEqual(settings);
    expect(await readFile(join(f.root, "data/config/runtime.json"))).toEqual(runtime);
  } finally { await f.cleanup(); }
});

test("model replacement and native cache conflicts require explicit decisions", async () => {
  const f = await fixture("short");
  try {
    const conflict = await execute([join(project, "scripts/migrations/run.ts"), "preview", "--decisions-only", "--project", f.root,
      "--groups", f.context.groups], f.root, { PI_CACHE_RETENTION: "long" });
    expect(conflict.code, conflict.text).toBe(2);
    expect(conflict.text).toContain("--accept-native-cache");
    await publishJson(join(f.root, "data/config/runtime.json"), { BOT_MODEL_CACHE_RETENTION: "short", PI_CACHE_RETENTION: "long" });
    await publishJson(join(f.root, "data/runtime/pi/settings.json"), { defaultProvider: "openai-codex", defaultModel: "gpt-5.4" });
    expect((await v1.preview(previewContext(f.context))).decisions.map(d => d.key)).toEqual(["acceptNativeCache", "model"]);
    f.context.decisions = { acceptNativeCache: true, provider: "fixture", model: "test" };
    await apply(f.context, (await preview(f.context)).plan!);
    expect((await json(join(f.root, "data/config/runtime.json")))?.PI_CACHE_RETENTION).toBe("long");
    expect((await json(join(f.root, "data/runtime/pi/settings.json")))?.defaultModel).toBe("test");
    await rollback(f.context);
  } finally { await f.cleanup(); }
}, migrationBudget(3));

test("unregistered data previews decisions, retries idempotently and commits paired markers last", async () => {
  const f = await fixture("none"), c = f.context;
  try {
    const before = await readFile(join(f.root, "data/config/runtime.json"));
    const undecided = await preview(c);
    expect(undecided.decisions.map(d => d.key)).toEqual(["acceptNativeCache"]);
    expect(await readFile(join(f.root, "data/config/runtime.json"))).toEqual(before);
    c.decisions = { acceptNativeCache: true };
    const plan = (await preview(c)).plan!;
    await apply(c, plan);
    expect(inspectDataVersion(c.project, c.groups).current).toBe(false);
    expect((await json(join(f.root, "data/config/runtime.json")))?.BOT_MODEL_CACHE_RETENTION).toBeUndefined();
    const journal = (await json(join(f.root, "data/state/migration.json")))!;
    expect(await preview(c)).toMatchObject({ pending: true });
    // Interrupted exactly between publication of the group and project markers.
    await publishJson(join(c.groups, "data-version.json"), { dataVersion: DATA_VERSION, transaction: journal.id });
    await apply(c);
    expect((await json(join(f.root, "data/state/migration.json")))?.id).toBe(journal.id);
    await commit(c);
    expect(inspectDataVersion(c.project, c.groups).current).toBe(true);
    expect(await json(join(c.groups, "data-version.json"))).toEqual(await json(join(f.root, "data/state/data-version.json")));
    expect(await rollback(c)).toBe(false);
    expect((await preview(c)).plan?.steps).toEqual([]);
  } finally { await f.cleanup(); }
}, migrationBudget(7));

test("rollback restores exact configuration and SQLite contents, rejects damaged backups", async () => {
  const f = await fixture(), c = f.context;
  try {
    const dbPath = join(f.root, "data/state/other.sqlite");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE example(value); INSERT INTO example VALUES (1); CREATE TABLE payload(value BLOB); INSERT INTO payload VALUES (zeroblob(262144))"); db.close();
    const original = await readFile(dbPath), runtime = await readFile(join(f.root, "data/config/runtime.json"));
    await apply(c, (await preview(c)).plan!);
    const changed = new Database(dbPath); changed.exec("INSERT INTO example VALUES (2)"); changed.close();
    const journal = (await json(join(f.root, "data/state/migration.json")))!;
    const saved = journal.files.find((file: any) => file.path === dbPath).saved;
    const backupPath = join(f.root, journal.backup, saved), backup = await readFile(backupPath);
    await writeFile(backupPath, "damaged");
    await expect(rollback(c)).rejects.toThrow("备份缺失或损坏");
    expect((await json(join(f.root, "data/state/migration.json")))?.id).toBe(journal.id);
    await writeFile(backupPath, backup);
    expect(await rollback(c)).toBe(true);
    expect(await readFile(dbPath)).toEqual(original);
    expect(await readFile(join(f.root, "data/config/runtime.json"))).toEqual(runtime);
    expect(await json(join(f.root, "data/state/data-version.json"))).toBeNull();
  } finally { await f.cleanup(); }
}, migrationBudget(2));

test("committed upgrades never restore old database backups after the group marker is restored separately", async () => {
  const f = await fixture(), c = f.context;
  try {
    await apply(c, (await preview(c)).plan!); await commit(c);
    const first = await json(join(c.groups, "data-version.json"));
    await apply(c, (await preview(c)).plan!); await commit(c);
    const stats = join(c.groups, "stats.sqlite"), agent = join(f.root, "data/state/agent.sqlite");
    await writeFile(stats, "new statistics after commit"); await writeFile(agent, "new deliveries after commit");
    await publishJson(join(c.groups, "data-version.json"), first);
    // Also covers the new no-op path, which deliberately keeps the first marker.
    await publishJson(join(c.groups, "data-version.json"), { ...first, transaction: "restored-other-snapshot" });
    expect(await rollback(c)).toBe(false);
    expect(await readFile(stats, "utf8")).toBe("new statistics after commit");
    expect(await readFile(agent, "utf8")).toBe("new deliveries after commit");
    expect(inspectDataVersion(c.project, c.groups).detail).toContain("不成对");
  } finally { await f.cleanup(); }
}, migrationBudget(6));

test("matching data versions skip migration code and database copies while retaining validation", async () => {
  const f = await fixture(), c = f.context;
  try {
    await apply(c, (await preview(c)).plan!); await commit(c);
    const marker = await readFile(join(c.groups, "data-version.json"));
    const snapshots = await readdir(join(f.root, "backup/snapshots"));
    const plan = (await preview(c)).plan!;
    expect(plan.kind).toBe("verification"); expect(plan.steps).toEqual([]);
    const original = { preview: v1.preview, apply: v1.apply, validate: v1.validate };
    const rejectMigration = async (): Promise<never> => { throw new Error("same version executed a migration"); };
    v1.preview = rejectMigration; v1.apply = rejectMigration; v1.validate = rejectMigration;
    try {
      const reports: string[] = [], verified = { ...c, report: (stage: string) => reports.push(stage) };
      await apply(verified, plan);
      const journal = (await json(join(f.root, "data/state/migration.json")))!;
      expect(journal).toMatchObject({ kind: "verification", steps: [], files: [], backup: null });
      expect(reports).toContain("skip-migration"); expect(reports).toContain("validate");
      await commit(verified);
    } finally { Object.assign(v1, original); }
    expect(await readFile(join(c.groups, "data-version.json"))).toEqual(marker);
    expect(await readFile(join(f.root, "data/state/data-version.json"))).toEqual(marker);
    expect(await readdir(join(f.root, "backup/snapshots"))).toEqual(snapshots);
    await publishJson(join(f.root, "data/config/runtime.json"), { BOT_MAX_ACTIVE_REQUESTS: "invalid" });
    await expect(preview(c)).rejects.toThrow("当前版本配置校验失败");
  } finally { await f.cleanup(); }
}, migrationBudget(7));

test("a legacy receipt protects the project commit point and a restored group is re-registered without touching its ledger", async () => {
  const f = await fixture(), c = f.context;
  try {
    await apply(c, (await preview(c)).plan!); await commit(c);
    const journalPath = join(f.root, "data/state/migration.json"), receipt = (await json(journalPath))!;
    // Simulate interruption after the project marker, before persisting the committed phase.
    await publishJson(journalPath, { ...receipt, phase: "validated" });
    await publishJson(join(c.groups, "data-version.json"), { dataVersion: DATA_VERSION, transaction: "restored" });
    const ledger = openStatsLedger(c.groups); ledger.close();
    const statsPath = join(c.groups, "stats.sqlite"), before = await readFile(statsPath);
    expect(await rollback(c)).toBe(false);
    expect(inspectDataVersion(c.project, c.groups).detail).toContain("不成对");
    const plan = (await preview(c)).plan!;
    expect(plan.steps).toEqual([]);
    expect(plan.kind).toBe("registration");
    await apply(c, plan); await commit(c);
    expect(inspectDataVersion(c.project, c.groups).current).toBe(true);
    expect((await json(journalPath))?.phase).toBe("committed");
    expect(await readFile(statsPath)).toEqual(before);
    // Even losing the project commit marker later cannot resurrect an old rollback.
    await publishJson(join(f.root, "data/state/data-version.json"), { dataVersion: DATA_VERSION, transaction: "restored-project" });
    expect(await rollback(c)).toBe(false);
    expect(await readFile(statsPath)).toEqual(before);
  } finally { await f.cleanup(); }
}, migrationBudget(6));

test("preview never runs migration apply and exposes only read operations on the live group root", async () => {
  const f = await fixture(), c = f.context;
  try {
    await writeFile(join(c.groups, "evidence"), "original");
    let applied = false;
    const config = join(f.root, "data/config/runtime.json"), before = await readFile(config);
    const result = await describeMigrations(c, [{
      to: 2,
      async preview(context) {
        expect(context.project).not.toBe(c.project);
        expect(Object.keys(context.groups).sort()).toEqual(["directories", "read"]);
        expect((await context.groups.read("evidence"))?.toString()).toBe("original");
        await expect(context.groups.read("../data/config/runtime.json")).rejects.toThrow("越界");
        return { files: [{ root: "groups", path: "evidence" }], decisions: [], steps: ["fixture"],
          configuration: { [config]: { PI_CACHE_RETENTION: "long" } } };
      },
      async apply(context) { applied = true; await writeFile(join(context.groups, "evidence"), "overwritten"); },
      async validate() {},
    }], [config], async staging => {
      expect((await json(join(staging, "data/config/runtime.json")))?.PI_CACHE_RETENTION).toBe("long");
    });
    expect(result.files).toEqual([join(c.groups, "evidence")]);
    expect(applied).toBe(false);
    expect(await readFile(join(c.groups, "evidence"), "utf8")).toBe("original");
    expect(await readFile(config)).toEqual(before);
  } finally { await f.cleanup(); }
});

test("normal startup ignores a leftover verification flag after the project commit point", async () => {
  const f = await fixture(), c = f.context;
  try {
    await apply(c, (await preview(c)).plan!); await commit(c);
    for (const path of ["src/core/data-version.ts", "scripts/lib/operation-log.ts", "scripts/lib/redact.ts", "src/server/index.ts"]) {
      await mkdir(dirname(join(f.root, path)), { recursive: true }); await copyFile(join(project, path), join(f.root, path));
    }
    await writeFile(join(f.root, "src/server/app.ts"), 'console.log("NORMAL_ENTRY")');
    await writeFile(join(f.root, "src/server/verify.ts"), 'console.log("VERIFY_ENTRY")');
    await writeFile(join(f.root, "data/state/verify-only"), "verify");
    for (const phase of ["committed", "validated"]) {
      const journal = (await json(join(f.root, "data/state/migration.json")))!;
      await publishJson(join(f.root, "data/state/migration.json"), { ...journal, phase });
      const result = await execute([join(f.root, "src/server/index.ts")], f.root, { GROUP_DATA_ROOT: c.groups });
      expect(result.code, result.text).toBe(0);
      expect(result.text).toContain("NORMAL_ENTRY");
      expect(result.text).not.toContain("VERIFY_ENTRY");
    }
  } finally { await f.cleanup(); }
}, migrationBudget(5));

test("the pre-stop preview stages only in --scratch so data can be mounted read-only", async () => {
  const f = await fixture();
  try {
    const scratch = join(f.root, "preview"), plan = join(scratch, "migration-plan.json");
    const list = async () => (await readdir(join(f.root, "data"), { recursive: true })).sort();
    const before = await list(), runtime = await readFile(join(f.root, "data/config/runtime.json"));
    const result = await execute([join(project, "scripts/migrations/run.ts"), "preview", "--decisions-only", "--project", f.root,
      "--groups", f.context.groups, "--scratch", scratch, "--plan", plan], f.root);
    expect(result.code, result.text).toBe(0);
    expect((await json(plan) as { target: number }).target).toBe(DATA_VERSION);
    // Nothing is created under data/ (not even data/runtime/tmp); the staging copy is removed from the scratch directory.
    expect(await list()).toEqual(before);
    expect(await readFile(join(f.root, "data/config/runtime.json"))).toEqual(runtime);
    expect(await readdir(scratch)).toEqual(["migration-plan.json"]);
    // Scratch staging is only for the read-only preview.
    const refused = await execute([join(project, "scripts/migrations/run.ts"), "apply", "--project", f.root, "--groups", f.context.groups, "--scratch", scratch], f.root);
    expect(refused.code, refused.text).toBe(1); expect(refused.text).toContain("--scratch 只能用于 preview");
    expect(await json(join(f.root, "data/state/migration.json"))).toBeNull();
  } finally { await f.cleanup(); }
}, migrationBudget(2));

test("migration preview uses mounted runtime storage when the image temporary directory is unavailable", async () => {
  const f = await fixture();
  try {
    // A file prevents even a privileged test user from creating image-side temporary files.
    await writeFile(join(f.root, "tmp"), "image-owned");
    const before = await readFile(join(f.root, "data/config/runtime.json"));
    expect((await preview(f.context)).plan?.target).toBe(DATA_VERSION);
    expect(await readFile(join(f.root, "tmp"), "utf8")).toBe("image-owned");
    expect(await readFile(join(f.root, "data/config/runtime.json"))).toEqual(before);
    expect(await readdir(join(f.root, "data/runtime/tmp"))).toEqual([]);
    expect(await json(join(f.root, "data/state/migration.json"))).toBeNull();
  } finally { await f.cleanup(); }
}, migrationBudget(1));

test("preflight changes, service leases, missing roots and newer markers cannot silently migrate", async () => {
  const f = await fixture(), c = f.context;
  try {
    const plan = (await preview(c)).plan!;
    await publishJson(join(f.root, "data/config/runtime.json"), { PI_CACHE_RETENTION: "long" });
    await expect(apply(c, plan)).rejects.toThrow("预览后变化");
    const release = await lock(join(f.root, "data/state/service"), { realpath: false });
    try { await expect(apply(c, plan)).rejects.toThrow(); } finally { await release(); }
    await expect(preview({ ...c, groups: join(f.root, "missing") })).rejects.toThrow("目录不存在");
    await publishJson(join(f.root, "data/state/data-version.json"), { dataVersion: 99, transaction: "future" });
    await expect(preview(c)).rejects.toThrow("拒绝降级");
  } finally { await f.cleanup(); }
}, migrationBudget(5));

test("another checkout holding the group root lease blocks the migration, which releases its service lease", async () => {
  const f = await fixture(), c = f.context;
  try {
    const plan = (await preview(c)).plan!;
    const release = await acquireGroupRootLease("other checkout", c.groups, { retries: 0 });
    try { await expect(apply(c, plan)).rejects.toThrow("群数据根"); } finally { await release(); }
    await apply(c, plan);
    await commit(c);
    expect(inspectDataVersion(c.project, c.groups).current).toBe(true);
    expect(await readdir(c.groups)).not.toContain(GROUP_ROOT_LEASE);
  } finally { await f.cleanup(); }
}, migrationBudget(4));

test("current validator prevents registration of invalid runtime and delivery schemas", async () => {
  const f = await fixture(), c = f.context;
  try {
    await publishJson(join(f.root, "data/config/runtime.json"), { unknown: "no" });
    const plan = (await preview(c, false)).plan!;
    await expect(apply(c, plan)).rejects.toThrow("完整校验失败");
    expect(await json(join(f.root, "data/state/data-version.json"))).toBeNull();
    await rollback(c);
    await publishJson(join(f.root, "data/config/runtime.json"), {});
    const db = new Database(join(f.root, "data/state/agent.sqlite"));
    db.exec("CREATE TABLE deliveries (id TEXT)"); db.close();
    // The preview validates only the configuration: before the migration a database may still have the old schema,
    // and the pre-stop preview mounts data read-only. apply checks the databases and refuses to register them.
    const ledgerPlan = (await preview(c)).plan!;
    await expect(apply(c, ledgerPlan)).rejects.toThrow("待补发账本格式不受当前迁移支持");
    expect(await json(join(f.root, "data/state/data-version.json"))).toBeNull();
    await rollback(c);
  } finally { await f.cleanup(); }
}, migrationBudget(4));

test("verification serves health and rejects messages without touching sessions or creating ledgers", async () => {
  const f = await fixture(), c = f.context;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const session = join(c.groups, "group/users/person/session.jsonl");
    await mkdir(dirname(session), { recursive: true }); await writeFile(session, JSON.stringify({ type: "session", version: 3, id: "fixture" }) + "\n");
    await apply(c, (await preview(c)).plan!);
    const probe = Bun.serve({ port: 0, fetch: () => new Response() }), port = String(probe.port); await probe.stop(true);
    child = Bun.spawn([process.execPath, join(project, "src/server/index.ts"), "--verify-only"], {
      cwd: f.root, env: { ...process.env, GROUP_DATA_ROOT: c.groups, BOT_PORT: port, BOT_HOST: "127.0.0.1" },
      stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const deadline = Date.now() + 15000;
    let health: Response | undefined;
    while (Date.now() < deadline) {
      try { health = await fetch(`http://127.0.0.1:${port}/health`); if (health.ok) break; } catch {}
      if (child.exitCode !== null) throw new Error(await new Response(child.stderr as ReadableStream).text());
      await Bun.sleep(50);
    }
    expect(health?.ok).toBe(true);
    expect(await health!.json()).toMatchObject({ verificationOnly: true, status: "ready" });
    const healthCli = join(project, "scripts/ops/health-check.ts");
    expect((await execute([healthCli], f.root, { BOT_PORT: port })).code).toBe(3);
    expect((await execute([healthCli, "--allow-verification"], f.root, { BOT_PORT: port })).code).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", body: "{}" })).status).toBe(503);
    const instance = (await json(join(f.root, "data/state/instance.json")))!;
    await fetch(`http://127.0.0.1:${port}/_admin/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${instance.token}` } });
    expect(await child.exited).toBe(0);
    expect(await readFile(session, "utf8")).toBe(JSON.stringify({ type: "session", version: 3, id: "fixture" }) + "\n");
    expect(await Bun.file(join(c.groups, "stats.sqlite")).exists()).toBe(false);
    expect(await Bun.file(join(f.root, "data/state/agent.sqlite")).exists()).toBe(false);
  } finally { if (child?.exitCode === null) { child.kill(); await child.exited; } await f.cleanup(); }
}, migrationBudget(4, 15_000));

// Copy only the bootstrap graph. Business views and npm dependencies are deliberately absent.
async function copyBootstrap(root: string) {
  for (const path of ["scripts/ops/tui.ts", "scripts/ops/tui/recovery.ts", "scripts/ops/tui/transaction.ts", "scripts/ops/tui/platform.ts", "scripts/lib/confirmed-transaction.ts", "src/core/data-version.ts", "scripts/lib/operation-log.ts", "scripts/lib/redact.ts", "scripts/lib/cli.ts", "src/server/index.ts"]) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await copyFile(join(project, path), join(root, path));
  }
}

test("TUI recovery and service gate load without importing invalid legacy configuration or dependencies", async () => {
  const f = await fixture("none");
  try {
    await copyBootstrap(f.root);
    const tui = await execute([join(f.root, "scripts/ops/tui.ts")], f.root);
    expect(tui.code).toBe(1); expect(tui.text).toContain("尚未登记"); expect(tui.text).not.toContain("Cannot find");
    const service = await execute([join(f.root, "src/server/index.ts")], f.root, { GROUP_DATA_ROOT: f.context.groups });
    expect(service.code).toBe(1); expect(service.text).toContain("尚未登记"); expect(service.text).not.toContain("BOT_MODEL_CACHE_RETENTION");
    const logs = await readdir(join(f.root, "logs/operations")); expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith("startup-");
    expect(await readFile(join(f.root, "logs/operations", logs[0]!), "utf8")).toContain("尚未登记");
  } finally { await f.cleanup(); }
}, migrationBudget(2));

test("TUI 有未完成的事务时按记录判断，普通设置损坏也进入继续或回滚", async () => {
  const f = await fixture("none");
  try {
    await copyBootstrap(f.root);
    const tui = () => execute([join(f.root, "scripts/ops/tui.ts")], f.root, { BOT_PORT: "", BOT_DOMAIN: "" });
    // Only the recorded target root carries a marker, so the detail shows which root the entry inspected.
    const target = join(f.root, "recorded groups"), snapshot = join(f.root, "backup/snapshots/deploy-abc123");
    await mkdir(target); await mkdir(snapshot, { recursive: true });
    await publishJson(join(target, "data-version.json"), { dataVersion: 999, transaction: "fixture" });
    await writeFile(join(snapshot, "transaction"), Object.entries({
      format: "1", operation: "deploy", snapshot: "deploy-abc123", target_sha: "", original_sha: "", original_branch: "",
      original_group_root: f.context.groups, target_group_root: target, was_running: "1", bot_port: "2022", deploy_mode: "direct",
      bot_domain: "", domain_action: "keep", unmanaged_tunnel: "", platform_ip: "203.0.113.17", reconfigure_ai: "0",
    }).map(([key, value]) => `${key}=${value}\n`).join(""));
    await writeFile(join(f.root, "data/state/deploy-transaction"), "deploy-abc123");
    let result = await tui();
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("数据维护：数据版本比代码新");
    // Broken ordinary settings no longer stop the entry before the recovery menu.
    await writeFile(join(f.root, "data/state/bot-port"), "invalid");
    result = await tui();
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("数据维护：普通设置无法读取（端口无效：invalid");
    expect(result.text).toContain("先继续或回滚上次操作");
    // Without a transaction the ordinary settings are loaded first, as before.
    await rm(join(f.root, "data/state/deploy-transaction"));
    result = await tui();
    expect(result.code, result.text).toBe(1); expect(result.text).toContain("端口无效：invalid"); expect(result.text).not.toContain("数据维护");
  } finally { await f.cleanup(); }
}, migrationBudget(3));

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
    // v2 两步，再是 v3 两步（tests/ops/migration-v3.test.ts）。
    expect(plan.steps).toHaveLength(6); expect(plan.steps[0]).toContain("统计账本升到 schema 2");
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
