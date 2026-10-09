// Usage projection of Durable conversations into the stats ledger (D3, src/durable/projection.ts and
// stats-ledger.ts ingestConversationRecords). Faux providers only.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import { dayKey, ingestConversationRecords, openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { conversationSource, projectConversation } from "../../src/durable/projection.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-projection-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a";
const PHONE = "13800000001";
let counter = 0;

async function ask(conversation: Conversation, content: string) {
  const settled = await (await conversation.submit({ type: "input", content, requestId: `${content}-${++counter}` }, context)).wait(context);
  expect(settled.status).toBe("done");
}

describe("usage projection", () => {
  test("entries after the cursor are counted once; compaction usage from the door's starts is recounted whole", async () => {
    const { faux, models, model } = fauxModels();
    const root = join(fixture.root, `root-${++counter}`);
    const opened = await openGroupHarness(join(fixture.root, `db-${counter}.sqlite`), models,
      { settings: { compaction: { enabled: false, keepRecentTokens: 1 } }, group: GROUP });
    const ledger = openStatsLedger(root);
    try {
      const { conversation } = await memberConversation(opened.harness, GROUP, PHONE, { model }, context);
      faux.setResponses([fauxAssistantMessage("一"), fauxAssistantMessage("二"), fauxAssistantMessage("摘要"), fauxAssistantMessage("三")]);
      await ask(conversation, "问一");
      await ask(conversation, "问二");
      const member = { groupId: GROUP, phone: PHONE, conversationId: conversation.id };
      expect(await projectConversation(ledger, opened.harness, member, context)).toBe(4);
      expect(await projectConversation(ledger, opened.harness, member, context)).toBe(0);
      const first = readLedger(ledger);
      expect(first.activity.map(({ asks, replies }) => ({ asks, replies }))).toEqual([{ asks: 2, replies: 2 }]);
      expect(first.usage.map(({ kind, requests }) => ({ kind, requests }))).toEqual([{ kind: "assistant", requests: 2 }]);

      const task = await conversation.compact(undefined, context);
      expect((await opened.harness.waitForTask(task, context)).state.outcome.status).toBe("completed");
      await ask(conversation, "问三");
      await projectConversation(ledger, opened.harness, member, context);
      await projectConversation(ledger, opened.harness, member, context);
      const second = readLedger(ledger);
      expect(second.activity.map(({ asks, replies }) => ({ asks, replies }))).toEqual([{ asks: 3, replies: 3 }]);
      const usage = Object.fromEntries(second.usage.map((row) => [row.kind, { requests: row.requests, missing: row.missingUsage, tokens: row.input + row.output }]));
      expect(usage.assistant!.requests).toBe(3);
      expect(usage.compaction!.requests).toBe(1);
      expect(usage.compaction!.missing).toBe(0);
      expect(usage.compaction!.tokens).toBeGreaterThan(0);
      expect(second.usage.find((row) => row.kind === "compaction")!.user).toBe(PHONE);
    } finally {
      ledger.close();
      await opened.close();
    }
  });

  test("a run across midnight counts on each message's day; a stale cursor writes nothing", () => {
    const root = join(fixture.root, `root-${++counter}`);
    const ledger = openStatsLedger(root);
    try {
      const source = conversationSource(GROUP, PHONE, 7);
      const before = new Date(2026, 9, 6, 23, 59, 50).getTime();
      const after = new Date(2026, 9, 7, 0, 0, 5).getTime();
      const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
      const records = [
        { type: "message", timestamp: new Date(before).toISOString(), message: { role: "user" } },
        { type: "message", timestamp: new Date(after).toISOString(), message: { role: "assistant", provider: "p", model: "m", usage } },
      ];
      expect(ingestConversationRecords(ledger, source, 0, 2, records)).toBe(true);
      expect(ingestConversationRecords(ledger, source, 0, 2, records)).toBe(false);
      const rows = readLedger(ledger);
      expect(rows.activity.map(({ day, asks, replies }) => ({ day, asks, replies })).sort((a, b) => a.day.localeCompare(b.day))).toEqual([
        { day: dayKey(before), asks: 1, replies: 0 }, { day: dayKey(after), asks: 0, replies: 1 },
      ]);
      expect(rows.usage.map(({ day, provider, model, requests }) => ({ day, provider, model, requests }))).toEqual([
        { day: dayKey(after), provider: "p", model: "m", requests: 1 },
      ]);
    } finally { ledger.close(); }
  });
});
