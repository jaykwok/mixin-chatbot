// A progress file that reached disk, followed by a failed call (the "persisted, caller saw an error" boundary).
// Each scenario injects that failure once, after a physical action, then replays the same plan as an operator would.
import { spyOn, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { Database } from "bun:sqlite";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import * as io from "../../scripts/lib/atomic-file.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { durableMemberScope } from "../../src/durable/maintenance-view.ts";
import { applyArchiveRemoval, applyTmpArchive, previewArchiveRemoval, previewTmpArchive } from "../../src/maintenance/archive.ts";
import { applyReclamation, previewReclamation } from "../../src/maintenance/reclaim.ts";
import { RootlessTasks, type TaskDriver } from "../../src/core/rootless-tasks.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf } from "../helpers/layout.ts";

const exists = (path: string) => lstat(path).then(() => true, () => false);
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

async function group(root: string, results: Record<string, string | undefined>) {
  new Database(join(root, "../state.sqlite")).close(); // An empty delivery ledger: nothing is waiting to be sent.
  const { models, model } = fauxModels(), opened = await openGroupHarness(join(root, "conversations/groups/group-a/durable.sqlite"), models);
  try {
    await memberConversation(opened.harness, scopeOf("group-a"), "alice", { model }, context);
    await opened.harness.commit(async tx => {
      for (const [name, task] of Object.entries(results)) (await tx.doc(ResultsDoc)).calls[name] = { phone: "alice", createdAt: 1, ...task ? { isolatedTask: task } : {} };
    }, context);
  } finally { await opened.close(); }
}
async function calls(root: string) {
  const { models } = fauxModels(), opened = await openGroupHarness(join(root, "conversations/groups/group-a/durable.sqlite"), models);
  try { return Object.keys((await opened.harness.snapshot(ResultsDoc, context))?.calls ?? {}); } finally { await opened.close(); }
}

/** Publish the file, then throw once the matching state is about to be acknowledged. */
function failAfterPublish(match: (path: string, value: any) => boolean) {
  const original = io.publishJson;
  const state = { injected: false };
  const spy = spyOn(io, "publishJson").mockImplementation(async (path, value) => {
    await original(path, value);
    if (!state.injected && match(path, value)) { state.injected = true; throw new Error("synthetic failure after publish"); }
  });
  return { state, restore: () => spy.mockRestore() };
}

async function archiveFixture(prefix: string) {
  const f = await tempFixture(prefix), root = join(f.root, "data"), temp = join(root, "tmp/groups/group-a/alice");
  await mkdir(join(temp, "codemode/1-result"), { recursive: true });
  await writeFile(join(temp, "codemode/1-result/output"), "result");
  await writeFile(join(temp, "note.txt"), "note");
  await group(root, { "1-result": undefined });
  return { f, root, temp, options: { root, state: join(f.root, "state.sqlite"), archive: join(root, "state/reclamation/backup/rm"), scope: durableMemberScope } };
}

test("archive: a progress write that landed before an error is replayed to the same archived result and settles ownership once", async () => {
  const { f, root, temp, options } = await archiveFixture("faults-archive-");
  try {
    const plan = await previewTmpArchive(options, 0);
    const fault = failAfterPublish((path, value) => path.endsWith(".progress.json") && value.outcomes?.["0"]?.status === "archived");
    let first;
    try { first = await applyTmpArchive(options, plan.id, plan.digest); } finally { fault.restore(); }
    expect(fault.state.injected).toBe(true);
    // The caller only saw the error: the item is reported failed and its ownership is not settled yet.
    expect(first.outcomes[0]!.status).toBe("failed");
    expect(await calls(root)).toEqual(["1-result"]);
    expect(await exists(join(temp, "codemode"))).toBe(false);
    const replay = await applyTmpArchive(options, plan.id, plan.digest);
    expect(Object.values(replay.outcomes).map(outcome => outcome.status)).toEqual(["archived", "archived"]);
    expect(await calls(root)).toEqual([]);
    expect(await readFile(join(plan.items[0]!.destination, "1-result/output"), "utf8")).toBe("result");
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "win32")("archive removal (Windows): a file whose removal was persisted before an error resumes from its deletion journal, never removed twice", async () => {
  const { f, options } = await archiveFixture("faults-removal-");
  try {
    const plan = await previewTmpArchive(options, 0);
    await applyTmpArchive(options, plan.id, plan.digest);
    const removal = await previewArchiveRemoval(options);
    const fileIndex = removal.items.findIndex(item => item.kind === "file");
    expect(removal.items[fileIndex]!.status).toBe("ready");
    const fault = failAfterPublish((path, value) => path.endsWith(".removal-progress.json") && value.outcomes?.[fileIndex]?.status === "removed");
    let first;
    try { first = await applyArchiveRemoval(options, removal.id, removal.digest); } finally { fault.restore(); }
    expect(fault.state.injected).toBe(true);
    expect(first.outcomes[fileIndex]!.status).toBe("failed");
    expect(await exists(removal.items[fileIndex]!.destination)).toBe(false);
    // The handle backend journaled this deletion (R0-F1 for files): the replay completes from it, without another deletion.
    const replay = await applyArchiveRemoval(options, removal.id, removal.digest);
    expect(replay.outcomes[fileIndex]).toEqual({ status: "removed", bytes: removal.items[fileIndex]!.evidence.bytes });
    for (const outcome of Object.values(replay.outcomes)) expect(outcome.status as string).toBe("removed");
    expect(await json(join(options.archive, ".tmp-plans", removal.id + ".removal-progress.json"))).toEqual(replay);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform === "win32")("archive removal (Linux): entries of the old shared identity wait for the privileged backend; nothing is deleted", async () => {
  const { f, options } = await archiveFixture("faults-removal-");
  try {
    const plan = await previewTmpArchive(options, 0);
    await applyTmpArchive(options, plan.id, plan.digest);
    const removal = await previewArchiveRemoval(options);
    expect(removal.items.map(item => [item.kind, item.status, item.reason])).toEqual(removal.items.map(item =>
      [item.kind, "deferred", "旧共享身份的归档项需要宿主特权离线后端（--legacy --journal）"]));
    const done = await applyArchiveRemoval(options, removal.id, removal.digest);
    expect(Object.values(done.outcomes).map(outcome => outcome.status)).toEqual(removal.items.map(() => "deferred"));
    expect(done.started).toEqual([]);
    for (const item of removal.items) expect(await exists(item.destination)).toBe(true);
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "win32")("physical reclamation (Windows): a removal persisted before an error resumes from its journal and settles once", async () => {
  const f = await tempFixture("faults-reclaim-"), root = join(f.root, "data"), temp = join(root, "tmp/groups/group-a/alice");
  try {
    await mkdir(join(temp, "codemode/1-result"), { recursive: true });
    await writeFile(join(temp, "codemode/1-result/output"), "result");
    await group(root, { "1-result": undefined });
    const options = { root, state: join(f.root, "state.sqlite"), directory: join(f.root, "plans"), scope: durableMemberScope };
    const plan = await previewReclamation(options, 0);
    const fault = failAfterPublish((path, value) => path.endsWith(".progress.json") && value.outcomes?.["0"]?.status === "removed");
    let first;
    try { first = await applyReclamation(options, plan.id, plan.digest); } finally { fault.restore(); }
    expect(fault.state.injected).toBe(true);
    expect(first.outcomes["0"]!.status).toBe("failed");
    expect(await calls(root)).toEqual(["1-result"]);
    const replay = await applyReclamation(options, plan.id, plan.digest);
    expect(replay.outcomes["0"]).toEqual({ status: "removed", bytes: 6 });
    expect(await calls(root)).toEqual([]);
    expect(await exists(join(temp, "codemode/1-result"))).toBe(false);
  } finally { await f.cleanup(); }
});

const image = "sha256:" + "a".repeat(64);
const driver: TaskDriver = { async run(args) {
  if (args[0] === "info") return { exitCode: 0, output: JSON.stringify({ ID: "faults-fixture", SecurityOptions: ["name=rootless"] }) };
  if (args[0] === "image") return { exitCode: 0, output: JSON.stringify([{ Id: image, Os: "linux" }]) };
  throw new Error("This fixture cannot start Docker: " + args.join(" "));
} };

test.skipIf(process.platform !== "linux")("physical reclamation (task): a removal persisted before an error resumes from the receipt and settles once", async () => {
  const f = await tempFixture("faults-task-"), root = join(f.root, "data"), temp = join(root, "tmp/groups/group-a/alice");
  try {
    await mkdir(temp, { recursive: true });
    const backend = new RootlessTasks(join(f.root, "control"), image, driver);
    const task = await backend.reserve(temp, "results", "1-result").create();
    await writeFile(join(task.path, "result"), "bytes"); await task.seal();
    await group(root, { "1-result": task.id });
    const options = { root, state: join(f.root, "state.sqlite"), directory: join(f.root, "plans"), scope: durableMemberScope, backend };
    const plan = await previewReclamation(options, 0);
    expect(plan.items.map(item => [item.task, item.status])).toEqual([[task.id, "ready"]]);
    const fault = failAfterPublish((path, value) => path.endsWith(".progress.json") && value.outcomes?.["0"]?.status === "removed");
    let first;
    try { first = await applyReclamation(options, plan.id, plan.digest); } finally { fault.restore(); }
    expect(fault.state.injected).toBe(true);
    expect(first.outcomes["0"]!.status).toBe("failed");
    expect(await calls(root)).toEqual(["1-result"]);
    const replay = await applyReclamation(options, plan.id, plan.digest);
    expect(replay.outcomes["0"]!.status).toBe("removed");
    expect(await calls(root)).toEqual([]);
    expect(await exists(join(temp, ".isolated-work", task.id))).toBe(false);
  } finally { await f.cleanup(); }
});
