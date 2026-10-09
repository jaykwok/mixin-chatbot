// Projection crash windows: real ledger transactions, controlled immutable entry/start snapshots; no model/network.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord, Harness } from "@earendil-works/pi-durable";
import { dayKey, ingestConversationRecords, openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { type AttemptStart, AttemptsDoc, NOT_SENT, type UsageRecord } from "../../src/durable/attempts.ts";
import { AuxiliaryDoc } from "../../src/durable/auxiliary-records.ts";
import { conversationSource, LegacyImportDoc, projectConversation } from "../../src/durable/projection.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("interrupted-usage-");
afterAll(() => fixture.cleanup());
const member = { groupId: "group", phone: "13800000001", conversationId: 1 };
const before = new Date(2026, 9, 6, 23, 59, 50).getTime(), after = before + 30_000;
const bill: UsageRecord = { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
const start = (changes: Partial<AttemptStart> = {}): AttemptStart => ({ taskId: 99, attempt: 1, k: 1, afterEntry: 1,
  startedAt: before, provider: "faux", model: "m", ...changes });
const user = (id = 1): EntryRecord => ({ id: id as never, conversationId: 1 as never, kind: "pi.user",
  model: [{ role: "user", content: "synthetic", timestamp: before }] });
const assistant = (id: number, reason: "stop" | "aborted" | "error", byTaskId?: number, errorMessage?: string): EntryRecord => ({
  id: id as never, conversationId: 1 as never, kind: "pi.assistant", ...(byTaskId === undefined ? {} : { byTaskId: byTaskId as never }),
  model: [{ ...fauxAssistantMessage("partial or final", { stopReason: reason, ...(errorMessage ? { errorMessage } : {}) }), timestamp: after,
    provider: "faux", model: "m", usage: { ...bill, input: 9000, output: 8000, totalTokens: 17002, cost: { ...bill.cost, total: 99 } } }],
});

test("an incomplete durable child list reports its known children and incompleteness without multiplying usage", async () => {
  const w = world({}, [{ id: 1 as never, conversationId: 1 as never, kind: "pi.tool-result", model: [{ role: "toolResult",
    toolCallId: "code", toolName: "codemode", content: [], isError: true, timestamp: before,
    details: { calls: [{ name: "read" }, { name: "write" }], complete: false }, usage: bill } as never] }]);
  try {
    await w.project(); await w.project();
    const rows = readLedger(w.ledger);
    expect(rows.tools.map(({ kind, tool, count }) => ({ kind, tool, count }))).toEqual([
      { kind: "nested", tool: "read", count: 1 },
      { kind: "nested", tool: "write", count: 1 }, { kind: "nested_incomplete", tool: "codemode", count: 1 }]);
    expect(rows.usage.map(({ kind, requests, cost }) => ({ kind, requests, cost }))).toEqual([{ kind: "tool", requests: 1, cost: 0.03 }]);
  } finally { w.ledger.close(); }
});
let counter = 0;
function world(starts: Record<string, AttemptStart>, entries: EntryRecord[], floor = 0) {
  const reads: number[] = [], ledger = openStatsLedger(join(fixture.root, `root-${++counter}`));
  const harness = {
    async snapshot(doc: unknown) {
      if (doc === AttemptsDoc) return { starts };
      if (doc === LegacyImportDoc) return { through: floor };
      if (doc === AuxiliaryDoc) return undefined;
      throw new Error("unexpected document");
    },
    async conversation() { return { async entries(filter: { minEntryId: number }) {
      reads.push(filter.minEntryId); return { items: entries.filter((entry) => entry.id >= filter.minEntryId) };
    } }; },
  } as unknown as Harness;
  return { ledger, reads, project: () => projectConversation(ledger, harness, member, context) };
}

test("a killed partial counts as interrupted with unknown usage; the recovery counts once on its own start day", async () => {
  const starts = { first: start(), recovered: start({ k: 2, afterEntry: 2, startedAt: after, outcome: "done", usage: bill }) };
  const w = world(starts, [user(), assistant(2, "aborted"), assistant(3, "stop", 99)]);
  try {
    await w.project(); await w.project();
    const rows = readLedger(w.ledger);
    expect(rows.activity.map(({ day, asks, replies }) => ({ day, asks, replies }))).toEqual([
      { day: dayKey(before), asks: 1, replies: 0 }, { day: dayKey(after), asks: 0, replies: 1 },
    ]);
    expect(rows.usage.map(({ kind, requests, missingUsage, unknownCost, input, cost }) => ({ kind, requests, missingUsage, unknownCost, input, cost })))
      .toEqual([{ kind: "interrupted", requests: 1, missingUsage: 1, unknownCost: 1, input: 0, cost: 0 },
        { kind: "assistant", requests: 1, missingUsage: 0, unknownCost: 0, input: 10, cost: 0.03 }]);
    expect(w.reads).toEqual([1, 4]);
  } finally { w.ledger.close(); }
});

test("a start before the first partial remains an upper-bound request; same-attempt recovery links only the newest invocation", async () => {
  const starts: Record<string, AttemptStart> = { first: start() }, entries = [user()];
  const w = world(starts, entries);
  try {
    await w.project();
    expect(readLedger(w.ledger).usage.map(({ kind, requests, missingUsage }) => ({ kind, requests, missingUsage })))
      .toEqual([{ kind: "generation_unconfirmed", requests: 1, missingUsage: 1 }]);
    starts.recovered = start({ k: 2, outcome: "done", usage: bill }); entries.push(assistant(2, "stop", 99));
    await w.project(); await w.project();
    expect(readLedger(w.ledger).usage.map(({ kind, requests }) => ({ kind, requests })))
      .toEqual([{ kind: "assistant", requests: 1 }, { kind: "generation_unconfirmed", requests: 1 }]);
    expect(w.reads).toEqual([1, 2, 3]);
  } finally { w.ledger.close(); }
});

for (const reverse of [false, true]) test(`batch pairing respects equal starts, interval boundaries, task identity and existing links; reverse=${reverse}`, async () => {
  const pairs: [string, AttemptStart][] = [
    ["older", start({ taskId: 10 })], ["recovery", start({ taskId: 10, k: 2, usage: bill, outcome: "done" })],
    ["next", start({ taskId: 20, afterEntry: 10 })], ["interrupted", start({ taskId: 30, afterEntry: 20 })],
    ["last", start({ taskId: 40, afterEntry: 22, usage: bill, outcome: "done" })],
  ];
  const w = world(Object.fromEntries(reverse ? pairs.reverse() : pairs), [user(), assistant(10, "stop", 10),
    assistant(19, "error", 20, NOT_SENT), assistant(20, "stop", 999), assistant(21, "aborted", 30),
    assistant(22, "stop", 30), assistant(30, "stop", 40)]);
  try {
    await w.project();
    const row = w.ledger.query("SELECT digest FROM sources").get() as { digest: string };
    const { links } = JSON.parse(row.digest);
    expect(links.older.entryId).toBeUndefined();
    expect(links.recovery.entryId).toBe(10);
    expect(links.next.entryId).toBeUndefined();
    expect(links.interrupted).toMatchObject({ entryId: 21, interrupted: true });
    expect(links.last.entryId).toBe(30);
    expect(await w.project()).toBe(0);
    expect((w.ledger.query("SELECT digest FROM sources").get() as { digest: string }).digest).toBe(row.digest);
  } finally { w.ledger.close(); }
});

test("confirmed usage before classification survives an aborted recovery entry and never uses its partial estimate", async () => {
  const entries = [user()], w = world({ first: start({ outcome: "done", usage: bill }) }, entries);
  try {
    await w.project();
    expect(readLedger(w.ledger).usage.map(({ kind, cost }) => ({ kind, cost }))).toEqual([{ kind: "generation_unsettled", cost: 0.03 }]);
    entries.push(assistant(2, "aborted")); await w.project(); await w.project();
    expect(readLedger(w.ledger).activity.map(({ replies }) => replies)).toEqual([0]);
    expect(readLedger(w.ledger).usage.map(({ kind, requests, cost, missingUsage }) => ({ kind, requests, cost, missingUsage })))
      .toEqual([{ kind: "interrupted", requests: 1, cost: 0.03, missingUsage: 0 }]);
  } finally { w.ledger.close(); }
});

test("withdrawn/NOT_SENT requests are omitted; compaction starts are not paired with assistant entries", async () => {
  const w = world({ withdrawn: start({ withdrawn: true }), summarize: start({ kind: "compaction", taskId: 100 }),
    real: start({ k: 2, usage: bill, outcome: "done" }) }, [user(), assistant(2, "error", 98, NOT_SENT), assistant(3, "stop", 99)]);
  try {
    await w.project(); await w.project();
    expect(readLedger(w.ledger).activity.map(({ asks, replies }) => ({ asks, replies }))).toEqual([{ asks: 1, replies: 1 }]);
    expect(readLedger(w.ledger).usage.map(({ kind, requests, missingUsage }) => ({ kind, requests, missingUsage })))
      .toEqual([{ kind: "assistant", requests: 1, missingUsage: 0 }, { kind: "compaction", requests: 1, missingUsage: 1 }]);
  } finally { w.ledger.close(); }
});

test("old Durable projections rebuild after the import floor, preserve other sources and compare the pairing checkpoint", async () => {
  const w = world({ first: start({ afterEntry: 2 }) }, [user(), assistant(2, "stop"), assistant(3, "aborted")], 2);
  const source = conversationSource(member.groupId, member.phone, member.conversationId);
  try {
    const record = { type: "message", timestamp: new Date(before).toISOString(), message: { role: "assistant" } };
    expect(ingestConversationRecords(w.ledger, source, 2, 3, [record], undefined, 2)).toBe(true);
    expect(ingestConversationRecords(w.ledger, { ...source, id: "legacy-preserved" }, 0, 1, [record])).toBe(true);
    w.ledger.query("UPDATE sources SET projection = 2 WHERE id = ?").run(source.id);
    await w.project();
    const rows = readLedger(w.ledger);
    expect(rows.activity.map(({ replies }) => replies)).toEqual([1]);
    expect(rows.usage.map(({ kind, requests }) => ({ kind, requests }))).toEqual([
      { kind: "assistant", requests: 1 }, { kind: "interrupted", requests: 1 },
    ]);
    const old = w.ledger.query("SELECT offset, digest FROM sources WHERE id = ?").get(source.id) as { offset: number; digest: string };
    expect(ingestConversationRecords(w.ledger, { ...source, digest: "new-checkpoint" }, old.offset, old.offset, [], undefined, 2, old.digest)).toBe(true);
    expect(ingestConversationRecords(w.ledger, source, old.offset, old.offset, [], undefined, 2, old.digest)).toBe(false);
    expect(w.reads).toEqual([3]);
  } finally { w.ledger.close(); }
});
