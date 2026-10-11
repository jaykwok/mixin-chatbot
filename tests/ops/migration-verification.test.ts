// Same-version verification, the verification-only instance, the pre-stop preview and the entries' data-version gates.
import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationBudget } from "../helpers/migration-budget.ts";
import { copyBootstrap, execute, fixture } from "../helpers/migration-fixture.ts";
import { apply, commit, preview } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { DATA_VERSION } from "../../src/core/data-version.ts";
import { v1 } from "../../scripts/migrations/v1.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));

test("matching data versions skip migration code and database copies while retaining validation", async () => {
  const f = await fixture(), c = f.context;
  try {
    await apply(c, (await preview(c)).plan!); await commit(c);
    const marker = await readFile(join(c.groups, "data-version.json"));
    const snapshots = await readdir(join(f.root, "backup/snapshots"));
    // The first migration keeps its recovery copy until the business instance is confirmed healthy.
    expect(snapshots).toHaveLength(1);
    expect((await json(join(f.root, "data/state/migration.json")))?.cleanup).toBe("pending");
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
