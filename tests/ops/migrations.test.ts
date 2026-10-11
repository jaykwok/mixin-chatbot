// Migration runner: preview, decisions, apply, commit, rollback and the guards before a migration starts.
// Group roots: migration-group-roots.test.ts; verification and entry points: migration-verification.test.ts;
// the statistics ledger step: migration-v2.test.ts.
import { expect, test } from "bun:test";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { lock } from "proper-lockfile";
import { migrationBudget } from "../helpers/migration-budget.ts";
import { execute, fixture } from "../helpers/migration-fixture.ts";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { DATA_VERSION, GROUP_ROOT_LEASE, inspectDataVersion } from "../../src/core/data-version.ts";
import { acquireGroupRootLease } from "../../src/core/maintenance.ts";
import { v1 } from "../../scripts/migrations/v1.ts";
import { describeMigrations, previewContext } from "../../scripts/migrations/lib/preview.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));

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
    expect(await readFile(backupPath)).toEqual(backup);
    expect(await readFile(dbPath)).toEqual(original);
    expect(await readFile(join(f.root, "data/config/runtime.json"))).toEqual(runtime);
    expect(await json(join(f.root, "data/state/data-version.json"))).toBeNull();
  } finally { await f.cleanup(); }
}, migrationBudget(2));

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
