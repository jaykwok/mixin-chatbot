import { expect, test } from "bun:test";
import { copyFile, cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { lock } from "proper-lockfile";
import { tempFixture } from "../helpers/temp.ts";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { inspectDataVersion } from "../../src/core/data-version.ts";
import { v1 } from "../../scripts/migrations/v1.ts";
import { describeMigrations, previewContext } from "../../scripts/migrations/lib/preview.ts";
import { openStatsLedger } from "../../src/agent/stats-ledger.ts";

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
  const child = Bun.spawn([process.execPath, ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr as ReadableStream).text()]);
  return { code, text: output + errors };
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
    await publishJson(join(next.groups, "data-version.json"), { dataVersion: 1, transaction: "restored-root" });
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
}, 60000);

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
    expect(result.plan?.steps).toHaveLength(3);
    expect(await readdir(next.groups)).toEqual([]);
    await apply(next, result.plan!); await commit(next);
    expect(inspectDataVersion(next.project, next.groups).current).toBe(true);
    expect(await readdir(next.groups)).toEqual(["data-version.json"]);
    expect(await json(join(next.groups, "data-version.json"))).toEqual(await json(join(f.root, "data/state/data-version.json")));
    expect((await preview(next)).plan?.kind).toBe("verification");
  } finally { await f.cleanup(); }
}, 60000);

test("migration decisions and diagnostics work with the original updater export manifest", async () => {
  const f = await fixture("none");
  try {
    const stage = join(f.root, "export");
    // Migration preview can use only the built-ins and paths in the original updater export.
    // The PowerShell orchestrator is not needed by preview (or shipped inside the Linux image).
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
}, 15000);

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
    expect(text).toContain("当前版本完整校验失败"); expect(text).toContain("migration-finished: exit=1");
    expect(text).toContain("rollback-complete: transaction="); expect(text).toContain("backup=");
    expect(text).not.toContain("fixture-key");
  } finally { await f.cleanup(); }
}, 30000);

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
}, 30000);

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
    await publishJson(join(c.groups, "data-version.json"), { dataVersion: 1, transaction: journal.id });
    await apply(c);
    expect((await json(join(f.root, "data/state/migration.json")))?.id).toBe(journal.id);
    await commit(c);
    expect(inspectDataVersion(c.project, c.groups).current).toBe(true);
    expect(await json(join(c.groups, "data-version.json"))).toEqual(await json(join(f.root, "data/state/data-version.json")));
    expect(await rollback(c)).toBe(false);
    expect((await preview(c)).plan?.steps).toEqual([]);
  } finally { await f.cleanup(); }
}, 30000);

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
}, 30000);

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
}, 30000);

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
    await expect(preview(c)).rejects.toThrow("完整校验失败");
  } finally { await f.cleanup(); }
}, 30000);

test("a legacy receipt protects the project commit point and a restored group is re-registered without touching its ledger", async () => {
  const f = await fixture(), c = f.context;
  try {
    await apply(c, (await preview(c)).plan!); await commit(c);
    const journalPath = join(f.root, "data/state/migration.json"), receipt = (await json(journalPath))!;
    // Simulate interruption after the project marker, before persisting the committed phase.
    await publishJson(journalPath, { ...receipt, phase: "validated" });
    await publishJson(join(c.groups, "data-version.json"), { dataVersion: 1, transaction: "restored" });
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
    await publishJson(join(f.root, "data/state/data-version.json"), { dataVersion: 1, transaction: "restored-project" });
    expect(await rollback(c)).toBe(false);
    expect(await readFile(statsPath)).toEqual(before);
  } finally { await f.cleanup(); }
}, 30000);

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
}, 30000);

test("migration preview uses mounted runtime storage when the image temporary directory is unavailable", async () => {
  const f = await fixture();
  try {
    // A file prevents even a privileged test user from creating image-side temporary files.
    await writeFile(join(f.root, "tmp"), "image-owned");
    const before = await readFile(join(f.root, "data/config/runtime.json"));
    expect((await preview(f.context)).plan?.target).toBe(1);
    expect(await readFile(join(f.root, "tmp"), "utf8")).toBe("image-owned");
    expect(await readFile(join(f.root, "data/config/runtime.json"))).toEqual(before);
    expect(await readdir(join(f.root, "data/runtime/tmp"))).toEqual([]);
    expect(await json(join(f.root, "data/state/migration.json"))).toBeNull();
  } finally { await f.cleanup(); }
}, 30000);

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
}, 30000);

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
    await expect(preview(c)).rejects.toThrow("待补发账本格式不受当前迁移支持");
  } finally { await f.cleanup(); }
}, 30000);

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
}, 30000);

test("TUI recovery and service gate load without importing invalid legacy configuration or dependencies", async () => {
  const f = await fixture("none");
  try {
    // Copy only the bootstrap graph. Business views and npm dependencies are deliberately absent.
    for (const path of ["scripts/ops/tui.ts", "scripts/ops/tui/recovery.ts", "scripts/ops/tui/platform.ts", "src/core/data-version.ts", "scripts/lib/operation-log.ts", "scripts/lib/redact.ts", "scripts/lib/cli.ts", "src/server/index.ts"]) {
      await mkdir(dirname(join(f.root, path)), { recursive: true }); await copyFile(join(project, path), join(f.root, path));
    }
    const tui = await execute([join(f.root, "scripts/ops/tui.ts")], f.root);
    expect(tui.code).toBe(1); expect(tui.text).toContain("尚未登记"); expect(tui.text).not.toContain("Cannot find");
    const service = await execute([join(f.root, "src/server/index.ts")], f.root, { GROUP_DATA_ROOT: f.context.groups });
    expect(service.code).toBe(1); expect(service.text).toContain("尚未登记"); expect(service.text).not.toContain("BOT_MODEL_CACHE_RETENTION");
    const logs = await readdir(join(f.root, "logs/operations")); expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith("startup-");
    expect(await readFile(join(f.root, "logs/operations", logs[0]!), "utf8")).toContain("尚未登记");
  } finally { await f.cleanup(); }
}, 30000);
