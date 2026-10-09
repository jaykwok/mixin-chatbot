import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { configure, createRegistry, Harness, type Conversation, type Storage } from "@earendil-works/pi-durable";
import { SqliteStorage, type SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite";
import { claimGroup, memberConversation } from "../../src/durable/identity.ts";
import { groupDoor } from "../../src/durable/models.ts";
import { openGroupDatabase } from "../../src/durable/sqlite.ts";
import { fauxModels } from "../helpers/durable.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-cache-"); afterAll(() => fixture.cleanup());
let n = 0;
async function open(retention: number, path = join(fixture.root, `cache-${++n}.sqlite`)) {
  const counts = { sql: 0, pages: 0, rows: 0 };
  const countSql = <T extends SqliteExecutor>(executor: T): T => new Proxy(executor, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "get" || key === "all") return (...args: unknown[]) => { counts.sql++; return Reflect.apply(value as Function, target, args); };
    if (key === "transaction") return (work: (tx: SqliteExecutor) => Promise<unknown>) => Reflect.apply(value as Function, target, [(tx: SqliteExecutor) => work(countSql(tx))]);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const db = await openGroupDatabase(path), native = await SqliteStorage.open(countSql(db));
  const storage: Storage = new Proxy(native, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "scanEntries") return async (...args: unknown[]) => { const page = await value.apply(target, args); counts.pages++; counts.rows += page.items.length; return page; };
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const { faux, models, model } = fauxModels();
  const holder: { harness?: Harness } = {}, door = groupDoor(holder), registry = createRegistry(); registry.install(door.extension());
  const harness = await Harness.open(storage, { models: door.wrap(models), registry,
    settings: { contextRetentionMs: retention, compaction: { enabled: false, keepRecentTokens: 100 }, retry: { maxRetries: 0 } } }, context);
  holder.harness = harness; await claimGroup(harness, "g", context);
  const reset = () => { counts.sql = counts.pages = counts.rows = 0; };
  const member = async (phone = "alice") => (await memberConversation(harness, "g", phone, { model }, context)).conversation;
  const ask = async (conversation: Conversation) => {
    let messages: Message[] = [];
    faux.setResponses([(transcript) => { messages = structuredClone(transcript.messages); return fauxAssistantMessage("reply"); }]);
    const from = performance.now();
    await (await conversation.submit({ type: "input", content: "next" }, context)).wait(context);
    await conversation.waitForIdle(context);
    return { messages, ms: performance.now() - from, ...counts };
  };
  return { harness, door, faux, path, counts, reset, member, ask, async close() { await door.close(); await harness.close(context); } };
}
async function seed(g: Awaited<ReturnType<typeof open>>, conversation: Conversation, count: number, chars = 160) {
  await g.harness.commit(async tx => {
    await configure(tx, conversation.id, { instructions: "cache fixture" });
    for (let i = 0; i < count; i++) await tx.appendEntry(conversation.id, { kind: "pi.user", model: [{ role: "user", content: `history-${i}:` + "x".repeat(chars), timestamp: 1000 + i }] });
  }, context);
}

test("official cache scans only additions, preserves system-first requests and independent context views", async () => {
  const g = await open(600000), conversation = await g.member();
  try {
    await seed(g, conversation, 1050); g.reset();
    const first = await g.ask(conversation); expect(first.messages[0]!.role).toBe("system"); expect(first.rows).toBeGreaterThan(1050);
    g.reset(); const warm = await g.ask(conversation);
    expect(warm.pages).toBeLessThan(first.pages); expect(warm.rows).toBeLessThan(30); expect(warm.sql).toBeLessThan(first.sql);
    const one = await conversation.context(context); (one.messages as Message[]).splice(0); (one.entries as unknown[]).splice(0);
    g.reset(); const two = await conversation.context(context);
    expect(two.messages[0]!.role).toBe("system"); expect(two.messages).toHaveLength(warm.messages.length + 1);
    expect(g.counts.rows).toBeGreaterThan(1050); // Public read views intentionally have their own uncached scan.
    const target = two.entries.find(entry => entry.kind === "pi.user")!;
    await g.harness.commit(tx => tx.appendEntry(conversation.id, { kind: "fixture.edit", edits: [{ target: target.id, action: "replace",
      messages: [{ role: "user", content: "edited-history", timestamp: 1000 }] }] }), context);
    const edited = await g.ask(conversation);
    expect(edited.messages.some(message => message.role === "user" && message.content === "edited-history")).toBe(true);
    expect(edited.messages.some(message => message.role === "user" && String(message.content).startsWith("history-0:"))).toBe(false);
    const fork = await conversation.fork(target.id, { ownership: { kind: "ownerless" } }, context);
    expect((await fork.context(context)).messages).toEqual((await conversation.context(context, { at: target.id })).messages);
    g.faux.setResponses([fauxAssistantMessage("summary")]);
    const compact = await conversation.compact(undefined, context); await g.harness.waitForTask(compact, context);
    const compacted = await g.ask(conversation);
    // Pi only moves a system message preceded exclusively by users. A retained assistant after compaction keeps
    // the positional baseline later; verify cache coherence against the official independent view in this case.
    expect(compacted.messages.some(message => message.role === "system")).toBe(true);
    expect(compacted.messages).toEqual((await conversation.context(context)).messages.slice(0, -1));
    expect(compacted.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("<summary>"))).toBe(true);
    await conversation.reset("handoff", context);
    const reset = await g.ask(conversation);
    expect(reset.messages[0]!.role).toBe("system"); expect(reset.messages.some(message => message.role === "user" && String(message.content).startsWith("history-"))).toBe(false);
    console.log("Pi 1.1 context scan: " + JSON.stringify({ first: { pages: first.pages, rows: first.rows, sql: first.sql, ms: first.ms }, warm: { pages: warm.pages, rows: warm.rows, sql: warm.sql, ms: warm.ms } }));
  } finally { await g.close(); }
  const reopened = await open(600000, g.path);
  try { const cold = await reopened.ask(await reopened.member()); expect(cold.messages[0]!.role).toBe("system"); expect(cold.messages.some(message => message.role === "user" && message.content === "handoff")).toBe(true); }
  finally { await reopened.close(); }
}, 30000);

test("retention zero and ten minutes produce the same requests; measure multi-member memory and control latency", async () => {
  const reports: Record<string, unknown>[] = [], requests: Message[][] = [];
  for (const retention of [0, 600000]) {
    const g = await open(retention), members: Conversation[] = [];
    let tick = performance.now(), delay = 0;
    const sample = setInterval(() => { const now = performance.now(); delay = Math.max(delay, now - tick - 5); tick = now; }, 5);
    try {
      Bun.gc(true); const before = process.memoryUsage();
      for (let i = 0; i < 16; i++) { const conversation = await g.member(`member-${i}`); members.push(conversation); await seed(g, conversation, 400); await g.ask(conversation); }
      await Bun.sleep(5); g.reset(); const warm = await g.ask(members[0]!);
      requests.push(warm.messages.map(message => ({ ...message, timestamp: 0, ...(message.role === "assistant" ? { api: "faux", durationMs: 0 } : {}) })) as Message[]);
      Bun.gc(true); const after = process.memoryUsage();
      const from = performance.now(); await members[0]!.abort(context); const controlMs = performance.now() - from;
      reports.push({ retention, members: members.length, entriesPerMember: 400, pages: warm.pages, rows: warm.rows, sqlReads: warm.sql,
        requestCycleMs: warm.ms, maxEventLoopDelayMs: delay, controlMs, rssDelta: after.rss - before.rss, heapDelta: after.heapUsed - before.heapUsed });
    } finally { clearInterval(sample); await g.close(); }
  }
  expect(requests[0]).toEqual(requests[1]);
  expect((reports[1]!.rows as number)).toBeLessThan(reports[0]!.rows as number);
  console.log("Pi 1.1 cache workload: " + JSON.stringify(reports));
}, 60000);
