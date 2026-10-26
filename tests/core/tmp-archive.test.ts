import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { durableMemberScope } from "../../src/durable/maintenance-view.ts";
import { applyArchiveRemoval, applyTmpArchive, previewArchiveRemoval, previewTmpArchive } from "../../src/maintenance/archive.ts";
import { archiveEntry } from "../../src/core/archive-entry.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { withSpaceSnapshot } from "../../src/durable/diagnostics.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { referTo } from "../helpers/pending-reply.ts";
import { recordsOf } from "../../src/durable/records.ts";
import { tempFixture } from "../helpers/temp.ts";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { scopeOf } from "../helpers/layout.ts";

async function fixture(durable = false) {
  const f = await tempFixture("tmp-archive-"), root = join(f.root, "data"), temp = join(root, "tmp/groups/group-a/alice");
  await mkdir(temp, { recursive: true });
  const state = join(f.root, "state.sqlite"), db = new Database(state);
  const path = join(root, "conversations/groups/group-a/durable.sqlite");
  if (durable) {
    const { models, model } = fauxModels(), group = await openGroupHarness(path, models);
    try {
      await memberConversation(group.harness, scopeOf("group-a"), "alice", { model }, context);
      await memberConversation(group.harness, scopeOf("group-a"), "bob", { model }, context);
      await group.harness.commit(async tx => { (await tx.doc(ResultsDoc)).calls["1-result"] = { phone: "alice", createdAt: 1 }; }, context);
    } finally { await group.close(); }
  }
  /** Bob's run record naming a path, written in the closed group database. */
  const refer = async (target: string | undefined) => {
    const group = await openGroupHarness(path, fauxModels().models);
    try { await referTo(group.harness, "bob", "msg:pending", target); } finally { await group.close(); }
  };
  return { f, root, temp, path, refer, options: { root, state, archive: join(root, "state/reclamation/backup/rm"), scope: durableMemberScope },
    async close() { db.close(); await f.cleanup(); } };
}

test("archive rechecks another member's pending replies, then settles the precise result ownership", async () => {
  const f = await fixture(true), source = join(f.temp, "codemode");
  try {
    await mkdir(join(source, "1-result"), { recursive: true }); await writeFile(join(source, "1-result/output"), "kept bytes");
    await writeFile(join(f.temp, "bash.log"), "log");
    const plan = await previewTmpArchive(f.options, 0);
    expect(plan.items.filter(item => item.status === "ready")).toHaveLength(2);
    await f.refer(join(source, "1-result/output"));
    const first = await applyTmpArchive(f.options, plan.id, plan.digest);
    expect(Object.values(first.outcomes).filter(item => item.status === "archived")).toHaveLength(1);
    expect(await readFile(join(source, "1-result/output"), "utf8")).toBe("kept bytes");
    await f.refer(undefined);
    const second = await applyTmpArchive(f.options, plan.id, plan.digest);
    console.log(JSON.stringify(second.outcomes));
    expect(Object.values(second.outcomes).every(item => item.status === "archived")).toBe(true);
    await withSpaceSnapshot(f.path, async harness => expect((await harness.snapshot(ResultsDoc, context))!.calls).toEqual({}));
    expect(await applyTmpArchive(f.options, plan.id, plan.digest)).toEqual(second);
    const target = plan.items.find(item => item.source === source)!.destination;
    expect(await readFile(join(target, "1-result/output"), "utf8")).toBe("kept bytes");
  } finally { await f.close(); }
});

test("archive resumes a persisted rename intent, but refuses a same-name replacement and altered content", async () => {
  const f = await fixture();
  try {
    const source = join(f.temp, "output.txt"); await writeFile(source, "original");
    const plan = await previewTmpArchive(f.options, 0), item = plan.items[0]!;
    const progress = join(f.options.archive, ".tmp-plans", plan.id + ".progress.json");
    await writeFile(progress, JSON.stringify({ version: 1, digest: plan.digest, started: [0], outcomes: {} }));
    await rename(source, item.destination);
    await writeFile(source, "replacement");
    expect((await applyTmpArchive(f.options, plan.id, plan.digest)).outcomes[0]!.status).toBe("failed");
    expect(await readFile(source, "utf8")).toBe("replacement");
    await rename(source, join(f.f.root, "saved-replacement"));
    expect((await applyTmpArchive(f.options, plan.id, plan.digest)).outcomes[0]!.status).toBe("archived");
    await writeFile(join(f.temp, "changed"), "before");
    const changed = await previewTmpArchive(f.options, 0);
    await writeFile(join(f.temp, "changed"), "after");
    expect((await applyTmpArchive(f.options, changed.id, changed.digest)).outcomes[0]!.status).toBe("failed");
    await expect(applyTmpArchive(f.options, changed.id, "0".repeat(64))).rejects.toThrow("摘要");
  } finally { await f.close(); }
});

test("archived entries are discarded only as proven by their plan, and only while unchanged", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.temp, "a.txt"), "file"); await mkdir(join(f.temp, "d/inner"), { recursive: true });
    await writeFile(join(f.temp, "d/inner/x"), "dir"); await writeFile(join(f.temp, "changed.txt"), "before");
    const plan = await previewTmpArchive(f.options, 0), archived = await applyTmpArchive(f.options, plan.id, plan.digest);
    expect(Object.values(archived.outcomes).map(item => item.status)).toEqual(["archived", "archived", "archived"]);
    const at = (name: string) => plan.items.find(item => item.source === join(f.temp, name))!.destination;
    await writeFile(at("changed.txt"), "after");
    const removal = await previewArchiveRemoval(f.options), status = (name: string) => removal.items.find(item => item.destination === at(name))?.status;
    // Linux: entries of the old shared identity wait for the privileged backend, files and directories alike.
    const plain = process.platform === "win32";
    expect([status("a.txt"), status("d"), status("changed.txt")]).toEqual([plain ? "ready" : "deferred", plain ? "ready" : "deferred", "kept"]);
    await expect(applyArchiveRemoval(f.options, removal.id, "0".repeat(64))).rejects.toThrow("摘要");
    const done = await applyArchiveRemoval(f.options, removal.id, removal.digest), outcome = (name: string) => done.outcomes[removal.items.findIndex(item => item.destination === at(name))]!.status;
    expect([outcome("a.txt"), outcome("d"), outcome("changed.txt")]).toEqual([plain ? "removed" : "deferred", plain ? "removed" : "deferred", "kept"]);
    const exists = (path: string) => lstat(path).then(() => true, () => false);
    expect([await exists(at("a.txt")), await exists(at("d")), await exists(at("changed.txt"))]).toEqual([!plain, !plain, true]);
    // Replays keep their final outcomes: the removal does not report a vanished entry, the archive does not fail.
    expect(await applyArchiveRemoval(f.options, removal.id, removal.digest)).toEqual(done);
    expect(await applyTmpArchive(f.options, plan.id, plan.digest)).toEqual(archived);
    expect((await previewArchiveRemoval(f.options)).items.map(item => item.destination).sort()).toEqual(
      (plain ? [at("changed.txt")] : [at("a.txt"), at("changed.txt"), at("d")]).sort());
  } finally { await f.close(); }
});

test("a discard list rechecks the entry right before deletion", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.temp, "a.txt"), "file");
    const plan = await previewTmpArchive(f.options, 0); await applyTmpArchive(f.options, plan.id, plan.digest);
    const removal = await previewArchiveRemoval(f.options);
    await writeFile(plan.items[0]!.destination, "rewritten");
    // Linux defers it already in the preview (privileged backend); Windows rechecks it right before deletion.
    expect((await applyArchiveRemoval(f.options, removal.id, removal.digest)).outcomes[0]!.status).toBe(process.platform === "win32" ? "failed" : "deferred");
    expect(await readFile(plan.items[0]!.destination, "utf8")).toBe("rewritten");
  } finally { await f.close(); }
});

test("archive never overwrites a destination and refuses the wrong source identity", async () => {
  const f = await fixture();
  try {
    const a = join(f.temp, "a"), b = join(f.temp, "b"); await writeFile(a, "a"); await writeFile(b, "b");
    const expected = await lstat(a, { bigint: true });
    await expect(archiveEntry(a, b, expected)).rejects.toThrow();
    await expect(archiveEntry(a, join(f.temp, "new"), { dev: expected.dev, ino: expected.ino + 1n })).rejects.toThrow("实体");
    expect(await readFile(a, "utf8")).toBe("a"); expect(await readFile(b, "utf8")).toBe("b");
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "linux")("archival moves a symlink itself and preserves its target", async () => {
  const f = await fixture();
  try {
    const external = join(f.f.root, "external"); await mkdir(external); await writeFile(join(external, "keep"), "outside");
    await symlink(external, join(f.temp, "link"));
    const plan = await previewTmpArchive(f.options, 0), done = await applyTmpArchive(f.options, plan.id, plan.digest);
    expect(done.outcomes[0]!.status).toBe("archived"); expect((await lstat(plan.items[0]!.destination)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(external, "keep"), "utf8")).toBe("outside");
  } finally { await f.close(); }
});

test("archive keeps entries whose owner changed, a destination without this operation's intent, and a resumed destination that changed", async () => {
  const f = await fixture(true);
  try {
    await mkdir(join(f.temp, "codemode/1-result"), { recursive: true }); await writeFile(join(f.temp, "codemode/1-result/output"), "owned");
    await writeFile(join(f.temp, "moved.txt"), "moved by hand"); await writeFile(join(f.temp, "resumed.txt"), "resumed");
    const plan = await previewTmpArchive(f.options, 0), at = (name: string) => plan.items.findIndex(item => item.source === join(f.temp, name));
    expect(plan.items.map(item => item.status)).toEqual(["ready", "ready", "ready"]);
    const group = await openGroupHarness(f.path, fauxModels().models);
    try { await group.harness.commit(async tx => { (await tx.doc(ResultsDoc)).calls["1-result"]!.createdAt = 2; }, context); } finally { await group.close(); }
    await rename(join(f.temp, "moved.txt"), plan.items[at("moved.txt")]!.destination);
    await writeFile(join(f.options.archive, ".tmp-plans", plan.id + ".progress.json"),
      JSON.stringify({ version: 1, digest: plan.digest, started: [at("resumed.txt")], outcomes: {} }));
    await rename(join(f.temp, "resumed.txt"), plan.items[at("resumed.txt")]!.destination);
    await writeFile(plan.items[at("resumed.txt")]!.destination, "altered at the destination");
    const result = await applyTmpArchive(f.options, plan.id, plan.digest), outcome = (name: string) => result.outcomes[at(name)]!;
    expect([outcome("codemode"), outcome("moved.txt"), outcome("resumed.txt")].map(item => item.status)).toEqual(["failed", "failed", "failed"]);
    expect(outcome("codemode").reason).toContain("结果归属已改变");
    expect(outcome("moved.txt").reason).toContain("没有本操作的持久意图");
    expect(outcome("resumed.txt").reason).toContain("归档后的内容或实体不符");
    expect(await readFile(join(f.temp, "codemode/1-result/output"), "utf8")).toBe("owned");
    await withSpaceSnapshot(f.path, async harness => expect((await harness.snapshot(ResultsDoc, context))!.calls["1-result"]?.createdAt).toBe(2));
  } finally { await f.close(); }
});

test("a direct-chat attachment that is not void protects its received file; a void one does not", async () => {
  const f = await fixture(true), dir = join(f.temp, "received"), file = join(dir, "0123456789abcdef-a.txt");
  const record = async (state: "ready" | "void") => {
    const group = await openGroupHarness(f.path, fauxModels().models);
    try {
      await group.harness.commit(async tx => {
        const now = Date.now();
        (await recordsOf(tx, "alice")).attachments["0123456789abcdef"] = {
          id: "0123456789abcdef", msgUid: "uid-1", receivedAt: now, epoch: 1, fileId: "file-1", kind: "file", name: "a.txt", state, at: now,
          reply: { kind: "direct", receiveId: "im-alice", senderImUserId: "im-alice", msgUid: "uid-1", summary: "[文件]", receivedAt: now },
          ...(state === "ready" ? { path: file, actualSize: 5 } : {}),
        };
      }, context);
    } finally { await group.close(); }
  };
  try {
    await mkdir(dir, { recursive: true }); await writeFile(file, "bytes");
    await record("ready");
    const plan = await previewTmpArchive(f.options, 0);
    expect(plan.items.find(item => item.source === dir)).toMatchObject({ status: "kept" });
    const first = await applyTmpArchive(f.options, plan.id, plan.digest);
    expect(Object.values(first.outcomes).some(item => item.status === "archived")).toBe(false);
    expect(await readFile(file, "utf8")).toBe("bytes");
    // Void: the record keeps no path, so a new plan may archive the file.
    await record("void");
    const again = await previewTmpArchive(f.options, 0);
    expect(again.items.find(item => item.source === dir)).toMatchObject({ status: "ready" });
    const second = await applyTmpArchive(f.options, again.id, again.digest);
    expect(Object.values(second.outcomes).every(item => item.status === "archived")).toBe(true);
    await expect(lstat(file)).rejects.toThrow();
  } finally { await f.close(); }
});
