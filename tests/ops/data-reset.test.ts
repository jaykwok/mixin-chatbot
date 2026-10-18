import { expect, test } from "bun:test";
import { mkdir, writeFile, readFile, cp, rename, symlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { DATA_VERSION, inspectDataVersion } from "../../src/core/data-version.ts";
import { openStatsLedger, ingestConversationRecords } from "../../src/agent/stats-ledger.ts";
import { prepareResetDraft, makeResetPlan, statsDigest, resetVersion, applyReset, rollbackReset, verifyReset, finishReset } from "../../scripts/runtime/data-reset.ts";
import { writeCurrentConfig } from "../helpers/current-config.ts";
import { tempFixture } from "../helpers/temp.ts";
import { freezeStats } from "../../scripts/runtime/stats-freeze.ts";
import { acquireLease, acquireGroupRootLease } from "../../src/core/maintenance.ts";

const runner = fileURLToPath(new URL("../../scripts/runtime/data-current.ts", import.meta.url));
const id = "deploy-reset123";
async function fixture(incompleteJsonl = false) {
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
  const db = openStatsLedger(groups);
  ingestConversationRecords(db, { id: "old-source", group: "g", user: "u", identity: "member" }, 0, 1,
    [{ type: "message", timestamp: "2026-10-17T01:00:00Z", message: { role: "user", content: [{ type: "text" }] } }]);
  if (incompleteJsonl) db.exec("UPDATE sources SET projection = 2, pending = 1, archived_at = 123");
  db.close();
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
  return { ...f, project, groups, snapshot, draft, plan, before, run };
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
    for (const action of ["apply", "apply", "validate", "commit", "commit", "finish-reset", "finish-reset"]) {
      const result = await f.run(action); expect(result.code, result.text).toBe(0);
    }
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
    expect(statsDigest(join(f.project, "backup/statistics", id, "stats.sqlite"))).toBe(f.before);
    expect(JSON.parse(await readFile(join(f.project, "backup/statistics", id, "baseline.json"), "utf8")).incompleteJsonl).toEqual({ sources: 1, lines: 1 });
    expect(await readFile(join(f.project, "data/config/webhook-secret"), "utf8")).toBe("a".repeat(64));
    expect(await readFile(join(f.project, "data/config/cloudflared-token"), "utf8")).toBe("private-test-token");
    for (const path of ["g/durable.sqlite", "g/workspace", ".reset-" + id]) expect(existsSync(join(f.groups, path))).toBe(false);
    expect(existsSync(join(f.project, "data/config/obsolete.json"))).toBe(false);
    expect(await readFile(join(f.project, "data/runtime/bot-launcher.ps1"), "utf8")).toBe("generated-host-launcher");
    expect((await f.run("rollback")).code).toBe(42);
  } finally { await f.cleanup(); }
});

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

test("reset rollback restores configuration, session, outbox and markers and can be retried", async () => {
  const f = await fixture();
  try {
    expect((await f.run("apply")).code).toBe(0);
    // Configuration renames must remain inside data/, which is a separate Docker mount from backup/.
    expect(await readFile(join(f.project, "data/.reset-" + id, "config/obsolete.json"), "utf8")).toBe("old-config");
    expect((await f.run("finish-reset")).code).toBe(1);
    for (const action of ["rollback", "rollback"]) { const r = await f.run(action); expect(r.code, r.text).toBe(0); }
    expect(await readFile(join(f.groups, "g/durable.sqlite"), "utf8")).toBe("old-session");
    expect(await readFile(join(f.project, "data/state/agent.sqlite"), "utf8")).toBe("old-outbox");
    expect(await readFile(join(f.project, "data/config/obsolete.json"), "utf8")).toBe("old-config");
    expect(resetVersion(f.project, f.groups)).toBe(DATA_VERSION - 1);
    expect(statsDigest(join(f.groups, "stats.sqlite"))).toBe(f.before);
  } finally { await f.cleanup(); }
});

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
    await rename(join(f.groups, ".reset-" + id, "g"), join(f.groups, "g"));
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
    expect(existsSync(join(f.groups, "g"))).toBe(false);
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
