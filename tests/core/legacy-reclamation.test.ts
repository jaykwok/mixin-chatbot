import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fsp from "node:fs/promises";
import { chmod, chown, lchown, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { withSpaceSnapshot } from "../../src/durable/diagnostics.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import * as io from "../../scripts/lib/atomic-file.ts";
import { describeUnfinished, legacyBlocker, LegacyReclamationPending, reclaimLegacy } from "../../src/maintenance/legacy.ts";
import { reclamationEvidence } from "../../src/core/reclamation-files.ts";
import { applyArchiveRemoval, applyTmpArchive, previewArchiveRemoval, previewTmpArchive } from "../../src/maintenance/archive.ts";
import type { MemberScope } from "../../src/maintenance/scope.ts";
import { scopeOf } from "../helpers/layout.ts";

// Opt-in only: the ordinary suite must never obtain privileges. Every byte is synthetic,
// and the root-owned journal needs trusted ancestors (so /tmp is deliberately unsuitable).
const privileged = process.platform === "linux" && process.getuid!() === 0 && process.env.MIXIN_REAL_RECLAMATION === "1" ? test : test.skip;
async function fixture() {
  const root = await mkdtemp("/var/lib/mixin-reclamation-test-");
  console.log("Synthetic privileged fixture retained at " + root);
  await chmod(root, 0o755);
  const parent = join(root, "caller"), path = join(parent, "result"), nested = join(path, "nested"), journal = join(root, "journal");
  await mkdir(nested, { recursive: true }); await mkdir(journal, { mode: 0o700 });
  for (const dir of [parent, path, nested]) { await chown(dir, 1000, 1000); await chmod(dir, 0o700); }
  await writeFile(join(nested, "owned"), "reviewed"); await chown(join(nested, "owned"), 1000, 1000);
  const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "keep");
  await symlink(outside, join(nested, "link"));
  return { root, parent, path, nested, journal, outside, operation: randomUUID() + "-0", proof: await reclamationEvidence(path) };
}

privileged("legacy fencing revokes an old writer's cwd and dirfd; deletion resumes from its durable intent", async () => {
  const f = await fixture();
  const actor = spawn(process.execPath, ["-e", `
    const fs = require('node:fs');
    const fd = fs.openSync('.', 'r');
    console.log('ready');
    process.stdin.once('data', () => {
      const results = [];
      for (const path of ['./new-child', '/proc/self/fd/' + fd + '/other-child']) {
        try { fs.mkdirSync(path); results.push('WRITABLE'); } catch (e) { results.push(e.code); }
      }
      console.log(JSON.stringify(results)); fs.closeSync(fd); process.exit(0);
    });
  `], { cwd: f.nested, uid: 1000, gid: 1000, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  actor.stdout.on("data", data => output += String(data)); actor.stderr.on("data", data => stderr += String(data));
  const exited = new Promise<number | null>((resolve, reject) => { actor.on("exit", resolve); actor.on("error", reject); });
  const deadline = Date.now() + 10_000;
  while (!output.includes("ready") && Date.now() < deadline) await Bun.sleep(10);
  expect(output, stderr).toContain("ready");
  const original = io.publishJson;
  let injected = false;
  const intercept = spyOn(io, "publishJson").mockImplementation(async (path, value) => {
    await original(path, value);
    if (!injected && (value as { phase?: string }).phase === "deleting") {
      injected = true; actor.stdin.end("try"); expect(await exited).toBe(0);
      expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual(["EACCES", "EACCES"]);
      throw new Error("synthetic crash after deletion intent");
    }
  });
  try {
    let failure: unknown;
    try { await reclaimLegacy(f.path, f.proof, f.journal, f.operation); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(LegacyReclamationPending); expect(injected).toBe(true);
  } finally { intercept.mockRestore(); actor.kill(); }
  expect((await lstat(f.path)).uid).toBe(0);
  await reclaimLegacy(f.path, f.proof, f.journal, f.operation);
  expect(await lstat(f.path).catch(error => error.code)).toBe("ENOENT");
  expect((await lstat(f.parent)).uid).toBe(1000);
  expect(await readFile(join(f.outside, "keep"), "utf8")).toBe("keep");
  await reclaimLegacy(f.path, f.proof, f.journal, f.operation);
});

privileged("legacy partial fencing restores original ownership; changed preview remains intact", async () => {
  const f = await fixture(), original = io.publishJson;
  const intercept = spyOn(io, "publishJson").mockImplementation(async (path, value) => {
    await original(path, value);
    if ((value as { directories?: unknown[] }).directories?.length === 3) throw new Error("synthetic fencing crash");
  });
  try { await expect(reclaimLegacy(f.path, f.proof, f.journal, f.operation)).rejects.toThrow("synthetic fencing crash"); }
  finally { intercept.mockRestore(); }
  for (const path of [f.parent, f.path, f.nested]) {
    const info = await lstat(path); expect(info.uid).toBe(1000); expect(info.mode & 0o777).toBe(0o700);
  }
  await writeFile(join(f.nested, "owned"), "changed after preview");
  await expect(reclaimLegacy(f.path, f.proof, f.journal, f.operation)).rejects.toThrow("预览后");
  expect(await readFile(join(f.nested, "owned"), "utf8")).toBe("changed after preview");
  expect((await lstat(f.parent)).uid).toBe(1000);
});

privileged("an unacknowledged deletion intent keeps the tree frozen; a replay completes it, also after the removal itself", async () => {
  const f = await fixture(), original = io.publishJson;
  // The intent save fails before anything is written: the outcome is uncertain, so writers are not handed back.
  let intercept = spyOn(io, "publishJson").mockImplementation(async (path, value) => {
    if ((value as { phase?: string }).phase === "deleting") throw new Error("synthetic lost intent acknowledgement");
    await original(path, value);
  });
  try { await expect(reclaimLegacy(f.path, f.proof, f.journal, f.operation)).rejects.toBeInstanceOf(LegacyReclamationPending); }
  finally { intercept.mockRestore(); }
  for (const path of [f.parent, f.path, f.nested]) expect((await lstat(path)).uid).toBe(0);
  // The removal completes but its acknowledgement is lost: the saved intent is still "deleting" and the tree is gone.
  intercept = spyOn(io, "publishJson").mockImplementation(async (path, value) => {
    if ((value as { phase?: string }).phase === "removed") throw new Error("synthetic crash after removal");
    await original(path, value);
  });
  try { await expect(reclaimLegacy(f.path, f.proof, f.journal, f.operation)).rejects.toBeInstanceOf(LegacyReclamationPending); }
  finally { intercept.mockRestore(); }
  expect(await lstat(f.path).catch(error => error.code)).toBe("ENOENT");
  expect((await lstat(f.parent)).uid).toBe(0);
  await reclaimLegacy(f.path, f.proof, f.journal, f.operation);
  expect((await lstat(f.parent)).uid).toBe(1000);
  expect(await readFile(join(f.outside, "keep"), "utf8")).toBe("keep");
});

privileged("a directory of another identity inside the reviewed tree is never taken over", async () => {
  const f = await fixture(), foreign = join(f.nested, "foreign");
  await mkdir(foreign); await chown(foreign, 1001, 1001); await chmod(foreign, 0o755);
  const proof = await reclamationEvidence(f.path);
  await expect(reclaimLegacy(f.path, proof, f.journal, f.operation)).rejects.toThrow("拒绝接管");
  for (const path of [f.parent, f.path, f.nested]) {
    const info = await lstat(path); expect([info.uid, info.mode & 0o777]).toEqual([1000, 0o700]);
  }
  const info = await lstat(foreign); expect([info.uid, info.mode & 0o777]).toEqual([1001, 0o755]);
  expect(await readFile(join(f.nested, "owned"), "utf8")).toBe("reviewed");
});

/** A parent of the old identity holding one reviewed file and one link, all synthetic. */
async function entryFixture() {
  const root = await mkdtemp("/var/lib/mixin-reclamation-test-");
  console.log("Synthetic privileged fixture retained at " + root);
  await chmod(root, 0o755);
  const parent = join(root, "archive"), file = join(parent, "reviewed.txt"), link = join(parent, "link"), outside = join(root, "outside"), journal = join(root, "journal");
  await mkdir(parent); await mkdir(journal, { mode: 0o700 }); await mkdir(outside);
  await writeFile(join(outside, "keep"), "keep");
  await writeFile(file, "reviewed original"); await symlink(outside, link);
  for (const path of [parent, file]) await chown(path, 1000, 1000);
  await lchown(link, 1000, 1000); await chmod(parent, 0o700);
  return { root, parent, file, link, outside, journal };
}

/** An old writer (UID 1000) waiting in `cwd`; on request it tries to swap `name` for a new file and reports each step. */
function oldWriter(cwd: string, name: string) {
  const actor = spawn(process.execPath, ["-e", `
    const fs = require('node:fs');
    console.log('ready');
    process.stdin.once('data', () => {
      const results = [];
      try { fs.renameSync(${JSON.stringify(name)}, 'moved-aside'); results.push('RENAMED'); } catch (e) { results.push(e.code); }
      try { fs.writeFileSync(${JSON.stringify(name)}, 'NEW UNREVIEWED FILE', { flag: 'wx' }); results.push('WRITTEN'); } catch (e) { results.push(e.code); }
      console.log(JSON.stringify(results)); process.exit(0);
    });
  `], { cwd, uid: 1000, gid: 1000, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", stderr = "";
  actor.stdout.on("data", data => output += String(data)); actor.stderr.on("data", data => stderr += String(data));
  const exited = new Promise<number | null>((resolve, reject) => { actor.on("exit", resolve); actor.on("error", reject); });
  return {
    async ready() { const deadline = Date.now() + 10_000; while (!output.includes("ready") && Date.now() < deadline) await Bun.sleep(10); expect(output, stderr).toContain("ready"); },
    async attempt() { actor.stdin.end("try"); expect(await exited).toBe(0); return JSON.parse(output.trim().split("\n").at(-1)!) as string[]; },
    kill() { actor.kill(); },
  };
}

privileged("IA-1: a reviewed file is unlinked under the fenced parent; an old writer cannot swap it after the recheck", async () => {
  const f = await entryFixture(), proof = await reclamationEvidence(f.file), operation = randomUUID() + "-0";
  const writer = oldWriter(f.parent, "reviewed.txt"), original = unlink;
  await writer.ready();
  let attempt: string[] | undefined;
  // Right before the real unlink, after the recheck under the fence: the audit's interleaving, by a real UID 1000 process.
  const intercept = spyOn(fsp, "unlink").mockImplementation(async path => {
    if (!attempt && String(path).endsWith("/reviewed.txt")) attempt = await writer.attempt();
    return original(path);
  });
  try { await reclaimLegacy(f.file, proof, f.journal, operation); } finally { intercept.mockRestore(); writer.kill(); }
  expect(attempt).toEqual(["EACCES", "EACCES"]);
  expect(await lstat(f.file).catch(error => error.code)).toBe("ENOENT");
  expect(await readdir(f.parent)).toEqual(["link"]);
  const parent = await lstat(f.parent); expect([parent.uid, parent.mode & 0o777]).toEqual([1000, 0o700]);
  expect(JSON.parse(await readFile(join(f.journal, operation + ".json"), "utf8")).phase).toBe("restored");
});

privileged("IA-1: a reviewed link is removed as itself; a deletion stopped after its intent resumes; its target stays", async () => {
  const f = await entryFixture(), proof = await reclamationEvidence(f.link), operation = randomUUID() + "-0", original = io.publishJson;
  const intercept = spyOn(io, "publishJson").mockImplementation(async (path, value) => {
    await original(path, value);
    if ((value as { phase?: string }).phase === "deleting") throw new Error("synthetic crash after deletion intent");
  });
  try { await expect(reclaimLegacy(f.link, proof, f.journal, operation)).rejects.toBeInstanceOf(LegacyReclamationPending); }
  finally { intercept.mockRestore(); }
  // Still fenced: the old identity gets nothing back before the deletion completes.
  expect((await lstat(f.parent)).uid).toBe(0);
  expect((await lstat(f.link)).isSymbolicLink()).toBe(true);
  await reclaimLegacy(f.link, proof, f.journal, operation);
  expect(await lstat(f.link).catch(error => error.code)).toBe("ENOENT");
  expect(await readFile(join(f.outside, "keep"), "utf8")).toBe("keep");
  expect(await readFile(f.file, "utf8")).toBe("reviewed original");
  expect((await lstat(f.parent)).uid).toBe(1000);
});

privileged("IA-1: a file replaced before the fence, or under a parent others can write, is kept and the parent restored", async () => {
  const f = await entryFixture(), proof = await reclamationEvidence(f.file);
  await rename(f.file, f.file + ".reviewed"); await writeFile(f.file, "NEW UNREVIEWED FILE"); await chown(f.file, 1000, 1000);
  await expect(reclaimLegacy(f.file, proof, f.journal, randomUUID() + "-0")).rejects.toThrow("被替换");
  expect(await readFile(f.file, "utf8")).toBe("NEW UNREVIEWED FILE");
  const parent = await lstat(f.parent); expect([parent.uid, parent.mode & 0o777]).toEqual([1000, 0o700]);
  // A root-owned sticky parent that others can write does not fence a file's name.
  const shared = join(f.root, "shared"), file = join(shared, "owned.txt");
  await mkdir(shared); await chmod(shared, 0o1777); await writeFile(file, "reviewed"); await chown(file, 1000, 1000);
  await expect(reclaimLegacy(file, await reclamationEvidence(file), f.journal, randomUUID() + "-0")).rejects.toThrow("他人可写");
  expect(await readFile(file, "utf8")).toBe("reviewed");
  const info = await lstat(shared); expect([info.uid, info.mode & 0o7777]).toEqual([0, 0o1777]);
});

privileged("IA-1 end to end: tmp discard --legacy removes an archived file of the old identity through the fenced backend", async () => {
  const root = await mkdtemp("/var/lib/mixin-reclamation-test-");
  console.log("Synthetic privileged fixture retained at " + root);
  await chmod(root, 0o755);
  const groups = join(root, "data"), temp = join(groups, "tmp/groups/group-a/alice"), journal = join(root, "journal");
  await mkdir(temp, { recursive: true }); await mkdir(journal, { mode: 0o700 });
  await writeFile(join(temp, "reviewed.txt"), "reviewed original"); await chown(join(temp, "reviewed.txt"), 1000, 1000);
  const scope: MemberScope = { async withMember(_paths, _member, _mode, run) {
    return run({ calls: {}, liveWork: false, protectedPath: () => false, settle: async () => {} });
  } };
  const options = { root: groups, state: join(root, "state.sqlite"), archive: join(groups, "state/reclamation/backup/rm"), scope };
  const plan = await previewTmpArchive(options, 0);
  expect((await applyTmpArchive(options, plan.id, plan.digest)).outcomes[0]?.status).toBe("archived");
  // The archive belongs to the old service identity, as on a deployment.
  for (const path of [join(groups, "state/reclamation"), join(groups, "state/reclamation/backup"), options.archive]) await chown(path, 1000, 1000);
  const plain = await previewArchiveRemoval(options);
  expect(plain.items[0]?.status).toBe("deferred");
  const removal = await previewArchiveRemoval({ ...options, legacy: true });
  expect([removal.items[0]?.kind, removal.items[0]?.status]).toEqual(["file", "ready"]);
  const done = await applyArchiveRemoval({ ...options, legacy: true, journal }, removal.id, removal.digest);
  expect(done.outcomes[0], JSON.stringify(done.outcomes[0])).toEqual({ status: "removed", bytes: "reviewed original".length });
  expect(await lstat(plan.items[0]!.destination).catch(error => error.code)).toBe("ENOENT");
  expect((await lstat(options.archive)).uid).toBe(1000);
});

test("a new privileged operation is blocked by related or unreadable journals and by a fenced parent, naming the original list", () => {
  const parent = { relative: "..", dev: "1", ino: "10", uid: 1000, gid: 1000, mode: 0o750 }, target = { dev: "1", ino: "11" };
  const list = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const related = { operation: list + "-3", phase: "deleting" as const, path: "/x/parent/a", entities: new Set(["1:10"]) };
  const unrelated = { operation: list + "-4", phase: "fencing" as const, path: "/y/b", entities: new Set(["1:99"]) };
  expect(legacyBlocker([unrelated], parent, target)).toBeUndefined();
  expect(legacyBlocker([unrelated, related], parent, target)).toContain(`原清单 ${list} `);
  expect(legacyBlocker([{ ...unrelated, entities: new Set(["1:11"]) }], parent, target)).toContain(list + "-4");
  expect(legacyBlocker([{ operation: list + "-5", entities: new Set(), error: "Error: bad" }], parent, target)).toContain("无法读取");
  // A fence, or one stopped between chown and chmod (either direction): root-owned without the sticky bit, any mode.
  for (const mode of [0o700, 0o750, 0o755, 0o2750]) expect(legacyBlocker([], { ...parent, uid: 0, gid: 0, mode }, target)).toContain("冻结");
  // The system /tmp (root, sticky) is a legitimate root-owned parent.
  expect(legacyBlocker([], { ...parent, uid: 0, gid: 0, mode: 0o1777 }, target)).toBeUndefined();
  expect(describeUnfinished(related)).toContain("deleting：/x/parent/a");
});

// R7-1 / R7-2: operations of one journal root that share a parent, crashes by a real process exit, and recovery. The
// journal root's task-owner lock lasts for a process lifetime, so every privileged step on these roots runs in a child.
const stepHelper = fileURLToPath(new URL("../helpers/legacy-crash-process.ts", import.meta.url));
type Reply = { ok: boolean; pending?: boolean; message?: string; result?: any };
const child = (request: Record<string, unknown>) => spawnSync(process.execPath, [stepHelper, JSON.stringify(request)], { encoding: "utf8", timeout: 60_000 });
/** Runs one privileged step that exits with 70 at the given journal save. */
function crashAt(request: Record<string, unknown>) {
  const result = child(request);
  expect(result.status, result.stdout + result.stderr).toBe(70);
}
function step(request: Record<string, unknown>): Reply {
  const result = child(request);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}
function done(reply: Reply) {
  expect(reply.message).toBeUndefined();
  return reply.result;
}
const reclaimStep = (path: string, proof: unknown, journal: string, operation: string) => step({ kind: "reclaim", path, proof, journal, operation });
const ownership = async (path: string) => { const info = await lstat(path); return [info.uid, info.gid, info.mode & 0o7777]; };
const journalOf = async (journal: string, operation: string) => JSON.parse(await readFile(join(journal, operation + ".json"), "utf8"));
const gone = (path: string) => lstat(path).then(() => false, error => error.code === "ENOENT");

/** A parent of the old identity (1000:1000 0750) with a reviewed directory, file and link, and an unrelated sibling. */
async function overlapFixture() {
  const root = await mkdtemp("/var/lib/mixin-reclamation-test-");
  console.log("Synthetic privileged fixture retained at " + root);
  await chmod(root, 0o755);
  const parent = join(root, "parent"), journal = join(root, "journal"), outside = join(root, "outside");
  const entries = { directory: join(parent, "directory"), file: join(parent, "file.txt"), link: join(parent, "link") }, sibling = join(parent, "sibling.txt");
  await mkdir(join(entries.directory, "nested"), { recursive: true }); await mkdir(journal, { mode: 0o700 }); await mkdir(outside);
  await writeFile(join(outside, "keep"), "keep"); await writeFile(join(entries.directory, "nested/owned"), "reviewed");
  await writeFile(entries.file, "reviewed file"); await writeFile(sibling, "unrelated sibling"); await symlink(outside, entries.link);
  for (const path of [parent, entries.directory, join(entries.directory, "nested"), join(entries.directory, "nested/owned"), entries.file, sibling]) await chown(path, 1000, 1000);
  await lchown(entries.link, 1000, 1000);
  await chmod(entries.directory, 0o700); await chmod(join(entries.directory, "nested"), 0o700); await chmod(parent, 0o750);
  return { root, parent, journal, outside, entries, sibling };
}

privileged("R7-2: an operation stopped at fencing, deleting or removed holds its parent; a new operation on a sibling is refused until the original resumes", async () => {
  for (const kind of ["directory", "file", "link"] as const) {
    for (const phase of ["fencing", "deleting", "removed"]) {
      const f = await overlapFixture(), target = f.entries[kind], proof = await reclamationEvidence(target), operation = randomUUID() + "-0";
      const siblingProof = await reclamationEvidence(f.sibling), label = `${kind} ${phase}`;
      // Directory: the parent is fenced and the top directory registered; file and link: the first fencing save.
      crashAt({ kind: "reclaim", path: target, proof, journal: f.journal, operation, crash: phase === "fencing" ? `fencing:${kind === "directory" ? 2 : 1}` : phase });
      if (phase !== "fencing") expect(await ownership(f.parent), label).toEqual([0, 0, 0o700]);
      const other = randomUUID() + "-0", refused = reclaimStep(f.sibling, siblingProof, f.journal, other);
      expect(refused.ok, label).toBe(false);
      expect(refused.message, label).toContain("不能以新清单接管");
      expect(refused.message, label).toContain(operation);
      expect(await readFile(f.sibling, "utf8"), label).toBe("unrelated sibling");
      expect(await gone(join(f.journal, other + ".json")), label).toBe(true);
      // The original operation resumes from its own journal and hands back exactly the saved metadata.
      done(reclaimStep(target, proof, f.journal, operation));
      expect(await gone(target), label).toBe(true);
      expect(await ownership(f.parent), label).toEqual([1000, 1000, 0o750]);
      const saved = await journalOf(f.journal, operation);
      expect([saved.phase, saved.directories[0].uid, saved.directories[0].gid, saved.directories[0].mode], label).toEqual(["restored", 1000, 1000, 0o750]);
      expect(await readFile(join(f.outside, "keep"), "utf8"), label).toBe("keep");
      // Once finished, it blocks nothing: the sibling's own operation runs.
      done(reclaimStep(f.sibling, siblingProof, f.journal, other));
      expect(await gone(f.sibling), label).toBe(true);
      expect(await ownership(f.parent), label).toEqual([1000, 1000, 0o750]);
    }
  }
}, 600_000);

/** Archived files of the old identity (archive 1000:1000 0750), as on a deployment. */
async function archiveFixture(names: string[]) {
  const root = await mkdtemp("/var/lib/mixin-reclamation-test-");
  console.log("Synthetic privileged fixture retained at " + root);
  await chmod(root, 0o755);
  const groups = join(root, "data"), temp = join(groups, "tmp/groups/group-a/alice"), journal = join(root, "journal");
  await mkdir(temp, { recursive: true }); await mkdir(journal, { mode: 0o700 });
  for (const name of names) { await writeFile(join(temp, name), "reviewed " + name); await chown(join(temp, name), 1000, 1000); }
  const scope: MemberScope = { async withMember(_paths, _member, _mode, run) {
    return run({ calls: {}, liveWork: false, protectedPath: () => false, settle: async () => {} });
  } };
  const options = { root: groups, state: join(root, "state.sqlite"), archive: join(groups, "state/reclamation/backup/rm"), scope };
  const plan = await previewTmpArchive(options, 0);
  await applyTmpArchive(options, plan.id, plan.digest);
  for (const path of [join(groups, "state/reclamation"), join(groups, "state/reclamation/backup"), options.archive]) await chown(path, 1000, 1000);
  await chmod(options.archive, 0o750);
  return { root, groups, journal, archive: options.archive, destinations: plan.items.map(item => item.destination) };
}
type ArchiveFixture = Awaited<ReturnType<typeof archiveFixture>>;
const previewStep = (f: ArchiveFixture) => done(step({ kind: "preview", groups: f.groups, journal: f.journal }));
const discardStep = (f: ArchiveFixture, list: { id: string; digest: string }) => step({ kind: "discard", groups: f.groups, journal: f.journal, id: list.id, digest: list.digest });
const statuses = (progress: { outcomes: Record<string, { status: string }> }) => Object.values(progress.outcomes).map(outcome => outcome.status);

privileged("R7-2: a fresh list waits for an interrupted privileged discard; a list made earlier is refused, then reports missing entries", async () => {
  const f = await archiveFixture(["a.txt", "b.txt"]);
  const earlier = previewStep(f), original = previewStep(f);
  expect(original.items.map((item: { status: string }) => item.status)).toEqual(["ready", "ready"]);
  crashAt({ kind: "discard", groups: f.groups, journal: f.journal, id: original.id, digest: original.digest, crash: "deleting" });
  expect(await ownership(f.archive)).toEqual([0, 0, 0o700]);
  // Preview: every entry under the held archive waits, naming the original list.
  const fresh = previewStep(f);
  expect(fresh.items.map((item: { status: string }) => item.status)).toEqual(["deferred", "deferred"]);
  expect(fresh.items[0].reason).toContain(original.id);
  expect(fresh.skipped.map((entry: { plan: string }) => entry.plan)).toEqual([original.id]);
  // Apply rechecks: the list made before the interruption takes nothing over and deletes nothing.
  const refused = done(discardStep(f, earlier));
  expect(statuses(refused)).toEqual(["failed", "failed"]);
  expect(refused.outcomes[0].reason).toContain("不能以新清单接管");
  for (const destination of f.destinations) expect(await gone(destination)).toBe(false);
  expect((await readdir(f.journal)).filter(name => name.startsWith(earlier.id))).toEqual([]);
  // The original list finishes and hands the archive back.
  expect(statuses(done(discardStep(f, original)))).toEqual(["removed", "removed"]);
  expect(await ownership(f.archive)).toEqual([1000, 1000, 0o750]);
  // The earlier list neither deletes again nor touches the restored archive: its entries are gone, unproven by it.
  expect(statuses(done(discardStep(f, earlier)))).toEqual(["missing", "missing"]);
  expect(await ownership(f.archive)).toEqual([1000, 1000, 0o750]);
  expect((await readdir(f.journal)).filter(name => name.startsWith(earlier.id))).toEqual([]);
}, 120_000);

/** As an older version: unlink the fenced entry by path and record it removed in the list's progress. */
async function olderVersionRemoves(f: ArchiveFixture, removal: { id: string }, index: number) {
  const destination = f.destinations[index]!, progressPath = join(f.archive, ".tmp-plans", removal.id + ".removal-progress.json");
  const bytes = (await lstat(destination)).size;
  await unlink(destination);
  const progress = JSON.parse(await readFile(progressPath, "utf8"));
  if (!progress.started.includes(index)) progress.started.push(index);
  progress.outcomes[index] = { status: "removed", bytes };
  await io.publishJson(progressPath, progress);
}

privileged("R7-1: an entry an older version removed by path still finishes its journal; the archive is handed back and writable by the service UID", async () => {
  const f = await archiveFixture(["a.txt"]), removal = previewStep(f), operation = `${removal.id}-0`;
  crashAt({ kind: "discard", groups: f.groups, journal: f.journal, id: removal.id, digest: removal.digest, crash: "deleting" });
  await olderVersionRemoves(f, removal, 0);
  expect(await ownership(f.archive)).toEqual([0, 0, 0o700]);
  // A fresh preview shows the unfinished operation instead of an empty list.
  expect(previewStep(f).skipped.map((entry: { plan: string }) => entry.plan)).toEqual([removal.id]);
  expect(statuses(done(discardStep(f, removal)))).toEqual(["removed"]);
  expect((await journalOf(f.journal, operation)).phase).toBe("restored");
  expect(await ownership(f.archive)).toEqual([1000, 1000, 0o750]);
  const probe = join(f.archive, "service-write-probe");
  const write = spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", probe], { uid: 1000, gid: 1000, encoding: "utf8" });
  expect(write.status, write.stderr).toBe(0);
  expect((await lstat(probe)).uid).toBe(1000);
  await unlink(probe);
  expect(statuses(done(discardStep(f, removal)))).toEqual(["removed"]);
  expect(await ownership(f.archive)).toEqual([1000, 1000, 0o750]);
  expect(previewStep(f).skipped).toEqual([]);
}, 120_000);

privileged("R7-1: a new entry at the removed name is never deleted by the finishing step; the archive stays fenced until it is resolved", async () => {
  const f = await archiveFixture(["a.txt"]), removal = previewStep(f), destination = f.destinations[0]!;
  crashAt({ kind: "discard", groups: f.groups, journal: f.journal, id: removal.id, digest: removal.digest, crash: "deleting" });
  await olderVersionRemoves(f, removal, 0);
  await writeFile(destination, "NEW UNREVIEWED FILE"); await chown(destination, 1000, 1000);
  // Every replay only tries to finish: the recorded outcome stays removed and the new file is never taken for the old one.
  for (let round = 0; round < 2; round++) {
    const reply = discardStep(f, removal);
    expect([reply.ok, reply.pending]).toEqual([false, true]);
    expect(reply.message).toContain("收尾不重新授权删除");
    expect(await readFile(destination, "utf8")).toBe("NEW UNREVIEWED FILE");
    expect(await ownership(f.archive)).toEqual([0, 0, 0o700]);
  }
  // An archive already handed back by hand is left as it is: the refused finishing step does not freeze it again.
  await chown(f.archive, 1000, 1000); await chmod(f.archive, 0o750);
  const handed = discardStep(f, removal);
  expect([handed.ok, handed.pending]).toEqual([false, true]);
  expect(await ownership(f.archive)).toEqual([1000, 1000, 0o750]);
  expect(await readFile(destination, "utf8")).toBe("NEW UNREVIEWED FILE");
  // Resolved by hand (the new entry moved out): the original list completes the same operation.
  await rename(destination, join(f.root, "moved-out"));
  expect(statuses(done(discardStep(f, removal)))).toEqual(["removed"]);
  expect(await ownership(f.archive)).toEqual([1000, 1000, 0o750]);
  expect(await readFile(join(f.root, "moved-out"), "utf8")).toBe("NEW UNREVIEWED FILE");
}, 120_000);

privileged("R7: a replaced parent or an unreadable journal is kept and reported; nothing is guessed", async () => {
  const f = await overlapFixture(), proof = await reclamationEvidence(f.entries.file), operation = randomUUID() + "-0";
  crashAt({ kind: "reclaim", path: f.entries.file, proof, journal: f.journal, operation, crash: "deleting" });
  await rename(f.parent, f.parent + ".held"); await mkdir(f.parent); await chown(f.parent, 1000, 1000); await chmod(f.parent, 0o750);
  await writeFile(f.entries.file, "NEW PARENT FILE"); await chown(f.entries.file, 1000, 1000);
  const replaced = reclaimStep(f.entries.file, proof, f.journal, operation);
  expect(replaced.ok).toBe(false);
  expect(replaced.message).toContain("父实体已变化");
  expect(await readFile(f.entries.file, "utf8")).toBe("NEW PARENT FILE");
  expect(await ownership(f.parent)).toEqual([1000, 1000, 0o750]);
  expect(await ownership(f.parent + ".held")).toEqual([0, 0, 0o700]);
  expect((await journalOf(f.journal, operation)).phase).toBe("deleting");
  // An unreadable journal cannot prove it is unrelated: a new operation does not start while it is there.
  const g = await overlapFixture(), corrupt = join(g.journal, randomUUID() + "-0.json"), siblingProof = await reclamationEvidence(g.sibling), other = randomUUID() + "-0";
  await writeFile(corrupt, "{", { mode: 0o600 });
  const unreadable = reclaimStep(g.sibling, siblingProof, g.journal, other);
  expect(unreadable.ok).toBe(false);
  expect(unreadable.message).toContain("无法读取");
  expect(await readFile(g.sibling, "utf8")).toBe("unrelated sibling");
  expect(await ownership(g.parent)).toEqual([1000, 1000, 0o750]);
  await unlink(corrupt);
  done(reclaimStep(g.sibling, siblingProof, g.journal, other));
  expect(await gone(g.sibling)).toBe(true);
}, 120_000);

privileged("R7: hand-back interrupted twice keeps the saved original; a saved fence is never applied; another frozen operation delays the hand-back", async () => {
  const f = await overlapFixture(), proof = await reclamationEvidence(f.entries.directory), operation = randomUUID() + "-0";
  crashAt({ kind: "reclaim", path: f.entries.directory, proof, journal: f.journal, operation, crash: "removed" });
  for (let round = 0; round < 2; round++) {
    crashAt({ kind: "reclaim", path: f.entries.directory, proof, journal: f.journal, operation, crash: "before:restored" });
    const saved = await journalOf(f.journal, operation);
    expect([saved.phase, saved.directories[0].uid, saved.directories[0].gid, saved.directories[0].mode]).toEqual(["removed", 1000, 1000, 0o750]);
  }
  done(reclaimStep(f.entries.directory, proof, f.journal, operation));
  done(reclaimStep(f.entries.directory, proof, f.journal, operation));
  expect(await ownership(f.parent)).toEqual([1000, 1000, 0o750]);
  // An older version's journal that saved another operation's fence as the "original" is finished without applying it.
  const parent = await lstat(f.parent, { bigint: true }), fileProof = await reclamationEvidence(f.entries.file), older = randomUUID() + "-0";
  const fence = { relative: "..", dev: String(parent.dev), ino: String(parent.ino), uid: 0, gid: 0, mode: 0o700 };
  await unlink(f.entries.file);
  await writeFile(join(f.journal, older + ".json"), JSON.stringify({ version: 1, path: f.entries.file, parent: f.parent, proof: fileProof, phase: "removed", directories: [fence] }), { mode: 0o600 });
  done(reclaimStep(f.entries.file, fileProof, f.journal, older));
  expect((await journalOf(f.journal, older)).phase).toBe("restored");
  expect(await ownership(f.parent)).toEqual([1000, 1000, 0o750]);
  // While another operation keeps content frozen under the same parent, a finished removal does not hand it back.
  const linkProof = await reclamationEvidence(f.entries.link), linkOperation = randomUUID() + "-0";
  crashAt({ kind: "reclaim", path: f.entries.link, proof: linkProof, journal: f.journal, operation: linkOperation, crash: "removed" });
  const frozen = randomUUID() + "-0", siblingProof = await reclamationEvidence(f.sibling);
  const record = { relative: "..", dev: String(parent.dev), ino: String(parent.ino), uid: 1000, gid: 1000, mode: 0o750 };
  await writeFile(join(f.journal, frozen + ".json"), JSON.stringify({ version: 1, path: f.sibling, parent: f.parent, proof: siblingProof, phase: "deleting", directories: [record] }), { mode: 0o600 });
  const delayed = reclaimStep(f.entries.link, linkProof, f.journal, linkOperation);
  expect([delayed.ok, delayed.pending]).toEqual([false, true]);
  expect(delayed.message).toContain(frozen);
  expect(await ownership(f.parent)).toEqual([0, 0, 0o700]);
  expect((await journalOf(f.journal, linkOperation)).phase).toBe("removed");
  done(reclaimStep(f.sibling, siblingProof, f.journal, frozen));
  expect(await ownership(f.parent)).toEqual([1000, 1000, 0o750]);
  done(reclaimStep(f.entries.link, linkProof, f.journal, linkOperation));
  expect((await journalOf(f.journal, linkOperation)).phase).toBe("restored");
  expect(await ownership(f.parent)).toEqual([1000, 1000, 0o750]);
  expect(await readFile(join(f.outside, "keep"), "utf8")).toBe("keep");
}, 120_000);

/** Shared codemode results of the old identity (codemode 1000:1000 0750), owned by the group's results ledger. */
async function sharedResultsFixture(names: string[]) {
  const root = await mkdtemp("/var/lib/mixin-reclamation-test-");
  console.log("Synthetic privileged fixture retained at " + root);
  await chmod(root, 0o755);
  const groups = join(root, "data"), codemode = join(groups, "tmp/groups/group-a/alice/codemode"), plans = join(root, "plans");
  const durable = join(groups, "conversations/groups/group-a/durable.sqlite"), paths = names.map(name => join(codemode, name));
  await mkdir(codemode, { recursive: true }); await mkdir(plans, { mode: 0o700 });
  const { models, model } = fauxModels(), group = await openGroupHarness(durable, models);
  try {
    await memberConversation(group.harness, scopeOf("group-a"), "alice", { model }, context);
    for (const name of names) {
      await mkdir(join(codemode, name)); await writeFile(join(codemode, name, "result"), "shared " + name);
      await group.harness.commit(async tx => { (await tx.doc(ResultsDoc)).calls[name] = { phone: "alice", createdAt: 1 }; }, context);
    }
  } finally { await group.close(); }
  new Database(join(root, "state.sqlite")).close();
  for (const path of paths) { await chown(path, 1000, 1000); await chown(join(path, "result"), 1000, 1000); await chmod(path, 0o700); }
  await chown(codemode, 1000, 1000); await chmod(codemode, 0o750);
  return { root, groups, codemode, plans, durable, paths };
}

privileged("R7-1/R7-2 in physical reclamation: an interrupted plan holds the shared parent; a recorded removal finishes its journal and settles", async () => {
  const f = await sharedResultsFixture(["1-old", "2-old"]);
  const preview = () => done(step({ kind: "reclaim-preview", groups: f.groups, journal: f.plans }));
  const apply = (plan: { id: string; digest: string }) => step({ kind: "reclaim-apply", groups: f.groups, journal: f.plans, id: plan.id, digest: plan.digest });
  const earlier = preview(), original = preview();
  expect(original.items.map((item: { status: string }) => item.status)).toEqual(["ready", "ready"]);
  crashAt({ kind: "reclaim-apply", groups: f.groups, journal: f.plans, id: original.id, digest: original.digest, crash: "deleting" });
  expect(await ownership(f.codemode)).toEqual([0, 0, 0o700]);
  const key = (await readdir(f.plans)).map(name => new RegExp(`^${original.id}-([0-9]+)[.]json$`).exec(name)?.[1]).find(Boolean)!;
  expect((await journalOf(f.plans, `${original.id}-${key}`)).phase).toBe("deleting");
  // A fresh plan waits for the original; a plan made before the interruption takes nothing over.
  const fresh = preview();
  expect(fresh.items.map((item: { status: string }) => item.status)).toEqual(["deferred", "deferred"]);
  for (const item of fresh.items) expect(item.reason).toContain(original.id);
  expect(statuses(done(apply(earlier)))).toEqual(["failed", "failed"]);
  for (const path of f.paths) expect(await gone(path)).toBe(false);
  expect((await readdir(f.plans)).filter(name => name.startsWith(earlier.id + "-"))).toEqual([]);
  // As an older version: the interrupted entry is removed by path and recorded removed, with the parent still fenced.
  await rm(original.items[+key].path, { recursive: true });
  const progressPath = join(f.plans, original.id + ".progress.json"), progress = JSON.parse(await readFile(progressPath, "utf8"));
  expect(progress.started).toContain(key);
  progress.outcomes[key] = { status: "removed", bytes: original.items[+key].evidence.bytes };
  await io.publishJson(progressPath, progress);
  // The original plan finishes that journal (no deletion), removes the other entry, hands the parent back and settles.
  expect(statuses(done(apply(original)))).toEqual(["removed", "removed"]);
  expect((await journalOf(f.plans, `${original.id}-${key}`)).phase).toBe("restored");
  expect(await ownership(f.codemode)).toEqual([1000, 1000, 0o750]);
  for (const path of f.paths) expect(await gone(path)).toBe(true);
  const probe = join(f.codemode, "service-write-probe");
  const write = spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", probe], { uid: 1000, gid: 1000, encoding: "utf8" });
  expect(write.status, write.stderr).toBe(0);
  await unlink(probe);
  await withSpaceSnapshot(f.durable, async harness => expect(Object.keys((await harness.snapshot(ResultsDoc, context))?.calls ?? {})).toEqual([]));
  expect(statuses(done(apply(original)))).toEqual(["removed", "removed"]);
  expect(await ownership(f.codemode)).toEqual([1000, 1000, 0o750]);
}, 120_000);

// Fence windows: a step stopped between chown and chmod (fencing: chown(0, 0) done; hand-back: chmod(original) done)
// leaves the parent root-owned with its original mode. No journal directory may take it over.
const entityOf = async (path: string) => { const info = await lstat(path, { bigint: true }); return `${info.dev}:${info.ino}`; };
function writableByService(directory: string) {
  const probe = join(directory, "service-write-probe");
  const write = spawnSync(process.execPath, ["-e", "const fs = require('node:fs'), p = process.argv[1]; fs.writeFileSync(p, 'ok'); fs.unlinkSync(p)", probe],
    { uid: 1000, gid: 1000, encoding: "utf8" });
  return write.status === 0;
}

privileged("R7-2: a stop between chown and chmod, fencing or handing back, is never taken over through the same or another journal", async () => {
  // 02750: chown of a directory keeps its setgid bit, so handing back chmod-first loses nothing.
  for (const mode of [0o750, 0o755, 0o2750]) {
    for (const window of ["fence", "hand-back"] as const) {
      const f = await overlapFixture(), label = `${mode.toString(8)} ${window}`;
      await chmod(f.parent, mode);
      const other = join(f.root, "journal-b"); await mkdir(other, { mode: 0o700 });
      const proof = await reclamationEvidence(f.entries.file), operation = randomUUID() + "-0", entity = await entityOf(f.parent);
      const at = window === "fence" ? { call: "chown", value: 0, entity } : { call: "chmod", value: mode, entity };
      // Hand-back is stopped twice: the replay, from the removed phase, hands back again and stops at the same point.
      for (let round = 0; round < (window === "fence" ? 1 : 2); round++) {
        crashAt({ kind: "reclaim", path: f.entries.file, proof, journal: f.journal, operation, window: at });
        expect(await ownership(f.parent), label).toEqual([0, 0, mode]);
        const saved = await journalOf(f.journal, operation);
        expect([saved.phase, saved.directories[0].uid, saved.directories[0].gid, saved.directories[0].mode], label)
          .toEqual([window === "fence" ? "fencing" : "removed", 1000, 1000, mode]);
      }
      const siblingProof = await reclamationEvidence(f.sibling);
      for (const journal of [f.journal, other]) {
        const attempt = randomUUID() + "-0", refused = reclaimStep(f.sibling, siblingProof, journal, attempt);
        expect(refused.ok, label).toBe(false);
        expect(refused.message, label).toContain("不能以新清单接管");
        expect(await gone(join(journal, attempt + ".json")), label).toBe(true);
        expect(await readFile(f.sibling, "utf8"), label).toBe("unrelated sibling");
        expect(await ownership(f.parent), label).toEqual([0, 0, mode]);
      }
      // The original operation finishes and hands back exactly what it saved; the service identity can write again.
      done(reclaimStep(f.entries.file, proof, f.journal, operation));
      expect(await gone(f.entries.file), label).toBe(true);
      expect(await ownership(f.parent), label).toEqual([1000, 1000, mode]);
      expect((await journalOf(f.journal, operation)).phase, label).toBe("restored");
      expect(writableByService(f.parent), label).toBe(true);
      done(reclaimStep(f.entries.file, proof, f.journal, operation));
      expect(await ownership(f.parent), label).toEqual([1000, 1000, mode]);
      // Afterwards the other journal directory can remove the sibling, and saves and restores the true original.
      const later = randomUUID() + "-0";
      done(reclaimStep(f.sibling, siblingProof, other, later));
      expect(await gone(f.sibling), label).toBe(true);
      expect((await journalOf(other, later)).directories[0].mode, label).toBe(mode);
      expect(await ownership(f.parent), label).toEqual([1000, 1000, mode]);
    }
  }
}, 600_000);

privileged("R7-2: a discard stopped between chown and chmod of the archive defers a fresh list under another journal; an earlier list is refused", async () => {
  const f = await archiveFixture(["a.txt", "b.txt"]), other = join(f.root, "journal-b");
  await mkdir(other, { mode: 0o700 });
  const withJournal = (journal: string) => ({ ...f, journal });
  const original = previewStep(f), earlier = previewStep(withJournal(other));
  crashAt({ kind: "discard", groups: f.groups, journal: f.journal, id: original.id, digest: original.digest,
    window: { call: "chown", value: 0, entity: await entityOf(f.archive) } });
  expect(await ownership(f.archive)).toEqual([0, 0, 0o750]);
  const fresh = previewStep(withJournal(other));
  expect(fresh.items.map((item: { status: string; reason: string }) => [item.status, item.reason.includes("不能以新清单接管")])).toEqual([["deferred", true], ["deferred", true]]);
  expect(statuses(done(discardStep(withJournal(other), earlier)))).toEqual(["failed", "failed"]);
  expect((await readdir(other)).filter(name => name.endsWith(".json"))).toEqual([]);
  for (const destination of f.destinations) expect(await gone(destination)).toBe(false);
  expect(await ownership(f.archive)).toEqual([0, 0, 0o750]);
  expect(statuses(done(discardStep(f, original)))).toEqual(["removed", "removed"]);
  expect(await ownership(f.archive)).toEqual([1000, 1000, 0o750]);
  expect(writableByService(f.archive)).toBe(true);
}, 120_000);

privileged("R7-2: a sticky parent of the service identity is refused before any journal, so no fence window can look like the system /tmp", async () => {
  const f = await overlapFixture();
  await chmod(f.parent, 0o1750);
  const proof = await reclamationEvidence(f.entries.file), operation = randomUUID() + "-0", refused = reclaimStep(f.entries.file, proof, f.journal, operation);
  expect(refused.ok).toBe(false);
  expect(refused.message).toContain("带粘滞位，不能安全冻结");
  expect(await gone(join(f.journal, operation + ".json"))).toBe(true);
  expect(await readFile(f.entries.file, "utf8")).toBe("reviewed file");
  expect(await ownership(f.parent)).toEqual([1000, 1000, 0o1750]);
}, 60_000);
