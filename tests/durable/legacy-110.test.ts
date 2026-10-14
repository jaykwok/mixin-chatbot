// A group database written by Pi 1.1.0 with the project's own codemode (tests/fixtures/pi-1.1.0-durable.json: dumped
// while work was running, then the process exited without closing: a crash), recovered by Pi 1.2.0 after the data
// version 5 step. The in-flight unsafe codemode call and the running direct tool end interrupted and never run again;
// the finished codemode result, its statistics, the inbox and the stored script values carry over.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Conversation, type ConversationId, createSession, defineExtension } from "@earendil-works/pi-durable";
import * as frozen from "../../scripts/migrations/lib/durable.ts";
import { openStatsLedger, readLedger } from "../../src/agent/stats-ledger.ts";
import { codemodeExtension, CodemodeStoreDoc } from "../../src/durable/codemode/index.ts";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { InboxDoc, WebhookReceiptsDoc } from "../../src/durable/inbox.ts";
import { projectConversation } from "../../src/durable/projection.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { baseMemberTools, type BaseToolsOptions, type MemberCall, memberRegistration, type MemberTool } from "../../src/durable/tools.ts";
import legacy from "../fixtures/pi-1.1.0-durable.json";
import { fauxModels, openGroupHarness } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const f = await tempFixture("durable-legacy-110-");
afterAll(() => f.cleanup());

const runs: Record<string, number> = {};
function tool(name: string, exposure: "direct" | "codemode"): MemberTool {
  return {
    definition: { name, label: name, description: `Fixture tool ${name}.`, ...(exposure === "codemode" ? { exposure } : {}),
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => { throw new Error("fixture tools run through MemberTool.run"); } } as ToolDefinition,
    replay: "unsafe", outputLimits: { maxBytes: 64 * 1024, maxLines: 2200 },
    run: async (_args: unknown, _call: MemberCall): Promise<AgentToolResult<unknown>> => {
      runs[name] = (runs[name] ?? 0) + 1;
      return { content: [{ type: "text", text: name }], details: undefined };
    },
  };
}

type Result = { isError: boolean; text: string; details?: Record<string, unknown> };
async function resultOf(conversation: Conversation, callId: string): Promise<Result | undefined> {
  for (const entry of (await conversation.entries({}, 1000, undefined, context)).items) {
    const message = entry.model?.[0] as { toolCallId?: string; isError: boolean; content: { text?: string }[]; details?: Record<string, unknown> } | undefined;
    if (entry.kind === "pi.tool-result" && message?.toolCallId === callId) {
      return { isError: message.isError, text: message.content.map((item) => item.text ?? "").join(""), details: message.details };
    }
  }
  return undefined;
}

test("a 1.1.0 crash recovers on 1.2.0: unsafe calls in flight end interrupted, finished results, statistics, inbox and store values carry over", async () => {
  expect(legacy.producer).toMatchObject({ package: "@earendil-works/pi-durable", version: "1.1.0" });
  const groups = join(f.root, "groups");
  const path = groupDatabasePath(groups, legacy.group);
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  for (const table of legacy.tables) {
    db.exec(table.sql);
    for (const row of table.rows as Record<string, unknown>[]) {
      const keys = Object.keys(row);
      db.query(`INSERT INTO "${table.name}" (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
        .run(...Object.values(row) as never[]);
    }
  }
  for (const sql of legacy.indexes) db.exec(sql);
  db.close();

  // Data version 5: the old store values are copied (the in-flight script's write was never committed).
  const alice = legacy.members.alice as ConversationId, bob = legacy.members.bob as ConversationId, carol = legacy.members.carol as ConversationId;
  expect(await frozen.copyCodemodeStores(path)).toEqual([{ conversationId: alice as number, keys: 2, through: expect.any(Number), outcome: "copied" }]);

  const base: BaseToolsOptions = { root: join(f.root, "group-data"), groupId: legacy.group };
  const members = baseMemberTools(base);
  const fixtureTools = [tool("fixture_wait", "direct"), tool("probe_metered", "codemode"), tool("probe_hang", "codemode")];
  const extensions = [
    defineExtension({ name: "mixin.base", tools: members.map(memberRegistration) }),
    defineExtension({ name: "fixture.module", tools: fixtureTools.map(memberRegistration) }),
    codemodeExtension({ members: base, tools: [...members, ...fixtureTools] }),
  ];
  const { faux, models } = fauxModels();
  const requests: string[] = [];
  faux.setResponses(Array.from({ length: 6 }, () => (transcript: { messages: { role: string; content: unknown }[] }) => {
    const last = transcript.messages.at(-1)!;
    requests.push(`${last.role}: ${JSON.stringify(last.content).slice(0, 120)}`);
    return fauxAssistantMessage("恢复后的回答");
  }));
  // Read without a Harness (nothing recovers).
  const before = await (async () => {
    const storage = await openGroupStorage(path);
    try {
      const session = createSession(storage, { documentRetentionMs: 0 });
      return { inbox: await session.snapshot(InboxDoc, carol, context), receipts: await session.snapshot(WebhookReceiptsDoc, context) };
    } finally { await storage.close(context); }
  })();
  const opened = await openGroupHarness(path, models, { group: legacy.group, extensions });
  const ledger = openStatsLedger(groups);
  try {
    const harness = opened.harness;
    const conversations = await Promise.all([alice, bob].map(async (id) => (await harness.conversation(id, context))!));
    await Promise.all(conversations.map((conversation) => conversation.waitForIdle(context)));
    const [aliceConversation, bobConversation] = conversations as [Conversation, Conversation];

    // Nothing ran again.
    expect(runs).toEqual({});
    const live = await resultOf(aliceConversation, legacy.calls.liveCodemode);
    const direct = await resultOf(bobConversation, legacy.calls.liveDirect);
    // Durable builds it from the call's last slot, written by the old code: its partial output and details stay.
    expect(live).toMatchObject({ isError: true, details: { complete: false, calls: [{ name: "probe_hang", status: "running" }] } });
    expect(live!.text).toStartWith("Sub-call index: ");
    expect(live!.text).toEndWith("<harness>\n[error] Tool codemode was interrupted and may have partially run\n</harness>");
    expect(direct).toMatchObject({ isError: true, text: "<harness>\n[error] Tool fixture_wait was interrupted and may have partially run\n</harness>" });
    expect(requests).toHaveLength(2);

    // The finished result reads as before; statistics follow the old rules for both old results (each child counted
    // once: the finished call's, and the one the interrupted call had started).
    const done = (await resultOf(aliceConversation, legacy.calls.done))!;
    expect(done.isError).toBe(false);
    expect(done.details).toMatchObject({ complete: true, calls: [{ name: "probe_metered" }] });
    const nested = () => readLedger(ledger).tools.filter((row) => row.kind === "nested").map(({ tool, count }) => ({ tool, count }))
      .sort((a, b) => a.tool.localeCompare(b.tool));
    await projectConversation(ledger, harness, { groupId: legacy.group, phone: "alice", conversationId: alice }, context);
    expect(nested()).toEqual([{ tool: "probe_hang", count: 1 }, { tool: "probe_metered", count: 1 }]);
    await projectConversation(ledger, harness, { groupId: legacy.group, phone: "alice", conversationId: alice }, context);
    expect(nested()).toEqual([{ tool: "probe_hang", count: 1 }, { tool: "probe_metered", count: 1 }]);

    // Inbox and webhook receipts are untouched by the recovery (the service, not the Harness, drains the inbox).
    expect(await harness.snapshot(InboxDoc, carol, context)).toEqual(before.inbox);
    expect(before.inbox?.items.map((item) => item.requestId)).toEqual(["carol-1", "carol-2"]);
    expect(await harness.snapshot(WebhookReceiptsDoc, context)).toEqual(before.receipts);

    // The copied values are the official store's; a new script reads them.
    expect((await harness.snapshot(CodemodeStoreDoc, alice, context))?.values).toEqual({ plan: { step: 2, items: ["甲", "乙"] }, note: "旧 store 值" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code: `return [load("plan"), load("note"), load("pending") ?? null];` }, { id: "cm-new" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("好的"),
    ]);
    await (await aliceConversation.submit({ type: "input", content: "读旧值" }, context)).wait(context);
    const loaded = (await resultOf(aliceConversation, "cm-new"))!;
    expect(loaded.isError).toBe(false);
    expect(JSON.parse(loaded.text.split("\n").at(-1)!)).toEqual([{ step: 2, items: ["甲", "乙"] }, "旧 store 值", null]);
  } finally { ledger.close(); await opened.close(); }
}, 60_000);
