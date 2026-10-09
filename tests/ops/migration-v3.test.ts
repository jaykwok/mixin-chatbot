// Data version 3 (scripts/migrations/v3.ts): the members' Pi session files become Durable conversations. The active
// context with its tool pairing, the codemode store of the active path, attribution through the storage identity, a
// torn final line, idempotent re-runs, rollback, the statistics floor, and the service continuing an imported
// conversation. Faux providers only; no network.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, type EntryRecord, Harness, type ModelRef, ProviderDoc } from "@earendil-works/pi-durable";
import { apply, commit, preview, rollback } from "../../scripts/migrations/lib/runner.ts";
import { migrationBudget } from "../helpers/migration-budget.ts";
import { json, publishJson } from "../../scripts/migrations/lib/io.ts";
import * as frozen from "../../scripts/migrations/lib/durable.ts";
import { v3 } from "../../scripts/migrations/v3.ts";
import { DeliveryStore } from "../../src/agent/delivery-store.ts";
import { openStatsLedger, readLedger, sweepSessionStats } from "../../src/agent/stats-ledger.ts";
import { inspectDataVersion } from "../../src/core/data-version.ts";
import { CodemodeStoreDoc } from "../../src/durable/codemode/index.ts";
import { groupDatabasePath } from "../../src/durable/groups.ts";
import { GroupDoc, IdentityDoc, MemberDirectory } from "../../src/durable/identity.ts";
import type { ModelSelection } from "../../src/durable/models.ts";
import { LegacyImportDoc } from "../../src/durable/projection.ts";
import { DurableService, type Outbound } from "../../src/durable/service.ts";
import { openGroupStorage } from "../../src/durable/sqlite.ts";
import { fauxModels, harnessOptions, TEST_PROGRESS } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

async function fixture() {
  const files = await tempFixture("migration-v3-");
  const groups = join(files.root, "external-groups");
  await mkdir(groups);
  await publishJson(join(files.root, "data/config/runtime.json"), { GROUP_DATA_ROOT: groups });
  await publishJson(join(files.root, "data/config/models.json"), { providers: { fixture: {
    baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-key", models: [{
      id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } });
  await publishJson(join(files.root, "data/runtime/pi/settings.json"), { defaultProvider: "fixture", defaultModel: "test", cacheWarming: "idle" });
  await mkdir(join(files.root, "data/state"), { recursive: true });
  return { ...files, context: { project: files.root, groups, decisions: {} } };
}

const at = (minute: number) => Date.UTC(2026, 8, 20, 1, minute);
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.15 } };
const assistant = (minute: number, content: unknown[], stopReason = "stop") =>
  ({ role: "assistant", api: "openai-completions", provider: "fixture", model: "test", content, usage, stopReason, timestamp: at(minute) });
const message = (id: string, parentId: string | null, minute: number, body: Record<string, unknown>) =>
  ({ type: "message", id, parentId, timestamp: new Date(at(minute)).toISOString(), message: { timestamp: at(minute), ...body } });
const store = (id: string, parentId: string, set: Record<string, unknown>, remove: string[] = []) =>
  ({ type: "custom", id, parentId, timestamp: new Date(at(0)).toISOString(), customType: "codemode-store", data: { set, delete: remove } });
const header = (id: string) => ({ type: "session", version: 3, id, timestamp: new Date(at(0)).toISOString(), cwd: "/legacy" });

/** Alice: a tool turn, a store, an abandoned branch and a second turn on the active path. */
const ALICE = [
  header("s-alice"),
  message("a1", null, 1, { role: "user", content: [{ type: "text", text: "第一问" }] }),
  message("a2", "a1", 2, assistant(2, [{ type: "thinking", thinking: "想一想" }, { type: "toolCall", id: "call-1", name: "codemode", arguments: { code: "1" } }], "toolUse")),
  message("a3", "a2", 3, { role: "toolResult", toolCallId: "call-1", toolName: "codemode", content: [{ type: "text", text: "脚本结果" }], isError: false }),
  store("a4", "a3", { kept: 1, gone: 2 }),
  message("a5", "a4", 4, assistant(4, [{ type: "text", text: "第一答" }])),
  message("b1", "a5", 5, { role: "user", content: [{ type: "text", text: "被放弃的分支" }] }),
  store("b2", "b1", { branch: true }),
  store("a6", "a5", {}, ["gone"]),
  message("a7", "a6", 6, { role: "user", content: "第二问" }),
  message("a8", "a7", 7, assistant(7, [{ type: "text", text: "第二答" }])),
];
/** Bob: a call without its result, a line that is not an object, a result without its call, a final line cut off by a crash. */
const BOB = [
  header("s-bob"),
  message("c1", null, 1, { role: "user", content: [{ type: "text", text: "帮我查" }] }),
  message("c2", "c1", 2, assistant(2, [{ type: "toolCall", id: "call-x", name: "read", arguments: { path: "a" } }], "toolUse")),
  "{broken",
  message("c3", "c2", 3, { role: "toolResult", toolCallId: "call-elsewhere", toolName: "read", content: [{ type: "text", text: "孤立结果" }], isError: false }),
];
const PHONE = "+86 13800000003";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function write(groups: string, source: string, entries: unknown[], tail = ""): Promise<string> {
  const path = join(groups, source);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n" + tail);
  return path;
}

async function legacy(groups: string, project: string) {
  const files = {
    alice: await write(groups, "g1/users/alice/session.jsonl", ALICE),
    bob: await write(groups, "g1/users/bob/session.jsonl", BOB, '{"type":"message","id":"c4","parentId":"c3","mess'),
    hashed: await write(groups, `g1/users/sha256-user-${sha(PHONE)}/session.jsonl`, [header("s-h"),
      message("h1", null, 1, { role: "user", content: "哈希目录的成员" }), message("h2", "h1", 2, assistant(2, [{ type: "text", text: "好" }]))]),
    unknown: await write(groups, `g1/users/sha256-user-${"0".repeat(64)}/session.jsonl`, [header("s-u"), message("u1", null, 1, { role: "user", content: "无主" })]),
  };
  // The storage identity the old service recorded, under a different (moved) root.
  const db = new Database(join(project, "data/state/agent.sqlite"));
  try {
    db.exec("CREATE TABLE storage_identity (path TEXT PRIMARY KEY COLLATE NOCASE, identity TEXT NOT NULL)");
    db.query("INSERT INTO storage_identity VALUES (?, ?)").run("/old-root/g1", "g1");
    db.query("INSERT INTO storage_identity VALUES (?, ?)").run(`/old-root/g1/users/sha256-user-${sha(PHONE)}`, JSON.stringify(["g1", PHONE]));
  } finally { db.close(); }
  // Data registered at version 2: only v3 runs (v1, frozen, refuses any broken line, a torn final one included).
  for (const marker of [join(project, "data/state/data-version.json"), join(groups, "data-version.json")]) {
    await publishJson(marker, { dataVersion: 2, transaction: "fixture-v2" });
  }
  return files;
}

async function withHarness<T>(groups: string, use: (harness: Harness) => Promise<T>): Promise<T> {
  const { models } = fauxModels();
  const harness = await Harness.open(await openGroupStorage(groupDatabasePath(groups, "g1")), harnessOptions(models)(), context);
  try { return await use(harness); } finally { await harness.close(context); }
}

async function memberEntries(harness: Harness, phone: string) {
  const member = await harness.snapshot(MemberDirectory, phone, context);
  const id = member!.conversationId as ConversationId;
  const conversation = (await harness.conversation(id, context))!;
  const entries: EntryRecord[] = [];
  let cursor: Parameters<typeof conversation.entries>[2];
  for (;;) {
    const page = await conversation.entries({}, 200, cursor, context);
    entries.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return { id, entries: entries.sort((a, b) => (a.id as number) - (b.id as number)) };
}

const legacyMessage = (entry: unknown) => (entry as { message: Message }).message;

test("v3 imports each attributed member's active context, store and import record, once; files stay; unattributed ones are reported", async () => {
  const f = await fixture(), c = f.context;
  try {
    const files = await legacy(c.groups, f.root);
    const before = await Promise.all(Object.values(files).map((path) => readFile(path)));
    const plan = (await preview(c)).plan!;
    expect(plan.steps.some((step) => step.includes("把 1 个群 4 位成员的当前会话导入"))).toBe(true);
    expect(plan.steps).toContain("缓存保温（cacheWarming）改为 off：Durable 引擎不支持");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) expect(plan.files).toContain(join(c.groups, "g1", "durable.sqlite" + suffix));
    const reports: string[] = [];
    await apply({ ...c, report: (stage, detail) => { if (stage === "durable-import") reports.push(detail); } }, plan);
    expect(reports).toEqual([
      `skipped=g1/users/sha256-user-${"0".repeat(64)}/session.jsonl; reason=无法确认成员身份`,
      "imported=g1/users/alice/session.jsonl; messages=6",
      "imported=g1/users/bob/session.jsonl; messages=3; bad-lines=1; torn-tail; unanswered-calls=1; orphan-results=1; interrupted",
      `imported=g1/users/sha256-user-${sha(PHONE)}/session.jsonl; messages=2`,
    ]);
    expect((await json(join(f.root, "data/runtime/pi/settings.json")))?.cacheWarming).toBeUndefined();
    await withHarness(c.groups, async (harness) => {
      expect((await harness.snapshot(GroupDoc, context))?.groupId).toBe("g1");
      const alice = await memberEntries(harness, "alice");
      expect(alice.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant", "pi.user", "pi.assistant"]);
      expect(alice.entries.map((entry) => entry.model![0])).toEqual(["a1", "a2", "a3", "a5", "a7", "a8"]
        .map((id) => legacyMessage(ALICE.find((entry) => (entry as { id?: string }).id === id))) as never);
      expect(alice.entries[2]!.data).toEqual({ diagnostics: [] });
      expect((await harness.snapshot(CodemodeStoreDoc, alice.id, context))?.values).toEqual({ kept: 1 });
      expect(await harness.snapshot(IdentityDoc, alice.id, context)).toEqual({ groupId: "g1", phone: "alice", version: 1 });
      expect(await harness.snapshot(ProviderDoc, alice.id, context)).toBeDefined();
      expect(await harness.snapshot(LegacyImportDoc, alice.id, context)).toMatchObject({
        source: "g1/users/alice/session.jsonl", sha256: sha(before[0]!.toString()), entries: 6, through: alice.entries.at(-1)!.id, interrupted: false,
      });
      const bob = await memberEntries(harness, "bob");
      expect(bob.entries.map((entry) => entry.model![0]!.role)).toEqual(["user", "assistant", "toolResult"]);
      expect(bob.entries[2]!.model![0]).toMatchObject({ role: "toolResult", toolCallId: "call-x", toolName: "read", isError: true, timestamp: at(2) });
      expect(JSON.stringify(bob.entries[2]!.model![0])).toContain("升级前的旧会话里");
      expect((await harness.snapshot(LegacyImportDoc, bob.id, context))?.interrupted).toBe(true);
      expect((await memberEntries(harness, PHONE)).entries).toHaveLength(2);
      expect(await harness.snapshot(MemberDirectory, "0".repeat(64), context)).toBeUndefined();
    });
    // Re-running the step (an interrupted transaction continues from the start) imports nothing twice.
    const again: string[] = [];
    await v3.apply({ ...c, report: (stage, detail) => { if (stage === "durable-import") again.push(detail.split(";")[0]!); } });
    expect(again).toEqual([`skipped=g1/users/sha256-user-${"0".repeat(64)}/session.jsonl`,
      "already-imported=g1/users/alice/session.jsonl", "already-imported=g1/users/bob/session.jsonl",
      `already-imported=g1/users/sha256-user-${sha(PHONE)}/session.jsonl`]);
    await withHarness(c.groups, async (harness) => expect((await memberEntries(harness, "alice")).entries).toHaveLength(6));
    await commit(c);
    expect(inspectDataVersion(c.project, c.groups).current).toBe(true);
    expect(await Promise.all(Object.values(files).map((path) => readFile(path)))).toEqual(before);
    // A file changed after its import is not silently re-imported.
    await writeFile(files.alice, before[0]!.toString() + JSON.stringify(message("a9", "a8", 9, { role: "user", content: "后加" })) + "\n");
    await expect(v3.validate(c)).rejects.toThrow("会话没有按当前文件导入：g1/users/alice/session.jsonl");
    await expect(v3.apply(c)).rejects.toThrow("不是由这份会话文件导入的");
  } finally { await f.cleanup(); }
}, migrationBudget(3, 60_000));

test("0.87.1 golden history keeps 1.741503 through import, validate, cold reopen, continue, compact, clear and deliver", async () => {
  const f = await fixture(), c = f.context, legacyPath = join(c.groups, "golden/users/member/session.jsonl");
  const bytes = (await readFile(new URL("../fixtures/pi-0.87.1-session.jsonl", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const stateDb = new Database(":memory:"), deliveries = new DeliveryStore(stateDb), { faux, models, model } = fauxModels();
  let delivered = false, requests = 0;
  const texts: string[] = [], replies: string[] = [];
  const outbound: Outbound = { sendText: async text => { texts.push(text); return true; },
    sendReply: async text => { replies.push(text); return delivered; }, rate: () => ({ used: 0, limit: 20 }), refresh: async item => item.text };
  const open = () => new DurableService({ root: c.groups, stateDb, deliveries, modules: [], relay: null, materials: false, outbound,
    limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 10 },
    selection: { ...selection(models, model), harnessSettings: { ...selection(models, model).harnessSettings,
      compaction: { enabled: false, keepRecentTokens: 1 } } } });
  let service: DurableService | undefined;
  const total = () => { const ledger = openStatsLedger(c.groups);
    try { return readLedger(ledger).usage.reduce((value, row) => value + row.cost, 0); } finally { ledger.close(); } };
  try {
    await mkdir(dirname(legacyPath), { recursive: true }); await writeFile(legacyPath, bytes);
    for (const path of [join(f.root, "data/state/data-version.json"), join(c.groups, "data-version.json")]) await publishJson(path, { dataVersion: 2, transaction: "golden-v2" });
    await sweepSessionStats(c.groups, { force: true }); expect(total()).toBeCloseTo(1.741503, 9);
    await apply(c, (await preview(c)).plan!); await commit(c); expect(inspectDataVersion(f.root, c.groups).current).toBe(true);
    expect(total()).toBeCloseTo(1.741503, 9);
    faux.setResponses([transcript => {
      requests++; const seen = JSON.stringify(transcript.messages);
      expect(seen).toContain("SUMMARY_0871"); expect(seen).toContain("WARM_TURN_0871"); expect(seen).not.toContain("FAILED_ATTEMPT_0871");
      return fauxAssistantMessage("golden continued");
    }, () => { requests++; return fauxAssistantMessage("golden summary"); }]);
    service = open(); await service.start(); await service.admit("member", "golden", "continue the 0.87.1 history", "https://example.invalid/callback");
    const deadline = Date.now() + 10_000;
    while ((!deliveries.pending(JSON.stringify(["golden", "member"])).length || !replies.length) && Date.now() < deadline) await Bun.sleep(10);
    expect(replies).toEqual(["golden continued"]); expect(total()).toBeCloseTo(1.741503, 9);
    await service.close(); service = open(); await service.start();
    expect(await service.control("member", "golden", "/compact", "https://example.invalid/callback")).toContain("压缩已完成");
    await service.control("member", "golden", "/clear", "https://example.invalid/callback");
    expect(deliveries.pending(JSON.stringify(["golden", "member"]))).toHaveLength(1);
    delivered = true; await service.control("member", "golden", "/deliver", "https://example.invalid/callback");
    expect(texts).toContain("golden continued"); expect(deliveries.pending(JSON.stringify(["golden", "member"]))).toEqual([]);
    expect(requests).toBe(2); expect(total()).toBeCloseTo(1.741503, 9);
    expect(await readFile(legacyPath, "utf8")).toBe(bytes);
    await service.close(); service = undefined;
    await sweepSessionStats(c.groups, { force: true }); expect(total()).toBeCloseTo(1.741503, 9);
  } finally { await service?.close(); stateDb.close(); await f.cleanup(); }
}, migrationBudget(3, 60_000));

test("v3 before commit rolls back to no group database and the original settings; an unreadable header or store record stops the preview", async () => {
  const f = await fixture(), c = f.context;
  try {
    await legacy(c.groups, f.root);
    const settings = await readFile(join(f.root, "data/runtime/pi/settings.json"));
    await apply(c, (await preview(c)).plan!);
    expect(await Bun.file(join(c.groups, "g1/durable.sqlite")).exists()).toBe(true);
    expect(await rollback(c)).toBe(true);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) expect(await Bun.file(join(c.groups, "g1/durable.sqlite" + suffix)).exists()).toBe(false);
    expect(await readFile(join(f.root, "data/runtime/pi/settings.json"))).toEqual(settings);
    const broken = join(c.groups, "g2/users/carol/session.jsonl");
    await mkdir(dirname(broken), { recursive: true });
    await writeFile(broken, ["{broken", JSON.stringify(message("d1", null, 1, { role: "user", content: "x" }))].join("\n") + "\n");
    await expect(preview(c)).rejects.toThrow("会话头格式无法识别：g2/users/carol/session.jsonl");
    await writeFile(broken, [JSON.stringify(header("s-c")), JSON.stringify(store("d1", "x", { a: 1 })),
      JSON.stringify({ type: "custom", id: "d2", parentId: "d1", customType: "codemode-store", data: { set: [] } })].join("\n") + "\n");
    await expect(preview(c)).rejects.toThrow("codemode store 记录无法识别");
  } finally { await f.cleanup(); }
}, migrationBudget(4));

test("the migration's frozen documents match the service's definitions", () => {
  const shape = (token: unknown) => {
    const { initial, ...rest } = (token as { definition: { initial: (seed?: unknown) => unknown } }).definition;
    return { ...rest, initial: JSON.stringify(initial({ conversationId: 0, createdAt: 0 })) };
  };
  expect(shape(frozen.GroupDoc)).toEqual(shape(GroupDoc));
  expect(shape(frozen.MemberDirectory)).toEqual(shape(MemberDirectory));
  expect(shape(frozen.IdentityDoc)).toEqual(shape(IdentityDoc));
  expect(shape(frozen.CodemodeStoreDoc)).toEqual(shape(CodemodeStoreDoc));
  expect(shape(frozen.LegacyImportDoc)).toEqual(shape(LegacyImportDoc));
});

function selection(models: Models, ref: ModelRef): ModelSelection {
  return {
    runtime: models as never, settings: undefined as never, model: models.getModel(ref.provider, ref.modelId)! as never, ref, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) },
    notices: [],
  };
}

test("the service continues an imported conversation with its history; only the new answer is counted", async () => {
  const f = await fixture(), c = f.context;
  try {
    await legacy(c.groups, f.root);
    await apply(c, (await preview(c)).plan!);
    await commit(c);
    const { faux, models, model } = fauxModels();
    const transcripts: Message[][] = [];
    const answer: FauxResponseFactory = (transcript) => {
      transcripts.push(transcript.messages as Message[]);
      return fauxAssistantMessage("第三答") as AssistantMessage;
    };
    faux.setResponses([answer]);
    const replies: string[] = [];
    const outbound: Outbound = {
      sendText: async () => true,
      sendReply: async (text) => { replies.push(text); return true; },
      rate: () => ({ used: 0, limit: 20 }),
      refresh: async (item) => item.text,
    };
    const stateDb = new Database(":memory:");
    const service = new DurableService({
      root: c.groups, selection: selection(models, model), modules: [], relay: null, materials: false,
      limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 },
      outbound, deliveries: new DeliveryStore(stateDb), stateDb,
    });
    try {
      await service.start();
      expect((await service.admit("alice", "g1", "第三问", "https://example.invalid/callback?key=synthetic")).status).toBe("accepted");
      const deadline = Date.now() + 10_000;
      while (!replies.length && Date.now() < deadline) await Bun.sleep(10);
      expect(replies).toEqual(["第三答"]);
    } finally { await service.close(); stateDb.close(); }
    const seen = transcripts[0]!.filter((item) => (item.role as string) !== "system");
    expect(seen.map((item) => item.role)).toEqual(["user", "assistant", "toolResult", "assistant", "user", "assistant", "user"]);
    expect(JSON.stringify(seen.at(-1))).toContain("第三问");
    const ledger = openStatsLedger(c.groups);
    try {
      const rows = readLedger(ledger);
      expect(rows.usage.map(({ kind, requests }) => ({ kind, requests }))).toEqual([{ kind: "assistant", requests: 1 }]);
      expect(rows.activity.map(({ user, asks, replies: answered }) => ({ user, asks, replies: answered }))).toEqual([{ user: "alice", asks: 1, replies: 1 }]);
    } finally { ledger.close(); }
  } finally { await f.cleanup(); }
}, migrationBudget(3, 60_000));
