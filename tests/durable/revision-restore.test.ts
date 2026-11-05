// Restoring a conversation database from its revision-cleanup backup (src/durable/revision-cleanup/restore.ts,
// revision-chain plan §8.3), after a committed base differed from the journal. On synthetic databases: the restore runs
// only when the live database is exactly the backup plus this run's own commits (equal commit counts alone are not
// enough), checks the copy against the backup record, swaps it in under the replacement protocol of the shrink, and a
// restore killed at every step finishes on the next run; anything it cannot explain is refused without a change, and
// the restore stays required.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { validateCurrentData } from "../../src/core/data-validation.ts";
import { assessMaintenanceAction, MaintenanceRefused, readMaintenanceState, type MaintenanceIntent } from "../../src/core/maintenance-state.ts";
import { journalPath, readJournal, type Journal } from "../../src/durable/revision-cleanup/journal.ts";
import { RestoreRefused, restoreDatabase, type RestorePoint } from "../../src/durable/revision-cleanup/restore.ts";
import { applyCleanup, CleanupStopped, endCleanup } from "../../src/durable/revision-cleanup/run.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { chainState, Other, PHONE, writeLongChains, type ChainState } from "../helpers/revision-chains.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("revision-restore-");
afterAll(() => fixture.cleanup());

const SPACES = ["direct", "groups/g1"];
const LENGTH = 70;
const template = join(fixture.root, "template");
let counter = 0;
for (const space of SPACES) await writeLongChains(join(template, "data", "conversations", ...space.split("/"), "durable.sqlite"), LENGTH);

const dbPath = (project: string, space: string) => join(project, "data", "conversations", ...space.split("/"), "durable.sqlite");
const data = (project: string) => join(project, "data");
const cliScript = join(import.meta.dir, "..", "..", "scripts", "runtime", "revision-cleanup.ts");

async function cli(project: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, cliScript, ...args, "--project", project], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

function project(): string {
  const root = join(fixture.root, `project-${++counter}`);
  cpSync(template, root, { recursive: true });
  return root;
}

function state(path: string): ChainState {
  const db = new Database(path, { readonly: true });
  try { return chainState(db); } finally { db.close(); }
}
const states = (root: string) => Object.fromEntries(SPACES.map(space => [space, state(dbPath(root, space))]));
const journal = (root: string) => readJournal(data(root))!;
const refusal = (root: string, intent: MaintenanceIntent) => {
  const assessment = assessMaintenanceAction(readMaintenanceState(root), intent);
  return assessment.allowed ? undefined : assessment.reasons.join("；");
};
const sql = (path: string, statement: string, ...values: (number | string)[]) => {
  const db = new Database(path);
  try { db.query(statement).run(...values); } finally { db.close(); }
};
const spaceFiles = (root: string) => readdirSync(dirname(dbPath(root, "direct"))).sort();

/** A cleanup whose third committed base in `direct` differs from the journal: two documents settled, the restore required. */
async function mismatched(root: string): Promise<Journal> {
  let calls = 0;
  const error = await applyCleanup({ project: root, hooks: { value: value => ++calls === 3 ? { ...value, corrupted: true } : undefined } })
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CleanupStopped);
  const stopped = journal(root);
  expect(stopped.restore).toMatchObject({ space: "direct", state: "required" });
  expect(stopped.databases[0]!.done).toHaveLength(2);
  return stopped;
}

test("恢复：会话库回到备份时的状态（已整理的文档一并撤销），被替换的库保留；之后服务可以启动，整理只能跳过或回滚，再整理从头开始；命令行输出协议结果", async () => {
  const root = project(), before = states(root);
  const stopped = await mismatched(root);
  const changed = state(dbPath(root, "direct"));
  // Nothing to restore elsewhere, and the run's other actions wait for it.
  expect(refusal(root, "service")).toContain("需要从备份恢复");
  const other = await cli(root, "restore", "--space", "groups/g1", "--json");
  expect(other.code).toBe(1);
  expect(JSON.parse(other.stdout)).toMatchObject({ command: "restore", outcome: "refused", message: expect.stringContaining("需要从备份恢复的是 direct") });

  const result = await cli(root, "restore", "--space", "direct", "--json");
  expect(result.code, result.stderr).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const output = JSON.parse(lines[0]!) as { result: { run: string; space: string; kept: string; backup: string } };
  expect(output).toMatchObject({ protocol: "mixin-maintenance", version: 1, command: "restore", outcome: "success",
    result: { space: "direct", backup: stopped.databases[0]!.backup!.path } });
  expect(output).not.toHaveProperty("result.recovered");
  expect(result.stderr).toContain("direct 已从备份恢复");
  expect(result.stdout + result.stderr).not.toContain(PHONE);

  // Before any read (a read-only connection leaves a -wal and -shm behind): the database and the replaced one beside it,
  // nothing else. The database as backed up (every value, every chain, next_seq), in WAL mode (file format bytes 18–19).
  const path = dbPath(root, "direct");
  expect(spaceFiles(root)).toEqual(["durable.sqlite", basename(output.result.kept)]);
  expect([...readFileSync(path).subarray(18, 20)]).toEqual([2, 2]);
  expect(state(path)).toEqual(before.direct!);
  expect(state(output.result.kept)).toEqual(changed);
  const session = createSession(await openGroupStorage(path));
  await session.close(context);

  const after = journal(root);
  expect(after).toMatchObject({ state: "stopped", restore: { state: "done", kept: output.result.kept, reverted: 2 } });
  expect(after.restore!.replacement).toBeUndefined();
  expect(after.databases[0]).toMatchObject({ space: "direct", done: [], nextSeq: before.direct!.nextSeq });
  for (const intent of ["service", "verify", "release", "skip", "rollback", "shrink", "conversation-write"] as const) expect(refusal(root, intent)).toBeUndefined();
  expect(refusal(root, "resume")).toContain("已停止");
  expect(refusal(root, "restore")).toContain("没有需要从备份恢复的会话库");
  await validateCurrentData(root, { intent: "service" }).catch((error: unknown) => expect(error).not.toBeInstanceOf(MaintenanceRefused));
  const status = await cli(root, "status");
  expect(status.stdout).toContain("direct 已从备份恢复（本次整理在这个库已整理的 2 份文档随之撤销）");
  const again = await cli(root, "restore", "--space", "direct", "--json");
  expect(again.code).toBe(1);
  expect(JSON.parse(again.stdout)).toMatchObject({ outcome: "refused", message: expect.stringContaining("没有需要从备份恢复的会话库") });

  // The run ends as skipped with nothing counted as cleaned; a later run cleans everything again from fresh backups.
  expect(await endCleanup({ project: root }, "skipped")).toMatchObject({ state: "skipped", documents: 0 });
  expect(state(dbPath(root, "groups/g1"))).toEqual(before["groups/g1"]!);
  const summary = await applyCleanup({ project: root });
  expect(summary).toMatchObject({ state: "finished", documents: 20 });
  expect(summary.run).not.toBe(stopped.run);
  for (const space of SPACES) expect(state(dbPath(root, space)).values).toEqual(before[space]!.values);
}, 60_000);

// ─── Killed restores ───────────────────────────────────────────────────────

const spec = (name: string) => JSON.stringify(import.meta.resolve(name));
const child = `
import { restoreDatabase } from ${spec("../../src/durable/revision-cleanup/restore.ts")};
const [project, stopAt] = process.argv.slice(2);
await restoreDatabase({ project, space: "direct", hooks: { point: async point => {
  if (point !== stopAt) return;
  console.log("AT " + point);
  await new Promise(() => {});
} } });
console.log("FINISHED");
`;

async function killAt(root: string, point: RestorePoint): Promise<void> {
  const script = join(fixture.root, "child.ts");
  if (!existsSync(script)) await writeFile(script, child);
  const proc = Bun.spawn([process.execPath, script, root, point], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const errors = new Response(proc.stderr).text();
  let output = "";
  const timer = setTimeout(() => proc.kill("SIGKILL"), 25_000);
  try { for await (const bytes of proc.stdout) { output += Buffer.from(bytes).toString(); if (output.includes(`AT ${point}\n`)) break; } }
  finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; }
  expect(output, await errors).toContain(`AT ${point}\n`);
}

const killed: [RestorePoint, string, "void" | "done"][] = [
  ["writing", "writing", "void"], ["verified", "verified", "void"], ["old-kept", "old-kept", "done"], ["installed", "installed", "done"],
  ["checked", "installed", "done"],
];

for (const [point, recorded, recovered] of killed) {
  test(`恢复在"${point}"处被强制结束：服务仍然拒绝；再次运行按替换的恢复表${recovered === "void" ? "丢弃副本后重新恢复" : "完成替换"}`, async () => {
    const root = project(), before = states(root);
    await mismatched(root);
    await killAt(root, point);
    const at = journal(root).restore!;
    expect(at).toMatchObject({ state: "replacing", replacement: { current: { state: recorded } } });
    expect(refusal(root, "service")).toContain("从备份恢复 direct 尚未完成");
    expect(refusal(root, "rollback")).toContain("从备份恢复 direct 尚未完成");
    expect(refusal(root, "restore")).toBeUndefined();
    const summary = await restoreDatabase({ project: root, space: "direct" });
    expect(summary.recovered).toBe(recovered);
    if (recovered === "done") expect(summary.run).toBe(at.replacement!.run);
    else expect(summary.run).not.toBe(at.replacement!.run);
    expect(spaceFiles(root)).toEqual(["durable.sqlite", basename(summary.kept!)]);
    expect(state(dbPath(root, "direct"))).toEqual(before.direct!);
    expect(journal(root).restore).toMatchObject({ state: "done", kept: summary.kept });
    expect(refusal(root, "service")).toBeUndefined();
  }, 60_000);
}

test("恢复在副本放到正式路径之前中断、副本又不见了：放回原库，再从头恢复", async () => {
  const root = project(), before = states(root);
  await mismatched(root);
  await killAt(root, "old-kept");
  const at = journal(root).restore!;
  const copy = `${dbPath(root, "direct")}.restore-${at.replacement!.run}.new`;
  expect(existsSync(copy)).toBe(true);
  rmSync(copy);
  const summary = await restoreDatabase({ project: root, space: "direct" });
  expect(summary.recovered).toBe("restored");
  expect(state(dbPath(root, "direct"))).toEqual(before.direct!);
  expect(journal(root).restore).toMatchObject({ state: "done" });
}, 60_000);

// ─── Refusals ──────────────────────────────────────────────────────────────

/** The second document settled in `direct` (its id and seq) and the database's path. */
const settled = (root: string) => ({ path: dbPath(root, "direct"), done: journal(root).databases[0]!.done });
const editJournal = (root: string, edit: (journal: Journal) => void) => {
  const value = journal(root);
  edit(value);
  writeFileSync(journalPath(data(root)), JSON.stringify(value, null, 2));
};

const refusals: [string, (root: string) => Promise<void> | void, string][] = [
  ["之后有别的提交（提交次数多出一次）", async root => {
    const session = createSession(await openGroupStorage(dbPath(root, "direct")));
    try { await session.commit(async tx => { (await tx.doc(Other)).n = -1; }, context); } finally { await session.close(context); }
    // Durable leaves the commit in the WAL; the restore refuses on the commits, not on the WAL.
    const db = new Database(dbPath(root, "direct"));
    try { db.query("PRAGMA wal_checkpoint(TRUNCATE)").get(); } finally { db.close(); }
  }, "提交序号对不上"],
  ["提交次数相等但归属不对（日志里两份已整理文档的序号互换）", root => editJournal(root, value => {
    const [a, b] = value.databases[0]!.done;
    [a!.seq, b!.seq] = [b!.seq, a!.seq];
  }), "不是序号"],
  ["一份已整理文档的基准被挪到别的序号", root => {
    const { path, done } = settled(root);
    sql(path, "UPDATE document_revisions SET seq = seq + 1000 WHERE document_id = ?", done[1]!.id);
  }, "不是序号"],
  ["已整理文档的值与日志的摘要不同", root => {
    const { path, done } = settled(root);
    sql(path, "UPDATE document_revisions SET content = json_set(content, '$.tampered', 1) WHERE document_id = ?", done[0]!.id);
  }, "的值与日志记录的摘要不同"],
  ["next_id 在备份之后变了", root => sql(dbPath(root, "direct"), "UPDATE durable_metadata SET next_id = '999999'"), "next_id 为 999999"],
  ["备份之后有文档退役", root => {
    const { path, done } = settled(root);
    const db = new Database(path, { readonly: true });
    const other = (db.query("SELECT id FROM documents WHERE id NOT IN (?, ?) ORDER BY id LIMIT 1").get(done[0]!.id, done[1]!.id) as { id: number }).id;
    db.close();
    sql(path, "UPDATE documents SET retired_at = (SELECT next_seq - 1 FROM durable_metadata) WHERE id = ?", other);
  }, "在备份之后新建或退役"],
  ["会话库文件被替换（内容相同、文件身份不同）", root => {
    const path = dbPath(root, "direct");
    copyFileSync(path, `${path}.copy`);
    renameSync(`${path}.copy`, path);
  }, "文件身份不同"],
  ["备份损坏但长度不变", root => {
    const backup = journal(root).databases[0]!.backup!.path, bytes = readFileSync(backup);
    bytes[100] = bytes[100]! ^ 1;
    writeFileSync(backup, bytes);
  }, "与记录的摘要不同（已损坏或被替换）"],
  ["备份不在了", root => rmSync(journal(root).databases[0]!.backup!.path), "的备份不在了"],
];

for (const [name, tamper, reason] of refusals) {
  test(`拒绝自动恢复：${name}——没有改动，恢复仍待处理，服务仍然拒绝`, async () => {
    const root = project();
    await mismatched(root);
    await tamper(root);
    const tampered = state(dbPath(root, "direct")), recorded = readFileSync(journalPath(data(root)), "utf8"), files = spaceFiles(root);
    const error = await restoreDatabase({ project: root, space: "direct" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RestoreRefused);
    expect((error as Error).message).toContain(reason);
    expect((error as Error).message).toContain("没有改动");
    expect(state(dbPath(root, "direct"))).toEqual(tampered);
    expect(readFileSync(journalPath(data(root)), "utf8")).toBe(recorded);
    expect(journal(root).restore).toMatchObject({ state: "required" });
    expect(spaceFiles(root)).toEqual(files);
    expect(refusal(root, "service")).toContain("需要从备份恢复");
    // Through the command line, as the ops entries run it: refused (exit 1), the entry for it always offered.
    const run = await cli(root, "restore", "--space", "direct", "--json");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({ command: "restore", outcome: "refused", message: expect.stringContaining(reason) });
  }, 60_000);
}
