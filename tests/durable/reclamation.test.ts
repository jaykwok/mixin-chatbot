import { test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, type Harness } from "@earendil-works/pi-durable";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { handoffResults, reclamationBatch, ReclamationItems, ReclamationQueues, settleReclamation } from "../../src/durable/results/queue.ts";
import { RESULT_CAPACITY, resultRegistration, ResultsDoc } from "../../src/durable/results/ownership.ts";
import { ResultMaintenance } from "../../src/durable/results/maintenance.ts";
import { resultReferences } from "../../src/durable/results/references.ts";
import { stubResultsBackend } from "../helpers/results-backend.ts";
import { tempFixture } from "../helpers/temp.ts";

test("ownership handoff crosses the 4096 active limit, survives restart and rolls back atomically", async () => {
  const f = await tempFixture("reclamation-handoff-"), path = join(f.root, "group.sqlite");
  let session = createSession(await openGroupStorage(path));
  try {
    const names = Array.from({ length: 4096 }, (_, i) => `${i + 1}-call`);
    await session.commit(async tx => {
      const records = (await tx.doc(ResultsDoc)).calls;
      for (const name of names) records[name] = { phone: "member", createdAt: 1, reclamation: { status: "deferred", reason: "synthetic shared directory", attemptedAt: 2, nextAttemptAt: 3 } };
    }, context);
    await expect(session.commit(async tx => { await handoffResults(tx, "member", names.slice(0, 3), 4); throw Error("crash before commit"); }, context)).rejects.toThrow("crash before commit");
    expect(Object.keys((await session.snapshot(ResultsDoc, context))!.calls)).toHaveLength(4096);
    expect(await session.snapshot(ReclamationQueues, "member", context)).toBeUndefined();
    expect(await session.snapshot(ReclamationItems, names[0]!, context)).toBeUndefined();
    for (let i = 0; i < names.length; i += 128) await session.commit(tx => handoffResults(tx, "member", names.slice(i, i + 128), 4), context);
    await session.close(context); session = createSession(await openGroupStorage(path));
    expect((await session.snapshot(ReclamationQueues, "member", context))!.count).toBe(4096);
    expect(Object.keys((await session.snapshot(ResultsDoc, context))!.calls)).toHaveLength(0);
    const batch = await reclamationBatch(session, "member", context);
    expect(batch).toHaveLength(64); expect(batch[0]!.call.expiredAt).toBeUndefined();
    expect(batch[0]!.call.reclamation!.reason).toBe("synthetic shared directory");
    await session.commit(async tx => { (await tx.doc(ResultsDoc)).calls["4097-call"] = { phone: "member", createdAt: 5 }; }, context);
    expect((await session.snapshot(ResultsDoc, context))!.calls["4097-call"]).toBeDefined();
    // A retry after the handoff commit finds no active source, so it must not enqueue duplicates.
    await session.commit(tx => handoffResults(tx, "member", names.slice(0, 10), 6), context);
    expect((await session.snapshot(ReclamationQueues, "member", context))!.count).toBe(4096);
  } finally { await session.close(context); await f.cleanup(); }
}, 60_000);

test("deferred entries rotate, confirmed removals retire ownership, and a stale outcome cannot pop another item", async () => {
  const f = await tempFixture("reclamation-rotation-"), session = createSession(await openGroupStorage(join(f.root, "group.sqlite")));
  try {
    await session.commit(async tx => {
      const records = (await tx.doc(ResultsDoc)).calls;
      for (const name of ["1-a", "2-b", "3-c"]) records[name] = { phone: "member", createdAt: 1 };
      records["4-other"] = { phone: "other", createdAt: 1 };
      await handoffResults(tx, "member", ["1-a", "2-b", "3-c", "4-other"], 2);
    }, context);
    const first = (await reclamationBatch(session, "member", context))[0]!;
    await session.commit(tx => settleReclamation(tx, "member", first, false), context);
    expect((await reclamationBatch(session, "member", context)).map(item => item.name)).toEqual(["2-b", "3-c", "1-a"]);
    await expect(session.commit(tx => settleReclamation(tx, "member", first, true), context)).rejects.toThrow("头部已变化");
    for (const item of await reclamationBatch(session, "member", context)) await session.commit(tx => settleReclamation(tx, "member", item, true), context);
    expect(await session.snapshot(ReclamationQueues, "member", context)).toEqual({ count: 0, removed: 3 });
    expect(await session.snapshot(ReclamationItems, "1-a", context)).toBeUndefined();
    expect((await session.snapshot(ResultsDoc, context))!.calls["4-other"]).toBeDefined();
  } finally { await session.close(context); await f.cleanup(); }
});

test("a full ownership table refuses new results until a maintenance pass frees it, keeping referenced results", async () => {
  const f = await tempFixture("reclamation-capacity-"), session = createSession(await openGroupStorage(join(f.root, "group.sqlite")));
  const tempDir = join(f.root, "temp"), now = Date.now(), warnings: string[] = [];
  const live = Array.from({ length: 256 }, (_, i) => `${10_000 + i}-live`);
  try {
    // Receipts beyond the kept 256 (an older store) plus live records fill the table exactly.
    await session.commit(async tx => {
      const records = (await tx.doc(ResultsDoc)).calls;
      for (let i = 0; i < RESULT_CAPACITY - live.length; i++) records[`${i + 1}-old`] = { phone: "member", createdAt: 1, expiredAt: i + 2 };
      for (const name of live) records[name] = { phone: "member", createdAt: now };
    }, context);
    for (const name of live.slice(0, 4)) await mkdir(join(tempDir, "codemode", name, "nested"), { recursive: true });
    await Bun.sleep(20);
    await expect(resultRegistration(session, context, "member", "20000-new")()).rejects.toThrow("结果归属记录已达上限");
    await resultRegistration(session, context, "member", live[0]!)(); // A repeated registration keeps its record.
    const references = resultReferences([{ text: `see ${join(tempDir, "codemode", live[0]!, "nested")}` }]);
    await new ResultMaintenance({ context, signal: new AbortController().signal, warn: line => warnings.push(line) })
      .member(session as unknown as Harness, "member", tempDir, now - 86_400_000, references);
    const calls = (await session.snapshot(ResultsDoc, context))!.calls;
    const queued = (await session.snapshot(ReclamationQueues, "member", context))?.count ?? 0;
    expect(existsSync(join(tempDir, "codemode", live[0]!))).toBe(true);
    expect(calls[live[0]!]).toEqual({ phone: "member", createdAt: now });
    if (process.platform === "linux") {
      // Shared directories without proof of exclusive writers (and missing names) are no removal proof: every
      // unreferenced record moves to the queue, which frees the quota without retiring anything.
      for (const name of live.slice(1, 4)) expect(existsSync(join(tempDir, "codemode", name))).toBe(true);
      expect(queued).toBe(live.length - 1);
      expect(Object.keys(calls)).toHaveLength(RESULT_CAPACITY - live.length + 1);
    } else {
      // Present directories are removed and retired (receipts trimmed to the latest 256); missing ones stay registered.
      for (const name of live.slice(1, 4)) expect(existsSync(join(tempDir, "codemode", name))).toBe(false);
      for (const name of live.slice(1, 4)) expect(calls[name]!.expiredAt).toBeDefined();
      expect(Object.values(calls).filter(call => call.expiredAt !== undefined)).toHaveLength(256);
      expect(queued).toBe(0);
      expect(Object.keys(calls)).toHaveLength(256 + live.length - 3);
    }
    await resultRegistration(session, context, "member", "20000-new")();
    expect((await session.snapshot(ResultsDoc, context))!.calls["20000-new"]).toMatchObject({ phone: "member" });
    expect(warnings).toEqual([]);
  } finally { await session.close(context); await f.cleanup(); }
}, 60_000);

test.skipIf(process.platform !== "linux")("live records in a retry delay and queued items keep their isolated tasks; queued references stay protected", async () => {
  const f = await tempFixture("reclamation-isolated-"), session = createSession(await openGroupStorage(join(f.root, "group.sqlite")));
  const tempDir = join(f.root, "temp"), runtime = stubResultsBackend(join(f.root, "control")), warnings: string[] = [];
  try {
    await mkdir(tempDir);
    const tasks: Record<string, string> = {};
    for (const name of ["1-delayed", "2-queued", "3-referenced"]) {
      const task = await runtime.backend.reserve(tempDir, "results", name).create();
      await task.seal(); tasks[name] = task.id;
    }
    const now = Date.now(), delay = { status: "deferred" as const, reason: "synthetic", attemptedAt: now, nextAttemptAt: now + 60_000 };
    await session.commit(async tx => {
      const records = (await tx.doc(ResultsDoc)).calls;
      records["1-delayed"] = { phone: "member", createdAt: 1, isolatedTask: tasks["1-delayed"]!, reclamation: delay };
      records["2-queued"] = { phone: "member", createdAt: 1, isolatedTask: tasks["2-queued"]!, reclamation: delay };
      records["3-referenced"] = { phone: "member", createdAt: 1, isolatedTask: tasks["3-referenced"]! };
      await handoffResults(tx, "member", ["2-queued", "3-referenced"], now);
    }, context);
    const references = resultReferences([`see ${join(tempDir, ".isolated-work", tasks["3-referenced"]!, "work", "out.txt")}`]);
    // Every receipt is past the deadline: only the ownership proofs keep the tasks.
    await new ResultMaintenance({ context, signal: new AbortController().signal, warn: line => warnings.push(line) })
      .member(session as unknown as Harness, "member", tempDir, Date.now() + 60_000, references);
    for (const name of Object.keys(tasks)) expect((await runtime.backend.describe(tasks[name]!, tempDir)).phase).not.toBe("removed");
    expect((await session.snapshot(ReclamationQueues, "member", context))!.count).toBe(2);
    expect((await session.snapshot(ResultsDoc, context))!.calls["1-delayed"]!.reclamation).toEqual(delay);
    expect(warnings).toEqual([]);
  } finally { runtime.restore(); await session.close(context); await f.cleanup(); }
}, 20_000);
