import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { RootlessTasks, type TaskDriver } from "../../src/core/rootless-tasks.ts";
import { applyReclamation, previewReclamation } from "../../src/maintenance/reclaim.ts";
import { legacyJournalRoot } from "../../src/maintenance/legacy.ts";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { handoffResults, ReclamationQueues } from "../../src/durable/results/queue.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { resultReferences } from "../../src/durable/results/references.ts";
import { durableMemberScope } from "../../src/durable/maintenance-view.ts";
import { applyArchiveRemoval, applyTmpArchive, previewArchiveRemoval, previewTmpArchive } from "../../src/maintenance/archive.ts";
import { withGroupSnapshot } from "../../src/durable/diagnostics.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { finishedEarlier } from "../../src/contracts/maintenance.ts";

const image = "sha256:" + "a".repeat(64);
const driver: TaskDriver = { async run(args) {
  if (args[0] === "info") return { exitCode: 0, output: JSON.stringify({ ID: "offline-fixture", SecurityOptions: ["name=rootless"] }) };
  if (args[0] === "image") return { exitCode: 0, output: JSON.stringify([{ Id: image, Os: "linux" }]) };
  throw new Error("This offline fixture cannot start Docker: " + args.join(" "));
} };
async function fixture() {
  const f = await tempFixture("offline-reclamation-"), root = join(f.root, "groups"), temp = join(root, "group-a/users/alice/tmp");
  await mkdir(temp, { recursive: true });
  const { models, model } = fauxModels(), path = join(root, "group-a/durable.sqlite"), group = await openGroupHarness(path, models);
  await memberConversation(group.harness, "group-a", "alice", { model }, context);
  const state = join(f.root, "state.sqlite"), db = new Database(state), deliveries = new DeliveryStore(db);
  const backend = new RootlessTasks(join(f.root, "control"), image, driver);
  const create = async (name: string, queued = false) => {
    // Like codemode, the receipt names its result, so a sweep can check the settled ownership.
    const task = await backend.reserve(temp, "results", name).create();
    await writeFile(join(task.path, "result"), name); await task.seal();
    await group.harness.commit(async tx => {
      (await tx.doc(ResultsDoc)).calls[name] = { phone: "alice", createdAt: 1, isolatedTask: task.id };
      if (queued) await handoffResults(tx, "alice", [name], 2);
    }, context);
    return task;
  };
  return { f, root, temp, path, group, db, deliveries, backend, create,
    options: { root, state, directory: join(f.root, "plans"), scope: durableMemberScope, backend },
    async close() { await group.close(); db.close(); await f.cleanup(); } };
}

test.skipIf(process.platform !== "linux")("offline rechecks outbox references and settles exact active/queued ownership atomically", async () => {
  const f = await fixture();
  try {
    const a = await f.create("1-active"), b = await f.create("2-queued", true);
    const plan = await previewReclamation(f.options, 0);
    expect(plan.items.filter(item => item.status === "ready")).toHaveLength(2);
    f.deliveries.put("another-member", "new-reference", join(a.path, "result"));
    const first = await applyReclamation(f.options, plan.id, plan.digest);
    expect(Object.values(first.outcomes).filter(item => item.status === "removed")).toHaveLength(1);
    expect(await readFile(join(a.path, "result"), "utf8")).toBe("1-active");
    expect((await f.backend.describe(b.id, f.temp)).phase).toBe("removed");
    await withGroupSnapshot(f.path, async harness => {
      expect((await harness.snapshot(ReclamationQueues, "alice", context))!.count).toBe(0);
      expect((await harness.snapshot(ResultsDoc, context))!.calls["1-active"]).toBeDefined();
    });
    f.deliveries.acknowledge(["new-reference"]);
    const final = await applyReclamation(f.options, plan.id, plan.digest);
    expect(Object.values(final.outcomes).every(item => item.status === "removed")).toBe(true);
    await withGroupSnapshot(f.path, async harness => expect(Object.keys((await harness.snapshot(ResultsDoc, context))!.calls)).toHaveLength(0));
    expect(await applyReclamation(f.options, plan.id, plan.digest)).toEqual(final);
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "linux")("offline resumes physical deletion before accounting and rejects a changed preview", async () => {
  const f = await fixture();
  try {
    const task = await f.create("1-resume", true), plan = await previewReclamation(f.options, 0);
    let crashed = false;
    const failing = { ...f.options, backend: { inventory: f.backend.inventory.bind(f.backend), async reclaim(id: string, temp?: string) {
      const result = await f.backend.reclaim(id, temp);
      if (!crashed) { crashed = true; throw new Error("synthetic crash after deletion"); }
      return result;
    } } };
    const failed = await applyReclamation(failing, plan.id, plan.digest);
    expect(Object.values(failed.outcomes)[0]!.reason).toContain("synthetic crash");
    expect((await f.backend.describe(task.id, f.temp)).phase).toBe("removed");
    const resumed = await applyReclamation(f.options, plan.id, plan.digest);
    // Already removed when the replay reached the backend: finished and settled, but its bytes are not counted.
    expect(Object.values(resumed.outcomes)[0]).toEqual(finishedEarlier());
    const saved = join(f.options.directory, plan.id + ".json");
    await writeFile(saved, JSON.stringify({ ...plan, before: plan.before + 1 }));
    await expect(applyReclamation(f.options, plan.id, plan.digest)).rejects.toThrow("摘要");
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "linux")("offline content changes and unregistered legacy files remain untouched", async () => {
  const f = await fixture();
  try {
    const task = await f.create("1-changed"); await writeFile(join(f.temp, ".document-unknown"), "unregistered");
    const plan = await previewReclamation(f.options, 0);
    expect(plan.items.find(item => item.path.endsWith(".document-unknown"))!.status).toBe("deferred");
    await writeFile(join(task.path, "result"), "modified after preview");
    const result = await applyReclamation(f.options, plan.id, plan.digest);
    expect(Object.values(result.outcomes).filter(item => item.status === "removed")).toHaveLength(0);
    expect(await readFile(join(task.path, "result"), "utf8")).toBe("modified after preview");
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "linux")("host maintenance protects references recorded at the container group root", async () => {
  const f = await fixture();
  try {
    const task = await f.create("1-mapped");
    const options = { ...f.options, recordedRoot: "/app/data/groups" };
    f.deliveries.put("another-member", "container-reference", join(task.path, "result").replace(f.root, options.recordedRoot));
    const plan = await previewReclamation(options, 0);
    expect(plan.items.find(item => item.task === task.id)?.status).toBe("kept");
    expect(Object.values((await applyReclamation(options, plan.id, plan.digest)).outcomes).some(item => item.status === "removed")).toBe(false);
    expect(await readFile(join(task.path, "result"), "utf8")).toBe("1-mapped");
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "linux")("an archived task keeps its receipt through sweeps; discard removes the tree first, then the receipt", async () => {
  const f = await fixture();
  try {
    // An observing preview creates nothing, even where no control root exists yet.
    const absent = join(f.f.root, "absent-control");
    expect(await new RootlessTasks(absent, image, driver).inventory(f.temp, true)).toEqual({ items: [], refused: [] });
    expect(await lstat(absent).then(() => true, () => false)).toBe(false);
    const task = await f.create("1-archived");
    expect((await f.backend.inventory(f.temp, true)).items.map(item => item.id)).toEqual([task.id]);
    const options = { root: f.root, state: f.options.state, archive: join(f.root, ".reclamation/backup/rm"), scope: durableMemberScope, backend: f.backend };
    const plan = await previewTmpArchive(options, 0), done = await applyTmpArchive(options, plan.id, plan.digest);
    const index = plan.items.findIndex(item => item.task === task.id);
    expect(done.outcomes[index]!.status).toBe("archived");
    await f.backend.sweep(f.temp, Infinity, resultReferences([]), new Set(), async () => true);
    expect((await f.backend.describe(task.id, f.temp)).phase).toBe("archived");
    // A replay after the sweep still finds the receipt-backed outcome final.
    expect(await applyTmpArchive(options, plan.id, plan.digest)).toEqual(done);
    const removal = await previewArchiveRemoval(options), item = removal.items.find(entry => entry.task === task.id)!;
    expect(item.status).toBe("ready");
    const removed = await applyArchiveRemoval(options, removal.id, removal.digest);
    expect(removed.outcomes[removal.items.indexOf(item)]!.status).toBe("removed");
    expect(await lstat(plan.items[index]!.destination).then(() => true, () => false)).toBe(false);
    await expect(f.backend.describe(task.id, f.temp)).rejects.toThrow();
  } finally { await f.close(); }
});

test.skipIf(process.platform === "linux" && process.getuid!() === 0)("legacy maintenance refuses ordinary identity before creating a journal", async () => {
  const f = await tempFixture("legacy-refused-");
  try { await expect(legacyJournalRoot(join(f.root, "journal"))).rejects.toThrow("UID 0"); }
  finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("a resumed deletion still rechecks references before settling ownership", async () => {
  const f = await fixture();
  try {
    const task = await f.create("1-referenced"), plan = await previewReclamation(f.options, 0);
    const failing = { ...f.options, backend: { inventory: f.backend.inventory.bind(f.backend), async reclaim(id: string, temp?: string) {
      await f.backend.reclaim(id, temp); throw new Error("synthetic crash after deletion");
    } } };
    expect(Object.values((await applyReclamation(failing, plan.id, plan.digest)).outcomes)[0]!.status).toBe("failed");
    expect((await f.backend.describe(task.id, f.temp)).phase).toBe("removed");
    f.deliveries.put("another-member", "late-reference", join(task.path, "result"));
    const kept = Object.values((await applyReclamation(f.options, plan.id, plan.digest)).outcomes)[0]!;
    expect([kept.status, kept.reason]).toEqual(["failed", expect.stringContaining("保留待核对")]);
    await withGroupSnapshot(f.path, async harness => expect((await harness.snapshot(ResultsDoc, context))!.calls["1-referenced"]).toBeDefined());
    f.deliveries.acknowledge(["late-reference"]);
    expect(Object.values((await applyReclamation(f.options, plan.id, plan.digest)).outcomes)[0]!.status).toBe("removed");
    await withGroupSnapshot(f.path, async harness => expect((await harness.snapshot(ResultsDoc, context))!.calls).toEqual({}));
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "linux")("a task claimed twice, or a member without a group database, is deferred whole", async () => {
  const f = await fixture();
  try {
    const task = await f.create("1-first");
    await f.group.harness.commit(async tx => { (await tx.doc(ResultsDoc)).calls["2-second"] = { phone: "alice", createdAt: 1, isolatedTask: task.id }; }, context);
    const orphan = join(f.root, "group-b/users/carol/tmp"); await mkdir(orphan, { recursive: true }); await writeFile(join(orphan, "file"), "no group database");
    const plan = await previewReclamation(f.options, 0), member = (dir: string) => plan.items.filter(item => item.path === dir);
    expect(member(f.temp).map(item => [item.status, item.reason])).toEqual([["deferred", expect.stringContaining("重复的结果归属")]]);
    expect(plan.items.some(item => item.task === task.id)).toBe(false);
    expect(member(orphan).map(item => item.status)).toEqual(["deferred"]);
    expect(Object.values((await applyReclamation(f.options, plan.id, plan.digest)).outcomes).map(item => item.status)).toEqual(["deferred", "deferred"]);
    expect(await readFile(join(task.path, "result"), "utf8")).toBe("1-first");
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "linux")("C6: Q started first and stopped before the backend; P then reclaimed and counted; Q's replay only finishes", async () => {
  const f = await fixture();
  try {
    const task = await f.create("1-shared", true), p = await previewReclamation(f.options, 0), q = await previewReclamation(f.options, 0);
    expect([p.items[0]!.status, q.items[0]!.status]).toEqual(["ready", "ready"]);
    const stopped = { ...f.options, backend: { inventory: f.backend.inventory.bind(f.backend), async reclaim() { throw new Error("synthetic crash before the backend was reached"); } } };
    const qFirst = await applyReclamation(stopped, q.id, q.digest);
    expect([qFirst.started, qFirst.outcomes["0"]!.status]).toEqual([["0"], "failed"]);
    const pDone = await applyReclamation(f.options, p.id, p.digest);
    expect(pDone.outcomes["0"]).toEqual({ status: "removed", bytes: p.items[0]!.evidence!.bytes });
    expect((await f.backend.describe(task.id, f.temp)).phase).toBe("removed");
    // Q's earlier start does not make the deletion its own: it finishes (and settles again), counting nothing.
    const qReplay = await applyReclamation(f.options, q.id, q.digest);
    expect(qReplay.outcomes["0"]).toEqual(finishedEarlier());
    expect(await applyReclamation(f.options, q.id, q.digest)).toEqual(qReplay);
    expect(await applyReclamation(f.options, p.id, p.digest)).toEqual(pDone);
    await withGroupSnapshot(f.path, async harness => {
      expect(Object.keys((await harness.snapshot(ResultsDoc, context))!.calls)).toHaveLength(0);
      expect((await harness.snapshot(ReclamationQueues, "alice", context))!.count).toBe(0);
    });
  } finally { await f.close(); }
});
