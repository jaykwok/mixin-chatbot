// The durable member view that offline maintenance runs under, and the archive's failure policy when the view's
// settlement fails. Synthetic group databases only.
import { test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { withGroupSnapshot } from "../../src/durable/diagnostics.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { durableMemberScope } from "../../src/durable/maintenance-view.ts";
import { ResultsDoc } from "../../src/durable/results/ownership.ts";
import { applyTmpArchive, previewTmpArchive } from "../../src/maintenance/archive.ts";
import type { MemberScope } from "../../src/maintenance/scope.ts";
import { fauxModels, gatedResponse, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { expectAsync as expect } from "../helpers/async-expect.ts";

async function fixture(durable: boolean) {
  const f = await tempFixture("maintenance-scope-"), root = join(f.root, "groups"), temp = join(root, "group-a/users/alice/tmp");
  await mkdir(temp, { recursive: true });
  const state = join(f.root, "state.sqlite"), db = new Database(state), deliveries = new DeliveryStore(db);
  const path = join(root, "group-a/durable.sqlite"), { models, model, faux } = fauxModels();
  const group = durable ? await openGroupHarness(path, models) : undefined;
  if (group) {
    await memberConversation(group.harness, "group-a", "alice", { model }, context);
    await group.harness.commit(async tx => { (await tx.doc(ResultsDoc)).calls["1-result"] = { phone: "alice", createdAt: 1 }; }, context);
  }
  const member = { group: "group-a", user: "alice", dir: temp, entries: [], bytes: 0, files: 0, newest: 0 };
  return { f, root, temp, path, deliveries, group, model, faux, member, options: { root, state, archive: join(root, ".reclamation/backup/rm"), scope: durableMemberScope },
    async close() { await group?.close(); db.close(); await f.cleanup(); } };
}

test("a read-only member view refuses settlement", async () => {
  const f = await fixture(true);
  try {
    await f.group!.close();
    await expect(durableMemberScope.withMember({ root: f.root, state: f.options.state }, f.member, { exclusive: false, requireGroup: true },
      view => view.settle(new Map([["1-result", { phone: "alice", createdAt: 1 }]])))).rejects.toThrow("只读预览不能结算回收账本");
    await withGroupSnapshot(f.path, async harness => expect((await harness.snapshot(ResultsDoc, context))!.calls["1-result"]).toBeDefined());
  } finally { await f.close(); }
});

test("without a group database the outbox ledger still protects a member's paths", async () => {
  const f = await fixture(false);
  try {
    await writeFile(join(f.temp, "pending.txt"), "awaiting delivery"); await writeFile(join(f.temp, "loose.txt"), "nothing refers to this");
    f.deliveries.put(JSON.stringify(["group-a", "alice"]), "pending", join(f.temp, "pending.txt"));
    const plan = await previewTmpArchive(f.options, 0), status = (name: string) => plan.items.find(item => item.source === join(f.temp, name))?.status;
    expect([status("pending.txt"), status("loose.txt")]).toEqual(["kept", "ready"]);
  } finally { await f.close(); }
});

test("recoverable group work protects every path of the member", async () => {
  const f = await fixture(true), gated = gatedResponse("done");
  try {
    await writeFile(join(f.temp, "loose.txt"), "nothing refers to this");
    const { conversation } = await memberConversation(f.group!.harness, "group-a", "alice", { model: f.model }, context);
    f.faux.setResponses([gated.step]);
    const submission = await conversation.submit({ type: "input", content: "work" }, context);
    await gated.started;
    const busy = await previewTmpArchive(f.options, 0);
    expect(busy.items.find(item => item.source === join(f.temp, "loose.txt"))?.status).toBe("kept");
    gated.open(); await submission.wait(context);
    const idle = await previewTmpArchive(f.options, 0);
    expect(idle.items.find(item => item.source === join(f.temp, "loose.txt"))?.status).toBe("ready");
  } finally { gated.open(); await f.close(); }
});

test("a failed archive settlement stops the batch and keeps moved entries archived; a replay settles them", async () => {
  const f = await fixture(true);
  try {
    await f.group!.close();
    await mkdir(join(f.temp, "codemode/1-result"), { recursive: true }); await writeFile(join(f.temp, "codemode/1-result/output"), "owned");
    await writeFile(join(f.temp, "changed.txt"), "before");
    // A later member (no group database) that the stopped batch must not reach.
    const later = join(f.root, "group-b/users/bob/tmp"); await mkdir(later, { recursive: true }); await writeFile(join(later, "later.txt"), "later");
    const plan = await previewTmpArchive(f.options, 0), index = (name: string) => plan.items.findIndex(item => item.source === join(f.temp, name));
    const laterIndex = plan.items.findIndex(item => item.source === join(later, "later.txt"));
    expect(laterIndex).toBeGreaterThan(index("changed.txt"));
    expect(plan.items.every(item => item.status === "ready")).toBe(true);
    await writeFile(join(f.temp, "changed.txt"), "after preview");
    const failing: MemberScope = { withMember: (paths, user, mode, run) => durableMemberScope.withMember(paths, user, mode,
      view => run({ ...view, protectedPath: path => view.protectedPath(path), settle: async () => { throw new Error("synthetic settlement failure"); } })) };
    await expect(applyTmpArchive({ ...f.options, scope: failing }, plan.id, plan.digest)).rejects.toThrow("归档账本结算未完成");
    const saved = JSON.parse(await readFile(join(f.options.archive, ".tmp-plans", plan.id + ".progress.json"), "utf8"));
    expect([saved.outcomes[index("codemode")].status, saved.outcomes[index("changed.txt")].status]).toEqual(["archived", "failed"]);
    expect(saved.outcomes[index("changed.txt")].reason).toContain("synthetic settlement failure");
    expect(saved.outcomes[laterIndex]).toBeUndefined();
    expect(await readFile(join(later, "later.txt"), "utf8")).toBe("later");
    await withGroupSnapshot(f.path, async harness => expect((await harness.snapshot(ResultsDoc, context))!.calls["1-result"]).toBeDefined());
    const replay = await applyTmpArchive(f.options, plan.id, plan.digest);
    expect([replay.outcomes[index("codemode")]!.status, replay.outcomes[laterIndex]!.status]).toEqual(["archived", "archived"]);
    await withGroupSnapshot(f.path, async harness => expect((await harness.snapshot(ResultsDoc, context))!.calls).toEqual({}));
  } finally { await f.close(); }
});
