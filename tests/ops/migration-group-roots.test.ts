// Replacing or restoring the group root after a migration: receipts, commit points and old backups.
import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrationBudget } from "../helpers/migration-budget.ts";
import { fixture } from "../helpers/migration-fixture.ts";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import { DATA_VERSION, inspectDataVersion } from "../../src/core/data-version.ts";
import { openStatsLedger } from "../../src/agent/stats-ledger.ts";

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
    // 未登记的群根从头走一遍：v1 三步，v2、v3、v4、v5 各两步（没有会话可导入，也没有保温设置或脚本 store 要改）。
    expect(result.plan?.steps).toHaveLength(11);
    expect(await readdir(next.groups)).toEqual([]);
    await apply(next, result.plan!); await commit(next);
    expect(inspectDataVersion(next.project, next.groups).current).toBe(true);
    expect(await readdir(next.groups)).toEqual(["data-version.json"]);
    expect(await json(join(next.groups, "data-version.json"))).toEqual(await json(join(f.root, "data/state/data-version.json")));
    expect((await preview(next)).plan?.kind).toBe("verification");
  } finally { await f.cleanup(); }
}, migrationBudget(7));

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
