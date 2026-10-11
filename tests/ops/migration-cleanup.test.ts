import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tempFixture } from "../helpers/temp.ts";
import { apply, cleanupBackups, commit, finalize, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { digest, json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { DATA_VERSION } from "../../src/core/data-version.ts";
import { lock } from "proper-lockfile";
import { apply as applyCleanup, scan } from "../../scripts/ops/backup-cleanup.ts";

async function fixture() {
  const f = await tempFixture("migration-cleanup-");
  const groups = join(f.root, "groups"), id = randomUUID();
  await mkdir(groups);
  const backup = `backup/snapshots/migration-${id}`, snapshot = join(f.root, backup);
  await mkdir(snapshot, { recursive: true });
  const journal = { format: 1, id, target: DATA_VERSION, steps: [], groups, backup, phase: "committed", kind: "migration", decisions: {},
    files: [{ path: join(f.root, "data/config/runtime.json"), saved: "0", hash: digest(Buffer.from("old")) }], cleanup: "pending" };
  await writeFile(join(snapshot, "0"), "old");
  await publishJson(join(snapshot, "manifest.json"), { ...journal, phase: "applying" });
  await publishJson(join(f.root, "data/state/migration.json"), journal);
  const marker = { dataVersion: DATA_VERSION, transaction: id };
  await publishJson(join(f.root, "data/state/data-version.json"), marker);
  await publishJson(join(groups, "data-version.json"), marker);
  const events: string[] = [];
  const context = { project: f.root, groups, decisions: {}, report: (stage: string) => { events.push(stage); } };
  const receipt = () => json(join(f.root, "data/state/migration-cleanup", id + ".json"));
  const finish = () => finalize(context, { transaction: id });
  return { ...f, snapshot, journal, events, context, receipt, finish };
}

test("数据提交保留迁移副本，正式实例启动后仅清理本事务清单，重试幂等", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "backup/snapshots/manual"), "keep");
    await commit(f.context);
    expect(await readFile(join(f.snapshot, "0"), "utf8")).toBe("old");
    expect(await f.receipt()).toBeNull();
    // A live service owns these leases; finalization must not try to acquire either one.
    const release = await lock(join(f.root, "data/state/service"), { realpath: false });
    try { expect(await f.finish()).toBe(true); } finally { await release(); }
    expect(await readdir(join(f.root, "backup/snapshots"))).toEqual(["manual"]);
    expect((await f.receipt())?.journal.cleanup).toBe("complete");
    expect(f.events).toContain("backup-cleaned");
    await commit(f.context); await f.finish(); expect(await rollback(f.context)).toBe(false);
    expect(await readFile(join(f.root, "backup/snapshots/manual"), "utf8")).toBe("keep");
  } finally { await f.cleanup(); }
});

test("清单外文件与内容变化会保留全部备份，修复后自动重试，部分已删除也可续做", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.snapshot, "unknown"), "keep");
    expect(await f.finish()).toBe(false);
    expect(f.events).toContain("backup-cleanup-pending");
    expect(await readFile(join(f.snapshot, "0"), "utf8")).toBe("old");
    expect((await f.receipt())?.journal.cleanup).toBe("pending");
    // Explicit manifest review remains available after activation, even if automatic cleanup refuses.
    expect(scan(f.root).entries.find(entry => entry.path === f.journal.backup)?.basis.join(" ")).not.toContain("引用");
    await unlink(join(f.snapshot, "unknown"));
    await writeFile(join(f.snapshot, "0"), "changed");
    expect(await cleanupBackups(f.context)).toBe(false);
    expect(await readFile(join(f.snapshot, "0"), "utf8")).toBe("changed");
    // Reproduce an interruption after deleting one owned file, before deleting the manifest.
    await unlink(join(f.snapshot, "0"));
    expect(await cleanupBackups(f.context)).toBe(true);
    expect(await readdir(join(f.root, "backup/snapshots"))).toEqual([]);
    expect((await f.receipt())?.journal.cleanup).toBe("complete");
  } finally { await f.cleanup(); }
});

test("备份目录联接不会被跟随，外部文件保留", async () => {
  const f = await fixture();
  try {
    await unlink(join(f.snapshot, "0"));
    const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "untouched");
    await symlink(outside, join(f.snapshot, "0"), process.platform === "win32" ? "junction" : "dir");
    expect(await f.finish()).toBe(false);
    expect(f.events).toContain("backup-cleanup-pending");
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("untouched");
  } finally { await f.cleanup(); }
});

test("没有自动清理标记的历史事务不会被扫描删除", async () => {
  const f = await fixture();
  try {
    const { cleanup: _, ...legacy } = f.journal;
    await publishJson(join(f.root, "data/state/migration.json"), legacy);
    await commit(f.context);
    await f.finish();
    expect(await readFile(join(f.snapshot, "0"), "utf8")).toBe("old");
    expect(f.events).not.toContain("backup-cleaned");
  } finally { await f.cleanup(); }
});

test.each([true, false])("旧副本独立保留，已获准清理=%s 都不阻断新升级，后续可重试", async ready => {
  const f = await fixture();
  try {
    await publishJson(join(f.root, "data/config/models.json"), { providers: { fixture: {
      baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-key", models: [{
        id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    } } });
    await publishJson(join(f.root, "data/runtime/pi/settings.json"), { defaultProvider: "fixture", defaultModel: "test" });
    await writeFile(join(f.snapshot, "unknown"), "preserve");
    if (ready) expect(await f.finish()).toBe(false);
    await apply(f.context, (await preview(f.context)).plan!);
    expect((await json(join(f.root, "data/state/migration.json")))?.id).not.toBe(f.journal.id);
    expect((await f.receipt())?.ready).toBe(ready);
    expect(await readFile(join(f.snapshot, "unknown"), "utf8")).toBe("preserve");
    await commit(f.context);
    await unlink(join(f.snapshot, "unknown"));
    if (ready) expect(await cleanupBackups(f.context)).toBe(true);
    else {
      await cleanupBackups(f.context);
      expect(await readFile(join(f.snapshot, "0"), "utf8")).toBe("old");
      expect(scan(f.root).entries.find(entry => entry.path === f.journal.backup)?.basis.join(" ")).toContain("尚未确认就绪");
      // A later accepted business startup may explicitly finalize this archived transaction.
      expect(await f.finish()).toBe(true);
    }
    expect(await Bun.file(join(f.snapshot, "manifest.json")).exists()).toBe(false);
  } finally { await f.cleanup(); }
}, 60000);

test("未正式启动的事务不能被 cleanup 或另一个部署的 finalize 清理", async () => {
  const f = await fixture();
  try {
    await commit(f.context);
    await cleanupBackups(f.context);
    await expect(finalize(f.context, { deployment: "deploy-other" })).rejects.toThrow("事务标识不匹配");
    expect(await readFile(join(f.snapshot, "0"), "utf8")).toBe("old");
    await publishJson(join(f.root, "data/state/migration-cleanup", f.journal.id + ".json"), { format: 1, ready: false, journal: f.journal });
    await cleanupBackups(f.context);
    expect(await readFile(join(f.snapshot, "0"), "utf8")).toBe("old");
    expect(scan(f.root).entries.find(entry => entry.path === f.journal.backup)?.basis.join(" ")).toContain("迁移日志");
  } finally { await f.cleanup(); }
});

test("自动清理异常的已就绪快照可经独立清单审查删除，无需篡改迁移回执", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.snapshot, "unknown"), "reviewed synthetic addition");
    expect(await f.finish()).toBe(false);
    const scanned = scan(f.root), manifestPath = join(f.root, "tmp/backup-cleanup", scanned.report!, "manifest.json");
    const manifest = (await json(manifestPath))!;
    manifest.entries.find((entry: { path: string }) => entry.path === f.journal.backup).action = "delete";
    await publishJson(manifestPath, manifest);
    const preview = applyCleanup(f.root, scanned.report!);
    const deleted = applyCleanup(f.root, scanned.report!, preview.code);
    expect(deleted.results.find(entry => entry.path === f.journal.backup)?.outcome).toBe("deleted");
    expect(await cleanupBackups(f.context)).toBe(true);
    expect((await f.receipt())?.journal.cleanup).toBe("complete");
  } finally { await f.cleanup(); }
});
