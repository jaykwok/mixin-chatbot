// Persisted maintenance formats, pinned against golden files produced by the refactoring baseline (T0′).
// Each scenario runs the real preview/apply code in a temporary root and compares the files it leaves behind
// after normalizing paths, IDs and identities. Key order is part of the contract: plan digests hash the JSON text.
// Regenerate only on purpose: MIXIN_WRITE_FORMAT_GOLDEN=1 bun run scripts/test.ts tests/core/maintenance-formats.test.ts
import { test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { openStatsLedger } from "../../src/agent/stats-ledger.ts";
import { AttemptsDoc, type UsageRecord } from "../../src/durable/attempts.ts";
import { AuxiliaryDoc } from "../../src/durable/auxiliary-records.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { conversationSource, projectConversation } from "../../src/durable/projection.ts";
import { handoffResults, ReclamationItems, ReclamationQueues } from "../../src/durable/results/queue.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { durableMemberScope } from "../../src/durable/maintenance-view.ts";
import { applyArchiveRemoval, applyTmpArchive, previewArchiveRemoval, previewTmpArchive } from "../../src/maintenance/archive.ts";
import { applyReclamation, previewReclamation } from "../../src/maintenance/reclaim.ts";
import { ReferenceText } from "../../src/core/reference-text.ts";
import { RootlessTasks, type TaskDriver } from "../../src/core/rootless-tasks.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const golden = join(import.meta.dir, "../fixtures/maintenance-formats");
const platform = process.platform === "win32" ? "win32" : "linux";
const writing = process.env.MIXIN_WRITE_FORMAT_GOLDEN === "1";
const PLAN = "11111111-1111-4111-8111-111111111111", REMOVAL = "22222222-2222-4222-8222-222222222222", RECLAIM = "33333333-3333-4333-8333-333333333333";

/** Values that differ per run or machine keep only their type; everything else, including key order, is compared. */
const VOLATILE = new Set(["createdAt", "before", "dev", "ino", "uid", "gid", "newest", "attemptedAt", "nextAttemptAt", "pid", "at", "seen_at",
  "rootIdentity", "archiveIdentity", "timestamp", "startedAt", "endedAt", "attributes", "mode", "expiryRequestedAt"]);
function normalize(value: unknown, roots: string[]): unknown {
  const ids = new Map<string, string>();
  const text = (input: string) => {
    let output = input.replaceAll("\\", "/");
    for (const [index, root] of roots.entries()) output = output.replaceAll(root.replaceAll("\\", "/"), `<ROOT${index}>`);
    output = output.replace(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/g, id => {
      if ([PLAN, REMOVAL, RECLAIM].includes(id)) return id;
      if (!ids.has(id)) ids.set(id, `<ID${ids.size}>`);
      return ids.get(id)!;
    });
    return output.replace(/\b[a-f\d]{64}\b/g, "<HEX64>").replace(/\b[a-f\d]{32}\b/g, "<HEX32>");
  };
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return text(input);
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [text(key), VOLATILE.has(key) ? `<${typeof item}>` : walk(item)]));
    }
    return input;
  };
  return walk(value);
}

async function check(name: string, value: unknown, roots: string[]): Promise<void> {
  const actual = JSON.stringify(normalize(value, roots), null, 2) + "\n", path = join(golden, `${name}.${platform}.json`);
  if (writing) { await mkdir(golden, { recursive: true }); await writeFile(path, actual); return; }
  expect(actual).toBe((await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
}
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
/** A plan digest is the SHA-256 of the JSON text without the digest, in the order the plan was written. */
function expectDigest(plan: { digest: string }) {
  const { digest, ...value } = plan;
  expect(createHash("sha256").update(JSON.stringify(value)).digest("hex")).toBe(digest);
}

async function group(root: string, results: string[]) {
  const { models, model } = fauxModels(), path = join(root, "group-a/durable.sqlite"), opened = await openGroupHarness(path, models);
  try {
    await memberConversation(opened.harness, "group-a", "alice", { model }, context);
    await opened.harness.commit(async tx => {
      for (const name of results) (await tx.doc(ResultsDoc)).calls[name] = { phone: "alice", createdAt: 1 };
    }, context);
  } finally { await opened.close(); }
  return path;
}

test("archive plan, progress, removal list and removal progress keep the baseline format", async () => {
  const f = await tempFixture("formats-archive-"), root = join(f.root, "groups"), temp = join(root, "group-a/users/alice/tmp");
  const db = new Database(join(f.root, "state.sqlite"));
  try {
    await mkdir(join(temp, "codemode/1-result"), { recursive: true });
    await writeFile(join(temp, "codemode/1-result/output"), "result");
    await writeFile(join(temp, "note.txt"), "note");
    await mkdir(join(temp, "folder/inner"), { recursive: true }); await writeFile(join(temp, "folder/inner/x"), "x");
    await group(root, ["1-result"]);
    const options = { root, state: join(f.root, "state.sqlite"), archive: join(root, ".reclamation/backup/rm"), scope: durableMemberScope };
    const plan = await previewTmpArchive(options, 0, undefined, undefined, "auto", PLAN);
    expectDigest(plan);
    const progress = await applyTmpArchive(options, plan.id, plan.digest);
    const plans = join(options.archive, ".tmp-plans");
    expect(await json(join(plans, PLAN + ".json"))).toEqual(plan);
    expect(await json(join(plans, PLAN + ".progress.json"))).toEqual(progress);
    await check("archive-plan", plan, [f.root]);
    await check("archive-progress", progress, [f.root]);
    const removal = await previewArchiveRemoval(options, REMOVAL);
    expectDigest(removal);
    const removed = await applyArchiveRemoval(options, removal.id, removal.digest);
    expect(await json(join(plans, REMOVAL + ".removal.json"))).toEqual(removal);
    expect(await json(join(plans, REMOVAL + ".removal-progress.json"))).toEqual(removed);
    await check("removal-plan", removal, [f.root]);
    await check("removal-progress", removed, [f.root]);
    if (process.platform === "win32") {
      const journals = join(plans, "removal");
      await check("removal-windows-journals", await Promise.all((await readdir(journals)).sort().map(name => json(join(journals, name)))), [f.root]);
    }
  } finally { db.close(); await f.cleanup(); }
});

test("physical reclamation plan, progress and journals keep the baseline format", async () => {
  const f = await tempFixture("formats-reclaim-"), root = join(f.root, "groups"), temp = join(root, "group-a/users/alice/tmp");
  const db = new Database(join(f.root, "state.sqlite"));
  try {
    await mkdir(join(temp, "codemode/1-result"), { recursive: true });
    await writeFile(join(temp, "codemode/1-result/output"), "result");
    await group(root, ["1-result"]);
    const options = { root, state: join(f.root, "state.sqlite"), directory: join(f.root, "plans"), scope: durableMemberScope };
    const plan = await previewReclamation(options, 0, undefined, undefined, "auto", RECLAIM);
    expectDigest(plan);
    const progress = await applyReclamation(options, plan.id, plan.digest);
    expect(await json(join(options.directory, RECLAIM + ".json"))).toEqual(plan);
    expect(await json(join(options.directory, RECLAIM + ".progress.json"))).toEqual(progress);
    await check("reclaim-plan", plan, [f.root]);
    await check("reclaim-progress", progress, [f.root]);
    if (process.platform === "win32") await check("reclaim-windows-journal", await json(join(options.directory, RECLAIM + "-0.json")), [f.root]);
  } finally { db.close(); await f.cleanup(); }
});

test("result ownership, the reclamation queue and its items keep the baseline document shapes", async () => {
  const f = await tempFixture("formats-results-");
  try {
    const { models, model } = fauxModels(), opened = await openGroupHarness(join(f.root, "group.sqlite"), models);
    try {
      await memberConversation(opened.harness, "group-a", "alice", { model }, context);
      await opened.harness.commit(async tx => {
        const calls = (await tx.doc(ResultsDoc)).calls;
        calls["1-a"] = { phone: "alice", createdAt: 1 }; calls["2-b"] = { phone: "alice", createdAt: 2, isolatedTask: PLAN };
        calls["3-c"] = { phone: "alice", createdAt: 3 };
      }, context);
      await opened.harness.commit(tx => handoffResults(tx, "alice", ["1-a", "2-b"], 10), context);
      await check("results-documents", {
        results: await opened.harness.snapshot(ResultsDoc, context),
        queue: await opened.harness.snapshot(ReclamationQueues, "alice", context),
        items: [await opened.harness.snapshot(ReclamationItems, "1-a", context), await opened.harness.snapshot(ReclamationItems, "2-b", context)],
      }, [f.root]);
    } finally { await opened.close(); }
  } finally { await f.cleanup(); }
});

test("a retirement checkpoint left by a failed group commit keeps the baseline format", async () => {
  const f = await tempFixture("formats-retirement-");
  const bill: UsageRecord = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
  const { faux, models, model } = fauxModels(), ledger = openStatsLedger(join(f.root, "stats"));
  const opened = await openGroupHarness(join(f.root, "group.sqlite"), models);
  try {
    const { conversation } = await memberConversation(opened.harness, "group-a", "member", { model }, context);
    faux.setResponses([fauxAssistantMessage("complete")]);
    await (await conversation.submit({ type: "input", content: "question", requestId: "retirement" }, context)).wait(context);
    const original = Object.values((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts)[0]!;
    const member = { groupId: "group-a", phone: "member", conversationId: conversation.id };
    await projectConversation(ledger, opened.harness, member, context);
    await opened.harness.commit(async tx => {
      // More than one retirement batch (256), so the checkpoint is left in its retiring state.
      const attempts = await tx.doc(AttemptsDoc, conversation.id), auxiliary = await tx.doc(AuxiliaryDoc, conversation.id);
      for (let i = 0; i < 600; i++) {
        attempts.starts["c:" + i] = { ...original, kind: "compaction", k: 100 + i, usage: bill };
        auxiliary.starts["a:" + i] = { taskId: original.taskId, callId: String(i), kind: "classifier", provider: "p", model: "m",
          startedAt: original.startedAt, endedAt: original.startedAt + 1, outcome: "stop", usage: bill };
      }
    }, context);
    const source = conversationSource("group-a", "member", conversation.id).id;
    const digest = () => (ledger.query("SELECT digest FROM sources WHERE id = ?").get(source) as { digest: string } | null)?.digest;
    let captured: string | undefined;
    const failing = new Proxy(opened.harness, { get(target, name) {
      if (name !== "commit") { const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value; }
      return (change: Parameters<Harness["commit"]>[0], ctx: typeof context) => target.commit(async tx => {
        const result = await change(tx);
        if (!captured && digest()?.includes('"retiring"')) { captured = digest(); throw new Error("synthetic group commit failure"); }
        return result;
      }, ctx);
    } });
    await expect(projectConversation(ledger, failing, member, context)).rejects.toThrow("synthetic");
    await check("retirement-checkpoint", JSON.parse(captured!), [f.root]);
    await check("retirement-meta", ledger.query("SELECT key FROM meta WHERE key LIKE 'durable_retired:%' ORDER BY key").all(), [f.root]);
  } finally { ledger.close(); await opened.close(); await f.cleanup(); }
});

const image = "sha256:" + "a".repeat(64);
const driver: TaskDriver = { async run(args) {
  if (args[0] === "info") return { exitCode: 0, output: JSON.stringify({ ID: "formats-fixture", SecurityOptions: ["name=rootless"] }) };
  if (args[0] === "image") return { exitCode: 0, output: JSON.stringify([{ Id: image, Os: "linux" }]) };
  throw new Error("This fixture cannot start Docker: " + args.join(" "));
} };

test.skipIf(process.platform !== "linux")("a signed task receipt keeps the baseline envelope and payload through archive", async () => {
  const f = await tempFixture("formats-receipt-"), root = join(f.root, "groups"), temp = join(root, "group-a/users/alice/tmp");
  const db = new Database(join(f.root, "state.sqlite"));
  try {
    await mkdir(temp, { recursive: true });
    const control = join(f.root, "control"), backend = new RootlessTasks(control, image, driver);
    const task = await backend.reserve(temp, "results", "1-result").create();
    await writeFile(join(task.path, "result"), "bytes"); await task.seal();
    const path = await group(root, []);
    const { models } = fauxModels(), opened = await openGroupHarness(path, models);
    try {
      await opened.harness.commit(async tx => { (await tx.doc(ResultsDoc)).calls["1-result"] = { phone: "alice", createdAt: 1, isolatedTask: task.id }; }, context);
    } finally { await opened.close(); }
    const envelope = async () => {
      const saved = await json(join(control, "receipts", task.id + ".json"));
      return { keys: Object.keys(saved), signature: saved.signature, payload: JSON.parse(saved.payload) };
    };
    await check("receipt-sealed", await envelope(), [f.root]);
    const options = { root, state: join(f.root, "state.sqlite"), archive: join(root, ".reclamation/backup/rm"), scope: durableMemberScope, backend };
    const plan = await previewTmpArchive(options, 0, undefined, undefined, "auto", PLAN);
    await applyTmpArchive(options, plan.id, plan.digest);
    await check("receipt-archived", await envelope(), [f.root]);
    await check("receipt-archive-plan", plan, [f.root]);
  } finally { db.close(); await f.cleanup(); }
});

test.skipIf(process.platform !== "linux")("a receipt written before the optional fields existed is still accepted, listed and kept by sweeps", async () => {
  const f = await tempFixture("formats-old-receipt-"), temp = join(f.root, "groups/group-a/users/alice/tmp");
  try {
    await mkdir(temp, { recursive: true });
    const control = join(f.root, "control"), backend = new RootlessTasks(control, image, driver);
    await backend.verify();
    const { manager, key } = await json(join(control, "manager.json")), id = "44444444-4444-4444-8444-444444444444";
    const template = await readFile(join(golden, "receipt-v2-minimal.payload.json"), "utf8");
    const payload = JSON.stringify(JSON.parse(template.replace("<ID>", id).replace("<NONCE>", "b".repeat(64)).replace("<MANAGER>", manager)
      .replace("<DAEMON>", "formats-fixture").replace("<IMAGE>", image).replace("<TEMP>", await realpath(temp))));
    const signature = createHmac("sha256", Buffer.from(key, "hex")).update(payload).digest("hex");
    await writeFile(join(control, "receipts", id + ".json"), JSON.stringify({ payload, signature }), { mode: 0o600 });
    const inventory = await backend.inventory(temp);
    expect(inventory.refused).toEqual([]);
    expect(inventory.items.map(item => [item.id, item.phase])).toEqual([[id, "removed"]]);
    // Old receipts do not record result ownership, so a sweep never discards their evidence.
    expect(await backend.sweep(temp, Date.now() + 1, new ReferenceText(() => "", "/"))).toEqual([]);
    // Already removed before this call: only bookkeeping, so a reclamation list does not count its bytes again.
    expect(await backend.reclaim(id, temp)).toEqual({ name: id, status: "removed", completedEarlier: true });
    expect(await json(join(control, "receipts", id + ".json"))).toEqual({ payload, signature });
  } finally { await f.cleanup(); }
});
