// First-time revision cleanup (src/durable/revision-cleanup, revision-chain plan §4.3, §8.1): on synthetic databases
// whose bot documents carry chains like an older release left them (never a base), every document keeps its value read
// by an independent fold (the console's read channel), long chains end as one base committed straight through the
// storage, a verified backup exists before the first change, and a run killed at every step resumes on the state table
// (N0 not committed, N0 + 1 one base at N0) or stops without writing when the state is neither; killed between documents
// with its databases written or replaced since, it is ended as skipped and started again. A committed base that differs
// from the journal is never written back: the database waits for a restore from its backup (revision-restore.test.ts),
// which the service, the rollback and every other maintenance action wait for too.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, defineDoc } from "@earendil-works/pi-durable";
import { validateCurrentData } from "../../src/core/data-validation.ts";
import { acquireLease } from "../../src/core/maintenance.ts";
import { assessMaintenanceAction, MAINTENANCE_INTENTS, MaintenanceRefused, readMaintenanceState, type MaintenanceIntent } from "../../src/core/maintenance-state.ts";
import { ReceiptsDoc } from "../../src/durable/records.ts";
import { fileDigest } from "../../src/durable/revision-cleanup/backup.ts";
import { canonical } from "../../src/durable/revision-cleanup/documents.ts";
import { readQuietly } from "../../src/durable/revision-cleanup/inspect.ts";
import { journalPath, readJournal, type Journal } from "../../src/durable/revision-cleanup/journal.ts";
import { restoreDatabase } from "../../src/durable/revision-cleanup/restore.ts";
import { applyCleanup, CleanupStopped, endCleanup, estimateSeconds, NotEnoughSpace, previewCleanup, previewNeeds, type Point, type Preview } from "../../src/durable/revision-cleanup/run.ts";
import { applyShrink } from "../../src/durable/revision-cleanup/shrink.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { chainState, kindOf as storedKind, Other, PHONE, writeLongChains, type ChainState } from "../helpers/revision-chains.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("revision-cleanup-");
afterAll(() => fixture.cleanup());

const SPACES = ["direct", "groups/g1"];
/** Commits of the template: every bot document changes in each, so each chain has this many revisions. */
const LENGTH = 70;
const template = join(fixture.root, "template");
let counter = 0;

const dbPath = (project: string, space: string) => join(project, "data", "conversations", ...space.split("/"), "durable.sqlite");
const data = (project: string) => join(project, "data");
const cliScript = join(import.meta.dir, "..", "..", "scripts", "runtime", "revision-cleanup.ts");

/** Runs the command-line tool on a project: what it printed and its exit status. */
async function cli(project: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, cliScript, ...args, "--project", project], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

type Any = Record<string, any>;

beforeAll(async () => {
  for (const space of SPACES) await writeLongChains(dbPath(template, space), LENGTH);
}, 60_000);

/** A copy of the template for one test. */
function project(): string {
  const root = join(fixture.root, `project-${++counter}`);
  cpSync(template, root, { recursive: true });
  return root;
}

type State = ChainState;
function state(path: string): State {
  const db = new Database(path, { readonly: true });
  try { return chainState(db); } finally { db.close(); }
}
const states = (root: string) => Object.fromEntries(SPACES.map(space => [space, state(dbPath(root, space))]));
const kindOf = (path: string, id: number) => {
  const db = new Database(path, { readonly: true });
  try { return storedKind(db, id); } finally { db.close(); }
};
const journal = (root: string) => readJournal(data(root));
/** Why the maintenance state refuses `intent` now (undefined: allowed). */
const refusal = (root: string, intent: MaintenanceIntent) => {
  const assessment = assessMaintenanceAction(readMaintenanceState(root), intent);
  return assessment.allowed ? undefined : assessment.reasons.join("；");
};

/** Every long bot chain is one base now; the other kind and the short chain kept theirs; every value is unchanged. */
function expectCleaned(root: string, before: Record<string, State>): void {
  for (const space of SPACES) {
    const path = dbPath(root, space), after = state(path);
    expect(after.values).toEqual(before[space]!.values);
    for (const [id, revisions] of Object.entries(before[space]!.chains)) {
      const kind = kindOf(path, Number(id));
      const expected = revisions > 64 && kind.startsWith("mixin.") ? 1 : revisions;
      expect([space, kind, after.chains[Number(id)]]).toEqual([space, kind, expected]);
    }
  }
}

test("整理：各文档的值逐字段不变，长链只剩一条基准；短链与其他种类不动；每个库先备份并验证；每份文档一次提交；再跑一次无事可做", async () => {
  const root = project(), before = states(root);
  const preview = await previewCleanup({ project: root });
  expect(preview.documents).toBe(20);
  expect(preview.longest).toBe(LENGTH);
  expect(preview.databases.map(db => [db.space, Object.keys(db.kinds).length, db.skipped["probe.other"]?.documents])).toEqual([["direct", 10, 1], ["groups/g1", 10, 1]]);
  expect(JSON.stringify(preview)).not.toContain(PHONE);

  const seen: string[] = [], perSpace: Record<string, number> = {};
  const summary = await applyCleanup({ project: root, hooks: { point: point => {
    if (point !== "journaled" && point !== "committed") return;
    const current = journal(root)!.current!;
    // Opening, reading and checking never advance next_seq; the one commit of each document advances it by one.
    const k = perSpace[current.space] ?? 0;
    expect(current.n0).toBe(before[current.space]!.nextSeq + k);
    expect(state(dbPath(root, current.space)).nextSeq - current.n0).toBe(point === "journaled" ? 0 : 1);
    if (point === "journaled") {
      const backup = journal(root)!.databases.find(db => db.space === current.space)!.backup!;
      expect(backup.state).toBe("verified");
      expect(existsSync(backup.path)).toBe(true);
    } else perSpace[current.space] = k + 1;
    seen.push(point);
  } } });
  expect(summary).toMatchObject({ state: "finished", documents: 20, revisions: 20 * (LENGTH - 1) });
  expect(summary.restore).toBeUndefined();
  expect(seen.filter(point => point === "committed").length).toBe(20);
  expectCleaned(root, before);

  // The backups hold the databases as they were; the journal records each settled document at its seq.
  for (const db of summary.databases) {
    const copy = state(db.backup!.path);
    expect(copy.values).toEqual(before[db.space]!.values);
    expect(copy.chains).toEqual(before[db.space]!.chains);
    expect(db.checkpoint).toMatchObject({ busy: 0, walBytes: 0 });
    const record = journal(root)!.databases.find(item => item.space === db.space)!;
    expect(record.done.map(item => item.seq)).toEqual(Array.from({ length: 10 }, (_, i) => before[db.space]!.nextSeq + i));
    expect(record.nextSeq).toBe(before[db.space]!.nextSeq + 10);
  }
  const text = readFileSync(journalPath(data(root)), "utf8");
  expect(journal(root)).toMatchObject({ state: "finished" });
  expect(journal(root)!.current).toBeUndefined();
  expect(text).not.toContain(PHONE);
  for (const intent of ["service", "verify", "release", "shrink", "conversation-write"] as const) expect(refusal(root, intent)).toBeUndefined();

  // Afterwards: a change through the bot's definition is a delta on the base; an older release reads the same value.
  const path = dbPath(root, "direct");
  const OldReceipts = defineDoc<Any>({ kind: "mixin.receipts", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ items: {} }) });
  const session = createSession(await openGroupStorage(path));
  try {
    expect(canonical(await session.snapshot(OldReceipts, context))).toBe(canonical(await session.snapshot(ReceiptsDoc, context)));
    await session.commit(async tx => { (await tx.doc(ReceiptsDoc)).items.extra = { at: 1, phone: PHONE }; }, context);
  } finally { await session.close(context); }
  const receipts = Object.entries(state(path).chains).find(([id]) => kindOf(path, Number(id)) === "mixin.receipts")!;
  expect(receipts[1]).toBe(2);

  // Nothing left: the finished run moves to the history, no new journal.
  const again = await applyCleanup({ project: root });
  expect(again.state).toBe("nothing");
  expect(existsSync(join(data(root), "state", "revision-cleanup", `${summary.run}.json`))).toBe(true);
  expect(journal(root)).toBeUndefined();
}, 60_000);

test("空间不够时不开始整理：不写日志、不改库", async () => {
  const root = project(), before = states(root);
  const refused = await applyCleanup({ project: root, reserve: Number.MAX_SAFE_INTEGER / 4 }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(NotEnoughSpace);
  expect((refused as Error).message).toContain("空间不足，整理没有开始");
  expect(journal(root)).toBeUndefined();
  expect(states(root)).toEqual(before);
}, 60_000);

test("命令行：预览只读、不含文档键；结构化结果只在 stdout；服务租约被占用时整理只等待、不写入；整理与状态输出汇总", async () => {
  const root = project(), before = states(root);
  const run = (...args: string[]) => cli(root, ...args);
  const preview = await run("preview"), json = await run("preview", "--json"), shell = await run("preview", "--shell");
  expect([preview.code, json.code, shell.code], preview.stderr + json.stderr + shell.stderr).toEqual([0, 0, 0]);
  expect(preview.stdout).toContain("待整理文档 20 份");
  expect(preview.stdout).toContain("不处理 probe.other");
  expect(preview.stdout).toMatch(/预计用时约 .+（先备份 .+），最大一次删除约需 WAL .+\n所需空间（含保留 1\.00 GB）：/);
  const library = await previewCleanup({ project: root }), need = previewNeeds({ project: root }, library);
  // One line of JSON, protocol fields first; the description goes to stderr.
  const lines = json.stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!) as Any;
  expect(Object.keys(parsed).slice(0, 4)).toEqual(["protocol", "version", "command", "outcome"]);
  expect(parsed).toMatchObject({ protocol: "mixin-maintenance", version: 1, command: "preview", outcome: "success",
    result: { documents: 20, longest: LENGTH, backupBytes: need.backupBytes } });
  expect(json.stderr).toContain("待整理文档 20 份");
  const values = Object.fromEntries(shell.stdout.trim().split("\n").map(line => line.split("=") as [string, string]));
  expect(values).toEqual({ protocol: "mixin-maintenance", version: "1", command: "preview", outcome: "success", documents: "20",
    revisions: String(library.revisions), longest: String(LENGTH), legacy: "0", backup_bytes: String(need.backupBytes),
    wal_bytes: String(need.walBytes), seconds: String(estimateSeconds(library, need)), run_state: "none", end: "1" });
  expect(shell.stdout.trim().split("\n").at(-1)).toBe("end=1");
  expect(need.backupBytes).toBeGreaterThan(0);
  expect(shell.stderr).toContain("待整理文档 20 份");
  // Space for the choice the deployment made: enough here, not enough (exit 4) when it cannot fit.
  const space = await run("space", "--backup-bytes", String(need.backupBytes), "--wal-bytes", String(need.walBytes));
  const short = await run("space", "--backup-bytes", String(Number.MAX_SAFE_INTEGER), "--wal-bytes", "0");
  const shortJson = await run("space", "--backup-bytes", String(Number.MAX_SAFE_INTEGER), "--wal-bytes", "0", "--json");
  expect([space.code, short.code, shortJson.code], space.stderr + short.stderr).toEqual([0, 4, 4]);
  expect(short.stderr).toContain("（不足）");
  expect(JSON.parse(shortJson.stdout)).toMatchObject({ command: "space", outcome: "not-enough-space", result: { volumes: [{ need: expect.any(Number) }] } });
  expect(states(root)).toEqual(before);

  // The service holds the lease: apply waits for it (a crashed holder's lease goes stale after 30 s) and writes nothing.
  const release = await acquireLease("test", join(data(root), "state", "service"));
  const waiting = run("apply", "--json");
  await Bun.sleep(3_000);
  expect(states(root)).toEqual(before);
  expect(journal(root)).toBeUndefined();
  await release();

  const applied = await waiting, status = await run("status"), statusJson = await run("status", "--json");
  expect([applied.code, status.code, statusJson.code], applied.stderr + status.stderr).toEqual([0, 0, 0]);
  expect(JSON.parse(applied.stdout)).toMatchObject({ command: "apply", outcome: "success", result: { state: "finished", documents: 20 } });
  expect(applied.stderr).toMatch(/修订整理（运行 \S+）已完成：整理文档 20 份/);
  expect(status.stdout).toMatch(/修订整理（运行 \S+）已完成/);
  expect(JSON.parse(statusJson.stdout)).toMatchObject({ outcome: "success",
    result: { state: { cleanup: { status: "present", state: "finished" }, shrink: { status: "absent" } }, summary: { documents: 20 } } });
  for (const output of [preview, json, shell, space, short, applied, status, statusJson]) expect(output.stdout + output.stderr).not.toContain(PHONE);
  expectCleaned(root, before);
}, 60_000);

test("命令行参数严格：未知参数、别的动作的参数、重复、缺少必需参数或值不对、--json 与 --shell 同用都拒绝（refused，退出码 1），不读不写", async () => {
  const root = project(), before = states(root);
  const cases: [string[], string][] = [
    [["apply", "--no-backup", "--json"], "apply 不接受参数 --no-backup"],
    [["apply", "--space", "direct", "--json"], "apply 不接受参数 --space"],
    [["shrink", "--spaces", "direct", "--json"], "shrink 不接受参数 --spaces"],
    [["shrink-remove-old", "--yes", "--yes", "--json"], "--yes 重复"],
    [["preview", "--json", "--shell"], "--json 与 --shell 只能选一个"],
    [["restore", "--json"], "restore 需要 --space"],
    [["restore", "--space", "direct", "--space", "groups/g1", "--json"], "--space 重复"],
    [["space", "--wal-bytes", "0", "--json"], "space 需要 --backup-bytes"],
    [["space", "--backup-bytes", "1e9", "--wal-bytes", "0", "--json"], "--backup-bytes 需要非负整数"],
    [["bogus", "--json"], "未知动作 bogus"],
  ];
  const results = await Promise.all(cases.map(([args]) => cli(root, ...args)));
  for (const [index, [args, message]] of cases.entries()) {
    const { stdout, stderr, code } = results[index]!;
    expect([args.join(" "), code]).toEqual([args.join(" "), 1]);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const result = JSON.parse(lines[0]!) as Any;
    expect(result).toMatchObject({ protocol: "mixin-maintenance", version: 1, command: args[0], outcome: "refused" });
    expect(result.message).toContain(message);
    expect(stderr).toContain(message);
  }
  const shell = await cli(root, "apply", "--no-backup", "--shell");
  expect(shell.code).toBe(1);
  expect(shell.stdout.trim().split("\n")).toEqual(["protocol=mixin-maintenance", "version=1", "command=apply", "outcome=refused", "end=1"]);
  expect(journal(root)).toBeUndefined();
  expect(states(root)).toEqual(before);
}, 60_000);

// The upgrade previews with data/ mounted read-only, where a read-only connection cannot create the -wal and -shm a
// cleanly closed database lacks. unshare is unavailable where unprivileged user namespaces are restricted (Ubuntu 24.04).
const readOnlyMount = (dir: string, ...command: string[]) => ["unshare", "-rm", "sh", "-c",
  'mount --bind "$1" "$1" && mount -o remount,bind,ro "$1" && shift && exec "$@"', "sh", dir, ...command];
const canMountReadOnly = process.platform === "linux" && Bun.which("unshare") !== null &&
  Bun.spawnSync(readOnlyMount(fixture.root, "true"), { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

test("预览不在会话库旁写文件：干净关闭的库按不可变文件读，服务开着的库连同 WAL 读；读取期间库被改写时重读", async () => {
  const root = project(), spaceFiles = () => SPACES.map(space => readdirSync(dirname(dbPath(root, space))).sort());
  const files = spaceFiles();
  expect(files).toEqual(SPACES.map(() => ["durable.sqlite"]));
  const closed = await previewCleanup({ project: root });
  expect(closed.documents).toBe(20);
  expect(spaceFiles()).toEqual(files);

  // The service has the direct conversation open with a commit only in its WAL: the preview counts it.
  const revisionsOf = (preview: Preview) => preview.databases.find(db => db.space === "direct")!.revisions;
  const session = createSession(await openGroupStorage(dbPath(root, "direct")));
  try {
    await session.commit(async tx => { (await tx.doc(Other)).n = -1; }, context);
    expect(existsSync(`${dbPath(root, "direct")}-wal`)).toBe(true);
    expect(revisionsOf(await previewCleanup({ project: root }))).toBe(revisionsOf(closed) + 1);
  } finally { await session.close(context); }
  expect(spaceFiles()).toEqual(files);

  // A writer that checkpoints into the file during an immutable read: the read is repeated; one that never stops fails.
  // Each write waits out the file system's timestamp tick (a few milliseconds on Linux), or the file looks unchanged.
  const path = join(fixture.root, `quiet-${++counter}.sqlite`);
  const write = (value: number) => {
    Bun.sleepSync(30);
    const db = new Database(path, { create: true });
    try { db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS t (v INTEGER); INSERT INTO t VALUES (${value})`); } finally { db.close(); }
  };
  write(1);
  const count = (db: Database) => (db.query("SELECT count(*) AS n FROM t").get() as { n: number }).n;
  let reads = 0;
  expect(readQuietly(path, db => { const n = count(db); if (++reads === 1) write(2); return n; })).toBe(2);
  expect(reads).toBe(2);
  expect(() => readQuietly(path, db => { write(3); return count(db); })).toThrow("在读取期间一直在变化");
}, 60_000);

test.skipIf(!canMountReadOnly)("Linux：data/ 只读挂载时预览照常读取干净关闭的库和服务开着的库", async () => {
  const root = project();
  const preview = async (format: "--shell" | "--json") => {
    const proc = Bun.spawn(readOnlyMount(data(root), process.execPath, cliScript, "preview", format, "--project", root), { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    return stdout;
  };
  const shell = Object.fromEntries((await preview("--shell")).trim().split("\n").map(line => line.split("=") as [string, string]));
  expect(shell).toMatchObject({ outcome: "success", documents: "20", run_state: "none", end: "1" });
  // The service's commit to another kind is only in its WAL: the database's revision count includes it.
  const direct = async () => (JSON.parse(await preview("--json")).result as Preview).databases.find(db => db.space === "direct")!;
  const closed = await direct();
  const session = createSession(await openGroupStorage(dbPath(root, "direct")));
  try {
    await session.commit(async tx => { (await tx.doc(Other)).n = -1; }, context);
    expect(existsSync(`${dbPath(root, "direct")}-wal`)).toBe(true);
    expect(await direct()).toMatchObject({ revisions: closed.revisions + 1, walBytes: statSync(`${dbPath(root, "direct")}-wal`).size });
  } finally { await session.close(context); }
}, 60_000);

// ─── A committed base that differs ─────────────────────────────────────────

/** A value hook that makes the `nth` committed base differ from the journal (1-based). */
const corruptNth = (nth: number) => {
  let calls = 0;
  return (value: Record<string, unknown>) => ++calls === nth ? { ...value, corrupted: true } : undefined;
};

test("提交后的基准与日志不同：不写回，整理停止，这个库待从备份恢复；恢复之前服务、续做、跳过、回滚、收缩和会话写入都拒绝，只有恢复可以", async () => {
  const root = project(), before = states(root);
  const error = await applyCleanup({ project: root, hooks: { value: corruptNth(3) } }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CleanupStopped);
  expect((error as Error).message).toContain("没有写回；这个库需要从备份恢复（revision-cleanup restore --space direct）");
  const stopped = journal(root)!;
  const id = stopped.restore!.document.id;
  expect(stopped).toMatchObject({ state: "stopped", restore: { space: "direct", state: "required", document: { seq: before.direct!.nextSeq + 2 } } });
  expect(stopped.restore!.document.found).not.toBe(stopped.restore!.document.expected);
  expect(stopped.current).toBeUndefined();
  expect(stopped.databases).toHaveLength(1);
  expect(stopped.databases[0]!.done).toHaveLength(2);
  // Not written back: the base with the wrong value stays as committed, for the restore to replace with the backup.
  const after = state(dbPath(root, "direct"));
  expect(after.nextSeq).toBe(before.direct!.nextSeq + 3);
  expect(after.chains[id]).toBe(1);
  expect(JSON.parse(after.values[id]!)).toMatchObject({ corrupted: true });
  expect(state(dbPath(root, "groups/g1"))).toEqual(before["groups/g1"]!);

  for (const intent of MAINTENANCE_INTENTS.filter(intent => intent !== "restore")) expect([intent, refusal(root, intent)]).toEqual([intent, expect.stringContaining("需要从备份恢复")]);
  expect(refusal(root, "restore")).toBeUndefined();
  await expect(applyCleanup({ project: root })).rejects.toBeInstanceOf(MaintenanceRefused);
  await expect(endCleanup({ project: root }, "skipped")).rejects.toThrow("需要从备份恢复");
  await expect(endCleanup({ project: root }, "abandoned")).rejects.toThrow("需要从备份恢复");
  await expect(applyShrink({ project: root })).rejects.toThrow("需要从备份恢复");
  await expect(validateCurrentData(root)).rejects.toThrow("需要从备份恢复");
  // The ops entries and the rollback read the same through the command line.
  const abandon = await cli(root, "abandon", "--json"), preview = await cli(root, "preview", "--json");
  expect([abandon.code, preview.code]).toEqual([1, 1]);
  expect(JSON.parse(abandon.stdout)).toMatchObject({ command: "abandon", outcome: "refused", result: { intent: "rollback" } });
  expect(JSON.parse(preview.stdout)).toMatchObject({ command: "preview", outcome: "refused" });
  expect(journal(root)).toEqual(stopped);
  expect(state(dbPath(root, "direct"))).toEqual(after);
}, 60_000);

// ─── Killed runs ───────────────────────────────────────────────────────────

const spec = (name: string) => JSON.stringify(import.meta.resolve(name));
const child = `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyCleanup } from ${spec("../../src/durable/revision-cleanup/run.ts")};
import { readJournal } from ${spec("../../src/durable/revision-cleanup/journal.ts")};
const [project, stopAt, corrupt] = process.argv.slice(2);
let corrupted = false;
await applyCleanup({ project, hooks: {
  point: async point => {
    if (point !== stopAt) return;
    if (point === "backup-started") {
      // Half a copy: the run is killed while VACUUM INTO writes.
      const backup = readJournal(join(project, "data")).databases.at(-1).backup;
      mkdirSync(dirname(backup.path), { recursive: true });
      writeFileSync(backup.path, "SQLite format 3\\0" + "x".repeat(5000));
    }
    console.log("AT " + point);
    await new Promise(() => {});
  },
  value: value => { if (corrupt && !corrupted) { corrupted = true; return { ...value, corrupted: true }; } },
} });
console.log("FINISHED");
`;

/** Runs the cleanup in a child process that blocks at `point` and is then force-killed. */
async function killAt(root: string, point: Point, corrupt = false): Promise<void> {
  const script = join(fixture.root, "child.ts");
  if (!existsSync(script)) await writeFile(script, child);
  const proc = Bun.spawn([process.execPath, script, root, point, corrupt ? "corrupt" : ""], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const errors = new Response(proc.stderr).text();
  let output = "";
  const timer = setTimeout(() => proc.kill("SIGKILL"), 25_000);
  try { for await (const bytes of proc.stdout) { output += Buffer.from(bytes).toString(); if (output.includes(`AT ${point}\n`)) break; } }
  finally { clearTimeout(timer); proc.kill("SIGKILL"); await proc.exited; }
  expect(output, await errors).toContain(`AT ${point}\n`);
}

const fileOf = (path: string) => { const info = statSync(path, { bigint: true }); return { ino: String(info.ino), mtime: String(info.mtimeNs), size: String(info.size) }; };

for (const point of ["backup-started", "backup-written", "backup-verified", "journaled", "committed"] as const) {
  test(`在"${point}"处被强制结束：在途文档先按状态表收尾，再续做其余文档；备份不会被整理到一半的库覆盖`, async () => {
    const root = project(), before = states(root);
    await killAt(root, point);
    const killed = journal(root)!;
    const backup = killed.databases[0]!.backup!;
    const verified = backup.state === "verified" ? fileOf(backup.path) : undefined;
    if (point === "backup-started" || point === "backup-written") {
      expect(backup.state).toBe("writing");
      expect(killed.current).toBeUndefined();
    } else if (point === "backup-verified") {
      expect(verified).toBeDefined();
      expect(killed.current).toBeUndefined();
    } else {
      expect(verified).toBeDefined();
      expect(killed.current).toBeDefined();
      expect(state(dbPath(root, killed.current!.space)).nextSeq - killed.current!.n0).toBe(point === "journaled" ? 0 : 1);
    }
    // Between documents nothing keeps the service stopped (it would supersede the run); a document in flight does.
    if (killed.current) expect(refusal(root, "service")).toContain("尚未收尾");
    else expect(refusal(root, "service")).toBeUndefined();
    const summary = await applyCleanup({ project: root });
    expect(summary).toMatchObject({ run: killed.run, state: "finished", documents: 20 });
    expectCleaned(root, before);
    // A verified copy is reused as it was (its digest checked first); an unfinished one is written again from the untouched
    // database.
    if (verified) {
      expect(fileOf(backup.path)).toEqual(verified);
      expect(journal(root)!.databases[0]!.backup).toEqual(backup);
      expect(await fileDigest(backup.path)).toBe(backup.sha256!);
    }
    for (const db of summary.databases) expect(state(db.backup!.path).values).toEqual(before[db.space]!.values);
  }, 60_000);
}

for (const end of ["resume", "skipped", "abandoned"] as const) {
  test(`提交了与日志不同的值后在"committed"处被强制结束：${end === "resume" ? "续做" : end === "skipped" ? "跳过" : "回滚"}收尾时发现不一致，不写回、不结束整理，待从备份恢复`, async () => {
    const root = project(), before = states(root);
    await killAt(root, "committed", true);
    expect(refusal(root, "service")).toContain("尚未收尾");
    const ending = end === "resume" ? applyCleanup({ project: root }) : endCleanup({ project: root }, end);
    const error = await ending.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CleanupStopped);
    expect((error as Error).message).toContain("需要从备份恢复");
    const stopped = journal(root)!;
    expect(stopped).toMatchObject({ state: "stopped", restore: { space: "direct", state: "required", document: { seq: before.direct!.nextSeq } } });
    expect(stopped.current).toBeUndefined();
    expect(stopped.databases[0]!.done).toEqual([]);
    // The rollback cannot clear it either: the restore stays required.
    for (const intent of ["service", "rollback", "skip", "resume"] as const) expect(refusal(root, intent)).toContain("需要从备份恢复");
    expect(refusal(root, "restore")).toBeUndefined();
    expect(state(dbPath(root, "direct")).nextSeq).toBe(before.direct!.nextSeq + 1);
    expect(state(dbPath(root, "groups/g1"))).toEqual(before["groups/g1"]!);
  }, 60_000);
}

// ─── Backups on resume ─────────────────────────────────────────────────────

/** Ways a verified backup can differ from its record while keeping its length. */
const backupChanges: [string, (path: string) => void][] = [
  // In place: one byte of the SQLite header, so it is not even a database any more.
  ["损坏但长度不变", path => {
    const bytes = readFileSync(path);
    bytes[0] = bytes[0]! ^ 1;
    writeFileSync(path, bytes);
  }],
  // A new file in its place: a valid database of the same size whose values differ (same-length text changed).
  ["同大小替换", path => {
    const copy = `${path}.replacement`;
    copyFileSync(path, copy);
    const db = new Database(copy);
    try { db.query("UPDATE document_revisions SET content = replace(content, 'generation-1', 'generation-9')").run(); } finally { db.close(); }
    renameSync(copy, path);
  }],
];

for (const [name, change] of backupChanges) {
  test(`续做前核对备份摘要：${name}，在途文档收尾后停止；剩余文档不动，备份不被整理到一半的库覆盖`, async () => {
    const root = project(), before = states(root);
    await killAt(root, "committed");
    const killed = journal(root)!;
    const backup = killed.databases[0]!.backup!, id = killed.current!.document.id;
    change(backup.path);
    const changed = readFileSync(backup.path);
    expect(changed.length).toBe(backup.bytes!);
    expect(await fileDigest(backup.path)).not.toBe(backup.sha256!);
    // Through the command line, as the ops entries run it: stopped (exit 3).
    const run = await cli(root, "apply", "--json");
    expect(run.code, run.stderr).toBe(3);
    expect(JSON.parse(run.stdout)).toMatchObject({ command: "apply", outcome: "stopped", message: expect.stringContaining("不能重新备份") });
    expect(run.stderr).toContain("修订整理已停止：");
    expect(run.stderr).toContain("与记录的摘要不同");
    // The document in flight was settled first (one base, same value); nothing after it was touched.
    const stopped = journal(root)!, space = killed.databases[0]!.space;
    expect(stopped.state).toBe("stopped");
    expect(stopped.current).toBeUndefined();
    expect(stopped.restore).toBeUndefined();
    // Nothing is in flight, so nothing keeps the service from starting and the ops entry that stopped the bot starts it
    // again: the tool says only that the cleanup stopped, not what becomes of the bot.
    expect(refusal(root, "service")).toBeUndefined();
    expect(run.stderr).not.toMatch(/机器人|保持停/);
    expect(stopped.databases.map(db => [db.space, db.done.map(item => item.id)])).toEqual([[space, [id]]]);
    expect(stopped.databases[0]!.backup).toEqual(backup);
    const after = state(dbPath(root, space));
    expect(after.values).toEqual(before[space]!.values);
    expect(after.chains[id]).toBe(1);
    expect(Object.values(after.chains).filter(n => n === LENGTH).length).toBe(Object.values(before[space]!.chains).filter(n => n === LENGTH).length - 1);
    for (const other of SPACES.filter(name => name !== space)) expect(state(dbPath(root, other))).toEqual(before[other]!);
    expect(readFileSync(backup.path).equals(changed)).toBe(true);
    await expect(applyCleanup({ project: root })).rejects.toThrow("只能跳过剩余整理或回滚");
  }, 60_000);

  test(`续做前核对备份摘要：${name}，会话库在备份之后没有改动——从原样的库重新备份后整理`, async () => {
    const root = project(), before = states(root);
    await killAt(root, "backup-verified");
    const killed = journal(root)!;
    const backup = killed.databases[0]!.backup!;
    expect(killed.current).toBeUndefined();
    change(backup.path);
    const logs: string[] = [];
    const summary = await applyCleanup({ project: root, log: line => logs.push(line) });
    expect(summary).toMatchObject({ run: killed.run, state: "finished", documents: 20 });
    expect(logs.join("\n")).toContain("与记录的摘要不同（已损坏或被替换）；会话库在备份之后没有改动，重新备份");
    expectCleaned(root, before);
    const rewritten = journal(root)!.databases[0]!.backup!;
    expect(rewritten.path).toBe(backup.path);
    expect(await fileDigest(rewritten.path)).toBe(rewritten.sha256!);
    for (const db of summary.databases) expect(state(db.backup!.path).values).toEqual(before[db.space]!.values);
  }, 60_000);
}

for (const end of ["skipped", "abandoned"] as const) {
  for (const point of ["journaled", "committed"] as const) {
    test(`${end === "skipped" ? "跳过剩余整理" : "回滚"}之前先收尾在途文档（在"${point}"处中断）：${point === "journaled" ? "尚未提交的不再整理" : "已提交的核对后记为完成"}；其余长链不动`, async () => {
      const root = project(), before = states(root);
      await killAt(root, point);
      const id = journal(root)!.current!.document.id;
      expect(await endCleanup({ project: root }, end)).toMatchObject({ state: end, documents: point === "journaled" ? 0 : 1 });
      const after = state(dbPath(root, "direct"));
      expect(after.values).toEqual(before.direct!.values);
      expect(after.chains[id]).toBe(point === "journaled" ? LENGTH : 1);
      expect(after.nextSeq).toBe(before.direct!.nextSeq + (point === "journaled" ? 0 : 1));
      expect(Object.values(after.chains).filter(n => n === LENGTH).length)
        .toBe(Object.values(before.direct!.chains).filter(n => n === LENGTH).length - (point === "journaled" ? 0 : 1));
      expect(journal(root)!.current).toBeUndefined();
      expect(journal(root)!.state).toBe(end);
      for (const intent of ["service", "cleanup", "shrink", "conversation-write"] as const) expect(refusal(root, intent)).toBeUndefined();
    }, 60_000);
  }
}

// ─── Superseded runs ───────────────────────────────────────────────────────

const idOf = (path: string, kind: string) => {
  const db = new Database(path, { readonly: true });
  try { return (db.query("SELECT id, kind FROM documents").all() as { id: number; kind: string }[]).find(row => JSON.parse(row.kind) === kind)!.id; }
  finally { db.close(); }
};

const replaceFile = (path: string) => {
  const db = new Database(path);
  try { db.query("PRAGMA wal_checkpoint(TRUNCATE)").get(); } finally { db.close(); }
  copyFileSync(path, `${path}.copy`);
  renameSync(`${path}.copy`, path);
};

const superseding: [string, (path: string) => Promise<void> | void, string][] = [
  ["服务写过这个库", path => otherWriter(path, idOf(path, "mixin.receipts"), 1, false), "已有其他写入"],
  ["会话库文件被替换（内容相同、文件身份不同）", replaceFile, "文件已被替换"],
];

for (const [name, alter, reason] of superseding) {
  test(`中断在两份文档之间，之后${name}：上次整理记为跳过，不续做、不沿用它的备份，重新整理`, async () => {
    const root = project();
    await killAt(root, "backup-written");
    const killed = journal(root)!;
    expect(killed.current).toBeUndefined();
    expect(previewNeeds({ project: root }, await previewCleanup({ project: root })).run).toEqual({ run: killed.run, state: "running" });
    await alter(dbPath(root, killed.databases[0]!.space));
    const changed = states(root);
    // Read only: the preview already treats the run as over and plans fresh backups of every database.
    const preview = await previewCleanup({ project: root }), need = previewNeeds({ project: root }, preview);
    expect(need.run).toBeUndefined();
    expect(need.backupBytes).toBe(preview.databases.reduce((n, db) => n + db.usedBytes + db.walBytes, 0));
    expect(journal(root)).toEqual(killed);
    const logs: string[] = [];
    const summary = await applyCleanup({ project: root, log: line => logs.push(line) });
    expect(summary).toMatchObject({ state: "finished", documents: 20 });
    expect(summary.run).not.toBe(killed.run);
    expect(logs.join("\n")).toContain(`上次整理（运行 ${killed.run}）不能续做`);
    const archived = JSON.parse(readFileSync(join(data(root), "state", "revision-cleanup", `${killed.run}.json`), "utf8")) as Journal;
    expect(archived).toMatchObject({ state: "skipped", superseded: expect.stringContaining(reason) });
    expectCleaned(root, changed);
    for (const db of summary.databases) {
      expect(db.backup!.path).toContain(summary.run);
      expect(state(db.backup!.path).values).toEqual(changed[db.space]!.values);
    }
  }, 60_000);
}

// ─── Refusals ──────────────────────────────────────────────────────────────

/** A writer that is not the cleanup: `base` writes every change as a base, otherwise as a delta. */
async function otherWriter(path: string, id: number, commits: number, base: boolean): Promise<void> {
  const kind = kindOf(path, id);
  const Token = defineDoc<Any>({ kind, version: 1, checkpointWhen: () => base, scope: "session", initial: () => ({}) });
  const session = createSession(await openGroupStorage(path));
  try {
    for (let i = 0; i < commits; i++) {
      // Only session-scoped singletons are written here (the first document the cleanup takes is the space document).
      await session.commit(async tx => { (await tx.doc(Token)).otherWriter = i; }, context);
    }
  } finally { await session.close(context); }
}

const sql = (path: string, statement: string, ...values: number[]) => {
  const db = new Database(path);
  try { db.query(statement).run(...values); } finally { db.close(); }
};

const refusals: [string, Point, (path: string, id: number) => Promise<void> | void, string][] = [
  ["会话库文件被替换（内容相同、文件身份不同）", "committed", path => replaceFile(path), "文件身份"],
  ["文档行与日志不同", "committed", (path, id) => sql(path, "UPDATE documents SET record = json_set(record, '$.edited', 1) WHERE id = ?", id), "文档行与日志不同"],
  ["停机期间出现额外的增量", "journaled", (path, id) => otherWriter(path, id, 1, false), "不是预计序号"],
  ["提交之后又出现一条增量", "committed", (path, id) => otherWriter(path, id, 1, false), "不是本次操作能留下的状态"],
  ["另一个写入者写出三条基准（序号 N0 + 3）", "journaled", (path, id) => otherWriter(path, id, 3, true), "不是本次操作能留下的状态"],
];

for (const [name, point, tamper, reason] of refusals) {
  test(`拒绝：${name}——停止、不写入、保持停机；跳过和回滚同样拒绝`, async () => {
    const root = project();
    await killAt(root, point);
    const current = journal(root)!.current!;
    const path = dbPath(root, current.space);
    await tamper(path, current.document.id);
    const tampered = state(path);
    const error = await applyCleanup({ project: root }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CleanupStopped);
    expect((error as Error).message).toContain(reason);
    expect(state(path)).toEqual(tampered);
    const stopped = journal(root) as Journal;
    expect(stopped.state).toBe("stopped");
    expect(stopped.restore).toBeUndefined();
    expect(stopped.current?.document.id).toBe(current.document.id);
    expect(refusal(root, "service")).toContain("尚未收尾");
    // The service, the verification instance and the release commit all validate through this, before anything else.
    await expect(validateCurrentData(root)).rejects.toThrow("尚未收尾");
    // Skipping or rolling back tries the same settlement first and refuses the same way.
    await expect(endCleanup({ project: root }, "skipped")).rejects.toThrow(reason);
    await expect(endCleanup({ project: root }, "abandoned")).rejects.toThrow(reason);
    expect(state(path)).toEqual(tampered);
    expect(journal(root)!.current?.document.id).toBe(current.document.id);
    expect(journal(root)!.state).toBe("stopped");
  }, 60_000);
}

test("拒绝：停机期间最后一条修订被改动（提交序号不变）——续做停止、不提交；跳过时这份尚未提交的文档原样留下，不写入", async () => {
  const root = project();
  await killAt(root, "journaled");
  const current = journal(root)!.current!;
  const path = dbPath(root, current.space);
  sql(path, `UPDATE document_revisions SET content = '[["s",["tampered"],1]]' WHERE document_id = ?1
    AND seq = (SELECT max(seq) FROM document_revisions WHERE document_id = ?1)`, current.document.id);
  const tampered = state(path);
  await expect(applyCleanup({ project: root })).rejects.toThrow("的值或版本与日志不同，没有写入");
  expect(state(path)).toEqual(tampered);
  expect(journal(root)).toMatchObject({ state: "stopped", current: { document: { id: current.document.id } } });
  expect(refusal(root, "service")).toContain("尚未收尾");
  expect(await endCleanup({ project: root }, "skipped")).toMatchObject({ state: "skipped", documents: 0 });
  expect(state(path)).toEqual(tampered);
  expect(refusal(root, "service")).toBeUndefined();
}, 60_000);

test("停机期间另一个写入者在 N0 写出一条值不同的基准：与本次提交无从区分，按提交后不一致处理，不写回，待从备份恢复", async () => {
  const root = project();
  await killAt(root, "journaled");
  const current = journal(root)!.current!;
  await otherWriter(dbPath(root, current.space), current.document.id, 1, true);
  await expect(applyCleanup({ project: root })).rejects.toThrow("需要从备份恢复");
  expect(journal(root)).toMatchObject({ state: "stopped", restore: { space: current.space, state: "required", document: { id: current.document.id, seq: current.n0 } } });
  expect(refusal(root, "rollback")).toContain("需要从备份恢复");
}, 60_000);

// ─── Journals of another format ────────────────────────────────────────────

test("旧格式（格式 1，开发版本）或无法解析的整理日志：服务、续做、跳过、回滚、恢复、收缩和会话写入都拒绝，日志与会话库原样保留", async () => {
  const texts = [
    // The first, unreleased format: no version, values and a no-backup choice in the journal.
    JSON.stringify({ run: "20261020-dev", state: "running", backup: false, databases: [], current: { space: "direct", phase: "marked" } }),
    JSON.stringify({ version: 1, run: "20261020-dev", state: "stopped", databases: [] }),
    "{",
  ];
  for (const text of texts) {
    const root = project(), before = states(root);
    mkdirSync(join(data(root), "state"), { recursive: true });
    writeFileSync(journalPath(data(root)), text);
    const reason = text === "{" ? "无法解析" : "格式不受支持";
    for (const intent of MAINTENANCE_INTENTS) expect([intent, refusal(root, intent)]).toEqual([intent, expect.stringContaining(reason)]);
    await expect(applyCleanup({ project: root })).rejects.toBeInstanceOf(MaintenanceRefused);
    await expect(endCleanup({ project: root }, "skipped")).rejects.toBeInstanceOf(MaintenanceRefused);
    await expect(endCleanup({ project: root }, "abandoned")).rejects.toBeInstanceOf(MaintenanceRefused);
    await expect(restoreDatabase({ project: root, space: "direct" })).rejects.toBeInstanceOf(MaintenanceRefused);
    await expect(applyShrink({ project: root })).rejects.toBeInstanceOf(MaintenanceRefused);
    await expect(validateCurrentData(root)).rejects.toThrow(reason);
    const outputs = await Promise.all([cli(root, "abandon", "--json"), cli(root, "preview", "--json"), cli(root, "apply", "--json")]);
    for (const output of outputs) {
      expect(output.code).toBe(1);
      expect(JSON.parse(output.stdout)).toMatchObject({ outcome: "refused", message: expect.stringContaining(reason) });
    }
    expect(readFileSync(journalPath(data(root)), "utf8")).toBe(text);
    expect(states(root)).toEqual(before);
  }
}, 60_000);
