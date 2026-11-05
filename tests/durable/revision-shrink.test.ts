// Offline shrink of the conversation databases (src/durable/revision-cleanup/shrink.ts, revision-chain plan §4.6): a
// compact copy written beside each database and swapped in under its own recovery record. Every value stays, the original
// is kept as .old until removed, a run killed at each step recovers onto the plan's table, and a
// combination outside it stops without changing anything. The service, the verification instance, the cleanup and every
// Durable open refuse while a replacement is unfinished.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession } from "@earendil-works/pi-durable";
import { validateCurrentData } from "../../src/core/data-validation.ts";
import { acquireLease } from "../../src/core/maintenance.ts";
import { assessMaintenanceAction, readMaintenanceState } from "../../src/core/maintenance-state.ts";
import { fileDigest } from "../../src/durable/revision-cleanup/backup.ts";
import { fileIdentity, pages, tableDigests } from "../../src/durable/revision-cleanup/inspect.ts";
import { journalPath, JOURNAL_VERSION } from "../../src/durable/revision-cleanup/journal.ts";
import { applyCleanup } from "../../src/durable/revision-cleanup/run.ts";
import { applyShrink, keptOriginals, previewShrink, removeKeptOriginals, shrinkFiles, ShrinkStopped, type ShrinkPoint } from "../../src/durable/revision-cleanup/shrink.ts";
import { readShrinkRecord, type ShrinkRecord } from "../../src/durable/revision-cleanup/shrink-record.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { chainState, writeLongChains, type ChainState } from "../helpers/revision-chains.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("revision-shrink-");
afterAll(() => fixture.cleanup());

const SPACES = ["direct", "groups/g1"];
const template = join(fixture.root, "template");
let counter = 0;
const dbPath = (project: string, space: string) => join(project, "data", "conversations", ...space.split("/"), "durable.sqlite");
const data = (project: string) => join(project, "data");
const cliScript = join(import.meta.dir, "../../scripts/runtime/revision-cleanup.ts");

/** Runs the command-line tool on a project: what it printed and its exit status. */
async function cli(project: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, cliScript, ...args, "--project", project], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

// Long chains, and 4 MiB of free pages from a table that was dropped again (as the cleanup's deletes leave them).
for (const space of SPACES) {
  const path = dbPath(template, space);
  await writeLongChains(path, 70);
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE filler (x BLOB); INSERT INTO filler VALUES (zeroblob(4194304)); DROP TABLE filler;");
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally { db.close(); }
}

function project(): string {
  const root = join(fixture.root, `project-${++counter}`);
  cpSync(template, root, { recursive: true });
  return root;
}

type State = ChainState & { digests: Record<string, string> };
function state(path: string): State {
  const db = new Database(path, { readonly: true });
  try { return { ...chainState(db), digests: tableDigests(db) }; } finally { db.close(); }
}
const states = (root: string) => Object.fromEntries(SPACES.map(space => [space, state(dbPath(root, space))]));
/** Why the maintenance state keeps the service from starting now (undefined: it may start). */
const serviceRefusal = (root: string) => {
  const assessment = assessMaintenanceAction(readMaintenanceState(root), "service");
  return assessment.allowed ? undefined : assessment.reasons.join("；");
};
const freePages = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return pages(db).freePages; } finally { db.close(); }
};
/** Durable opens the database and reads it. */
async function opens(path: string): Promise<void> {
  const session = createSession(await openGroupStorage(path));
  await session.close(context);
}

test("收缩：预览的数字；副本逐行与原库相同、没有空闲页、是 WAL 模式；原库保留为 .old，旁边没有多余文件；Durable 照常打开；再跑一次无事可做；确认后删除保留的原库", async () => {
  const root = project(), before = states(root);
  const preview = await previewShrink({ project: root });
  expect(preview.databases.map(db => db.space)).toEqual(SPACES);
  for (const db of preview.databases) {
    const path = dbPath(root, db.space), info = new Database(path, { readonly: true });
    try {
      const { pageSize, pages: total, freePages: free } = pages(info);
      expect(db).toMatchObject({ bytes: statSync(path).size, usedBytes: (total - free) * pageSize, freeBytes: free * pageSize, shrink: true });
    } finally { info.close(); }
    expect(db.freeBytes).toBeGreaterThanOrEqual(4_194_304);
  }
  expect(preview.volumes).toHaveLength(1);
  expect(preview.volumes[0]!.need).toBe(1_073_741_824 + preview.databases.reduce((n, db) => n + db.usedBytes + db.walBytes, 0));
  const originals = Object.fromEntries(SPACES.map(space => [space, fileIdentity(dbPath(root, space))]));

  const summary = await applyShrink({ project: root });
  expect(summary.recovered).toBeUndefined();
  expect(summary.done.map(db => db.space)).toEqual(SPACES);
  for (const space of SPACES) {
    const path = dbPath(root, space), files = shrinkFiles(path, summary.run);
    // Before any read: the database, its kept original, nothing else (no copy, no -wal or -shm of any of them).
    expect(readdirSync(dirname(path)).sort()).toEqual(["durable.sqlite", `durable.sqlite.shrink-${summary.run}.old`]);
    // The file format bytes 18 and 19: 2 is WAL.
    expect([...readFileSync(path).subarray(18, 20)]).toEqual([2, 2]);
    const done = summary.done.find(db => db.space === space)!;
    expect(done.after).toBeLessThan(done.before - 4_000_000);
    expect(state(path)).toEqual(before[space]);
    expect(freePages(path)).toBe(0);
    expect(fileIdentity(files.old)).toEqual(originals[space]);
    expect(state(files.old)).toEqual(before[space]);
    await opens(path);
  }
  expect(readShrinkRecord(data(root))).toMatchObject({ run: summary.run, done: [{ space: "direct" }, { space: "groups/g1" }] });
  expect(readShrinkRecord(data(root))!.current).toBeUndefined();
  expect(serviceRefusal(root)).toBeUndefined();

  // Nothing left to give back: the record of the run moves aside, no new run starts.
  expect(await applyShrink({ project: root })).toEqual({ run: "", done: [] });
  expect(readShrinkRecord(data(root))).toBeUndefined();
  const kept = keptOriginals(root);
  expect(kept.map(item => [item.run, item.space])).toEqual(SPACES.map(space => [summary.run, space]));
  expect(await removeKeptOriginals(root)).toEqual(kept);
  for (const item of kept) expect(readdirSync(dirname(item.path)).filter(name => name.includes(".shrink-"))).toEqual([]);
  expect(keptOriginals(root)).toEqual([]);
  for (const space of SPACES) expect(state(dbPath(root, space))).toEqual(before[space]);
}, 60_000);

test("收缩只处理选中的空间；没有这个空间时拒绝", async () => {
  const root = project(), before = states(root);
  const summary = await applyShrink({ project: root, spaces: ["groups/g1"] });
  expect(summary.done.map(db => db.space)).toEqual(["groups/g1"]);
  expect(freePages(dbPath(root, "direct"))).toBeGreaterThan(0);
  expect(state(dbPath(root, "direct"))).toEqual(before.direct);
  await expect(previewShrink({ project: root, spaces: ["groups/none"] })).rejects.toThrow("没有这些空间的会话库");
}, 60_000);

test("拒绝的情形：空间不够、整理有在途文档、checkpoint 被占（busy）时都不做任何改动", async () => {
  const root = project(), before = states(root);
  const untouched = () => {
    expect(states(root)).toEqual(before);
    expect(readShrinkRecord(data(root))?.current).toBeUndefined();
    for (const space of SPACES) expect(readdirSync(dirname(dbPath(root, space))).filter(name => name.includes(".shrink-"))).toEqual([]);
  };
  await expect(applyShrink({ project: root, reserve: Number.MAX_SAFE_INTEGER })).rejects.toThrow("空间不足，收缩没有开始");
  untouched();

  mkdirSync(dirname(journalPath(data(root))), { recursive: true });
  writeFileSync(journalPath(data(root)), JSON.stringify({ version: JOURNAL_VERSION, run: "r-test", state: "running", databases: [], current: { space: "direct" } }, null, 2));
  await expect(applyShrink({ project: root })).rejects.toThrow("有一份文档尚未收尾");
  expect((await previewShrink({ project: root })).blocked).toContain("尚未收尾");
  rmSync(journalPath(data(root)));
  untouched();

  // A reader holds a snapshot while the WAL has frames: TRUNCATE cannot finish.
  const path = dbPath(root, "direct"), writer = new Database(path), reader = new Database(path);
  try {
    writer.exec("PRAGMA wal_autocheckpoint = 0; CREATE TABLE probe (x); DROP TABLE probe;");
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM documents").get();
    writer.exec("CREATE TABLE probe (x); DROP TABLE probe;");
    // Through the command line, as the ops entries run it: stopped (exit 3).
    const run = await cli(root, "shrink");
    expect(run.code, run.stderr).toBe(3);
    expect(run.stderr).toContain("会话库收缩已停止：direct 的 WAL 未能截断（busy 1");
    // Nothing is left unfinished, so the ops entry that stopped the bot starts it again: the tool does not say otherwise.
    expect(run.stderr).not.toMatch(/机器人|保持停/);
  } finally { reader.exec("ROLLBACK"); reader.close(); writer.close(); }
  // The run had started: its record stays, without a replacement in flight, and nothing was renamed.
  expect(readShrinkRecord(data(root))).toMatchObject({ done: [] });
  expect(states(root).direct!.values).toEqual(before.direct!.values);
  expect(readShrinkRecord(data(root))?.current).toBeUndefined();
  expect(serviceRefusal(root)).toBeUndefined();
  for (const space of SPACES) expect(readdirSync(dirname(dbPath(root, space))).filter(name => name.includes(".shrink-"))).toEqual([]);
}, 60_000);

// ─── Killed runs ───────────────────────────────────────────────────────────

const spec = (name: string) => JSON.stringify(import.meta.resolve(name));
const child = `
import { applyShrink } from ${spec("../../src/durable/revision-cleanup/shrink.ts")};
const [project, stopAt] = process.argv.slice(2);
await applyShrink({ project, spaces: ["groups/g1"], hooks: { point: async point => {
  if (point !== stopAt) return;
  console.log("AT " + point);
  await new Promise(() => {});
} } });
console.log("FINISHED");
`;

/** Runs the shrink of groups/g1 in a child process that blocks at `point` and is then force-killed. */
async function killAt(root: string, point: ShrinkPoint): Promise<void> {
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

const cases: [ShrinkPoint, "void" | "done", string][] = [
  ["writing", "void", "副本写到一半"],
  ["verified", "void", "替换前"],
  ["old-kept", "done", "保留旧库后"],
  ["installed", "done", "安装新库后"],
  ["checked", "done", "完成记录前"],
];
for (const [point, recovered, what] of cases) {
  test(`在"${what}"（${point}）被强制结束：服务、验证、整理与 Durable 打开都拒绝；再次收缩按恢复表收尾（${recovered}），值不变`, async () => {
    const root = project(), before = states(root), path = dbPath(root, "groups/g1");
    await killAt(root, point);
    const killed = readShrinkRecord(data(root))!;
    expect(killed.current?.space).toBe("groups/g1");
    expect(serviceRefusal(root)).toContain("尚未替换完成");
    await expect(validateCurrentData(root)).rejects.toThrow("尚未替换完成");
    await expect(applyCleanup({ project: root })).rejects.toThrow("尚未替换完成");
    if (point === "old-kept") {
      // Nothing at the database's path: a Durable open does not create an empty database there.
      expect(existsSync(path)).toBe(false);
      await expect(opens(path)).rejects.toThrow("旁边有收缩或恢复保留的原库");
      expect(existsSync(path)).toBe(false);
    }
    const summary = await applyShrink({ project: root, spaces: ["groups/g1"] });
    expect(summary.recovered).toBe(recovered);
    // After dropping an unreplaced copy, the same command shrinks the database in a new run.
    expect(summary.done.map(db => db.space)).toEqual(recovered === "void" ? ["groups/g1"] : []);
    expect(serviceRefusal(root)).toBeUndefined();
    expect(state(path)).toEqual(before["groups/g1"]);
    expect(freePages(path)).toBe(0);
    expect(state(dbPath(root, "direct"))).toEqual(before.direct);
    const kept = keptOriginals(root);
    expect(kept.map(item => item.space)).toEqual(["groups/g1"]);
    expect(state(kept[0]!.path)).toEqual(before["groups/g1"]);
    expect(readdirSync(dirname(path)).filter(name => name.endsWith(".new"))).toEqual([]);
    await opens(path);
  }, 60_000);
}

test("改名到一半（原库已改名、-wal 和 -shm 还在原路径）：恢复把它们归到原库再换上副本", async () => {
  const root = project(), before = states(root), path = dbPath(root, "groups/g1");
  await killAt(root, "verified");
  const { run } = readShrinkRecord(data(root))!, files = shrinkFiles(path, run);
  writeFileSync(files.wal, ""); writeFileSync(files.shm, "");
  renameSync(files.main, files.old);
  const summary = await applyShrink({ project: root, spaces: ["groups/g1"] });
  expect(summary.recovered).toBe("done");
  expect([existsSync(files.oldWal), existsSync(files.oldShm), existsSync(files.wal), existsSync(files.shm)]).toEqual([true, true, false, false]);
  expect(state(path)).toEqual(before["groups/g1"]);
}, 60_000);

// ─── The installed copy ────────────────────────────────────────────────────

/** Changes one value in place (the same file), committed and checkpointed: quick_check and the Durable counters stay. */
function alterInPlace(path: string): void {
  const db = new Database(path);
  try {
    const meta = db.query("SELECT next_seq, next_id FROM durable_metadata").get();
    const { changes } = db.query("UPDATE document_revisions SET content = json_set(content, '$.altered', 1) " +
      "WHERE rowid = (SELECT min(rowid) FROM document_revisions WHERE kind = 'base')").run();
    expect(changes).toBe(1);
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    expect(db.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(db.query("SELECT next_seq, next_id FROM durable_metadata").get()).toEqual(meta);
  } finally { db.close(); }
}

/** The recovery stops: the record, the kept original and every file beside the database stay as they were. */
async function expectKept(root: string, killed: ShrinkRecord, reason: string): Promise<void> {
  const path = dbPath(root, killed.current!.space), files = shrinkFiles(path, killed.run);
  const listing = readdirSync(dirname(path)).sort(), old = { file: fileIdentity(files.old), sha256: await fileDigest(files.old) };
  const error = await applyShrink({ project: root, spaces: ["groups/g1"] }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ShrinkStopped);
  expect((error as Error).message).toContain(reason);
  expect((error as Error).message).toContain(`原库保留在 ${files.old}`);
  expect(readShrinkRecord(data(root))).toEqual(killed);
  expect(readdirSync(dirname(path)).sort()).toEqual(listing);
  expect({ file: fileIdentity(files.old), sha256: await fileDigest(files.old) }).toEqual(old);
  expect(serviceRefusal(root)).toContain("尚未替换完成");
  await expect(validateCurrentData(root)).rejects.toThrow("尚未替换完成");
}

test("保留旧库后副本已改名到正式路径、记录仍是 old-kept：核对副本摘要后完成；同一文件的内容被改过时停止，旧库与记录都保留", async () => {
  const root = project(), before = states(root), path = dbPath(root, "groups/g1");
  await killAt(root, "old-kept");
  const killed = readShrinkRecord(data(root))!, files = shrinkFiles(path, killed.run);
  expect(killed.current?.state).toBe("old-kept");
  renameSync(files.copy, files.main);
  expect((await applyShrink({ project: root, spaces: ["groups/g1"] })).recovered).toBe("done");
  expect(readdirSync(dirname(path)).sort()).toEqual(["durable.sqlite", `durable.sqlite.shrink-${killed.run}.old`]);
  expect(state(path)).toEqual(before["groups/g1"]);

  const other = project(), otherPath = dbPath(other, "groups/g1");
  await killAt(other, "old-kept");
  const otherKilled = readShrinkRecord(data(other))!, otherFiles = shrinkFiles(otherPath, otherKilled.run);
  renameSync(otherFiles.copy, otherFiles.main);
  alterInPlace(otherPath);
  expect(fileIdentity(otherPath)).toEqual(otherKilled.current!.copy!.file);
  await expectKept(other, otherKilled, "换上的库与校验过的副本内容不同");
}, 60_000);

for (const point of ["installed", "checked"] as const) {
  test(`在"${point}"处被强制结束后，换上的库被改过（同一文件、提交计数不变、quick_check 通过）：停止，旧库与记录都保留`, async () => {
    const root = project(), path = dbPath(root, "groups/g1");
    await killAt(root, point);
    const killed = readShrinkRecord(data(root))!;
    expect(killed.current?.state).toBe("installed");
    alterInPlace(path);
    expect(fileIdentity(path)).toEqual(killed.current!.copy!.file);
    await expectKept(root, killed, "换上的库与校验过的副本内容不同");
  }, 60_000);
}

const walWriter = `
import { Database } from "bun:sqlite";
const db = new Database(process.argv[2]);
db.exec("PRAGMA wal_autocheckpoint = 0");
db.query("UPDATE document_revisions SET content = json_set(content, '$.written', 1) WHERE rowid = (SELECT min(rowid) FROM document_revisions)").run();
console.log("WROTE");
await new Promise(() => {});
`;

test("换上的库旁的 WAL 有帧（安装之后另一个进程写入、未 checkpoint 就被结束）：文件本身仍与副本相同，也停止，旧库与记录都保留", async () => {
  const root = project(), path = dbPath(root, "groups/g1");
  await killAt(root, "installed");
  const killed = readShrinkRecord(data(root))!, files = shrinkFiles(path, killed.run);
  const script = join(fixture.root, "wal-writer.ts");
  if (!existsSync(script)) await writeFile(script, walWriter);
  const proc = Bun.spawn([process.execPath, script, path], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const errors = new Response(proc.stderr).text();
  let output = "";
  const timer = setTimeout(() => proc.kill("SIGKILL"), 25_000);
  try { for await (const bytes of proc.stdout) { output += Buffer.from(bytes).toString(); if (output.includes("WROTE\n")) break; } }
  finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; }
  expect(output, await errors).toContain("WROTE\n");
  expect(statSync(files.wal).size).toBeGreaterThan(0);
  expect(await fileDigest(path)).toBe(killed.current!.copy!.sha256);
  await expectKept(root, killed, "换上的库旁的 WAL 有");
}, 60_000);

test("保留旧库后副本被改动：放回原库（restored），再重新收缩；记录对不上文件时停止、不做任何改动", async () => {
  const root = project(), before = states(root), path = dbPath(root, "groups/g1");
  await killAt(root, "old-kept");
  const { run } = readShrinkRecord(data(root))!, files = shrinkFiles(path, run);
  appendFileSync(files.copy, "x");
  const summary = await applyShrink({ project: root, spaces: ["groups/g1"] });
  expect(summary.recovered).toBe("restored");
  expect(summary.done.map(db => db.space)).toEqual(["groups/g1"]);
  expect(existsSync(files.old)).toBe(false);
  expect(state(path)).toEqual(before["groups/g1"]);

  // Installed, then the kept original disappeared: not a state of the table.
  const other = project();
  await killAt(other, "installed");
  const killed = readShrinkRecord(data(other))!, otherFiles = shrinkFiles(dbPath(other, "groups/g1"), killed.run);
  rmSync(otherFiles.old);
  const listing = readdirSync(dirname(otherFiles.main)).sort();
  const error = await applyShrink({ project: other, spaces: ["groups/g1"] }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ShrinkStopped);
  expect((error as Error).message).toContain("收缩记录与文件对不上：groups/g1（阶段 installed）；正式路径是副本，.old不存在，.new不存在");
  expect(readdirSync(dirname(otherFiles.main)).sort()).toEqual(listing);
  expect(readShrinkRecord(data(other))).toEqual(killed);
}, 60_000);

test("命令行：shrink-preview 只读；服务持有租约时 shrink 等待；shrink 先恢复再收缩；shrink-status 与 shrink-remove-old 先列出、加 --yes 才删除；未完成的收缩让整理预览先拒绝", async () => {
  const root = project();
  const run = (...args: string[]) => cli(root, ...args);
  const preview = await run("shrink-preview");
  expect(preview.code, preview.stderr).toBe(0);
  expect(preview.stdout).toContain("会话库 2 个，可收缩 2 个");
  expect(preview.stdout).toContain("没有收缩保留的原库");

  // While the service holds the lease the shrink waits, without starting a run.
  const before = states(root), release = await acquireLease("test", join(data(root), "state", "service"));
  const waiting = run("shrink", "--space", "direct");
  await Bun.sleep(3_000);
  expect(states(root)).toEqual(before);
  expect(readShrinkRecord(data(root))).toBeUndefined();
  await release();
  const direct = await waiting;
  expect(direct.code, direct.stderr).toBe(0);
  expect(direct.stdout).toMatch(/会话库收缩（运行 \S+）已完成：1 个库/);
  expect(state(dbPath(root, "direct"))).toEqual(before.direct);

  await killAt(root, "old-kept");
  const refused = await run("preview", "--shell");
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("尚未替换完成");
  const unfinished = await run("shrink-status");
  expect(unfinished.stdout).toContain("未完成：groups/g1，阶段 old-kept");

  const shrunk = await run("shrink", "--space", "groups/g1");
  expect(shrunk.code, shrunk.stderr).toBe(0);
  expect(shrunk.stdout).toContain("上次未完成的收缩已恢复：已完成替换");
  expect(shrunk.stdout).toContain("没有需要收缩的会话库");
  const listed = await run("shrink-remove-old");
  expect(listed.stdout).toContain("收缩保留的原库 2 个");
  expect(listed.stdout).toContain("确认删除请加 --yes");
  expect(keptOriginals(root)).toHaveLength(2);
  const removed = await run("shrink-remove-old", "--yes");
  expect(removed.stdout).toContain("已删除收缩保留的原库 2 个");
  expect(keptOriginals(root)).toEqual([]);
  const stopped = await run("shrink", "--space", "groups/none");
  expect([stopped.code, stopped.stderr.trim()]).toEqual([1, "会话库收缩失败：没有这些空间的会话库：groups/none"]);
}, 90_000);
