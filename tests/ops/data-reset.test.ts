import { expect, spyOn, test } from "bun:test";
import { mkdir, writeFile, readFile, cp, rename, symlink, rm } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { DATA_VERSION, inspectDataVersion } from "../../src/core/data-version.ts";
import { openStatsLedger, ingestConversationRecords } from "../../src/agent/stats-ledger.ts";
import { prepareResetDraft, makeResetPlan, statsDigest, resetVersion, applyReset, rollbackReset, verifyReset, finishReset, settleResetDraft, offerResetModels, discardResetModels } from "../../scripts/runtime/data-reset.ts";
import { validateConfiguration } from "../../src/core/data-validation.ts";
import { checkResetModels } from "../../scripts/runtime/reset-model-check.ts";
import { openRelayIndex, readRelayIndex } from "../../src/integrations/relay-index.ts";
import { writeCurrentConfig } from "../helpers/current-config.ts";
import { tempFixture } from "../helpers/temp.ts";
import { freezeStats } from "../../scripts/runtime/stats-freeze.ts";
import { acquireLease, acquireGroupRootLease } from "../../src/core/maintenance.ts";
import { holdDirectory } from "../../src/core/held-directory.ts";

const runner = fileURLToPath(new URL("../../scripts/runtime/data-current.ts", import.meta.url));
const id = "deploy-reset123";
async function fixture(incompleteJsonl = false, settings?: (project: string) => Promise<void>) {
  const f = await tempFixture("data-reset-"), project = f.root, groups = join(project, "groups"), snapshot = join(project, "backup/snapshots", id);
  await mkdir(join(groups, "g/workspace"), { recursive: true });
  await mkdir(join(project, "data/state"), { recursive: true });
  await mkdir(snapshot, { recursive: true });
  await writeCurrentConfig(project);
  for (const path of [join(project, "data/state/data-version.json"), join(groups, "data-version.json")])
    await writeFile(path, JSON.stringify({ dataVersion: DATA_VERSION - 1, transaction: "old" }));
  await writeFile(join(project, "data/config/webhook-secret"), "a".repeat(64));
  await writeFile(join(project, "data/config/cloudflared-token"), "private-test-token");
  await writeFile(join(project, "data/config/obsolete.json"), "old-config");
  await writeFile(join(project, "data/runtime/bot-launcher.ps1"), "generated-host-launcher");
  await writeFile(join(project, "data/state/agent.sqlite"), "old-outbox");
  await writeFile(join(groups, "g/workspace/old.txt"), "old-reference");
  await writeFile(join(groups, "g/durable.sqlite"), "old-session");
  const kept = ["g/workspace/资料/reference.sqlite", "g/other-materials/book.pdf", "g/stats.sqlite", "g/venv/keep.txt",
    "g/users/u/notes.txt", "g/users/u/materials/reference.sqlite", "2081562792700661761/workspace/资料.docx",
    "2081562792700661761/notes.txt", ".reclamation/backup/rm/previous.txt", "root-materials.sqlite", "g/index/ignore.txt"];
  const cleared = ["g/index/nested/materials.md", "g/index/materials.md.manifest.json","g/users/u/session.jsonl", "g/users/u/tmp/output.docx",
    "g/durable.sqlite-wal", "g/durable.sqlite-shm", "g/durable.sqlite-journal", "g/other.sqlite", "g/other.sqlite-wal",
    "2081562792700661761/durable.sqlite", "2081562792700661761/users/u/tmp/old.pdf"];
  for (const name of [...kept, ...cleared]) {
    const path = join(groups, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, name);
  }
  const db = openStatsLedger(groups);
  ingestConversationRecords(db, { id: "old-source", group: "g", user: "u", identity: "member" }, 0, 1,
    [{ type: "message", timestamp: "2026-10-17T01:00:00Z", message: { role: "user", content: [{ type: "text" }] } }]);
  if (incompleteJsonl) db.exec("UPDATE sources SET projection = 2, pending = 1, archived_at = 123");
  db.close();
  await settings?.(project);
  const before = statsDigest(join(groups, "stats.sqlite"));
  const draft = join(project, "draft"); await prepareResetDraft(project, groups, draft); await writeCurrentConfig(draft);
  const plan = makeResetPlan(project, groups, draft);
  await cp(draft, join(snapshot, "reset-config"), { recursive: true });
  await writeFile(join(snapshot, "data-plan.json"), JSON.stringify({ format: 1, dataVersion: DATA_VERSION, reset: plan }));
  await writeFile(join(snapshot, "stats-frozen.json"), JSON.stringify({ digest: before, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  const run = async (action: string) => {
    const child = Bun.spawn([process.execPath, runner, action, "--project", project, "--groups", groups, "--deployment", id,
      "--plan", join(snapshot, "data-plan.json")], { cwd: project, env: { ...process.env, BOT_OPERATION_LOG: "", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, text: out + err };
  };
  return { ...f, project, groups, snapshot, draft, plan, before, run, kept, cleared };
}

test("data-version equality bypasses reset; only a lower matched pair offers reset", async () => {
  const f = await fixture();
  try {
    expect((await f.run("probe")).code).toBe(20);
    expect(inspectDataVersion(f.project, f.groups).detail).toContain("通过 update");
    expect(inspectDataVersion(f.project, f.groups).detail).not.toContain("不成对");
    for (const version of [DATA_VERSION, DATA_VERSION + 1]) {
      for (const path of [join(f.project, "data/state/data-version.json"), join(f.groups, "data-version.json")])
        await writeFile(path, JSON.stringify({ dataVersion: version, transaction: "same" }));
      if (version === DATA_VERSION) { expect(resetVersion(f.project, f.groups)).toBeNull(); expect((await f.run("probe")).code).toBe(0); }
      else {
        expect(() => resetVersion(f.project, f.groups)).toThrow("降级");
        expect(inspectDataVersion(f.project, f.groups).detail).toContain("降级");
      }
    }
    await writeFile(join(f.groups, "data-version.json"), JSON.stringify({ dataVersion: DATA_VERSION - 1, transaction: "different" }));
    expect(() => resetVersion(f.project, f.groups)).toThrow("不成对");
    expect(inspectDataVersion(f.project, f.groups).detail).toContain("不成对");
    expect(await readFile(join(f.groups, "g/durable.sqlite"), "utf8")).toBe("old-session");
  } finally { await f.cleanup(); }
}, 60000);

test("reset preserves all stats rows and entrance credentials, commits and deletes only temporary session backups", async () => {
  const f = await fixture(true);
  try {
    const directory = lstatSync(join(f.groups, "g/workspace"));
    for (const action of ["apply", "apply", "validate", "commit", "commit", "finish-reset", "finish-reset"]) {
      const result = await f.run(action); expect(result.code, result.text).toBe(0);
      for (const name of f.kept) expect(await readFile(join(f.groups, name), "utf8")).toBe(name);
      expect(await readFile(join(f.groups, "g/workspace/old.txt"), "utf8")).toBe("old-reference");
      expect(lstatSync(join(f.groups, "g/workspace")).ino).toBe(directory.ino);
    }
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
    expect(statsDigest(join(f.project, "backup/statistics", id, "stats.sqlite"))).toBe(f.before);
    expect(JSON.parse(await readFile(join(f.project, "backup/statistics", id, "baseline.json"), "utf8")).incompleteJsonl).toEqual({ sources: 1, lines: 1 });
    expect(await readFile(join(f.project, "data/config/webhook-secret"), "utf8")).toBe("a".repeat(64));
    expect(await readFile(join(f.project, "data/config/cloudflared-token"), "utf8")).toBe("private-test-token");
    for (const path of ["g/durable.sqlite", ...f.cleared, ".reset-" + id]) expect(existsSync(join(f.groups, path))).toBe(false);
    expect(existsSync(join(f.project, "data/config/obsolete.json"))).toBe(false);
    expect(await readFile(join(f.project, "data/runtime/bot-launcher.ps1"), "utf8")).toBe("generated-host-launcher");
    expect((await f.run("rollback")).code).toBe(42);
  } finally { await f.cleanup(); }
}, 60000);

test("an actual reset journal still enforces link boundaries, deployment identity and valid content", async () => {
  const f = await fixture();
  try {
    const alias = join(f.project, "linked-groups");
    await symlink(f.groups, alias, process.platform === "win32" ? "junction" : "dir");
    const journal = join(f.snapshot, "reset.json");
    await writeFile(journal, "{}");
    expect(() => verifyReset(f.project, alias, id)).toThrow("链接");
    await expect(rollbackReset(f.project, alias, id)).rejects.toThrow("链接");
    await expect(finishReset(f.project, alias, id)).rejects.toThrow("链接");
    await writeFile(journal, "null");
    expect(() => verifyReset(f.project, f.groups, id)).toThrow("记录无效");
    await writeFile(journal, "{");
    await expect(finishReset(f.project, f.groups, id)).rejects.toThrow();
    await expect(rollbackReset(f.project, f.groups, "../outside")).rejects.toThrow("发布事务");
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
  } finally { await f.cleanup(); }
});

test("reset refuses journals that could move whole groups, materials or statistics", async () => {
  const f = await fixture();
  try {
    await applyReset(f.project, f.groups, id, f.plan);
    const path = join(f.snapshot, "reset.json"), journal = JSON.parse(await readFile(path, "utf8"));
    for (const name of ["g", "g/workspace", "g/users/u", "g/users/u/materials", "stats.sqlite", "g/stats.sqlite", "g/workspace/reference.sqlite", "g/../outside.sqlite",
      "g/index/ignore.txt", "g/index/IGNORE.TXT", "g/index/nested/materials.md"]) {
      await writeFile(path, JSON.stringify({ ...journal, moves: [...journal.moves, { area: "groups", name, existed: true }] }));
      await expect(applyReset(f.project, f.groups, id, f.plan)).rejects.toThrow();
      await expect(rollbackReset(f.project, f.groups, id)).rejects.toThrow();
      await expect(finishReset(f.project, f.groups, id)).rejects.toThrow();
      for (const item of f.kept) expect(await readFile(join(f.groups, item), "utf8")).toBe(item);
    }
    await writeFile(path, JSON.stringify({ ...journal, format: 1 }));
    await expect(finishReset(f.project, f.groups, id)).rejects.toThrow("记录无效");
    await writeFile(path, JSON.stringify(journal));
    await rollbackReset(f.project, f.groups, id);
  } finally { await f.cleanup(); }
});

test("reset archive cleanup preserves unexpected material instead of recursively deleting it", async () => {
  const f = await fixture();
  try {
    await applyReset(f.project, f.groups, id, f.plan);
    const unexpected = join(f.groups, ".reset-" + id, "g/workspace");
    await mkdir(unexpected, { recursive: true }); await writeFile(join(unexpected, "keep.txt"), "do not discard");
    await expect(finishReset(f.project, f.groups, id)).rejects.toThrow("未列入清单");
    expect(await readFile(join(unexpected, "keep.txt"), "utf8")).toBe("do not discard");
    for (const name of f.kept) expect(await readFile(join(f.groups, name), "utf8")).toBe(name);
  } finally { await f.cleanup(); }
});

test("reset refuses database-shaped directories and linked cleanup paths without touching materials", async () => {
  const f = await fixture();
  try {
    const fake = join(f.groups, "g/not-a-database.sqlite");
    await mkdir(fake); await writeFile(join(fake, "material.txt"), "keep");
    await expect(applyReset(f.project, f.groups, id, f.plan)).rejects.toThrow("不是普通文件");
    expect(await readFile(join(fake, "material.txt"), "utf8")).toBe("keep");
    await rename(fake, join(f.groups, "g/material-folder"));
    const index = join(f.groups, "g/index"); await rename(index, join(f.groups, "g/old-index"));
    await symlink(join(f.groups, "g/workspace"), index, process.platform === "win32" ? "junction" : "dir");
    await expect(applyReset(f.project, f.groups, id, f.plan)).rejects.toThrow("链接");
    expect(await readFile(join(f.groups, "g/durable.sqlite"), "utf8")).toBe("old-session");
    expect(await readFile(join(f.groups, "g/old-index/ignore.txt"), "utf8")).toBe("g/index/ignore.txt");
    for (const name of f.kept.filter(name => !name.startsWith("g/index/"))) expect(await readFile(join(f.groups, name), "utf8")).toBe(name);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "win32")("reset never moves a group or workspace even when a material directory is held open", async () => {
  const f = await fixture();
  let held: Awaited<ReturnType<typeof holdDirectory>> | undefined;
  try {
    held = await holdDirectory(join(f.groups, "g/workspace"), [], false);
    for (const action of ["apply", "commit", "finish-reset"]) {
      const result = await f.run(action); expect(result.code, result.text).toBe(0);
    }
    expect(await readFile(join(f.groups, "g/workspace/old.txt"), "utf8")).toBe("old-reference");
  } finally { await held?.release(); await f.cleanup(); }
}, 60000);

test("reset rollback restores configuration, session, outbox and markers and can be retried", async () => {
  const f = await fixture();
  try {
    expect((await f.run("apply")).code).toBe(0);
    // Configuration renames must remain inside data/, which is a separate Docker mount from backup/.
    expect(await readFile(join(f.project, "data/.reset-" + id, "config/obsolete.json"), "utf8")).toBe("old-config");
    expect((await f.run("finish-reset")).code).toBe(1);
    await writeFile(join(f.groups, "g/workspace/during-reset.txt"), "new reference must survive rollback");
    await mkdir(join(f.groups, "new-group/workspace"), { recursive: true });
    await writeFile(join(f.groups, "new-group/workspace/keep.txt"), "new group material");
    await writeFile(join(f.groups, "new-group/durable.sqlite"), "new-runtime");
    for (const action of ["rollback", "rollback"]) { const r = await f.run(action); expect(r.code, r.text).toBe(0); }
    for (const name of [...f.kept, ...f.cleared]) expect(await readFile(join(f.groups, name), "utf8")).toBe(name);
    expect(await readFile(join(f.groups, "g/workspace/during-reset.txt"), "utf8")).toBe("new reference must survive rollback");
    expect(await readFile(join(f.groups, "new-group/workspace/keep.txt"), "utf8")).toBe("new group material");
    expect(existsSync(join(f.groups, "new-group/durable.sqlite"))).toBe(false);
    expect(await readFile(join(f.groups, "g/durable.sqlite"), "utf8")).toBe("old-session");
    expect(await readFile(join(f.project, "data/state/agent.sqlite"), "utf8")).toBe("old-outbox");
    expect(await readFile(join(f.project, "data/config/obsolete.json"), "utf8")).toBe("old-config");
    expect(resetVersion(f.project, f.groups)).toBe(DATA_VERSION - 1);
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
  } finally { await f.cleanup(); }
});

test("reset leaves index/ignore.txt in place while clearing the rest of the index", async () => {
  const f = await fixture();
  try {
    const ignore = join(f.groups, "g/index/ignore.txt"), inode = lstatSync(ignore).ino;
    await applyReset(f.project, f.groups, id, f.plan);
    expect(lstatSync(ignore).ino).toBe(inode);
    expect(existsSync(join(f.groups, ".reset-" + id, "g/index/ignore.txt"))).toBe(false);
    for (const name of ["g/index/nested", "g/index/materials.md.manifest.json"]) expect(existsSync(join(f.groups, name))).toBe(false);
    expect(verifyReset(f.project, f.groups, id)).toBe(true);
    // The list is never part of the move set, so edits made while the reset is pending survive a rollback.
    await writeFile(ignore, "edited during reset");
    await rollbackReset(f.project, f.groups, id);
    expect(await readFile(ignore, "utf8")).toBe("edited during reset");
    for (const name of f.cleared) expect(await readFile(join(f.groups, name), "utf8")).toBe(name);
  } finally { await f.cleanup(); }
});

test("rollback of a journal that moved index whole restores every index entry", async () => {
  const f = await fixture();
  try {
    await applyReset(f.project, f.groups, id, f.plan);
    // Rebuild what an earlier version's apply leaves: the whole index archived and one g/index move in the journal.
    const live = join(f.groups, "g/index"), saved = join(f.groups, ".reset-" + id, "g/index");
    await rename(join(live, "ignore.txt"), join(saved, "ignore.txt")); await rm(live, { recursive: true });
    const path = join(f.snapshot, "reset.json"), journal = JSON.parse(await readFile(path, "utf8"));
    const at = journal.moves.findIndex((m: { name: string }) => m.name.startsWith("g/index/"));
    const moves = journal.moves.filter((m: { name: string }) => !m.name.startsWith("g/index/"));
    moves.splice(at, 0, { area: "groups", name: "g/index", existed: true });
    await writeFile(path, JSON.stringify({ ...journal, moves }));
    expect(verifyReset(f.project, f.groups, id)).toBe(true);
    // A verification instance may already have generated a fresh index; rollback replaces it with the original.
    await mkdir(live); await writeFile(join(live, "materials.md"), "new generation");
    await rollbackReset(f.project, f.groups, id);
    for (const name of [...f.kept, ...f.cleared]) expect(await readFile(join(f.groups, name), "utf8")).toBe(name);
    expect(existsSync(join(live, "materials.md"))).toBe(false);
    expect(existsSync(join(f.groups, ".reset-" + id))).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).phase).toBe("restored");
  } finally { await f.cleanup(); }
});

test("reset lists every unrecognised index entry before moving anything; later ones are left alone", async () => {
  const f = await fixture();
  try {
    const index = join(f.groups, "g/index"), other = join(f.groups, "2081562792700661761/index");
    await mkdir(other); await writeFile(join(index, ".DS_Store"), "finder"); await writeFile(join(other, ".hidden"), "unknown");
    const failure = await applyReset(f.project, f.groups, id, f.plan).then(() => null, error => error as Error);
    expect(failure?.message).toContain("未移动任何数据");
    for (const path of [join(index, ".DS_Store"), join(other, ".hidden")]) expect(failure?.message).toContain(path);
    expect(await readFile(join(f.groups, "g/durable.sqlite"), "utf8")).toBe("old-session");
    expect(existsSync(join(f.snapshot, "reset.json"))).toBe(false);
    await rm(join(index, ".DS_Store")); await rm(join(other, ".hidden"));
    // Once the moves are planned, an entry that appears later blocks neither commit checks nor rollback and is kept.
    await applyReset(f.project, f.groups, id, f.plan);
    await writeFile(join(index, ".DS_Store"), "finder");
    expect(verifyReset(f.project, f.groups, id)).toBe(true);
    await rollbackReset(f.project, f.groups, id);
    expect(await readFile(join(index, ".DS_Store"), "utf8")).toBe("finder");
    for (const name of f.cleared) expect(await readFile(join(f.groups, name), "utf8")).toBe(name);
  } finally { await f.cleanup(); }
});

test("reset moves a non-directory index whole and restores it on rollback", async () => {
  const f = await fixture();
  try {
    const index = join(f.groups, "g/index");
    await rm(index, { recursive: true }); await writeFile(index, "legacy index file");
    await applyReset(f.project, f.groups, id, f.plan);
    expect(existsSync(index)).toBe(false);
    expect(await readFile(join(f.groups, ".reset-" + id, "g/index"), "utf8")).toBe("legacy index file");
    await rollbackReset(f.project, f.groups, id);
    expect(await readFile(index, "utf8")).toBe("legacy index file");
  } finally { await f.cleanup(); }
});

for (const action of ["apply", "rollback"] as const) test.skipIf(process.platform !== "win32")(
  `Windows reset ${action} waits for a real directory handle to close before moving it`, async () => {
    const f = await fixture();
    let held: Awaited<ReturnType<typeof holdDirectory>> | undefined;
    let released: Promise<void> | undefined;
    try {
      if (action === "rollback") await applyReset(f.project, f.groups, id, f.plan);
      const group = join(f.groups, ...(action === "rollback" ? [".reset-" + id] : []), "g/index");
      held = await holdDirectory(join(group, "nested"), [], false);
      // A handle inside the directory also prevents renaming its ancestor on Windows.
      const blocked = await rename(group, group + "-probe").then(() => null, error => error as NodeJS.ErrnoException);
      expect(["EPERM", "EACCES", "EBUSY"]).toContain(blocked?.code ?? "rename unexpectedly succeeded");
      released = Bun.sleep(700).then(() => held!.release());
      if (action === "apply") await applyReset(f.project, f.groups, id, f.plan);
      else await rollbackReset(f.project, f.groups, id);
      await released;
      expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
      const finalGroup = join(f.groups, ...(action === "apply" ? [".reset-" + id] : []), "g");
      expect(await readFile(join(finalGroup, "durable.sqlite"), "utf8")).toBe("old-session");
      expect(await readFile(join(f.project, "data/config/webhook-secret"), "utf8")).toBe("a".repeat(64));
    } finally { await released; await held?.release(); await f.cleanup(); }
  }, 30000);

test.skipIf(process.platform !== "win32")("Windows reset refuses a persistently held directory with actionable diagnostics and remains rollbackable", async () => {
  const f = await fixture();
  let held: Awaited<ReturnType<typeof holdDirectory>> | undefined;
  try {
    held = await holdDirectory(join(f.groups, "g/index/nested"), [], false);
    const started = performance.now();
    const failure = await applyReset(f.project, f.groups, id, f.plan).then(() => null, error => error as Error);
    expect(failure?.message).toContain("重置路径移动失败");
    expect(failure?.message).toContain(join(f.groups, "g"));
    expect(failure?.message).toContain("占用");
    expect(failure?.message).toMatch(/错误码 (EPERM|EACCES|EBUSY).*尝试 \d+ 次.*耗时 \d+ ms/);
    expect(performance.now() - started).toBeGreaterThanOrEqual(9000);
    expect(performance.now() - started).toBeLessThan(20000);
    expect(await readFile(join(f.groups, "g/durable.sqlite"), "utf8")).toBe("old-session");
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
    expect(statsDigest(join(f.project, "backup/statistics", id, "stats.sqlite"))).toBe(f.before);
    await held.release();
    await rollbackReset(f.project, f.groups, id);
    expect(resetVersion(f.project, f.groups)).toBe(DATA_VERSION - 1);
    expect(await readFile(join(f.project, "data/config/cloudflared-token"), "utf8")).toBe("private-test-token");
    expect(existsSync(join(f.groups, ".reset-" + id))).toBe(false);
  } finally { await held?.release(); await f.cleanup(); }
}, 30000);

test("configuration or ledger changes after preview block reset before any old data is moved", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.project, "data/config/obsolete.json"), "changed");
    expect((await f.run("apply")).text).toContain("预览后");
    await writeFile(join(f.project, "data/config/obsolete.json"), "old-config");
    const db = new Database(join(f.groups, "stats.sqlite")); db.exec("UPDATE activity SET asks = asks + 1"); db.close();
    expect((await f.run("apply")).text).toContain("冻结");
    expect(await readFile(join(f.groups, "g/durable.sqlite"), "utf8")).toBe("old-session");
  } finally { await f.cleanup(); }
});

test("statistics mismatch before commit keeps old sessions available for rollback", async () => {
  const f = await fixture();
  try {
    expect((await f.run("apply")).code).toBe(0);
    const db = new Database(join(f.groups, "stats.sqlite")); db.exec("UPDATE activity SET asks = asks + 1"); db.close();
    expect((await f.run("commit")).text).toContain("统计不一致");
    expect(existsSync(join(f.groups, ".reset-" + id, "g/durable.sqlite"))).toBe(true);
  } finally { await f.cleanup(); }
});

test("interrupted rename journal resumes apply and rollback without adopting the partial new generation", async () => {
  const f = await fixture();
  try {
    await applyReset(f.project, f.groups, id, f.plan);
    const path = join(f.snapshot, "reset.json"), journal = JSON.parse(await readFile(path, "utf8"));
    journal.phase = "moving"; await writeFile(path, JSON.stringify(journal));
    // Simulate a crash before the final original group rename and before draft publication.
    await rename(join(f.groups, ".reset-" + id, "g/durable.sqlite"), join(f.groups, "g/durable.sqlite"));
    await applyReset(f.project, f.groups, id, f.plan);
    await rollbackReset(f.project, f.groups, id);
    expect(await readFile(join(f.groups, "g/durable.sqlite"), "utf8")).toBe("old-session");
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
  } finally { await f.cleanup(); }
});

test("committed archive cleanup runs while the activated service owns its leases", async () => {
  const f = await fixture();
  let release: (() => Promise<void>) | undefined, releaseGroups: (() => Promise<void>) | undefined;
  try {
    expect((await f.run("apply")).code).toBe(0); expect((await f.run("commit")).code).toBe(0);
    release = await acquireLease("fixture-service", join(f.project, "data/state/service"));
    releaseGroups = await acquireGroupRootLease("fixture-service", f.groups);
    const result = await f.run("finish-reset"); expect(result.code, result.text).toBe(0);
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
  } finally { await releaseGroups?.(); await release?.(); await f.cleanup(); }
}, 60000);

const relay = { provider: "s3", endpoint: "https://s3.example.test", region: "test-region", bucket: "test-bucket",
  accessKeyId: "fixture-ak", secretAccessKey: "fixture-sk", expireHours: 12 };
const mcp = { format: 1, servers: [{ name: "docs", tools: ["search"], transport: "http", url: "https://mcp.example.test/" }] };
const office = process.platform === "win32" ? "C:/LibreOffice/program/soffice.exe" : "/usr/bin/soffice";
async function adminSettings(project: string, relayConfig: unknown = relay) {
  const config = join(project, "data/config");
  await writeFile(join(config, "relay.json"), JSON.stringify(relayConfig));
  await writeFile(join(config, "runtime.json"), JSON.stringify({ BOT_PORT: "9999", BOT_DOCUMENT_PPTX_TEMPLATE: "模板/默认.pptx",
    BOT_DOCUMENT_OFFICE_PATH: office, BOT_INDEX_TTL_MINUTES: 30, BOT_RUN_TIMEOUT_SECONDS: "99999",
    BOT_TASK_IMAGE: "sha256:" + "a".repeat(64), BOT_RETIRED_SETTING: "1" }));
  await writeFile(join(config, "auxiliary.json"), JSON.stringify({ format: 1, maxConcurrent: 3 }));
  await writeFile(join(config, "mcp.json"), JSON.stringify(mcp));
  await writeFile(join(config, "cloudflared-protocol"), "quic\n");
  await writeFile(join(config, "cloudflared-logging"), "verbose");
  const ledger = await openRelayIndex(join(project, "data/state/relay.sqlite"));
  try {
    await ledger.remember({ key: "ns:digest:report.pdf", url: "https://test-bucket.s3.example.test/report.pdf", name: "report.pdf", size: 1,
      at: "2026-10-18T00:00:00Z", state: "uploaded", expiresAt: "2026-10-18T12:00:00Z", deleteAfter: "2026-10-18T12:10:00Z" });
  } finally { ledger.close(); }
}

test("reset carries administrator settings the target version accepts and drops only the rejected ones", async () => {
  const f = await fixture(false, project => adminSettings(project));
  try {
    const log = spyOn(console, "log").mockImplementation(() => {});
    let printed: string;
    try { await prepareResetDraft(f.project, f.groups, join(f.project, "draft-2")); printed = log.mock.calls.flat().join("\n"); }
    finally { log.mockRestore(); }
    for (const name of ["relay.json", "auxiliary.json", "mcp.json", "cloudflared-protocol", "BOT_DOCUMENT_PPTX_TEMPLATE", "BOT_INDEX_TTL_MINUTES"])
      expect(printed).toContain(name);
    expect(printed).toContain("BOT_RUN_TIMEOUT_SECONDS（BOT_RUN_TIMEOUT_SECONDS 必须是 10-7200 的整数）");
    expect(printed).toContain("cloudflared-logging（只接受 off、on）");
    for (const name of ["BOT_TASK_IMAGE", "BOT_RETIRED_SETTING", "BOT_PORT"]) expect(printed).not.toContain(name);
    for (const action of ["apply", "validate", "commit", "finish-reset"]) {
      const result = await f.run(action); expect(result.code, result.text).toBe(0);
    }
    const config = join(f.project, "data/config"), json = async (name: string) => JSON.parse(await readFile(join(config, name), "utf8"));
    expect(await json("relay.json")).toEqual(relay);
    expect(await json("mcp.json")).toEqual(mcp);
    expect(await json("auxiliary.json")).toEqual({ format: 1, maxConcurrent: 3 });
    expect(await readFile(join(config, "cloudflared-protocol"), "utf8")).toBe("quic\n");
    expect(existsSync(join(config, "cloudflared-logging"))).toBe(false);
    expect(await json("runtime.json")).toEqual({ BOT_DOCUMENT_PPTX_TEMPLATE: "模板/默认.pptx", BOT_DOCUMENT_OFFICE_PATH: office,
      BOT_INDEX_TTL_MINUTES: "30", GROUP_DATA_ROOT: f.groups, BOT_PORT: "1011", BOT_HOST: "0.0.0.0" });
    // Objects uploaded before the reset keep their cleanup record.
    expect(readRelayIndex(join(f.project, "data/state/relay.sqlite")).map(entry => entry.name)).toEqual(["report.pdf"]);
    expect(existsSync(join(f.project, "data/state/agent.sqlite"))).toBe(false);
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
  } finally { await f.cleanup(); }
}, 60000);

test("a relay configuration the target rejects is reset with its ledger, and rollback restores both", async () => {
  const f = await fixture(false, project => adminSettings(project, { ...relay, provider: "ftp" }));
  try {
    const result = await f.run("apply"); expect(result.code, result.text).toBe(0);
    expect(existsSync(join(f.project, "data/config/relay.json"))).toBe(false);
    expect(existsSync(join(f.project, "data/state/relay.sqlite"))).toBe(false);
    expect(await readFile(join(f.project, "data/config/mcp.json"), "utf8")).toBe(JSON.stringify(mcp));
    expect((await f.run("rollback")).code).toBe(0);
    expect(JSON.parse(await readFile(join(f.project, "data/config/relay.json"), "utf8")).provider).toBe("ftp");
    expect(readRelayIndex(join(f.project, "data/state/relay.sqlite")).length).toBe(1);
    expect(await readFile(join(f.project, "data/config/cloudflared-logging"), "utf8")).toBe("verbose");
  } finally { await f.cleanup(); }
}, 60000);

test("settings are judged by the readers the target runs, so a kept file never fails later in the preview", async () => {
  const bom = String.fromCharCode(0xfeff);
  const f = await fixture(false, async project => {
    const config = join(project, "data/config");
    // The service reads relay.json and runtime.json without stripping a BOM; the MCP reader strips it.
    await writeFile(join(config, "relay.json"), bom + JSON.stringify(relay));
    await writeFile(join(config, "runtime.json"), bom + JSON.stringify({ BOT_INDEX_TTL_MINUTES: 30 }));
    await writeFile(join(config, "mcp.json"), bom + JSON.stringify(mcp));
    // PowerShell drops the BOM and trims the whole text; Linux sed keeps the BOM and trims each line.
    await writeFile(join(config, "cloudflared-logging"), bom + "on\r\n");
    await writeFile(join(config, "cloudflared-protocol"), "\nquic");
  });
  try {
    const draft = join(f.project, "draft-bom"), config = join(draft, "data/config");
    const log = spyOn(console, "log").mockImplementation(() => {});
    let printed: string;
    try { await prepareResetDraft(f.project, f.groups, draft); printed = log.mock.calls.flat().join("\n"); }
    finally { log.mockRestore(); }
    expect(existsSync(join(config, "relay.json"))).toBe(false);
    expect(printed).toContain("relay.json（");
    expect(printed).toContain("runtime.json 运行设置（不是有效 JSON）");
    expect(JSON.parse(await readFile(join(config, "runtime.json"), "utf8")).BOT_INDEX_TTL_MINUTES).toBeUndefined();
    expect(await readFile(join(config, "mcp.json"), "utf8")).toBe(bom + JSON.stringify(mcp));
    const windows = process.platform === "win32";
    for (const name of ["cloudflared-logging", "cloudflared-protocol"]) expect(existsSync(join(config, name))).toBe(windows);
    await writeCurrentConfig(draft);
    await validateConfiguration(draft);
  } finally { await f.cleanup(); }
}, 60000);

const modelFiles = ["data/config/models.json", "data/runtime/pi/settings.json", "data/runtime/models-store.json"];

test("old model files never cross a reset by being present; one the target Pi rejects leaves the wizard an empty draft", async () => {
  const f = await fixture(false, async project => {
    await writeFile(join(project, "data/config/models.json"), "old-models");
    await writeFile(join(project, "data/runtime/models-store.json"), "{}");
  });
  try {
    const bare = join(f.project, "draft-bare");
    await prepareResetDraft(f.project, f.groups, bare);
    for (const name of modelFiles) expect(existsSync(join(bare, name))).toBe(false);
    expect(() => makeResetPlan(f.project, f.groups, bare)).toThrow("草稿中没有模型配置");
    const rejected = await offerResetModels(f.project, bare);
    expect("reason" in rejected && rejected.reason).toContain("models.json");
    for (const name of modelFiles) expect(existsSync(join(bare, name))).toBe(false);
    const child = Bun.spawn([process.execPath, runner, "offer-models", "--project", f.project, "--groups", f.groups, "--reset-config", bare],
      { cwd: f.project, env: { ...process.env, BOT_OPERATION_LOG: "" }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code, out).toBe(21); expect(out).toContain("现有模型配置不能沿用");
    await writeCurrentConfig(bare); await rm(join(bare, "data/runtime/pi/settings.json"));
    expect(() => makeResetPlan(f.project, f.groups, bare)).toThrow("草稿中没有模型配置");
    const result = await f.run("apply"); expect(result.code, result.text).toBe(0);
    for (const name of ["data/config/models.json", "data/runtime/pi/settings.json"])
      expect(await readFile(join(f.project, name), "utf8")).toBe(await readFile(join(f.draft, name), "utf8"));
    expect(existsSync(join(f.project, "data/runtime/models-store.json"))).toBe(false);
  } finally { await f.cleanup(); }
}, 60000);

test("a model configuration the target Pi fully resolves is offered as a whole and can be discarded for the wizard", async () => {
  const f = await tempFixture("reset-models-");
  try {
    const project = join(f.root, "project"), draft = join(f.root, "draft");
    await writeCurrentConfig(project); await writeFile(join(project, "data/runtime/models-store.json"), "{}");
    await mkdir(join(draft, "data/config"), { recursive: true });
    expect(await offerResetModels(project, draft)).toEqual({ model: "fixture/test" });
    for (const name of modelFiles) expect(await readFile(join(draft, name), "utf8")).toBe(await readFile(join(project, name), "utf8"));
    await validateConfiguration(draft);
    await discardResetModels(draft);
    for (const name of modelFiles) expect(existsSync(join(draft, name))).toBe(false);
    // Every file is present and parses, but the selected model no longer exists in this Pi.
    await writeFile(join(project, "data/runtime/pi/settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "retired" }));
    const refused = await offerResetModels(project, draft);
    expect("reason" in refused && refused.reason).toContain("fixture/retired");
    for (const name of modelFiles) expect(existsSync(join(draft, name))).toBe(false);
    // Pi's real credential resolution decides, including the commands and header references checkAuth skips.
    await writeCurrentConfig(project);
    const models = join(project, "data/config/models.json"), provider = JSON.parse(await readFile(models, "utf8")).providers.fixture;
    expect(process.env.MIXIN_TEST_UNSET_HEADER).toBeUndefined();
    for (const [broken, reason] of [[{ ...provider, apiKey: "!exit 1" }, "shell command"],
      [{ ...provider, headers: { "X-Key": "$MIXIN_TEST_UNSET_HEADER" } }, "X-Key"]] as const) {
      await writeFile(models, JSON.stringify({ providers: { fixture: broken } }));
      const failed = await offerResetModels(project, draft);
      expect("reason" in failed && failed.reason).toContain(reason);
      for (const name of modelFiles) expect(existsSync(join(draft, name))).toBe(false);
    }
    // A late file that is not a plain file must not leave earlier ones copied.
    await writeCurrentConfig(project);
    await rm(join(project, "data/runtime/models-store.json")); await mkdir(join(project, "data/runtime/models-store.json"));
    const partial = await offerResetModels(project, draft);
    expect("reason" in partial && partial.reason).toContain("不是普通文件");
    for (const name of modelFiles) expect(existsSync(join(draft, name))).toBe(false);
  } finally { await f.cleanup(); }
}, 60000);

test("model reuse checks relative credentials and project-local HOME in the reset draft without changing the caller", async () => {
  const f = await fixture();
  const oldHome = process.env.HOME, oldCwd = process.cwd();
  try {
    const home = join(f.project, "data/runtime/home"), key = join(home, "reset-test-key");
    await mkdir(home, { recursive: true }); await writeFile(key, "fixture-key");
    process.env.HOME = home.replaceAll("\\", "/");
    const models = join(f.project, "data/config/models.json");
    const provider = JSON.parse(await readFile(models, "utf8")).providers.fixture;
    const draft = join(f.project, "credential-draft");
    await prepareResetDraft(f.project, f.groups, draft);
    for (const fields of [
      { apiKey: '!cat "$HOME/reset-test-key"' },
      { apiKey: "!cat data/runtime/home/reset-test-key" },
      { headers: { "X-Key": "!cat data/runtime/home/reset-test-key" } },
    ]) {
      await writeFile(models, JSON.stringify({ providers: { fixture: { ...provider, ...fields } } }));
      // These commands really work in the old service's tree; only the projected reset must reject them.
      expect(await checkResetModels(f.project)).toBe("fixture/test");
      const offer = await offerResetModels(f.project, draft);
      expect("reason" in offer && offer.reason).toContain("shell command");
      for (const name of modelFiles) expect(existsSync(join(draft, name))).toBe(false);
      expect(await readFile(key, "utf8")).toBe("fixture-key");
      expect(process.env.HOME).toBe(home.replaceAll("\\", "/"));
      expect(process.cwd()).toBe(oldCwd);
    }
    // A command reading a retained file still resolves: command syntax itself is not rejected or rewritten.
    await writeFile(models, JSON.stringify({ providers: { fixture: { ...provider, apiKey: "!cat data/config/webhook-secret" } } }));
    expect(await offerResetModels(f.project, draft)).toEqual({ model: "fixture/test" });
    // Homes outside the replaced trees are not redirected to an empty draft.
    const keptHome = join(f.project, "admin-home");
    await mkdir(keptHome); await writeFile(join(keptHome, "reset-test-key"), "fixture-key");
    process.env.HOME = keptHome.replaceAll("\\", "/");
    await writeFile(models, JSON.stringify({ providers: { fixture: { ...provider, apiKey: '!cat "$HOME/reset-test-key"' } } }));
    expect(await offerResetModels(f.project, draft)).toEqual({ model: "fixture/test" });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await f.cleanup();
  }
}, 120000);

test("reset commit refuses absolute credential references to discarded files and can still roll back", async () => {
  const f = await fixture(false, async project => {
    const key = join(project, "data/runtime/absolute-test-key");
    await writeFile(key, "fixture-key");
    const models = join(project, "data/config/models.json"), value = JSON.parse(await readFile(models, "utf8"));
    value.providers.fixture.apiKey = `!cat "${key.replaceAll("\\", "/")}"`;
    await writeFile(models, JSON.stringify(value));
  });
  try {
    // Windows cannot hide a live absolute path during the draft check; it must be rechecked before commit.
    expect(await offerResetModels(f.project, f.draft)).toEqual({ model: "fixture/test" });
    const snapshotDraft = join(f.snapshot, "reset-config");
    await cp(f.draft, snapshotDraft, { recursive: true });
    const plan = makeResetPlan(f.project, f.groups, snapshotDraft);
    await writeFile(join(f.snapshot, "data-plan.json"), JSON.stringify({ format: 1, dataVersion: DATA_VERSION, reset: plan }));
    const applied = await f.run("apply"); expect(applied.code, applied.text).toBe(0);
    expect(existsSync(join(f.project, "data/runtime/absolute-test-key"))).toBe(false);
    const committed = await f.run("commit");
    expect(committed.code, committed.text).toBe(1); expect(committed.text).toContain("shell command");
    expect(committed.text).toContain("重新升级时请在询问是否重新配置模型时选择 y");
    expect(JSON.parse(await readFile(join(f.project, "data/state/release-data.json"), "utf8")).phase).toBe("prepared");
    expect((await f.run("finish-reset")).code).toBe(1);
    const restored = await f.run("rollback"); expect(restored.code, restored.text).toBe(0);
    expect(await readFile(join(f.project, "data/runtime/absolute-test-key"), "utf8")).toBe("fixture-key");
    expect(await checkResetModels(f.project)).toBe("fixture/test");
  } finally { await f.cleanup(); }
}, 60000);

test("auxiliary models missing from the reset's new model configuration drop auxiliary.json before planning", async () => {
  const f = await tempFixture("reset-auxiliary-");
  try {
    await writeCurrentConfig(f.root);
    const path = join(f.root, "data/config/auxiliary.json");
    await writeFile(path, JSON.stringify({ format: 1, maxConcurrent: 3 }));
    await settleResetDraft(f.root);
    expect(existsSync(path)).toBe(true);
    await writeFile(path, JSON.stringify({ format: 1, classifier: { provider: "fixture", modelId: "retired" } }));
    await expect(validateConfiguration(f.root)).rejects.toThrow("auxiliary.json");
    await settleResetDraft(f.root);
    expect(existsSync(path)).toBe(false);
    await validateConfiguration(f.root);
  } finally { await f.cleanup(); }
});

test("target freeze and reset discard unreadable old sessions and task state without importing source readers", async () => {
  const f = await fixture(true);
  try {
    // Neither these invalid old databases nor source-release code/dependencies are needed.
    await writeFile(join(f.project, "data/state/relay.sqlite"), "unreadable old relay state");
    await mkdir(join(f.project, "src/durable"), { recursive: true });
    await writeFile(join(f.project, "src/durable/identity.ts"), 'throw new Error("old reader must not run");');
    const receipt = join(f.snapshot, "stats-frozen.json"); await rm(receipt);
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../../scripts/runtime/stats-freeze.ts", import.meta.url)),
      "--groups", f.groups, "--receipt", receipt], { cwd: f.project, env: { ...process.env, BOT_OPERATION_LOG: "", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone }, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    await freezeStats(f.project, f.groups, receipt);
    expect(JSON.parse(await readFile(receipt, "utf8")).digest).toBe(f.before);
    for (const action of ["apply", "validate", "commit", "finish-reset"]) {
      const result = await f.run(action); expect(result.code, result.text).toBe(0);
    }
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
    expect(statsDigest(join(f.project, "backup/statistics", id, "stats.sqlite"))).toBe(f.before);
    expect(await readFile(join(f.project, "data/config/webhook-secret"), "utf8")).toBe("a".repeat(64));
    expect(await readFile(join(f.project, "data/config/cloudflared-token"), "utf8")).toBe("private-test-token");
    expect(existsSync(join(f.groups, "g/durable.sqlite"))).toBe(false);
    for (const name of f.kept) expect(await readFile(join(f.groups, name), "utf8")).toBe(name);
    expect(existsSync(join(f.project, "data/state/relay.sqlite"))).toBe(false);
    expect(existsSync(join(f.project, "data/state/agent.sqlite"))).toBe(false);
  } finally { await f.cleanup(); }
});

test("freeze preserves existing statistics and source flags without reading or backfilling any JSONL", async () => {
  const f = await tempFixture("freeze-jsonl-"), project = f.root, groups = join(project, "groups"), receipt = join(project, "frozen.json");
  try {
    await mkdir(join(project, "data/state"), { recursive: true });
    const db = openStatsLedger(groups);
    try {
      for (const user of ["present", "archived", "missing"]) {
        ingestConversationRecords(db, { id: user, group: "g", user, identity: "old:" + user }, 0, 1,
          [{ type: "message", timestamp: "2026-10-17T01:00:00Z", message: { role: "user", content: [{ type: "text" }] } }]);
      }
      db.exec("UPDATE sources SET pending = 1, projection = 2; UPDATE sources SET archived_at = 123, projection = 1 WHERE id = 'archived'");
      await mkdir(join(groups, "g/users/present"), { recursive: true });
      await writeFile(join(groups, "g/users/present/session.jsonl"), '{"type":"message","timestamp":"2026-10-17T02:00:00Z","message":{"role":"user","content":[{"type":"text","text":"never backfill"}]}}\n{"unfinished":');
      // Old projection versions and pending markers are retained as opaque ledger data.
      db.exec("UPDATE sources SET projection = 99 WHERE id = 'missing'");
    } finally { db.close(); }
    const before = statsDigest(join(groups, "stats.sqlite"));
    await freezeStats(project, groups, receipt);
    await freezeStats(project, groups, receipt);
    expect(statsDigest(join(groups, "stats.sqlite"))).toBe(before);
    // Freeze itself does not destroy any rollback material.
    expect(await readFile(join(groups, "g/users/present/session.jsonl"), "utf8")).toEndWith('{"unfinished":');
    const frozen = new Database(join(groups, "stats.sqlite"), { readonly: true });
    try {
      expect(frozen.query("SELECT SUM(asks) AS asks FROM activity").get()).toEqual({ asks: 3 });
      expect(frozen.query("SELECT SUM(pending) AS skipped, COUNT(DISTINCT user_segment) AS users FROM sources").get()).toEqual({ skipped: 3, users: 3 });
    } finally { frozen.close(); }
  } finally { await f.cleanup(); }
});

test("freeze refuses a missing or unsupported ledger and rejects changes after freezing", async () => {
  const f = await tempFixture("freeze-integrity-"), project = f.root, groups = join(project, "groups"), receipt = join(project, "frozen.json");
  try {
    await mkdir(join(project, "data/state"), { recursive: true }); await mkdir(groups);
    await expect(freezeStats(project, groups, receipt)).rejects.toThrow("统计库缺失");
    expect(existsSync(join(groups, "stats.sqlite"))).toBe(false);
    const db = openStatsLedger(groups);
    try {
      db.exec("UPDATE stats_schema SET version = 1");
      await expect(freezeStats(project, groups, receipt)).rejects.toThrow("schema 2");
      expect(existsSync(receipt)).toBe(false);
      db.exec("UPDATE stats_schema SET version = 2");
      await freezeStats(project, groups, receipt);
      ingestConversationRecords(db, { id: "later", group: "g", user: "u", identity: "member" }, 0, 1,
        [{ type: "message", timestamp: "2026-10-17T01:00:00Z", message: { role: "user", content: [{ type: "text" }] } }]);
      await expect(freezeStats(project, groups, receipt)).rejects.toThrow("统计冻结后发生变化");
    } finally { db.close(); }
  } finally { await f.cleanup(); }
});
