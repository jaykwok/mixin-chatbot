import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { conversationTimings, historicalContext, withSpaceSnapshot } from "../../src/durable/diagnostics.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { databaseOf, scopeOf } from "../helpers/layout.ts";

const f = await tempFixture("durable-diagnostics-"); afterAll(() => f.cleanup());
const path = join(f.root, "current.sqlite");
const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
const fixtureModels = fauxModels();
const fixtureGroup = await openGroupHarness(path, fixtureModels.models);
const fixtureConversation = (await memberConversation(fixtureGroup.harness, scopeOf("group-a"), "alice", { model: fixtureModels.model }, context)).conversation;
fixtureModels.faux.setResponses([fauxAssistantMessage("current answer")]);
await (await fixtureConversation.submit({ type: "input", content: "current question" }, context)).wait(context);
await fixtureGroup.close();

test("current diagnostics read context and timing without changing the database", async () => {
  const before = await digest(path);
  expect(JSON.stringify((await historicalContext(path, "alice")).messages)).toContain("current answer");
  expect((await conversationTimings(path, "alice")).response.count).toBe(1);
  expect(await digest(path)).toBe(before);
});

test("historical diagnostics reject invalid cuts, absent members and future schemas without writes", async () => {
  const before = await digest(path);
  await expect(historicalContext(path, "alice", 0)).rejects.toThrow("正整数");
  await expect(historicalContext(path, "nobody")).rejects.toThrow("没有该成员");
  await expect(historicalContext(path, "alice", 999999)).rejects.toThrow("not visible");
  expect(await digest(path)).toBe(before);
  const future = join(f.root, "future.sqlite"), db = new Database(future);
  db.exec("CREATE TABLE durable_schema(singleton INTEGER PRIMARY KEY, version INTEGER); INSERT INTO durable_schema VALUES(1,999)"); db.close();
  const bytes = await readFile(future);
  await expect(historicalContext(future, "alice")).rejects.toThrow("会话库格式为 Durable schema 999，当前程序只支持 schema 2"); expect(await readFile(future)).toEqual(bytes);
  const ordinary = join(f.root, "not-database"); await writeFile(ordinary, "fixture");
  await expect(conversationTimings(ordinary, "alice")).rejects.toThrow();
});

test("a space database above the memory limit is snapshotted into a private file on the data volume, then removed", async () => {
  const data = join(f.root, "data-large"), large = databaseOf(data, "group-a");
  await mkdir(join(large, ".."), { recursive: true });
  const { models, model } = fauxModels(), opened = await openGroupHarness(large, models, { group: "group-a" });
  try { await memberConversation(opened.harness, scopeOf("group-a"), "alice", { model }, context); } finally { await opened.close(); }
  const before = await digest(large), snapshots = join(data, "state", "reclamation", "snapshots");
  for (const exclusive of [false, true]) {
    const seen = await withSpaceSnapshot(large, async harness => {
      expect(await harness.inspect(context)).toMatchObject({ scheduling: "paused" });
      return readdir(snapshots);
    }, exclusive, 1);
    expect(seen).toHaveLength(1);
    expect(await readdir(snapshots)).toEqual([]);
  }
  expect(await digest(large)).toBe(before);
  // The direct space's database sits one level higher and snapshots into the same place; elsewhere is refused.
  const direct = databaseOf(data, "direct");
  await mkdir(join(direct, ".."), { recursive: true });
  const other = await openGroupHarness(direct, models, { scope: scopeOf("direct") });
  try { await memberConversation(other.harness, scopeOf("direct"), "alice", { model }, context); } finally { await other.close(); }
  expect(await withSpaceSnapshot(direct, async () => readdir(snapshots), false, 1)).toHaveLength(1);
  await expect(withSpaceSnapshot(path, async () => 0, false, 1)).rejects.toThrow("会话库不在数据目录的 conversations 下");
});
