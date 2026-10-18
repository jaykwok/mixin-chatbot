// Fixed interleavings from the R2 re-review: real SQLite, Harness and official VM; synthetic paid tools only.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, type Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, hook, NestedCallDoc, ToolTask, UsageDoc, type Harness, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { codemodeExtension } from "../../src/durable/codemode/index.ts";
import { NestedUsageDoc, recordNestedUsage } from "../../src/durable/codemode/usage.ts";
import { memberConversation } from "../../src/durable/identity.ts";
import { memberRegistration, type AdaptedMemberTool } from "../../src/durable/tools.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { projectConversation } from "../../src/durable/projection.ts";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("codemode-usage-");
afterAll(() => fixture.cleanup());
const usage = (n: number): Usage => ({ input: n, output: 2 * n, cacheRead: 0, cacheWrite: 0, totalTokens: 3 * n,
  cost: { input: n / 1000, output: n / 500, cacheRead: 0, cacheWrite: 0, total: 3 * n / 1000 } });
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
const tool = (name: string, run: AdaptedMemberTool["run"]): AdaptedMemberTool => ({
  definition: { name, label: name, description: name, exposure: "codemode", parameters: Type.Object({}),
    execute: async () => { throw new Error("not used"); } },
  replay: "safe", outputLimits: { maxBytes: 64 * 1024, maxLines: 2200 }, run,
});
async function until(probe: () => Promise<boolean>) {
  const limit = Date.now() + 5000;
  while (!await probe()) { if (Date.now() > limit) throw new Error("probe timeout"); await Bun.sleep(5); }
}
async function stopped(signal: AbortSignal | undefined) {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

test.each(["abort-before-seed", "child-after-outcome", "restart-after-outcome", "ledger-before-prune"] as const)(
  "nested charges survive %s, repeat projection and another restart", async mode => {
    const { models, faux, model } = fauxModels();
    const base = { root: join(fixture.root, mode, "groups"), groupId: "group-a" };
    const waiting = Promise.withResolvers<void>(), window = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const lateStored = Promise.withResolvers<void>();
    let recovering = false, holdOutcome = true, runs = 0, lateRuns = 0;
    const tools = [tool("metered", async () => { runs++; return { ...text("paid"), usage: usage(42) }; }),
      tool("wait_here", async (_args, call) => {
        waiting.resolve(); await stopped(call.signal); throw new Error("aborted");
      }), tool("late", async () => { lateRuns++; waiting.resolve(); await release.promise; return { ...text("late paid"), usage: usage(8) }; }),
      tool("wait_started", async () => { await waiting.promise; return text("started"); })];
    const pause = defineExtension({ name: "fixture.pause", wraps: [{ tool: "codemode", wrap: (tool: ToolRegistration) => ({
      ...tool, execute: (args: unknown, api: ToolExecutionApi, ctx: typeof context) => tool.execute(args as never, {
        ...api, commit: async (change, cc) => {
          const value = await api.commit(change, cc);
          if (recovering && (value as { rerun?: boolean } | undefined)?.rerun === true) {
            recovering = false; window.resolve(); await stopped(ctx.abortSignal); ctx.abortSignal?.throwIfAborted();
          }
          if (mode !== "abort-before-seed" && holdOutcome && (value as { output?: unknown } | undefined)?.output !== undefined) {
            holdOutcome = false; window.resolve();
            await until(async () => (await api.snapshot(NestedCallDoc, api.taskId, "c2", context))?.result !== undefined);
            lateStored.resolve();
            if (mode === "restart-after-outcome") { await stopped(ctx.abortSignal); ctx.abortSignal?.throwIfAborted(); }
          }
          return value;
        },
      }, ctx),
    }) }] });
    const extensions = [defineExtension({ name: "fixture.tools", tools: tools.map(memberRegistration) }), pause,
      codemodeExtension({ members: base, tools })];
    const open = () => openGroupHarness(join(fixture.root, mode, "db.sqlite"), models, { extensions });
    let group = await open();
    const ledger = openStatsLedger(base.root);
    try {
      const { conversation } = await memberConversation(group.harness, "group-a", "+8613800000001", { model }, context);
      const identity = { groupId: "group-a", phone: "+8613800000001", conversationId: conversation.id };
      const code = mode === "abort-before-seed" ? "await tools.metered({}); await tools.wait_here({});"
        : "await tools.metered({}); tools.late({}); await tools.wait_started({}); return 1;";
      faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: mode })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      await conversation.submit({ type: "input", content: "charge" }, context);
      await waiting.promise;
      const charges = () => readLedger(ledger).usage.filter(row => row.kind === "tool");
      if (mode === "abort-before-seed") {
        // Already independently billable before either a parent result or recovered progress exists.
        await projectConversation(ledger, group.harness, identity, context);
        expect(charges().map(row => row.cost)).toEqual([0.126]);
        expect(Object.keys((await group.harness.snapshot(NestedUsageDoc, conversation.id, context))!.receipts)).toHaveLength(1);
        await group.close(); recovering = true; group = await open();
        const resumed = (await group.harness.conversation(conversation.id, context))!;
        group.harness.resume(); await window.promise; await resumed.abort(context); await resumed.waitForIdle(context);
        const result = (await resumed.entries({}, 1000, undefined, context)).items.find(entry =>
          entry.kind === "pi.tool-result" && (entry.model?.[0] as { toolCallId?: string })?.toolCallId === mode)?.model?.[0];
        expect(result).toMatchObject({ isError: true });
        expect((result as { content: { text?: string }[] }).content[0]!.text).toContain("Tool codemode was aborted");
        expect((result as { details?: unknown }).details).toBeUndefined();
      } else {
        await window.promise; release.resolve();
        if (mode === "restart-after-outcome") {
          await lateStored.promise; await group.close(); group = await open();
          await (await group.harness.conversation(conversation.id, context))!.waitForIdle(context);
        } else { await conversation.waitForIdle(context); }
      }
      const expected = mode === "abort-before-seed" ? 0.126 : 0.15;
      const durable = await group.harness.snapshot(UsageDoc, conversation.id, context);
      expect(Object.values(durable?.tools ?? {}).reduce((total, row) => total + row.cost.total, 0)).toBeCloseTo(expected, 6);
      expect([runs, lateRuns]).toEqual([1, mode === "abort-before-seed" ? 0 : 1]);
      if (mode === "ledger-before-prune") {
        let commits = 0;
        const target = group.harness;
        const failPrune = { snapshot: target.snapshot.bind(target),
          commit: <T>(change: Parameters<Harness["commit"]>[0], ctx: typeof context): Promise<T> => {
            if (++commits === 2) return Promise.reject(new Error("fixture: ledger committed, prune failed"));
            return target.commit(change, ctx) as Promise<T>;
          },
        } as Harness;
        let failure: unknown;
        try { await projectConversation(ledger, failPrune, identity, context); } catch (error) { failure = error; }
        expect(String(failure)).toContain("ledger committed, prune failed");
        expect(Object.keys((await group.harness.snapshot(NestedUsageDoc, conversation.id, context))!.receipts)).toHaveLength(2);
      }
      for (let repeat = 0; repeat < 2; repeat++) {
        await projectConversation(ledger, group.harness, identity, context);
        expect(charges().reduce((total, row) => total + row.cost, 0)).toBeCloseTo(expected, 6);
        expect(charges().reduce((total, row) => total + row.requests, 0)).toBe(mode === "abort-before-seed" ? 1 : 2);
        await group.close(); group = await open();
      }
      expect((await group.harness.snapshot(NestedUsageDoc, conversation.id, context))!.receipts).toEqual({});
      console.log("NESTED_USAGE", JSON.stringify({ mode, expected, charges: charges(), runs, lateRuns }));
    } finally { release.resolve(); ledger.close(); await group.close(); }
  }, 30000);

test.each([false, true])("nested receipt is idempotent inside settlement; a receipt failure rolls back all usage (fail=%s)", async fail => {
  const { models, faux, model } = fauxModels();
  const base = { root: join(fixture.root, `atomic-${fail}`, "groups"), groupId: "group-a" };
  let runs = 0;
  const tools = [tool("metered", async () => { runs++; return { ...text("paid"), usage: usage(42) }; })];
  const verify = defineExtension({ name: "fixture.receipt", hooks: [hook(ToolTask, {
    async settleNestedTool(call, key, result, tx) {
      await recordNestedUsage(call, key, result, tx);
      const task = (await tx.task(result.taskId))!;
      const doc = await tx.doc(NestedUsageDoc, task.conversationId);
      expect(doc.sequence).toBe(1);
      expect(Object.keys(doc.receipts)).toHaveLength(1);
      if (fail) throw new Error("fixture: receipt transaction failed");
    },
  })] });
  const group = await openGroupHarness(join(fixture.root, `atomic-${fail}`, "db.sqlite"), models, { extensions: [
    defineExtension({ name: "fixture.tools", tools: tools.map(memberRegistration) }), codemodeExtension({ members: base, tools }), verify,
  ] });
  const ledger = openStatsLedger(base.root);
  try {
    const { conversation } = await memberConversation(group.harness, "group-a", "+8613800000001", { model }, context);
    faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code: "return await tools.metered({});" }, { id: "atomic" })],
      { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
    await (await conversation.submit({ type: "input", content: "atomic" }, context)).wait(context);
    expect(runs).toBe(1);
    const durable = await group.harness.snapshot(UsageDoc, conversation.id, context);
    const receipts = await group.harness.snapshot(NestedUsageDoc, conversation.id, context);
    expect(durable?.tools.metered?.cost.total ?? 0).toBe(fail ? 0 : .126);
    expect(receipts?.sequence ?? 0).toBe(fail ? 0 : 1);
    const identity = { groupId: "group-a", phone: "+8613800000001", conversationId: conversation.id };
    for (let repeat = 0; repeat < 2; repeat++) {
      await projectConversation(ledger, group.harness, identity, context);
      const rows = readLedger(ledger).usage.filter(row => row.kind === "tool");
      expect(rows.reduce((total, row) => total + row.cost, 0)).toBe(fail ? 0 : .126);
    }
  } finally { ledger.close(); await group.close(); }
}, 30000);
