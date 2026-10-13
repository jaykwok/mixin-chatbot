// Permanent removal of archived entries (audit 2026-10-13, IA-1 and IA-2). IA-1: a same-UID writer swaps the reviewed
// entry for a new one right after the last check; the new entry must survive and a "removed" must mean the reviewed
// one. IA-2: an archived task tree whose deletion stopped part way resumes from the backend's deletion journal, while
// anything that is not the rest of the reviewed tree keeps it. Every interleaving is injected exactly; the renames,
// writes and deletions are real.
import { spyOn, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as io from "../../scripts/migrations/lib/io.ts";
import * as evidence from "../../src/core/reclamation-files.ts";
import { applyArchiveRemoval, applyTmpArchive, previewArchiveRemoval, previewTmpArchive } from "../../src/maintenance/archive.ts";
import type { MemberScope } from "../../src/maintenance/scope.ts";
import { finishedEarlier } from "../../src/contracts/maintenance.ts";
import { RootlessTasks, type TaskDriver } from "../../src/core/rootless-tasks.ts";
import { tempFixture } from "../helpers/temp.ts";

const scope: MemberScope = { async withMember(_paths, _member, _mode, run) {
  return run({ calls: {}, liveWork: false, protectedPath: () => false, settle: async () => {} });
} };
const image = "sha256:" + "a".repeat(64);
const driver: TaskDriver = { async run(args) {
  if (args[0] === "info") return { exitCode: 0, output: JSON.stringify({ ID: "archive-safety", SecurityOptions: ["name=rootless"] }) };
  if (args[0] === "image") return { exitCode: 0, output: JSON.stringify([{ Id: image, Os: "linux" }]) };
  throw new Error("Docker is never started here: " + args.join(" "));
} };
const exists = (path: string) => fs.lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const onLinux = test.skipIf(process.platform !== "linux"), onWindows = test.skipIf(process.platform !== "win32");

async function fixture(prefix: string) {
  const f = await tempFixture(prefix), root = join(f.root, "groups"), temp = join(root, "group-a/users/alice/tmp");
  await fs.mkdir(temp, { recursive: true });
  return { f, root, temp, options: { root, state: join(f.root, "state.sqlite"), archive: join(root, ".reclamation/backup/rm"), scope } };
}

/** Archive one plain entry made by `make`, then preview its removal. */
async function archivedEntry(prefix: string, make: (temp: string) => Promise<void>) {
  const context = await fixture(prefix);
  await make(context.temp);
  const plan = await previewTmpArchive(context.options, 0);
  expect((await applyTmpArchive(context.options, plan.id, plan.digest)).outcomes[0]?.status).toBe("archived");
  const removal = await previewArchiveRemoval(context.options);
  return { ...context, removal, item: removal.items[0]! };
}

/** Swap the entry at `target` for a new file once the `call`-th content check of it during the removal returned. */
function swapAfterCheck(target: string, call: number) {
  const original = evidence.reclamationEvidence, moved = target + ".reviewed-moved";
  const state: { attempted: boolean; swap?: string } = { attempted: false };
  let calls = 0;
  const spy = spyOn(evidence, "reclamationEvidence").mockImplementation(async (path, collect) => {
    const result = await original(path, collect);
    if (path === target && ++calls === call) {
      state.attempted = true;
      try { await fs.rename(target, moved); await fs.writeFile(target, "NEW UNREVIEWED FILE"); state.swap = "swapped"; }
      catch (error) { state.swap = (error as NodeJS.ErrnoException).code ?? String(error); }
    }
    return result;
  });
  return { state, moved, restore: () => spy.mockRestore() };
}

onWindows("IA-1 (Windows): a file swapped after a check keeps the new file; under the deletion handle no swap is possible", async () => {
  // Call 1: the list's own recheck, before any handle; call 2: the backend's check while it holds the deletion handle.
  for (const call of [1, 2]) {
    const { f, options, removal, item } = await archivedEntry("safety-swap-", temp => fs.writeFile(join(temp, "reviewed.txt"), "reviewed original"));
    try {
      expect([item.kind, item.status]).toEqual(["file", "ready"]);
      const swap = swapAfterCheck(item.destination, call);
      let done;
      try { done = await applyArchiveRemoval(options, removal.id, removal.digest); } finally { swap.restore(); }
      expect(swap.state.attempted, `call ${call}`).toBe(true);
      if (call === 1) {
        // The swap happened: the new file stays, the reviewed one stays beside it, nothing is reported removed.
        expect(swap.state.swap).toBe("swapped");
        expect(done.outcomes[0]?.status).toBe("failed");
        expect([await fs.readFile(item.destination, "utf8"), await fs.readFile(swap.moved, "utf8")]).toEqual(["NEW UNREVIEWED FILE", "reviewed original"]);
      } else {
        // Rename needs DELETE access, which the held handle does not share: the reviewed file is the one removed.
        expect(swap.state.swap).not.toBe("swapped");
        expect(done.outcomes[0]).toEqual({ status: "removed", bytes: "reviewed original".length });
        expect([await exists(item.destination), await exists(swap.moved)]).toEqual([false, false]);
      }
    } finally { await f.cleanup(); }
  }
});

onWindows("IA-1 (Windows): an archived junction is removed as itself; its target is untouched", async () => {
  const outside = await fixture("safety-junction-target-");
  try {
    await fs.writeFile(join(outside.temp, "keep.txt"), "keep");
    const { f, options, removal, item } = await archivedEntry("safety-junction-", temp => fs.symlink(outside.temp, join(temp, "link"), "junction"));
    try {
      expect([item.kind, item.status]).toEqual(["link", "ready"]);
      expect((await applyArchiveRemoval(options, removal.id, removal.digest)).outcomes[0]?.status).toBe("removed");
      expect(await exists(item.destination)).toBe(false);
      expect(await fs.readFile(join(outside.temp, "keep.txt"), "utf8")).toBe("keep");
    } finally { await f.cleanup(); }
  } finally { await outside.f.cleanup(); }
});

onLinux("IA-1 (Linux): without the privileged backend a swap finds nothing to delete; both files stay", async () => {
  const { f, options, removal, item } = await archivedEntry("safety-swap-", temp => fs.writeFile(join(temp, "reviewed.txt"), "reviewed original"));
  try {
    expect([item.kind, item.status]).toEqual(["file", "deferred"]);
    const original = fs.unlink, deleted: string[] = [];
    const spy = spyOn(fs, "unlink").mockImplementation(async path => { deleted.push(String(path)); return original(path); });
    let done;
    try { done = await applyArchiveRemoval(options, removal.id, removal.digest); } finally { spy.mockRestore(); }
    expect(done.outcomes[0]?.status).toBe("deferred");
    expect(deleted.filter(path => path.startsWith(options.archive) && !path.includes(".tmp-plans"))).toEqual([]);
    expect(await fs.readFile(item.destination, "utf8")).toBe("reviewed original");
  } finally { await f.cleanup(); }
});

// IA-2: archived task trees (Linux only: isolated tasks need Linux).

async function archivedTask(prefix: string, files: Record<string, string>, backendRoot?: string) {
  const context = await fixture(prefix);
  const backend = new RootlessTasks(backendRoot ?? join(context.f.root, "control"), image, driver);
  const task = await backend.create(context.temp);
  for (const [name, text] of Object.entries(files)) await fs.writeFile(join(task.path, name), text);
  await task.seal();
  const options = { ...context.options, backend };
  const plan = await previewTmpArchive(options, 0), index = plan.items.findIndex(item => item.task === task.id);
  expect((await applyTmpArchive(options, plan.id, plan.digest)).outcomes[index]?.status).toBe("archived");
  const removal = await previewArchiveRemoval(options), at = removal.items.findIndex(item => item.task === task.id);
  expect(removal.items[at]!.status).toBe("ready");
  return { ...context, backend, task, options, removal, at, item: removal.items[at]!, control: join(context.f.root, "control") };
}

/** Let the next `count` data-file deletions happen, each followed by an EIO, as a failing disk would. */
function failAfterDataUnlinks(count: number) {
  const original = fs.unlink, deleted: string[] = [];
  const spy = spyOn(fs, "unlink").mockImplementation(async path => {
    await original(path);
    if (deleted.length < count && /\/data-\d\.txt$/.test(String(path))) {
      deleted.push(String(path).split("/").at(-1)!);
      throw Object.assign(new Error("synthetic I/O failure after a data file was removed"), { code: "EIO" });
    }
  });
  return { deleted, restore: () => spy.mockRestore() };
}

const DATA = { "data-1.txt": "one", "data-2.txt": "two", "data-3.txt": "three large deliverable" };
const receiptGone = async (control: string, id: string) => !await exists(join(control, "receipts", id + ".json"));
const journalOf = (control: string, id: string) => join(control, "discards", id + ".json");

onLinux("IA-2: a deletion interrupted part way, twice, resumes from its journal with the original list", async () => {
  const t = await archivedTask("safety-partial-", DATA);
  try {
    let fault = failAfterDataUnlinks(1), first;
    try { first = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest); } finally { fault.restore(); }
    expect(first.outcomes[t.at]?.status).toBe("failed");
    expect(fault.deleted.length).toBe(1);
    expect(await exists(journalOf(t.control, t.task.id))).toBe(true);
    fault = failAfterDataUnlinks(1);
    let second;
    try { second = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest); } finally { fault.restore(); }
    expect(second.outcomes[t.at]?.status).toBe("failed");
    expect(fault.deleted.length).toBe(1);
    const third = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest);
    expect(third.outcomes[t.at]).toEqual({ status: "removed", bytes: t.item.evidence.bytes });
    expect(await exists(t.item.destination)).toBe(false);
    expect(await receiptGone(t.control, t.task.id)).toBe(true);
    // The finished journal is dropped once the plan saved the outcome.
    expect(await exists(journalOf(t.control, t.task.id))).toBe(false);
    // Asked directly afterwards, the backend says it has nothing that proves this archive any more.
    expect(await t.backend.discardArchive(t.task.id, t.item.destination, t.item.evidence)).toEqual({ name: t.task.id, status: "refused", reason: "archive-receipt-missing" });
  } finally { await t.f.cleanup(); }
});

onLinux("IA-2: a new preview after a partial deletion offers the rest, and the backend alone may resume it", async () => {
  const t = await archivedTask("safety-preview-", DATA);
  try {
    const fault = failAfterDataUnlinks(1);
    try { await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest); } finally { fault.restore(); }
    const fresh = await previewArchiveRemoval(t.options), item = fresh.items.find(entry => entry.task === t.task.id)!;
    expect(item.status).toBe("ready");
    const done = await applyArchiveRemoval(t.options, fresh.id, fresh.digest);
    expect(done.outcomes[fresh.items.indexOf(item)]?.status).toBe("removed");
    expect(await exists(t.item.destination)).toBe(false);
    // The original list, replayed later, finds the backend's finished state, not a missing tree.
    expect((await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest)).outcomes[t.at]?.status).toBe("missing");
    expect((await previewArchiveRemoval(t.options)).items.some(entry => entry.task === t.task.id)).toBe(false);
  } finally { await t.f.cleanup(); }
});

onLinux("IA-2: an entry added, or a remaining file replaced, after the deletion started keeps the tree", async () => {
  for (const change of ["added", "replaced"] as const) {
    const t = await archivedTask("safety-foreign-", DATA);
    try {
      const fault = failAfterDataUnlinks(1);
      try { await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest); } finally { fault.restore(); }
      const work = join(t.item.destination, "work"), remaining = (await fs.readdir(work)).filter(name => name.startsWith("data-")).sort();
      if (change === "added") await fs.writeFile(join(work, "new.txt"), "not reviewed");
      else {
        // Same name and bytes, another inode (made before the old one is freed, so its number cannot be reused).
        const path = join(work, remaining[0]!);
        await fs.writeFile(path + ".new", await fs.readFile(path, "utf8")); await fs.rename(path + ".new", path);
      }
      const replay = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest);
      expect(replay.outcomes[t.at], change).toMatchObject({ status: "deferred", reason: "archive-changed-during-removal" });
      expect((await fs.readdir(work)).filter(name => name.startsWith("data-")).sort(), change).toEqual(remaining);
      if (change === "added") expect(await fs.readFile(join(work, "new.txt"), "utf8")).toBe("not reviewed");
      expect(await receiptGone(t.control, t.task.id), change).toBe(false);
    } finally { await t.f.cleanup(); }
  }
});

onLinux("IA-2: a tree removed whose receipt could not be dropped is finished by a replay", async () => {
  const t = await archivedTask("safety-receipt-", DATA);
  try {
    const original = fs.unlink, receipt = join(t.control, "receipts", t.task.id + ".json");
    let refused = false;
    const spy = spyOn(fs, "unlink").mockImplementation(async path => {
      if (!refused && String(path) === receipt) { refused = true; throw Object.assign(new Error("synthetic receipt unlink failure"), { code: "EIO" }); }
      return original(path);
    });
    let first;
    try { first = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest); } finally { spy.mockRestore(); }
    expect(refused).toBe(true);
    expect(first.outcomes[t.at]?.status).toBe("failed");
    expect([await exists(t.item.destination), await receiptGone(t.control, t.task.id)]).toEqual([false, false]);
    // The tree was already gone when the replay reached the backend: it only finishes, and counts no bytes (nothing
    // durable says which list deleted it; under-counting is accepted, counting twice is not).
    const replay = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest);
    expect(replay.outcomes[t.at]).toEqual(finishedEarlier());
    expect([await receiptGone(t.control, t.task.id), await exists(journalOf(t.control, t.task.id))]).toEqual([true, false]);
  } finally { await t.f.cleanup(); }
});

onLinux("IA-2: a root found gone before the journal said so is reported unconfirmed, never removed", async () => {
  const t = await archivedTask("safety-unconfirmed-", DATA);
  try {
    const original = io.publishJson, journal = journalOf(t.control, t.task.id);
    let lost = false;
    const spy = spyOn(io, "publishJson").mockImplementation(async (path, value) => {
      if (!lost && path === journal && String((value as { payload?: string }).payload).includes('"phase":"removed"')) { lost = true; throw new Error("synthetic crash before the removal was journaled"); }
      return original(path, value);
    });
    try { expect((await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest)).outcomes[t.at]?.status).toBe("failed"); }
    finally { spy.mockRestore(); }
    expect(lost).toBe(true);
    expect(await exists(t.item.destination)).toBe(false);
    const replay = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest);
    expect(replay.outcomes[t.at]).toMatchObject({ status: "deferred", reason: "archive-removal-unconfirmed" });
    expect(await receiptGone(t.control, t.task.id)).toBe(false);
  } finally { await t.f.cleanup(); }
});

onLinux("IA-2: another process resumes the journaled deletion", async () => {
  const context = await fixture("safety-process-"), control = join(context.f.root, "control");
  try {
    // The first process archives, starts the deletion, fails part way and exits (releasing the owner lock).
    const child = spawn(process.execPath, [fileURLToPath(new URL("../helpers/archive-discard-process.ts", import.meta.url)), context.f.root], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "";
    child.stdout.on("data", data => output += String(data)); child.stderr.on("data", data => stderr += String(data));
    expect(await new Promise(resolve => child.on("exit", resolve)), stderr).toBe(0);
    const started = JSON.parse(output.trim().split("\n").at(-1)!) as { id: string; removal: string; digest: string; at: number; destination: string; status: string };
    expect(started.status).toBe("failed");
    const backend = new RootlessTasks(control, image, driver), options = { ...context.options, backend };
    const replay = await applyArchiveRemoval(options, started.removal, started.digest);
    expect(replay.outcomes[started.at]?.status).toBe("removed");
    expect([await exists(started.destination), await receiptGone(control, started.id)]).toEqual([false, true]);
  } finally { await context.f.cleanup(); }
});

onLinux("IA-2: a journal not signed by this manager is refused; the remaining tree stays", async () => {
  const t = await archivedTask("safety-forged-", DATA);
  try {
    const fault = failAfterDataUnlinks(1);
    try { await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest); } finally { fault.restore(); }
    const path = journalOf(t.control, t.task.id), saved = JSON.parse(await fs.readFile(path, "utf8"));
    const payload = JSON.parse(saved.payload);
    payload.entries.push({ path: "/work/planted.txt", dev: payload.evidence.dev, ino: "1", type: "file", size: 0, sha256: "0".repeat(64) });
    await fs.writeFile(path, JSON.stringify({ payload: JSON.stringify(payload), signature: saved.signature }), { mode: 0o600 });
    const remaining = await fs.readdir(join(t.item.destination, "work"));
    const replay = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest);
    expect(replay.outcomes[t.at]?.status).toBe("failed");
    expect(String(replay.outcomes[t.at]?.reason)).toContain("签名无效");
    expect(await fs.readdir(join(t.item.destination, "work"))).toEqual(remaining);
  } finally { await t.f.cleanup(); }
});

onLinux("IA-2: a root swapped after the resume check is not the registered entity and is never deleted", async () => {
  const t = await archivedTask("safety-root-swap-", DATA);
  try {
    const fault = failAfterDataUnlinks(1);
    try { await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest); } finally { fault.restore(); }
    const original = evidence.reclamationEvidence, moved = t.item.destination + ".reviewed-moved";
    let swapped = false;
    const spy = spyOn(evidence, "reclamationEvidence").mockImplementation(async (path, collect) => {
      const result = await original(path, collect);
      if (!swapped && path === t.item.destination && collect) {
        swapped = true;
        await fs.rename(t.item.destination, moved); await fs.mkdir(t.item.destination); await fs.writeFile(join(t.item.destination, "new.txt"), "new");
      }
      return result;
    });
    let replay;
    try { replay = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest); } finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(replay.outcomes[t.at]).toMatchObject({ status: "deferred", reason: "registered-entity-moved-or-replaced" });
    expect(await fs.readFile(join(t.item.destination, "new.txt"), "utf8")).toBe("new");
    expect(await exists(moved)).toBe(true);
  } finally { await t.f.cleanup(); }
});

// C6: an archived task's bytes count once at most, across every list. A removal its backend finds already done
// (journal at removed) only finishes, whichever list reaches it and whatever that list started before.

/** The real backend, except the next `discardArchive` (before reaching it) or `forgetDiscard` call fails. */
function failingBackend(backend: RootlessTasks, fail: "discard-before" | "discard-after" | "forget") {
  return {
    inventory: backend.inventory.bind(backend), archive: backend.archive.bind(backend), discardStarted: backend.discardStarted.bind(backend),
    async discardArchive(...args: Parameters<RootlessTasks["discardArchive"]>) {
      if (fail === "discard-before") throw new Error("synthetic crash before the backend was reached");
      const result = await backend.discardArchive(...args);
      if (fail === "discard-after") throw new Error("synthetic crash after the backend removed the tree");
      return result;
    },
    async forgetDiscard(...args: Parameters<RootlessTasks["forgetDiscard"]>) {
      if (fail === "forget") throw new Error("synthetic failure dropping the finished journal");
      return backend.forgetDiscard(...args);
    },
  };
}
const counted = (...lists: { outcomes: Record<string, { status: string; bytes: number; finishing?: true }> }[]) =>
  lists.flatMap(list => Object.values(list.outcomes)).filter(outcome => outcome.status === "removed" && !outcome.finishing).reduce((sum, outcome) => sum + outcome.bytes, 0);

onLinux("C6: B started first and stopped before the backend; A then deleted and counted; B's replay only finishes", async () => {
  const t = await archivedTask("c6-interleave-", DATA);
  try {
    const a = t.removal, b = await previewArchiveRemoval(t.options), bAt = b.items.findIndex(item => item.task === t.task.id);
    expect(b.items[bAt]!.status).toBe("ready");
    // B saves its start, then stops before reaching the backend.
    const bFirst = await applyArchiveRemoval({ ...t.options, backend: failingBackend(t.backend, "discard-before") }, b.id, b.digest);
    expect([bFirst.started.includes(bAt), bFirst.outcomes[bAt]?.status]).toEqual([true, "failed"]);
    expect(await exists(t.item.destination)).toBe(true);
    // A deletes the tree and counts it; dropping the finished journal fails, so the journal stays at removed.
    const aDone = await applyArchiveRemoval({ ...t.options, backend: failingBackend(t.backend, "forget") }, a.id, a.digest);
    expect(aDone.outcomes[t.at]).toEqual({ status: "removed", bytes: t.item.evidence.bytes });
    expect([await exists(t.item.destination), await exists(journalOf(t.control, t.task.id))]).toEqual([false, true]);
    // B replays: its earlier start proves nothing about who deleted; it finishes and counts nothing.
    const bReplay = await applyArchiveRemoval(t.options, b.id, b.digest);
    expect(bReplay.outcomes[bAt]).toEqual(finishedEarlier());
    expect(await exists(journalOf(t.control, t.task.id))).toBe(false);
    // Repeating either list changes nothing; the bytes are counted exactly once over both.
    expect(await applyArchiveRemoval(t.options, b.id, b.digest)).toEqual(bReplay);
    const aReplay = await applyArchiveRemoval(t.options, a.id, a.digest);
    expect(aReplay.outcomes[t.at]).toEqual(aDone.outcomes[t.at]);
    expect(counted(aReplay, bReplay)).toBe(t.item.evidence.bytes);
    expect((await previewArchiveRemoval(t.options)).items.some(item => item.task === t.task.id)).toBe(false);
  } finally { await t.f.cleanup(); }
});

onLinux("C6: a deletion stopped after the backend removed the tree, then finished by a new list, is counted by neither", async () => {
  const t = await archivedTask("c6-new-list-", DATA);
  try {
    // A's backend removes the tree and journals it; A stops before saving its outcome.
    const aFirst = await applyArchiveRemoval({ ...t.options, backend: failingBackend(t.backend, "discard-after") }, t.removal.id, t.removal.digest);
    expect(aFirst.outcomes[t.at]?.status).toBe("failed");
    expect([await exists(t.item.destination), await exists(journalOf(t.control, t.task.id))]).toEqual([false, true]);
    // A new list offers the journaled entry and only finishes it.
    const c = await previewArchiveRemoval(t.options), cAt = c.items.findIndex(item => item.task === t.task.id);
    expect(c.items[cAt]!.status).toBe("ready");
    const cDone = await applyArchiveRemoval(t.options, c.id, c.digest);
    expect(cDone.outcomes[cAt]).toEqual(finishedEarlier());
    expect([await receiptGone(t.control, t.task.id), await exists(journalOf(t.control, t.task.id))]).toEqual([true, false]);
    expect(await applyArchiveRemoval(t.options, c.id, c.digest)).toEqual(cDone);
    // A's replay finds no journal and no tree: missing, not removed. Nothing is counted: the deleting run never saved
    // its outcome and no record ties the deletion to it (under-counting is accepted; counting twice is not).
    const aReplay = await applyArchiveRemoval(t.options, t.removal.id, t.removal.digest);
    expect(aReplay.outcomes[t.at]?.status).toBe("missing");
    expect(counted(aReplay, cDone)).toBe(0);
  } finally { await t.f.cleanup(); }
});
