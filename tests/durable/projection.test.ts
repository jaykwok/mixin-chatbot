// Stats sync of Durable conversations into the stats ledger (src/durable/projection.ts, stats-ledger.ts syncUsage):
// the growth of `pi.usage` per sync, per model and tool. Faux providers only.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { type Conversation, UsageDoc } from "@earendil-works/pi-durable";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { syncMemberStats } from "../../src/durable/projection.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";
import { scopeOf, statsOf } from "../helpers/layout.ts";

const fixture = await tempFixture("durable-projection-");
afterAll(() => fixture.cleanup());
const GROUP = "group-a";
const PHONE = "13800000001";
let counter = 0;

async function ask(conversation: Conversation, content: string) {
  const settled = await (await conversation.submit({ type: "input", content, requestId: `${content}-${++counter}` }, context)).wait(context);
  expect(settled.status).toBe("done");
}

const sum = (rows: { totalTokens: number }[]) => rows.reduce((total, row) => total + row.totalTokens, 0);

describe("usage sync", () => {
  test("growth of pi.usage counts once per sync; a compaction adds to the model's totals; no growth writes nothing", async () => {
    const { faux, models, model } = fauxModels();
    const root = join(fixture.root, `root-${++counter}`);
    const opened = await openGroupHarness(join(fixture.root, `db-${counter}.sqlite`), models,
      { settings: { compaction: { enabled: false, keepRecentTokens: 1 } }, group: GROUP });
    const ledger = openStatsLedger(statsOf(root));
    try {
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), PHONE, { model }, context);
      faux.setResponses([fauxAssistantMessage("一"), fauxAssistantMessage("二"), fauxAssistantMessage("摘要"), fauxAssistantMessage("三")]);
      await ask(conversation, "问一");
      await ask(conversation, "问二");
      const member = { scope: scopeOf(GROUP), phone: PHONE, conversationId: conversation.id };
      expect(await syncMemberStats(ledger, opened.harness, member, context)).toEqual([]);
      const first = readLedger(ledger).usage;
      const key = `${model.provider}/${model.modelId}`;
      expect(first.map(({ bucket, key, user }) => ({ bucket, key, user }))).toEqual([{ bucket: "models", key, user: PHONE }]);
      const usage = (await opened.harness.snapshot(UsageDoc, conversation.id, context))!;
      expect(sum(first)).toBe(usage.models[key]!.totalTokens);
      expect(sum(first)).toBeGreaterThan(0);

      const sources = () => ledger.query("SELECT seen_at FROM usage_sources").all();
      const seen = sources();
      await syncMemberStats(ledger, opened.harness, member, context);
      expect(sum(readLedger(ledger).usage)).toBe(sum(first));
      expect(sources()).toEqual(seen);

      const task = await conversation.compact(undefined, context);
      expect((await opened.harness.waitForTask(task, context)).state.outcome.status).toBe("completed");
      await ask(conversation, "问三");
      await syncMemberStats(ledger, opened.harness, member, context);
      await syncMemberStats(ledger, opened.harness, member, context);
      const after = (await opened.harness.snapshot(UsageDoc, conversation.id, context))!;
      expect(sum(readLedger(ledger).usage)).toBe(after.models[key]!.totalTokens);
      expect(after.models[key]!.totalTokens).toBeGreaterThan(usage.models[key]!.totalTokens);
    } finally {
      ledger.close();
      await opened.close();
    }
  });

  test("a member without a conversation syncs nothing; another member's sync keeps its own rows", async () => {
    const { faux, models, model } = fauxModels();
    const root = join(fixture.root, `root-${++counter}`);
    const opened = await openGroupHarness(join(fixture.root, `db-${counter}.sqlite`), models, { group: GROUP });
    const ledger = openStatsLedger(statsOf(root));
    try {
      expect(await syncMemberStats(ledger, opened.harness, { scope: scopeOf(GROUP), phone: "13800000009" }, context)).toEqual([]);
      const { conversation } = await memberConversation(opened.harness, scopeOf(GROUP), PHONE, { model }, context);
      faux.setResponses([fauxAssistantMessage("一")]);
      await ask(conversation, "问一");
      await syncMemberStats(ledger, opened.harness, { scope: scopeOf(GROUP), phone: PHONE, conversationId: conversation.id }, context);
      expect(new Set(readLedger(ledger).usage.map(row => row.user))).toEqual(new Set([PHONE]));
    } finally {
      ledger.close();
      await opened.close();
    }
  });
});
