import { test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Harness } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { AttemptsDoc, type AttemptStart, type UsageRecord } from "../../src/durable/attempts.ts";
import { AuxiliaryDoc, type AuxiliaryRequest } from "../../src/durable/auxiliary-records.ts";
import { GroupDoc, memberConversation } from "../../src/durable/identity.ts";
import { conversationSource, projectConversation } from "../../src/durable/projection.ts";
import { recoverProjectionRetirement, retireProjectedRequests, selectRetirement, type ProjectionSnapshot } from "../../src/durable/projection/retirement.ts";
import { fingerprint, pendingUsage } from "../../src/durable/projection/usage.ts";
import { fauxModels, gatedResponse, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const bill: UsageRecord = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };

for (const crash of ["before-group-commit", "after-group-commit", "none"]) test(`projected receipts survive ${crash} and retire in bounded batches`, async () => {
  const fixture = await tempFixture("projection-retirement-");
  const { faux, models, model } = fauxModels();
  const path = join(fixture.root, "group.sqlite"), ledger = openStatsLedger(join(fixture.root, "stats"));
  let opened = await openGroupHarness(path, models);
  try {
    const { conversation } = await memberConversation(opened.harness, "group-a", "member", { model }, context);
    faux.setResponses([fauxAssistantMessage("complete")]);
    await (await conversation.submit({ type: "input", content: "question", requestId: "retirement" }, context)).wait(context);
    const original = Object.values((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts)[0]!;
    const member = { groupId: "group-a", phone: "member", conversationId: conversation.id };
    await projectConversation(ledger, opened.harness, member, context);
    await opened.harness.commit(async tx => {
      const attempts = await tx.doc(AttemptsDoc, conversation.id), auxiliary = await tx.doc(AuxiliaryDoc, conversation.id);
      for (let i = 0; i < 600; i++) {
        attempts.starts["c:" + i] = { ...original, kind: "compaction", k: 100 + i, usage: bill };
        auxiliary.starts["a:" + i] = { taskId: original.taskId, callId: String(i), kind: "classifier", provider: "p", model: "m",
          startedAt: original.startedAt, endedAt: original.startedAt + 1, outcome: "stop", usage: bill };
      }
    }, context);
    const generation = (await opened.harness.snapshot(GroupDoc, context))!.generation;
    let injected = false;
    const interrupted = new Proxy(opened.harness, { get(target, name) {
      if (name !== "commit") { const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value; }
      return async (change: Parameters<Harness["commit"]>[0], ctx: typeof context) => {
        const pending = () => (ledger.query("SELECT digest FROM sources WHERE id = ?").get(conversationSource("group-a", "member", conversation.id, generation).id) as { digest: string } | null)?.digest.includes('"retiring"');
        const value = await target.commit(async tx => {
          const result = await change(tx);
          if (!injected && crash === "before-group-commit" && pending()) { injected = true; throw new Error("synthetic group commit failure"); }
          return result;
        }, ctx);
        if (!injected && crash === "after-group-commit" && pending()) { injected = true; throw new Error("synthetic acknowledgement crash"); }
        return value;
      };
    } });
    if (crash === "none") await projectConversation(ledger, interrupted, member, context);
    else await expect(projectConversation(ledger, interrupted, member, context)).rejects.toThrow("synthetic");
    const count = async () => Object.keys((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts).length
      + Object.keys((await opened.harness.snapshot(AuxiliaryDoc, conversation.id, context))!.starts).length;
    expect(await count()).toBe(crash === "before-group-commit" ? 1200 : 944);
    const totals = () => {
      const rows = new Map<string, { kind: string; requests: number; input: number; missingUsage: number; cost: number }>();
      for (const row of readLedger(ledger).usage) {
        const sum = rows.get(row.kind) ?? { kind: row.kind, requests: 0, input: 0, missingUsage: 0, cost: 0 };
        sum.requests += row.requests; sum.input += row.input; sum.missingUsage += row.missingUsage; sum.cost += Math.round(row.cost * 1e6);
        rows.set(row.kind, sum);
      }
      return [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind));
    };
    const accounted = totals();
    expect(accounted.find(row => row.kind === "compaction")?.requests).toBe(600);
    expect(accounted.find(row => row.kind === "auxiliary")?.requests).toBe(600);
    await opened.close(); opened = await openGroupHarness(path, models);
    for (let i = 0; i < 7; i++) await projectConversation(ledger, opened.harness, member, context);
    expect(await count()).toBe(0); expect(totals()).toEqual(accounted);
    // Settled usage is current accounting: the report must not count it as an unverifiable pre-upgrade source.
    expect([...readLedger(ledger).legacy]).toEqual([]);
    const checkpoint = JSON.parse((ledger.query("SELECT digest FROM sources WHERE id = ?").get(conversationSource("group-a", "member", conversation.id, (await opened.harness.snapshot(GroupDoc, context))!.generation).id) as { digest: string }).digest);
    expect(checkpoint).toEqual({ version: 1, links: {}, orphans: {} });
    await Promise.all([projectConversation(ledger, opened.harness, member, context), projectConversation(ledger, opened.harness, member, context)]);
    expect(totals()).toEqual(accounted);
    // New starts preserve already retired usage across another incremental projection.
    await opened.harness.commit(async tx => {
      (await tx.doc(AttemptsDoc, conversation.id)).starts["next"] = { ...original, kind: "compaction", k: 900, usage: bill };
    }, context);
    await projectConversation(ledger, opened.harness, member, context);
    expect(totals().find(row => row.kind === "compaction")?.requests).toBe(601);
    expect(totals().find(row => row.kind === "auxiliary")?.requests).toBe(600);
  } finally { await opened.close(); ledger.close(); await fixture.cleanup(); }
}, 20000);

for (const finishAfterSnapshot of [false, true]) test(`in-flight starts are retained until projected from a terminal snapshot; finishAfterSnapshot=${finishAfterSnapshot}`, async () => {
  const fixture = await tempFixture("projection-active-"); const { faux, models, model } = fauxModels();
  const opened = await openGroupHarness(join(fixture.root, "group.sqlite"), models), ledger = openStatsLedger(join(fixture.root, "stats"));
  const gate = gatedResponse("complete");
  try {
    const { conversation } = await memberConversation(opened.harness, "group-a", "member", { model }, context);
    const member = { groupId: "group-a", phone: "member", conversationId: conversation.id };
    faux.setResponses([gate.step]); const pending = await conversation.submit({ type: "input", content: "question", requestId: "active-retirement" }, context); await gate.started;
    let finished = false;
    const observed = new Proxy(opened.harness, { get(target, name) {
      if (name !== "commit") { const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value; }
      return async (change: Parameters<Harness["commit"]>[0], ctx: typeof context) => {
        const value = await target.commit(change, ctx);
        if (finishAfterSnapshot && !finished && value && typeof value === "object" && "terminal" in value) {
          finished = true; gate.open(); await pending.wait(context);
        }
        return value;
      };
    } });
    await projectConversation(ledger, observed, member, context);
    expect(Object.keys((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts)).toHaveLength(1);
    gate.open(); await pending.wait(context); await projectConversation(ledger, opened.harness, member, context);
    expect(Object.keys((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts)).toHaveLength(0);
    expect(readLedger(ledger).usage.map(row => [row.kind, row.requests])).toEqual([["assistant", 1]]);
  } finally { gate.open(); await opened.close(); ledger.close(); await fixture.cleanup(); }
});

test("batch selection: terminal and unchanged starts only, attempts before auxiliary, at most 256, orphans only on an unchanged attempt set", () => {
  const start = (taskId: number, k: number): AttemptStart => ({ taskId, attempt: 1, k, afterEntry: 0, startedAt: 1_700_000_000_000, provider: "p", model: "m", kind: "compaction", usage: bill });
  const aux = (taskId: number, callId: string, withdrawn = false): AuxiliaryRequest => ({ taskId, callId, kind: "classifier", provider: "p", model: "m", startedAt: 1_700_000_000_000, outcome: "stop", ...(withdrawn ? { withdrawn } : {}) });
  const attempts: Record<string, AttemptStart> = { done: start(1, 1), active: start(2, 2), changed: start(1, 3) };
  const auxiliary: Record<string, AuxiliaryRequest> = { kept: aux(1, "a"), withdrawn: aux(1, "b", true) };
  const orphan = { type: "usage" as const, kind: "interrupted", timestamp: "2023-11-14T22:13:20.000Z", provider: "p", model: "m" };
  const snapshot: ProjectionSnapshot = { attempts, auxiliary, terminal: new Set([1]), checkpoint: { version: 1, links: {}, orphans: { "7": orphan } } };
  const current = { attempts: { ...attempts, changed: { ...attempts.changed!, outcome: "error" as const } }, auxiliary };
  const batch = selectRetirement(snapshot, current, 0)!;
  expect(Object.keys(batch.retired.attempts)).toEqual(["done"]);
  expect(batch.retired.attempts.done).toBe(fingerprint(attempts.done));
  expect(Object.keys(batch.retired.auxiliary)).toEqual(["kept", "withdrawn"]);
  expect(Object.keys(selectRetirement(snapshot, { attempts, auxiliary: { ...auxiliary, kept: { ...auxiliary.kept!, outcome: "error" } } }, 0)!.retired.auxiliary)).toEqual(["withdrawn"]);
  // Orphans stay pending (interrupted, unknown usage) until a batch retires them.
  expect(pendingUsage({}, {}, snapshot.checkpoint, 0).find(group => group.kind === "interrupted")!.records).toEqual([orphan]);
  // The attempt set changed since the snapshot: a new or changed start may still claim the orphan.
  expect(batch.retired.orphans).toEqual([]);
  // Withdrawn requests retire without a bill.
  expect(batch.frozen.map(item => item.kind)).toEqual(["compaction", "auxiliary"]);
  expect(selectRetirement(snapshot, { attempts, auxiliary }, 0)!.retired.orphans).toEqual(["7"]);
  expect(selectRetirement({ ...snapshot, terminal: new Set(), checkpoint: { version: 1, links: {}, orphans: {} } }, { attempts, auxiliary }, 0)).toBeUndefined();
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`c:${i}`, start(1, 100 + i)]));
  const full = selectRetirement({ ...snapshot, attempts: many }, { attempts: many, auxiliary }, 0)!;
  expect(Object.keys(full.retired.attempts)).toHaveLength(256);
  expect(Object.keys(full.retired.auxiliary)).toEqual([]);
  expect(full.retired.orphans).toEqual([]);
});

test("a stale checkpoint retires nothing; a start changed after staging stops recovery; confirmation never overwrites a newer checkpoint", async () => {
  const fixture = await tempFixture("projection-stale-"); const { faux, models, model } = fauxModels();
  const opened = await openGroupHarness(join(fixture.root, "group.sqlite"), models), ledger = openStatsLedger(join(fixture.root, "stats"));
  try {
    const { conversation } = await memberConversation(opened.harness, "group-a", "member", { model }, context);
    faux.setResponses([fauxAssistantMessage("complete")]);
    await (await conversation.submit({ type: "input", content: "question", requestId: "stale" }, context)).wait(context);
    const original = Object.values((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts)[0]!;
    const member = { groupId: "group-a", phone: "member", conversationId: conversation.id }, source = conversationSource("group-a", "member", conversation.id, (await opened.harness.snapshot(GroupDoc, context))!.generation);
    await projectConversation(ledger, opened.harness, member, context); // Retires the reply's own start.
    await opened.harness.commit(async tx => {
      const attempts = await tx.doc(AttemptsDoc, conversation.id);
      for (let i = 0; i < 3; i++) attempts.starts["c:" + i] = { ...original, kind: "compaction", k: 100 + i, usage: bill };
    }, context);
    const digest = () => (ledger.query("SELECT digest FROM sources WHERE id = ?").get(source.id) as { digest: string }).digest;
    const before = digest(), starts = (await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts;
    const cursor = (ledger.query("SELECT offset FROM sources WHERE id = ?").get(source.id) as { offset: number }).offset;
    const terminal = new Set([original.taskId]);
    // The ledger moved on since this snapshot (another projection): its checkpoint is not the one counted.
    await retireProjectedRequests(ledger, opened.harness, source, conversation.id,
      { attempts: starts, auxiliary: {}, terminal, checkpoint: { version: 1, links: { stale: { through: 0 } }, orphans: {} } }, cursor, 0, context);
    expect(Object.keys((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts)).toHaveLength(3);
    expect(digest()).toBe(before);
    // Stage a batch but fail the group commit, then change one counted start: recovery must stop, not prune it.
    const failing = new Proxy(opened.harness, { get(target, name) {
      if (name !== "commit") { const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value; }
      return (change: Parameters<Harness["commit"]>[0], ctx: typeof context) => target.commit(async tx => { await change(tx); throw new Error("synthetic group commit failure"); }, ctx);
    } });
    await expect(retireProjectedRequests(ledger, failing, source, conversation.id, { attempts: starts, auxiliary: {}, terminal, checkpoint: JSON.parse(before) }, cursor, 0, context)).rejects.toThrow("synthetic");
    expect(JSON.parse(digest()).retiring).toBeDefined();
    await opened.harness.commit(async tx => { (await tx.doc(AttemptsDoc, conversation.id)).starts["c:1"]!.k = 999; }, context);
    await expect(recoverProjectionRetirement(ledger, opened.harness, source, conversation.id, context)).rejects.toThrow("已入账请求在裁剪恢复前发生变化");
    expect(Object.keys((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts)).toHaveLength(3);
    expect(JSON.parse(digest()).retiring).toBeDefined();
    // Restored to the counted value, the batch recovers: pruned and confirmed.
    await opened.harness.commit(async tx => { (await tx.doc(AttemptsDoc, conversation.id)).starts["c:1"]!.k = 101; }, context);
    await recoverProjectionRetirement(ledger, opened.harness, source, conversation.id, context);
    expect((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts).toEqual({});
    expect(JSON.parse(digest()).retiring).toBeUndefined();
    // A checkpoint written by someone else between the group commit and confirmation is not overwritten.
    await opened.harness.commit(async tx => { (await tx.doc(AttemptsDoc, conversation.id)).starts["c:9"] = { ...original, kind: "compaction", k: 109, usage: bill }; }, context);
    const concurrent = JSON.stringify({ version: 1, links: { concurrent: { through: 0 } }, orphans: {} });
    const racing = new Proxy(opened.harness, { get(target, name) {
      if (name !== "commit") { const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value; }
      return async (change: Parameters<Harness["commit"]>[0], ctx: typeof context) => {
        const value = await target.commit(change, ctx);
        if (value && typeof value === "object" && "digest" in value) ledger.query("UPDATE sources SET digest = ? WHERE id = ?").run(concurrent, source.id);
        return value;
      };
    } });
    await retireProjectedRequests(ledger, racing, source, conversation.id, { attempts: (await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts,
      auxiliary: {}, terminal, checkpoint: JSON.parse(digest()) }, cursor, 0, context);
    expect((await opened.harness.snapshot(AttemptsDoc, conversation.id, context))!.starts).toEqual({});
    expect(digest()).toBe(concurrent);
  } finally { await opened.close(); ledger.close(); await fixture.cleanup(); }
});
