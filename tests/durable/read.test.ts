// The console's read channel (src/durable/read/): the real service writes two spaces with faux models while the reads
// run through the real worker on read-only connections; the route maps failures to answers. Synthetic data only.
import { afterAll, beforeAll, describe, spyOn, test } from "bun:test";
import { expectAsync as expect } from "../helpers/async-expect.ts";
import { Database } from "bun:sqlite";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { appLayout } from "../../src/core/layout.ts";
import { DurableService } from "../../src/durable/service.ts";
import { ReadBusy, ReadChannel, readStatus } from "../../src/durable/read/client.ts";
import { parseReadOp, type ReadOp } from "../../src/durable/read/protocol.ts";
import * as q from "../../src/durable/read/queries.ts";
import { PushStore } from "../../src/push/store.ts";
import { createApp } from "../../src/server/http-app.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("durable-read-");
const ALICE = "13800000001", BOB = "13800000002", CAROL = "13800000003";
const root = join(fixture.root, "data");
const layout = appLayout(root);
const statePath = join(root, "state", "agent.sqlite");
const { faux, models, model } = fauxModels();
const out = recordingOutbound();
const m = models.getModel(model.provider, model.modelId)!;
const service = new DurableService({
  layout, modules: [], relay: null, materials: false, outbound: out.outbound, onReport: () => {},
  selection: { runtime: models as never, settings: undefined as never, model: { ...m, contextWindow: 128000 } as never, ref: model, thinkingLevel: "off",
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 20 }, ...(TEST_PROGRESS === undefined ? {} : { progress: TEST_PROGRESS }) } },
  limits: { runTimeoutMs: 60_000, modelIdleMs: 60_000, modelResponseMs: 60_000, tickMs: 20 },
});
let channel: ReadChannel;
let serviceOpen = true;

async function until(probe: () => boolean, label: string) {
  const deadline = Date.now() + 20_000;
  while (!probe()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`); await Bun.sleep(10); }
}
async function ask(space: string, phone: string, text: string, answers: Parameters<typeof faux.setResponses>[0]) {
  faux.setResponses(answers);
  const before = replyTexts(out.sent).length;
  await service.admit(out.message(space, phone, text));
  await until(() => replyTexts(out.sent).length > before, text);
}

type Spaces = { spaces: { space: string; state: string; key?: string; generation?: string; members?: number; lastAt?: number | null }[] };
type Members = { items: q.MemberInfo[]; next: number | null };
const read = <T>(op: ReadOp) => channel.run(op) as Promise<T>;
let direct: { space: string; generation: string };
let alice: q.MemberInfo;

beforeAll(async () => {
  await ask("direct", ALICE, "你好，帮我总结周报 Quarterly", [fauxAssistantMessage("这是**总结**。")]);
  await ask("direct", ALICE, "查一下天气", [fauxAssistantMessage([fauxToolCall("bash", { command: "echo sunny" })], { stopReason: "toolUse" }), fauxAssistantMessage("天气晴。")]);
  await service.control(out.message("direct", ALICE, "/clear"));
  await ask("direct", ALICE, "清空之后的问题", [fauxAssistantMessage("新的回答")]);
  await ask("direct", BOB, "<script>alert(1)</script>", [fauxAssistantMessage("收到")]);
  await ask("100", ALICE, "群里的问题", [fauxAssistantMessage("群里的回答")]);
  await mkdir(join(root, "state"), { recursive: true });
  const names = new Database(statePath, { create: true, strict: true });
  names.exec("CREATE TABLE member_directory (phone TEXT PRIMARY KEY, im_user_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_verified_at INTEGER NOT NULL) STRICT");
  names.query("INSERT INTO member_directory VALUES (?, ?, ?, ?)").run(ALICE, "im-a", "张三", 1);
  names.close();
  channel = new ReadChannel({ conversations: layout.conversations, state: statePath });
  const spaces = await read<Spaces>({ op: "spaces" });
  const found = spaces.spaces.find(space => space.space === "direct")!;
  direct = { space: "direct", generation: found.generation! };
  alice = (await read<Members>({ op: "members", ...direct, after: 0, limit: 10 })).items.find(member => member.phone === ALICE)!;
});
afterAll(async () => {
  await channel?.close();
  if (serviceOpen) await service.close();
  await fixture.cleanup();
});

describe("read channel against a running service", () => {
  test("lists the spaces with their recorded key, generation and members", async () => {
    const { spaces } = await read<Spaces>({ op: "spaces" });
    expect(spaces.map(space => [space.space, space.state, space.key, space.members])).toEqual([["direct", "ready", "direct", 2], ["groups/100", "ready", "group:100", 1]]);
    expect(spaces.every(space => typeof space.lastAt === "number" && /^[0-9a-f-]{36}$/.test(space.generation!))).toBe(true);
  });

  test("pages members by document id", async () => {
    const first = await read<Members>({ op: "members", ...direct, after: 0, limit: 1 });
    expect(first.items.length).toBe(1);
    expect(first.next).toBe(first.items[0]!.document);
    const second = await read<Members>({ op: "members", ...direct, after: first.next!, limit: 1 });
    expect([...first.items, ...second.items].map(member => member.phone).sort()).toEqual([ALICE, BOB]);
    expect(second.next).toBeNull();
  });

  test("pages entries both ways, keeps the reset, and stops at the upper bound", async () => {
    const all: q.EntryView[] = [];
    let cursor: number | null = null;
    do {
      const page: q.EntryPage = await read<q.EntryPage>({ op: "entries", ...direct, conversation: alice.conversationId, older: false, cursor, upper: null, limit: 3 });
      all.push(...page.items); cursor = page.next;
    } while (cursor !== null);
    const kinds = all.map(entry => entry.kind);
    expect(kinds.filter(kind => kind === "pi.user").length).toBe(3);
    const reset = all.find(entry => entry.kind === "pi.reset")!;
    expect(reset.head).toBe(reset.id);
    expect(all.some(entry => entry.parts.some(part => part.type === "toolCall" && part.name === "bash" && part.arguments.includes("echo sunny")))).toBe(true);
    const result = all.find(entry => entry.kind === "pi.tool-result")!;
    expect(result.tool?.name).toBe("bash");
    expect(result.tool?.isError).toBe(false);
    // Newest first gives the same entries in reverse.
    const newest = await read<q.EntryPage>({ op: "entries", ...direct, conversation: alice.conversationId, older: true, cursor: null, upper: null, limit: 200 });
    expect(newest.items.map(entry => entry.id)).toEqual(all.map(entry => entry.id).reverse());
    // An upper bound fixes the range even after more entries arrive.
    const upper = all.at(-1)!.id;
    await ask("direct", ALICE, "上界之后的问题", [fauxAssistantMessage("上界之后的回答")]);
    const bounded = await read<q.EntryPage>({ op: "entries", ...direct, conversation: alice.conversationId, older: false, cursor: null, upper, limit: 200 });
    expect(bounded.items.map(entry => entry.id)).toEqual(all.map(entry => entry.id));
    const bounds = await read<{ upper: Record<string, number> }>({ op: "bounds", ...direct, conversations: [alice.conversationId] });
    expect(bounds.upper[alice.conversationId]! > upper).toBe(true);
  });

  test("summarizes system prompts in pages and gives them whole on their own", async () => {
    const page = await read<q.EntryPage>({ op: "entries", ...direct, conversation: alice.conversationId, older: false, cursor: null, upper: null, limit: 200 });
    const system = page.items.find(entry => entry.role === "system")!;
    expect(system.parts.length).toBe(0);
    expect(system.system!.sections.length > 0 && system.system!.chars > 1000).toBe(true);
    const whole = await read<{ entry: q.EntryView }>({ op: "entry", ...direct, conversation: alice.conversationId, id: system.id });
    expect(whole.entry.parts[0]?.type === "text" && whole.entry.parts[0].text.length > 1000).toBe(true);
    // Another member's conversation does not hand it out.
    const bob = (await read<Members>({ op: "members", ...direct, after: 0, limit: 10 })).items.find(member => member.phone === BOB)!;
    expect((await read<{ entry: unknown }>({ op: "entry", ...direct, conversation: bob.conversationId, id: system.id })).entry).toBeNull();
  });

  test("lists the reset among the generation boundaries", async () => {
    const result = await read<{ items: { kind: string }[] }>({ op: "boundaries", ...direct, conversation: alice.conversationId, after: 0, limit: 10 });
    expect(result.items.map(item => item.kind)).toEqual(["pi.reset"]);
  });

  test("searches message text case-insensitively, skips system prompts, and ends at the start", async () => {
    const hit = await read<{ hits: q.SearchHit[]; next: number | null }>({ op: "search", ...direct, conversation: null, text: "quarterly", cursor: null, upper: null });
    expect(hit.hits.map(h => [h.conversationId, h.kind])).toEqual([[alice.conversationId, "pi.user"]]);
    expect(hit.hits[0]!.snippet.includes("Quarterly")).toBe(true);
    expect(hit.next).toBeNull();
    // Words of the system prompt are not hits.
    expect((await read<{ hits: unknown[] }>({ op: "search", ...direct, conversation: alice.conversationId, text: "资料库", cursor: null, upper: null })).hits.length).toBe(0);
    // A quote turns the raw prefilter off; the match still works on the parsed text.
    expect((await read<{ hits: unknown[] }>({ op: "search", ...direct, conversation: null, text: "\"x", cursor: null, upper: null })).hits.length).toBe(0);
  });

  test("returns the kept run records with delivery states and their entries", async () => {
    const result = await read<{ items: q.RequestView[]; total: number }>({ op: "requests", ...direct, conversation: alice.conversationId, phone: ALICE });
    expect(result.total >= 3).toBe(true);
    const first = result.items.find(item => item.summary.startsWith("你好"))!;
    expect(first.delivery?.parts.map(part => part.state)).toEqual(["sent"]);
    expect(first.status).toBe("done");
    expect(typeof first.entry === "number" && typeof first.answer === "number").toBe(true);
  });

  test("shows when a failed reply is tried again, and why a delivery was given up", async () => {
    out.state.failWhen = sent => sent.phone === CAROL && sent.kind === "reply" ? "failed" : false;
    try {
      faux.setResponses([fauxAssistantMessage("卡罗的回答")]);
      await service.admit(out.message("direct", CAROL, "卡罗的问题"));
      let carol: q.MemberInfo | undefined;
      const record = async () => {
        carol ??= (await read<Members>({ op: "members", ...direct, after: 0, limit: 10 })).items.find(member => member.phone === CAROL);
        if (!carol) return undefined;
        return (await read<{ items: q.RequestView[] }>({ op: "requests", ...direct, conversation: carol.conversationId, phone: CAROL })).items[0];
      };
      let seen: q.RequestView | undefined;
      const deadline = Date.now() + 20_000;
      while (!(seen = await record())?.delivery?.parts.some(part => part.state === "failed" && part.retryAt !== undefined)) {
        if (Date.now() > deadline) throw new Error(`no failed part with a retry: ${JSON.stringify(seen?.delivery)}`);
        await Bun.sleep(20);
      }
      const failed = seen!.delivery!.parts.find(part => part.state === "failed")!;
      expect(failed.retryAt! > Date.now() - 1_000 && failed.attempts >= 1 && failed.error?.includes("synthetic failed")).toBe(true);
      expect([seen!.delivery!.abandoned, seen!.delivery!.abandonedReason]).toEqual([false, undefined]);

      await service.control(out.message("direct", CAROL, "/clear"));
      const given = await record();
      expect([given?.delivery?.abandoned, given?.delivery?.abandonedReason]).toEqual([true, "withdrawn"]);
    } finally {
      delete out.state.failWhen;
    }
  });

  test("looks names up in the directory cache, and nothing when there is no state database", async () => {
    const names = await read<{ found: { phone: string; name: string }[]; observedAt: number }>({ op: "names", phones: [ALICE, BOB] });
    expect(names.found.map(row => [row.phone, row.name])).toEqual([[ALICE, "张三"]]);
    const empty = new ReadChannel({ conversations: layout.conversations, state: join(fixture.root, "missing.sqlite") });
    try { expect(((await empty.run({ op: "names", phones: [ALICE] })) as { found: unknown[] }).found).toEqual([]); }
    finally { await empty.close(); }
  });

  test("gives the named groups by space segment, and none before the push tables exist or without a state database", async () => {
    type Groups = { groups: { segment: string; name: string }[] };
    expect((await read<Groups>({ op: "groups" })).groups).toEqual([]);
    const db = new Database(statePath, { strict: true });
    try {
      const store = new PushStore(db);
      store.groupSeen("100", 1, 0); store.groupSeen("200", 1, 0);
      store.saveGroup("100", { name: "销售一部", state: "registered", registeredAt: 2, registeredBy: null });
    } finally { db.close(); }
    expect((await read<Groups>({ op: "groups" })).groups).toEqual([{ segment: "100", name: "销售一部" }]);
    const empty = new ReadChannel({ conversations: layout.conversations, state: join(fixture.root, "missing.sqlite") });
    try { expect(((await empty.run({ op: "groups" })) as Groups).groups).toEqual([]); }
    finally { await empty.close(); }
    expect(parseReadOp({ op: "groups" })).toEqual({ op: "groups" });
  });

  test("refuses another generation and a space that does not exist", async () => {
    const other = { ...direct, generation: crypto.randomUUID() };
    const changed = await read({ op: "members", ...other, after: 0, limit: 1 }).catch((error: Error) => error) as Error;
    expect([changed.name, readStatus(changed)]).toEqual(["SpaceChanged", 409]);
    const absent = await read({ op: "members", space: "groups/999", generation: direct.generation, after: 0, limit: 1 }).catch((error: Error) => error) as Error;
    expect([absent.name, readStatus(absent)]).toEqual(["SpaceAbsent", 404]);
  });

  test("answers busy past its slots and expired past its deadline", async () => {
    const small = new ReadChannel({ conversations: layout.conversations, state: statePath, slots: 1 });
    try {
      const first = small.run({ op: "spaces" });
      const second = await small.run({ op: "spaces" }).catch(error => error);
      expect(second instanceof ReadBusy).toBe(true);
      await first;
    } finally { await small.close(); }
    const late = new ReadChannel({ conversations: layout.conversations, state: statePath, deadlineMs: -1_000 });
    try {
      const error = await late.run({ op: "spaces" }).catch((error: Error) => error) as Error;
      expect([error.name, readStatus(error)]).toEqual(["ReadExpired", 504]);
    } finally { await late.close(); }
  });

  test("answers at the deadline while a statement still runs; the slot stays taken until a stuck worker is replaced", async () => {
    // A worker inside a long statement: it never gets to the request or to the deadline check between statements.
    const post = Worker.prototype.postMessage;
    const spy = spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, message: unknown, ...rest: never[]) {
      if ((message as { op?: unknown } | null)?.op === undefined) post.call(this, message, ...rest);
    });
    const stuck = new ReadChannel({ conversations: layout.conversations, state: statePath, slots: 1, deadlineMs: 50, stuckMs: 500 });
    try {
      const error = await stuck.run({ op: "spaces" }).catch((error: Error) => error) as Error;
      expect([error.name, readStatus(error)]).toEqual(["ReadExpired", 504]);
      expect(await stuck.run({ op: "spaces" }).catch(error => error) instanceof ReadBusy).toBe(true);
      spy.mockRestore();
      // The replacement worker loads first; on a slow runner that alone can outlast the 50 ms deadline, so an expired
      // answer is retried like a busy one.
      let answer: unknown = new ReadBusy("");
      const again = (value: unknown) => value instanceof ReadBusy || (value as Error | undefined)?.name === "ReadExpired";
      for (const end = Date.now() + 10_000; again(answer) && Date.now() < end;) {
        answer = await stuck.run({ op: "spaces" }).catch(error => error);
        if (again(answer)) await Bun.sleep(50);
      }
      expect((answer as Spaces).spaces.length).toBe(2);
    } finally { spy.mockRestore(); await stuck.close(); }
  });

  test("answers a cancelled caller at once", async () => {
    const controller = new AbortController();
    const pending = channel.run({ op: "spaces" }, controller.signal);
    controller.abort(new Error("caller gone"));
    expect((await pending.catch((error: Error) => error) as Error).message).toBe("caller gone");
    // The channel keeps working afterwards.
    expect(((await read<Spaces>({ op: "spaces" })).spaces.length)).toBe(2);
  });
});

describe("read route", () => {
  const app = () => createApp({ isStopping: () => false, adminToken: "t", shutdown: () => {}, read: channel });
  const post = (body: unknown, token = "t") => app().request("/_admin/read", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("needs the admin token and a well-formed operation", async () => {
    expect((await post({ op: "spaces" }, "wrong")).status).toBe(404);
    const bad = await post({ op: "members", space: "../x", generation: direct.generation });
    expect([bad.status, (await bad.json() as { code: string }).code]).toEqual([400, "ReadRequestError"]);
    expect((await post({ op: "entries", ...direct, conversation: 1, older: true, limit: 999 })).status).toBe(400);
    expect((await post({ op: "drop" })).status).toBe(400);
  });

  test("answers results and maps failures", async () => {
    const ok = await post({ op: "members", ...direct, limit: 5 });
    expect(ok.status).toBe(200);
    const phones = (await ok.json() as { result: { items: { phone: string }[] } }).result.items.map(item => item.phone);
    expect([ALICE, BOB].every(phone => phones.includes(phone))).toBe(true);
    expect((await post({ op: "members", ...direct, generation: crypto.randomUUID(), limit: 5 })).status).toBe(409);
  });
});

describe("read-only", () => {
  test("never changes a database file, and the service's close still truncates the log", async () => {
    const file = join(layout.conversations, "groups", "100", "durable.sqlite");
    await service.close(); serviceOpen = false;
    const before = await readFile(file);
    const spaces = await read<Spaces>({ op: "spaces" });
    const group = spaces.spaces.find(space => space.space === "groups/100")!;
    const conversations = (await read<Members>({ op: "members", space: "groups/100", generation: group.generation!, after: 0, limit: 10 })).items;
    await read({ op: "entries", space: "groups/100", generation: group.generation!, conversation: conversations[0]!.conversationId, older: true, cursor: null, upper: null, limit: 50 });
    expect(Buffer.compare(before, await readFile(file))).toBe(0);
    // No connection is kept between operations: no read transaction outlives its request.
    expect((await stat(file + "-wal").catch(() => undefined))?.size ?? 0).toBe(0);
    await rm(file + "-wal", { force: true }); await rm(file + "-shm", { force: true });
  });

  test("rejects space names outside the conversations root", () => {
    for (const space of ["..", "groups/..", "groups/a/b", "/etc", "groups/con"]) expect(() => parseReadOp({ op: "members", space, generation: crypto.randomUUID() })).toThrow("space");
  });
});

describe("queries", () => {
  test("a guard stops a long document between chunks", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE document_revisions (document_id INTEGER, seq INTEGER, kind TEXT, version INTEGER, content TEXT, PRIMARY KEY (document_id, seq))");
    const insert = db.query("INSERT INTO document_revisions VALUES (1, ?, ?, 1, ?)");
    insert.run(1, "base", JSON.stringify({ n: 0 }));
    for (let i = 2; i < 5000; i++) insert.run(i, "delta", JSON.stringify([["s", ["n"], i]]));
    expect(q.documentValue(db, 1).value).toEqual({ n: 4999 });
    let calls = 0;
    expect(() => q.documentValue(db, 1, () => { if (++calls > 1) throw new Error("stopped"); })).toThrow("stopped");
    expect(calls).toBe(2);
    expect(() => q.documentValue(db, 1, undefined, { revisions: 100, chars: 1e9 })).toThrow("修订链过长");
  });

  test("an image is described, not copied; long texts are cut in pages", () => {
    const record = JSON.stringify({ kind: "pi.user", model: [{ role: "user", timestamp: 5, content: [{ type: "text", text: "x".repeat(q.PAGE_TEXT_CHARS + 10) }, { type: "image", mimeType: "image/png", data: "AAAA".repeat(100) }] }] });
    const view = q.entryView({ id: 1, head: null, record }, q.PAGE_TEXT_CHARS);
    expect(view.parts).toEqual([{ type: "text", text: "x".repeat(q.PAGE_TEXT_CHARS), truncated: q.PAGE_TEXT_CHARS + 10 }, { type: "image", mimeType: "image/png", bytes: 300 }]);
    expect(view.at).toBe(5);
  });

  test("search blocks end where the scan ends", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, head INTEGER, commit_seq INTEGER, record TEXT)");
    for (let i = 1; i <= 7; i++) db.query("INSERT INTO entries VALUES (?, 1, NULL, ?, ?)").run(i, i, JSON.stringify({ kind: "pi.user", model: [{ role: "user", content: i === 2 ? "needle" : "hay", timestamp: i }] }));
    const block = (cursor: number | null) => q.search(db, { ...ANY, conversationId: 1, text: "needle", cursor, upper: null, scan: 3, hits: 10 });
    // 7 6 5 | 4 3 2 | 1: a block without hits still ends and names where the next one starts.
    expect(block(null)).toEqual({ hits: [], scanned: 3, next: 5, terms: ["needle"] });
    const second = block(5);
    expect([second.hits.map(hit => hit.id), second.scanned, second.next]).toEqual([[2], 3, 2]);
    expect(block(2)).toEqual({ hits: [], scanned: 1, next: null, terms: ["needle"] });
    // Stopping at the hit limit leaves the rest of the block for later.
    const limited = q.search(db, { ...ANY, conversationId: 1, text: "needle", cursor: 5, upper: null, scan: 3, hits: 1 });
    expect([limited.scanned, limited.next]).toEqual([3, 2]);
  });

  test("every term must occur; double quotes keep a phrase together", () => {
    expect(q.searchTerms('  Alpha "Beta  Gamma" alpha "" 报价 ')).toEqual(["alpha", "beta  gamma", "报价"]);
    expect(q.searchTerms("a b c d e f g h i j")).toHaveLength(8);
    const db = entriesDb(["alpha beta", "alpha only", "beta gamma, alpha", "Beta  Gamma 报价"].map(text => user(text)));
    const ids = (text: string) => q.search(db, { ...ANY, conversationId: null, text, scan: 50, hits: 50 }).hits.map(hit => hit.id);
    expect(ids("alpha beta")).toEqual([3, 1]);
    expect(ids("BETA alpha")).toEqual([3, 1]);
    expect(ids('"beta  gamma"')).toEqual([4]);
    expect(ids("报价 gamma")).toEqual([4]);
    expect(() => q.search(db, { ...ANY, conversationId: null, text: '""', scan: 50, hits: 50 })).toThrow("搜索内容不能为空");
    // The snippet is centred on the earliest of the terms.
    const [hit] = q.search(db, { ...ANY, conversationId: null, text: "alpha gamma", scan: 50, hits: 50 }).hits;
    expect([hit!.id, hit!.offset, hit!.snippet]).toEqual([3, 5, "beta gamma, alpha"]);
  });

  test("kinds choose the parts of the history a search looks in", () => {
    const db = entriesDb([
      user("needle in a question"),
      { kind: "pi.assistant", model: [{ role: "assistant", timestamp: 2, content: [{ type: "text", text: "needle in an answer" },
        { type: "thinking", thinking: "needle in a thought" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo needle" } }] }] },
      { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", timestamp: 3, content: [{ type: "text", text: "needle output" }] }] },
      { kind: "pi.compaction", model: [{ role: "user", timestamp: 4, content: "needle in a summary" }] },
      { kind: "pi.system", model: [{ role: "system", timestamp: 5, content: "needle in the system prompt" }] },
    ]);
    const found = (kinds: q.SearchOptions["kinds"]) =>
      q.search(db, { ...ANY, conversationId: null, text: "needle", kinds, scan: 50, hits: 50 }).hits.map(hit => [hit.id, hit.snippet]);
    expect(found(null).map(([id]) => id)).toEqual([4, 3, 2, 1]);
    expect(found(["question"])).toEqual([[1, "needle in a question"]]);
    expect(found(["answer"])).toEqual([[2, "needle in an answer"]]);
    expect(found(["thinking"])).toEqual([[2, "needle in a thought"]]);
    expect(found(["tool"])).toEqual([[3, "needle output"], [2, 'bash { "command": "echo needle" }']]);
    expect(found(["summary"])).toEqual([[4, "needle in a summary"]]);
    expect(found(["question", "summary"]).map(([id]) => id)).toEqual([4, 1]);
  });

  test("a time range starts the scan near its end, stops past its start, and is exact on each entry", () => {
    const HOUR = 3600_000;
    // One entry an hour; entry 50 was stamped a little before entry 49, as a slow commit does; entry 45 has no time stamp.
    const db = entriesDb(Array.from({ length: 100 }, (_, index) => {
      const id = index + 1;
      return id === 45 ? { kind: "pi.user", model: [{ role: "user", content: "needle" }] } : user("needle", id === 50 ? 48.5 * HOUR : id * HOUR);
    }));
    const run = (options: Partial<q.SearchOptions>) => q.search(db, { ...ANY, text: "needle", conversationId: null, scan: 500, hits: 50, ...options });
    const ranged = run({ from: 40 * HOUR, to: 60 * HOUR });
    expect(ranged.hits.map(hit => hit.id)).toEqual([59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47, 46, 44, 43, 42, 41, 40]);
    expect(ranged.next).toBeNull();
    // Only the entries around the range were read: from below 61 h + margin down to the first one older than 39 h.
    expect(ranged.scanned < 30).toBe(true);
    // The same within one conversation, and with an open end.
    expect(run({ conversationId: 1, from: 95 * HOUR, to: null }).hits.map(hit => hit.id)).toEqual([100, 99, 98, 97, 96, 95]);
    expect(run({ from: null, to: 3 * HOUR }).hits.map(hit => hit.id)).toEqual([2, 1]);
    // A range after every entry starts at the newest; one before every entry finds nothing.
    expect(run({ from: 200 * HOUR, to: 300 * HOUR })).toMatchObject({ hits: [], next: null });
    expect(run({ from: 0, to: HOUR / 2 })).toMatchObject({ hits: [], next: null });
  });

  test("search requests check their kinds and time range", () => {
    const base = { op: "search", space: "direct", generation: crypto.randomUUID(), text: "x" };
    expect(parseReadOp({ ...base, kinds: ["answer", "answer", "tool"], from: 1, to: 2 })).toMatchObject({ kinds: ["answer", "tool"], from: 1, to: 2 });
    expect(parseReadOp(base)).toMatchObject({ kinds: null, from: null, to: null });
    for (const kinds of [[], ["answers"], "answer", [1]]) expect(() => parseReadOp({ ...base, kinds })).toThrow("kinds");
    expect(() => parseReadOp({ ...base, from: 2, to: 2 })).toThrow("from");
    expect(() => parseReadOp({ ...base, from: -1 })).toThrow("from");
  });
});

/** Search options with no filter and no cursor. */
const ANY = { kinds: null, from: null, to: null, cursor: null, upper: null } as const;

/** A user entry with a time stamp. */
const user = (text: string, timestamp = 1) => ({ kind: "pi.user", model: [{ role: "user", timestamp, content: text }] });

/** An in-memory entries table of one conversation holding these records, numbered from 1. */
function entriesDb(records: unknown[]): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, head INTEGER, commit_seq INTEGER, record TEXT)");
  records.forEach((record, index) => db.query("INSERT INTO entries VALUES (?, 1, NULL, ?, ?)").run(index + 1, index + 1, JSON.stringify(record)));
  return db;
}
