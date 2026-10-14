// Data version 5 (scripts/migrations/v5.ts): scripts' store() values move from the project's codemode document to the
// official one. Copied as they are, once; the old document stays; a conversation without values gets no document; a
// repeated or resumed run finishes; an official store holding other values stops it; rollback before commit restores
// the database. Each copy records its history boundary: before it the official store has no value (no past value is
// made up), as-of reads and forks included; a reset keeps the values. Synthetic group databases only.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { type ConversationId, createSession, type EntryId, Harness, UserEntry } from "@earendil-works/pi-durable";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import * as frozen from "../../scripts/migrations/lib/durable.ts";
import { DATA_VERSION, inspectDataVersion } from "../../src/core/data-version.ts";
import { CodemodeStoreDoc } from "../../src/durable/codemode/index.ts";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, harnessOptions } from "../helpers/durable.ts";
import { migrationBudget } from "../helpers/migration-budget.ts";
import { tempFixture } from "../helpers/temp.ts";

type Values = Record<string, JsonValue>;

async function fixture() {
  const f = await tempFixture("migration-v5-");
  const groups = join(f.root, "groups");
  await mkdir(groups); await mkdir(join(f.root, "data/state"), { recursive: true });
  await publishJson(join(f.root, "data/config/runtime.json"), { GROUP_DATA_ROOT: groups });
  await publishJson(join(f.root, "data/config/models.json"), { providers: { fixture: {
    baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-key", models: [{
      id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } });
  await publishJson(join(f.root, "data/runtime/pi/settings.json"), { format: 1, defaultProvider: "fixture", defaultModel: "test" });
  for (const path of [join(f.root, "data/state/data-version.json"), join(groups, "data-version.json")])
    await publishJson(path, { dataVersion: 4, transaction: "fixture-v4" });
  const bill = join(f.root, "data/state/historical-bill.sqlite"), db = new Database(bill);
  db.exec("CREATE TABLE bill (amount REAL NOT NULL); INSERT INTO bill VALUES (1.741503)"); db.close();
  return { ...f, groups, bill, context: { project: f.root, groups, decisions: {} } };
}

/** A group database with one conversation per entry: its old store values (undefined: no store document at all). */
async function group(groups: string, name: string, stores: (Values | undefined)[], official: Record<number, Values> = {}) {
  const path = groupDatabasePath(groups, name);
  await mkdir(dirname(path), { recursive: true });
  const storage = await openGroupStorage(path);
  try {
    const session = createSession(storage, { documentRetentionMs: 0 });
    const ids: ConversationId[] = [];
    for (const [index, values] of stores.entries()) {
      ids.push(await session.commit(async (tx) => {
        const { id } = await tx.createConversation({ ownership: { kind: "ownerless" } });
        if (values !== undefined) (await tx.doc(frozen.CodemodeStoreDoc, id)).values = structuredClone(values);
        if (official[index] !== undefined) {
          (await tx.doc(frozen.OfficialCodemodeStoreDoc, id)).values = structuredClone(official[index]);
          // As an earlier run of v5 left it: the copy and its boundary in one commit.
          Object.assign(await tx.doc(frozen.CodemodeStoreBoundaryDoc, id), { version: 1, through: 0, copiedAt: 1 });
        }
        return id;
      }, context));
    }
    return { path, ids };
  } finally { await storage.close(context); }
}

/** Both store documents of each conversation, read without a Harness (undefined: no document). */
async function stores(path: string, ids: ConversationId[]) {
  const storage = await openGroupStorage(path);
  try {
    const session = createSession(storage, { documentRetentionMs: 0 });
    return await Promise.all(ids.map(async (id) => ({
      old: (await session.snapshot(frozen.CodemodeStoreDoc, id, context))?.values,
      official: (await session.snapshot(frozen.OfficialCodemodeStoreDoc, id, context))?.values,
    })));
  } finally { await storage.close(context); }
}

const ALICE: Values = { kept: 1, 表: { 行: [1, "二", null] }, empty: "" };
const BOB: Values = { n: 42 };

test("v5 previews read-only, copies each store once, keeps the old one, touches no conversation without values, and rolls back exact bytes", async () => {
  const f = await fixture();
  try {
    const g1 = await group(f.groups, "g1", [ALICE, undefined, {}, BOB]);
    const g2 = await group(f.groups, "g2", [undefined]);
    const before = await stores(g1.path, g1.ids);
    const reports: string[] = [];
    const c = { ...f.context, report: (stage: string, detail: string) => reports.push(`${stage} ${detail}`) };

    const plan = (await preview(c)).plan!;
    expect(DATA_VERSION).toBe(5);
    expect(plan.target).toBe(5);
    expect(plan.steps.join("\n")).toContain("pi.codemode.store");
    expect(await stores(g1.path, g1.ids)).toEqual(before);

    await apply(c, plan);
    expect(reports).toContain("codemode-store group=g1; copied=2; already=0");
    expect(reports).toContain("codemode-store group=g2; copied=0; already=0");
    expect(await stores(g1.path, g1.ids)).toEqual([
      { old: ALICE, official: ALICE }, { old: undefined, official: undefined }, { old: {}, official: undefined }, { old: BOB, official: BOB },
    ]);
    expect(await stores(g2.path, g2.ids)).toEqual([{ old: undefined, official: undefined }]);
    // A repeated run finds them copied and writes nothing.
    expect(await frozen.copyCodemodeStores(g1.path)).toEqual([
      { conversationId: g1.ids[0] as number, keys: 3, through: 0, outcome: "already-copied" }, { conversationId: g1.ids[3] as number, keys: 1, through: 0, outcome: "already-copied" },
    ]);
    expect(await frozen.uncopiedCodemodeStores(g1.path)).toEqual([]);

    // Before commit the database comes back as it was.
    expect(await rollback(c)).toBe(true);
    expect(await stores(g1.path, g1.ids)).toEqual(before);
    expect((await json(join(f.root, "data/state/data-version.json")))!.dataVersion).toBe(4);

    await apply(c, (await preview(c)).plan!);
    await commit(c);
    expect(inspectDataVersion(f.root, f.groups)).toMatchObject({ current: true });
    expect(await rollback(c)).toBe(false);

    // The service reads the copied values through the official document.
    const { models } = fauxModels();
    const harness = await Harness.open(await openGroupStorage(g1.path), harnessOptions(models)(), context);
    try {
      expect((await harness.snapshot(CodemodeStoreDoc, g1.ids[0]!, context))?.values).toEqual(ALICE);
      expect((await harness.snapshot(CodemodeStoreDoc, g1.ids[1]!, context))).toBeUndefined();
    } finally { await harness.close(context); }
  } finally { await f.cleanup(); }
}, migrationBudget(6));

test("v5 resumes a partly copied group; an official store holding other values stops it and nothing else is written", async () => {
  const f = await fixture();
  try {
    // Resumed: the first conversation was copied by an interrupted run.
    const resumed = await group(f.groups, "g1", [ALICE, BOB], { 0: ALICE });
    expect(await frozen.uncopiedCodemodeStores(resumed.path)).toEqual([resumed.ids[1] as number]);
    expect(await frozen.copyCodemodeStores(resumed.path)).toEqual([
      { conversationId: resumed.ids[0] as number, keys: 3, through: 0, outcome: "already-copied" }, { conversationId: resumed.ids[1] as number, keys: 1, through: 0, outcome: "copied" },
    ]);
    expect(await stores(resumed.path, resumed.ids)).toEqual([{ old: ALICE, official: ALICE }, { old: BOB, official: BOB }]);

    // Conflict: the official store of the second conversation holds other values.
    const conflict = await group(f.groups, "g2", [ALICE, BOB, { z: 1 }], { 1: { n: 7 } });
    const before = await readFile(join(f.groups, "data-version.json"));
    await expect(apply(f.context, (await preview(f.context)).plan!)).rejects.toThrow("的官方 codemode store 已有不同的值，拒绝覆盖");
    await rollback(f.context);
    expect(await stores(conflict.path, conflict.ids)).toEqual([
      { old: ALICE, official: undefined }, { old: BOB, official: { n: 7 } }, { old: { z: 1 }, official: undefined },
    ]);
    expect(await readFile(join(f.groups, "data-version.json"))).toEqual(before);
    expect(await frozen.uncopiedCodemodeStores(conflict.path)).toEqual(conflict.ids.map(Number));
  } finally { await f.cleanup(); }
}, migrationBudget(4));

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 0 });

test("v5 records each copied store's history boundary: up to it the official store is empty as of an entry or in a fork; a reset keeps the values", async () => {
  const f = await fixture();
  try {
    const path = groupDatabasePath(f.groups, "g1");
    await mkdir(dirname(path), { recursive: true });
    let id!: ConversationId, first!: EntryId, last!: EntryId, unrecorded!: ConversationId;
    const storage = await openGroupStorage(path);
    try {
      await createSession(storage, { documentRetentionMs: 0 }).commit(async (tx) => {
        ({ id } = await tx.createConversation({ ownership: { kind: "ownerless" } }));
        first = (await tx.appendEntry(UserEntry, id, { model: [user("first")] })).id;
        (await tx.doc(frozen.CodemodeStoreDoc, id)).values = structuredClone(ALICE);
        last = (await tx.appendEntry(UserEntry, id, { model: [user("second")] })).id;
      }, context);
    } finally { await storage.close(context); }
    const startedAt = Date.now();
    await apply(f.context, (await preview(f.context)).plan!);
    await commit(f.context);

    const { models } = fauxModels();
    const harness = await Harness.open(await openGroupStorage(path), harnessOptions(models)(), context);
    try {
      const boundary = (await harness.snapshot(frozen.CodemodeStoreBoundaryDoc, id, context))!;
      expect(boundary).toMatchObject({ version: 1, through: last as number });
      expect(boundary.copiedAt).toBeGreaterThanOrEqual(startedAt);
      // Up to the boundary there is no value, not the copied one; the first later entry sees the copy.
      for (const at of [first, last]) expect((await harness.snapshotAsOf(CodemodeStoreDoc, id, at, context))?.values ?? {}).toEqual({});
      const later = await harness.commit((tx) => tx.appendEntry(UserEntry, id, { model: [user("third")] }), context);
      expect((await harness.snapshotAsOf(CodemodeStoreDoc, id, later.id, context))?.values).toEqual(ALICE);
      // A fork at the boundary starts empty, as an old fork did; one after it starts with the copy.
      const conversation = (await harness.conversation(id, context))!;
      const before = await conversation.fork(last, { ownership: { kind: "ownerless" } }, context);
      const after = await conversation.fork(later.id, { ownership: { kind: "ownerless" } }, context);
      expect((await harness.snapshot(CodemodeStoreDoc, before.id, context))?.values ?? {}).toEqual({});
      expect((await harness.snapshot(CodemodeStoreDoc, after.id, context))?.values).toEqual(ALICE);
      // A reset (/clear) changes no document.
      await conversation.reset(undefined, context);
      await conversation.waitForIdle(context);
      expect((await harness.snapshot(CodemodeStoreDoc, id, context))?.values).toEqual(ALICE);
      // An official store with the old values but no boundary was not written by v5: a run stops there.
      unrecorded = await harness.commit(async (tx) => {
        const { id: other } = await tx.createConversation({ ownership: { kind: "ownerless" } });
        (await tx.doc(frozen.CodemodeStoreDoc, other)).values = structuredClone(BOB);
        (await tx.doc(frozen.OfficialCodemodeStoreDoc, other)).values = structuredClone(BOB);
        return other;
      }, context);
    } finally { await harness.close(context); }
    expect(await frozen.uncopiedCodemodeStores(path)).toEqual([unrecorded as number]);
    await expect(frozen.copyCodemodeStores(path)).rejects.toThrow("没有迁移边界记录");
  } finally { await f.cleanup(); }
}, migrationBudget(6));
