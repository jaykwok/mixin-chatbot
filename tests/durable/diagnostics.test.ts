import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { conversationTimings, historicalContext, withGroupSnapshot } from "../../src/durable/diagnostics.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { projectConversation } from "../../src/durable/projection.ts";
import legacy from "../fixtures/pi-1.0.4-durable.json";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const f = await tempFixture("durable-diagnostics-"); afterAll(() => f.cleanup());
const path = join(f.root, "legacy.sqlite");
const db = new Database(path);
for (const table of legacy.tables) {
  db.exec(table.sql);
  for (const row of table.rows) {
    const keys = Object.keys(row);
    db.query(`INSERT INTO "${table.name}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row));
  }
}
for (const sql of legacy.indexes) db.exec(sql);
db.close();
const digest = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

test("real 1.0.4 storage cold-opens at 1.1.0; missing timing is unknown; new usage preserves the old bill", async () => {
  expect(legacy.producer.version).toBe("1.0.4");
  const before = await digest(path);
  const old = await conversationTimings(path, "alice");
  expect(old.response).toMatchObject({ count: 2, known: 0, unknown: 2, meanMs: null });
  expect(old.tools.noop).toMatchObject({ count: 1, known: 0, unknown: 1 });
  expect(old.taskSpans["fixture.old-task"]).toMatchObject({ count: 1, known: 0, unknown: 1 });
  expect((await historicalContext(path, "alice", legacy.entries[0])).messages).toEqual([{ role: "user", content: "old question", timestamp: 1000 }]);
  expect(await withGroupSnapshot(path, harness => harness.inspect(context))).toMatchObject({ scheduling: "paused" });
  expect(await digest(path)).toBe(before);
  const { faux, models, model } = fauxModels(), opened = await openGroupHarness(path, models, { group: "legacy-group" });
  const ledger = openStatsLedger(join(f.root, "groups"));
  try {
    const oldTask = await opened.harness.getTask(legacy.taskId as TaskId, context);
    expect(oldTask!.startedAt).toBeUndefined(); expect(oldTask!.endedAt).toBeUndefined();
    const conversation = (await opened.harness.conversation(legacy.conversationId as ConversationId, context))!;
    const member = { groupId: "legacy-group", phone: "alice", conversationId: conversation.id };
    await projectConversation(ledger, opened.harness, member, context);
    expect(readLedger(ledger).usage.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(1.741503, 6);
    await memberConversation(opened.harness, "legacy-group", "alice", { model }, context);
    let oldHistory = false;
    faux.setResponses([transcript => { oldHistory = transcript.messages.some(message => message.role === "user" && message.content === "old question"); return fauxAssistantMessage("new answer"); }]);
    await (await conversation.submit({ type: "input", content: "continue" }, context)).wait(context);
    expect(oldHistory).toBe(true);
    const main = await digest(path), wal = await digest(path + "-wal");
    const view = await historicalContext(path, "alice"); expect(JSON.stringify(view.messages)).toContain("new answer");
    const timing = await conversationTimings(path, "alice");
    expect(timing.response.known).toBe(1); expect(timing.response.unknown).toBe(2);
    expect(timing.taskSpans["pi.generation"]!.known).toBeGreaterThan(0);
    expect(await digest(path)).toBe(main); expect(await digest(path + "-wal")).toBe(wal);
    await projectConversation(ledger, opened.harness, member, context); await projectConversation(ledger, opened.harness, member, context);
    expect(readLedger(ledger).usage.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(1.741503, 6);
  } finally { ledger.close(); await opened.close(); }
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
  await expect(historicalContext(future, "alice")).rejects.toThrow("版本不匹配"); expect(await readFile(future)).toEqual(bytes);
  const ordinary = join(f.root, "not-database"); await writeFile(ordinary, "fixture");
  await expect(conversationTimings(ordinary, "alice")).rejects.toThrow();
});
