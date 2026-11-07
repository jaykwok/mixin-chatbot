// The console's conversation and statistics API end to end: the real service writes synthetic chats with faux models,
// the bot's HTTP app serves /health and /_admin/read on a loopback port, and the console's handler answers the page
// through BotLink. Checks what the page receives in each identity mode, the name states and the audit. Synthetic data.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { appLayout } from "../../src/core/layout.ts";
import { DurableService } from "../../src/durable/service.ts";
import { ReadChannel } from "../../src/durable/read/client.ts";
import type { ReadOp } from "../../src/durable/read/protocol.ts";
import { PushStore } from "../../src/push/store.ts";
import { createApp } from "../../src/server/http-app.ts";
import { AuditLog } from "../../console/server/audit.ts";
import { Auth } from "../../console/server/auth.ts";
import { BotLink, BotOffline, BotReadError, type BotReader } from "../../console/server/bot.ts";
import type { Bundle } from "../../console/server/bundle.ts";
import { Exports } from "../../console/server/exports.ts";
import { guardConfig } from "../../console/server/guard.ts";
import { createHandler } from "../../console/server/server.ts";
import { statsRoutes } from "../../console/server/stats.ts";
import { conversationRoutes, Views } from "../../console/server/views.ts";
import type {
  EntryPage, ExportStatus, ExportTicket, GlobalSearchCursor, GlobalSearchHit, GlobalSearchResponse, GlobalSearchViewResponse, MemberRow, MembersResponse,
  Overview, RequestsResponse, SearchResponse, SpacesResponse, SpaceViewResponse, StatsResponse, ViewInfo,
} from "../../console/ui/src/contract.ts";
import { fauxModels, TEST_PROGRESS } from "../helpers/durable.ts";
import { recordingOutbound, replyTexts } from "../helpers/recording-outbound.ts";
import { tempFixture } from "../helpers/temp.ts";

const fixture = await tempFixture("console-live-");
const ALICE = "13800000001", BOB = "13800000002", CAROL = "13800000003";
const NUMBERS = [ALICE, BOB, CAROL];
/** Any fixture number, full or masked. A bare "138" also occurs inside time stamps (observedAt 1793085013811). */
const PHONE = /138(?:0000|\*{4})000\d/;
const TOKEN = `admin-${crypto.randomUUID()}`;
const root = join(fixture.root, "data");
const layout = appLayout(root);
const statePath = join(root, "state", "agent.sqlite");
const instanceFile = join(root, "state", "instance.json");
const auditDir = join(fixture.root, "console", "audit");
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
let bot: ReturnType<typeof Bun.serve>;

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

/** The bot's HTTP app on a fresh loopback port, recorded the way src/server/app.ts records it. */
async function startBot(token = TOKEN) {
  const instanceId = crypto.randomUUID(), startedAt = Date.now();
  const app = createApp({ isStopping: () => false, adminToken: token, instanceId, startedAt, shutdown: () => {}, read: channel });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  await writeFile(instanceFile, JSON.stringify({ pid: process.pid, port: server.port, token, host: "127.0.0.1", instanceId, startedAt }));
  return server;
}

beforeAll(async () => {
  await ask("direct", ALICE, "你好，帮我总结周报 Quarterly", [fauxAssistantMessage("这是**总结**。")]);
  await ask("direct", ALICE, "查一下天气", [fauxAssistantMessage([fauxToolCall("bash", { command: "echo sunny" })], { stopReason: "toolUse" }), fauxAssistantMessage("天气晴。")]);
  await service.control(out.message("direct", ALICE, "/clear"));
  await ask("direct", ALICE, "清空之后的问题", [fauxAssistantMessage("新的回答")]);
  await ask("direct", BOB, "<script>alert(1)</script>", [fauxAssistantMessage("收到")]);
  await ask("100", ALICE, "群里的问题", [fauxAssistantMessage("群里的回答")]);
  await ask("100", CAROL, "群里另一个问题", [fauxAssistantMessage("另一个回答")]);
  await mkdir(join(root, "state"), { recursive: true });
  const names = new Database(statePath, { create: true, strict: true });
  names.exec("CREATE TABLE member_directory (phone TEXT PRIMARY KEY, im_user_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, last_verified_at INTEGER NOT NULL) STRICT");
  names.query("INSERT INTO member_directory VALUES (?, ?, ?, ?)").run(ALICE, "im-a", "张三", 1);
  names.query("INSERT INTO member_directory VALUES (?, ?, ?, ?)").run(CAROL, "im-c", "李四", 1);
  names.close();
  channel = new ReadChannel({ conversations: layout.conversations, state: statePath });
  bot = await startBot();
});
afterAll(async () => {
  bot?.stop(true);
  await channel?.close();
  await service.close();
  await fixture.cleanup();
});

// ─── Console side ──────────────────────────────────────────────────────────

const PORT = 10001;
const bundle: Bundle = { index: { path: "/", type: "text/html; charset=utf-8", body: new Uint8Array() }, assets: new Map() };
/** Every response body the page received, to check none carries a complete number or the bot's token. */
const received: string[] = [];

function consoleWith(reader: BotReader, options: { ticketMs?: number } = {}) {
  const auth = new Auth(), views = new Views(), audit = new AuditLog(auditDir);
  const exporter = new Exports({ bot: reader, audit, views, root, gapMs: 1, ...options });
  auth.onEnd(label => views.end(label));
  auth.onEnd(label => exporter.end(label));
  const handle = createHandler({ port: PORT, guard: guardConfig(PORT), bundle, auth, instanceId: "console", overview: async () => ({}) as Overview,
    routes: { ...conversationRoutes({ bot: reader, audit, views }), ...statsRoutes({ bot: reader, audit, views, root }), ...exporter.routes() },
    download: (ticket, context) => exporter.download(ticket, context) });
  /** A download as the browser starts it from the console page: a GET navigation without the API header. */
  const download = (cookie: string, url: string, headers: Record<string, string> = {}, signal?: AbortSignal) =>
    handle(new Request(`http://127.0.0.1:${PORT}${url}`, { signal, headers: { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", cookie, ...headers } }));
  const request = (path: string, method: string, cookie: string, body?: unknown) => new Request(`http://127.0.0.1:${PORT}${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { host: `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", "x-console-request": "1", cookie,
      ...(method === "POST" ? { origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json" } : {}) },
  });
  const login = async () => {
    const response = await handle(request("/api/session/exchange", "POST", "", { token: auth.issueToken().token }));
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const call = async <T>(cookie: string, method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await handle(request(path, method, cookie, body));
    const text = await response.text();
    received.push(text);
    return { status: response.status, body: JSON.parse(text) as T & { code?: string; error?: string }, text };
  };
  return { auth, views, exporter, login, call, download };
}

const live = consoleWith(new BotLink({ instanceFile }));

async function openSpace(cookie: string, space: string, mode = "default", confirm?: boolean) {
  const spaces = await live.call<SpacesResponse>(cookie, "GET", "/api/spaces");
  const generation = spaces.body.spaces.find(row => row.space === space)!.generation!;
  return live.call<SpaceViewResponse>(cookie, "POST", "/api/views/space", { space, generation, mode, confirm });
}

async function auditLines(): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  for (const name of await readdir(auditDir)) {
    for (const line of (await readFile(join(auditDir, name), "utf8")).split("\n")) if (line) lines.push(JSON.parse(line));
  }
  return lines;
}

describe("live conversations", () => {
  test("lists spaces and opens one in default mode: names with masked numbers, the missing name states why", async () => {
    const cookie = await live.login();
    const spaces = await live.call<SpacesResponse>(cookie, "GET", "/api/spaces");
    expect(spaces.status).toBe(200);
    expect(spaces.body.spaces.map(row => [row.space, row.title, row.state, row.members])).toEqual([["direct", "单聊", "ready", 2], ["groups/100", "群 100", "ready", 2]]);

    const view = await openSpace(cookie, "direct");
    expect(view.status).toBe(200);
    expect(view.body.view.mode).toBe("default");
    expect(view.body.names.state).toBe("ok");
    const byLabel = Object.fromEntries(view.body.members.map(row => [row.identity.label, row.identity]));
    expect(byLabel["张三（138****0001）"]).toMatchObject({ name: "张三", phone: "138****0001", nameState: "named" });
    expect(typeof byLabel["张三（138****0001）"]!.nameObservedAt).toBe("number");
    expect(byLabel["138****0002"]).toMatchObject({ phone: "138****0002", nameState: "missing", nameNote: "当前通讯录缓存未找到" });
    expect(byLabel["138****0002"]!.name).toBeUndefined();
    for (const row of view.body.members) expect(row.identity.key).toMatch(/^[A-Za-z0-9_-]{12}$/);
    for (const number of NUMBERS) expect(view.text).not.toContain(number);
  });

  test("reads a member's entries, one entry, boundaries, run records and search by member key", async () => {
    const cookie = await live.login();
    const view = (await openSpace(cookie, "direct")).body;
    const alice = view.members.find(row => row.identity.name === "张三")!.identity.key;
    const at = { view: view.view.id, member: alice };

    const page = await live.call<EntryPage>(cookie, "POST", "/api/conversation/entries", { ...at, older: true, cursor: null, upper: null });
    expect(page.status).toBe(200);
    const kinds = page.body.items.map(entry => entry.kind);
    expect(kinds).toContain("pi.reset");
    expect(page.body.items[0]!.id).toBeGreaterThan(page.body.items.at(-1)!.id);
    // A page summarises system prompts; the single entry has the whole text.
    const system = page.body.items.find(entry => entry.role === "system")!;
    expect(system.parts).toEqual([]);
    const whole = await live.call<{ entry: { parts: { text: string }[] } }>(cookie, "POST", "/api/conversation/entry", { ...at, id: system.id });
    expect(whole.body.entry.parts[0]!.text.length).toBeGreaterThan(0);
    const bob = view.members.find(row => row.identity.nameState === "missing")!.identity.key;
    const foreign = await live.call(cookie, "POST", "/api/conversation/entry", { view: view.view.id, member: bob, id: page.body.items[0]!.id });
    expect([foreign.status, foreign.body.code]).toEqual([404, "not-found"]);

    const bounds = await live.call<{ items: { kind: string }[] }>(cookie, "POST", "/api/conversation/boundaries", at);
    expect(bounds.body.items.map(item => item.kind)).toEqual(["pi.reset"]);

    const runs = await live.call<RequestsResponse>(cookie, "POST", "/api/conversation/requests", at);
    expect(runs.status).toBe(200);
    expect(runs.body.items.length).toBeGreaterThan(0);
    expect(runs.body.items.every(item => item.delivery?.parts.every(part => part.state === "sent"))).toBe(true);

    const found = await live.call<SearchResponse>(cookie, "POST", "/api/conversation/search", { view: view.view.id, member: null, text: "quarterly", cursor: null, upper: null });
    expect(found.body.hits.map(hit => hit.member)).toEqual([alice]);
    expect(found.body.hits[0]!.snippet).toContain("Quarterly");

    expect(await live.call(cookie, "POST", "/api/conversation/entries", { ...at, member: "nobody", older: true }).then(r => r.status)).toBe(400);
    for (const text of received) for (const number of NUMBERS) expect(text).not.toContain(number);
  });

  test("anonymous mode gives member codes only; full mode needs this request's confirmation and is audited", async () => {
    const cookie = await live.login();
    const anonymous = await openSpace(cookie, "groups/100", "anonymous");
    expect(anonymous.body.names.state).toBe("skipped");
    for (const row of anonymous.body.members) {
      expect(row.identity.label).toMatch(/^成员 [A-HJ-NP-Z]\d+$/);
      expect(Object.keys(row.identity).sort()).toEqual(["key", "label"]);
    }
    expect(new Set(anonymous.body.members.map(row => row.identity.label)).size).toBe(2);
    expect(anonymous.text).not.toMatch(PHONE);
    expect(anonymous.text).not.toContain("张三");

    const refused = await openSpace(cookie, "groups/100", "full");
    expect([refused.status, refused.body.code]).toEqual([400, "input"]);
    const full = await openSpace(cookie, "groups/100", "full", true);
    expect(full.body.members.map(row => row.identity.phone).sort()).toEqual([ALICE, CAROL]);
    expect(full.body.members.find(row => row.identity.phone === CAROL)!.identity.label).toBe(`李四（${CAROL}）`);

    const search = await live.call<SearchResponse>(cookie, "POST", "/api/conversation/search",
      { view: anonymous.body.view.id, member: null, text: "群里的问题", cursor: null, upper: null });
    expect(search.body.hits.length).toBe(1);

    const lines = await auditLines();
    expect(lines.some(line => line.action === "identity-full" && line.scope === "groups/100" && line.mode === "full")).toBe(true);
    expect(lines.some(line => line.action === "view-open" && line.mode === "anonymous")).toBe(true);
    expect(lines.some(line => line.action === "search" && line.scope === "groups/100")).toBe(true);
    expect(lines.some(line => line.action === "conversation-open" && line.scope === "direct 138****0001")).toBe(true);
    const text = JSON.stringify(lines);
    for (const value of [...NUMBERS, "群里的问题", "quarterly", TOKEN]) expect(text).not.toContain(value);
  });

  test("a mode switch keeps the member: the new view names the same conversation by its own key, and only for this session's view of the same space", async () => {
    const cookie = await live.login();
    const first = (await openSpace(cookie, "direct")).body;
    const alice = first.members.find(row => row.identity.name === "张三")!.identity.key;
    const keep = { view: first.view.id, member: alice };
    const generation = first.space.generation;
    const switched = await live.call<SpaceViewResponse>(cookie, "POST", "/api/views/space", { space: "direct", generation, mode: "anonymous", keep });
    expect(switched.status).toBe(200);
    const kept = switched.body.kept!;
    expect(kept).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(kept).not.toBe(alice);
    // The same entries through either view.
    const ids = async (view: string, member: string) =>
      (await live.call<EntryPage>(cookie, "POST", "/api/conversation/entries", { view, member, older: true, cursor: null, upper: null })).body.items.map(entry => entry.id);
    expect(await ids(switched.body.view.id, kept)).toEqual(await ids(first.view.id, alice));

    // Nothing is kept from another space, an unknown member, a malformed request or another session's view.
    const group = await openSpace(cookie, "groups/100");
    const other = await live.call<SpaceViewResponse>(cookie, "POST", "/api/views/space",
      { space: "groups/100", generation: group.body.space.generation, mode: "default", keep });
    expect([other.status, other.body.kept]).toEqual([200, undefined]);
    for (const wrong of [{ view: first.view.id, member: "nobody" }, "text", { view: 1, member: alice }]) {
      const answer = await live.call<SpaceViewResponse>(cookie, "POST", "/api/views/space", { space: "direct", generation, mode: "default", keep: wrong });
      expect([answer.status, answer.body.kept]).toEqual([200, undefined]);
    }
    const stranger = await live.login();
    const theirs = await live.call<SpaceViewResponse>(stranger, "POST", "/api/views/space", { space: "direct", generation, mode: "default", keep });
    expect([theirs.status, theirs.body.kept]).toEqual([200, undefined]);
  });

  test("a space search takes kinds and a time range, and names the terms it looked for", async () => {
    const cookie = await live.login();
    const view = (await openSpace(cookie, "direct")).body;
    const search = (body: Record<string, unknown>) =>
      live.call<SearchResponse>(cookie, "POST", "/api/conversation/search", { view: view.view.id, member: null, text: "quarterly", cursor: null, ...body });
    const asked = await search({ kinds: ["question"] });
    expect([asked.body.hits.length, asked.body.terms]).toEqual([1, ["quarterly"]]);
    expect((await search({ kinds: ["answer", "tool"] })).body.hits).toEqual([]);
    expect((await search({ text: "天气 晴" })).body.hits.map(hit => hit.kind)).toEqual(["pi.assistant"]);
    expect((await search({ from: Date.now() + 7200_000 })).body.hits).toEqual([]);
    expect((await search({ from: 0, to: Date.now() + 7200_000 })).body.hits.length).toBe(1);
    expect([(await search({ kinds: ["everything"] })).status, (await search({ from: 5, to: 5 })).status]).toEqual([400, 400]);
  });

  test("a search over every space: spaces in list order, members in the search's mode, a hit opens its member, the audit has no text", async () => {
    const seen = received.length;
    const cookie = await live.login();
    const all = async (view: string, body: Record<string, unknown>) => {
      const hits: GlobalSearchHit[] = [];
      let cursor: GlobalSearchCursor | null = null, blocks = 0;
      do {
        const answer: { status: number; body: GlobalSearchResponse } = await live.call<GlobalSearchResponse>(cookie, "POST", "/api/search", { view, ...body, cursor });
        expect(answer.status).toBe(200);
        hits.push(...answer.body.hits);
        cursor = answer.body.next;
      } while (cursor && ++blocks < 20);
      return hits;
    };

    const opened = await live.call<GlobalSearchViewResponse>(cookie, "POST", "/api/views/search", { mode: "default" });
    expect([opened.status, opened.body.spaces, opened.body.view.kind, opened.body.view.mode]).toEqual([200, 2, "search", "default"]);
    const search = opened.body.view.id;
    const hits = await all(search, { text: "问题" });
    expect(hits.map(hit => [hit.title, hit.member?.label, hit.kind])).toEqual([
      ["单聊", "张三（138****0001）", "pi.user"], ["群 100", "李四（138****0003）", "pi.user"], ["群 100", "张三（138****0001）", "pi.user"]]);
    // Several terms with a kind, and a time range, narrow it as in a space.
    expect((await all(search, { text: "群里 回答", kinds: ["answer"] })).map(hit => hit.snippet)).toEqual(["群里的回答"]);
    expect(await all(search, { text: "群里 回答", kinds: ["question"] })).toEqual([]);
    expect(await all(search, { text: "问题", from: Date.now() + 7200_000 })).toEqual([]);

    // A hit opens its space with the member kept, and the hit's entry is in that member's conversation.
    const carol = hits[1]!;
    const generation = (await live.call<SpacesResponse>(cookie, "GET", "/api/spaces")).body.spaces.find(row => row.space === carol.space)!.generation!;
    const space = await live.call<SpaceViewResponse>(cookie, "POST", "/api/views/space",
      { space: carol.space, generation, mode: "default", keep: { view: search, member: carol.member!.key } });
    expect(space.body.members.find(row => row.identity.key === space.body.kept)?.identity.label).toBe("李四（138****0003）");
    const page = await live.call<EntryPage>(cookie, "POST", "/api/conversation/entries", { view: space.body.view.id, member: space.body.kept, older: true, cursor: null, upper: null });
    expect(page.body.items.some(entry => entry.id === carol.id)).toBe(true);

    // Anonymous: codes only. Full identity is not offered here. An unknown view is gone.
    const anonymous = await live.call<GlobalSearchViewResponse>(cookie, "POST", "/api/views/search", { mode: "anonymous" });
    const coded = await all(anonymous.body.view.id, { text: "问题" });
    for (const hit of coded) expect(Object.keys(hit.member!).sort()).toEqual(["key", "label"]);
    expect(coded.map(hit => hit.member!.label).every(label => /^成员 [A-HJ-NP-Z]\d+$/.test(label))).toBe(true);
    expect(JSON.stringify(coded)).not.toContain("张三");
    const full = await live.call(cookie, "POST", "/api/views/search", { mode: "full", confirm: true });
    expect([full.status, full.body.code]).toEqual([400, "input"]);
    const gone = await live.call(cookie, "POST", "/api/search", { view: "nothing", text: "问题", cursor: null });
    expect([gone.status, gone.body.code]).toEqual([410, "view-gone"]);

    const lines = await auditLines();
    expect(lines.some(line => line.action === "search" && line.scope === "全部空间" && line.mode === "anonymous")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain("问题");
    for (const text of received.slice(seen)) for (const number of NUMBERS) expect(text).not.toContain(number);
  });

  test("a replaced database, a closed view and an ended session each answer clearly", async () => {
    const cookie = await live.login();
    const changed = await live.call(cookie, "POST", "/api/views/space", { space: "direct", generation: crypto.randomUUID(), mode: "default" });
    expect([changed.status, changed.body.code]).toEqual([409, "space-changed"]);
    const absent = await live.call(cookie, "POST", "/api/views/space", { space: "groups/999", generation: crypto.randomUUID() });
    expect([absent.status, absent.body.code]).toEqual([404, "space-absent"]);
    expect((await live.call(cookie, "POST", "/api/views/space", { space: "../x", generation: crypto.randomUUID() })).status).toBe(400);

    const view = (await openSpace(cookie, "direct")).body;
    const member = view.members[0]!.identity.key;
    await live.call(cookie, "POST", "/api/views/close", { view: view.view.id });
    const closed = await live.call(cookie, "POST", "/api/conversation/entries", { view: view.view.id, member, older: true });
    expect([closed.status, closed.body.code]).toEqual([410, "view-gone"]);

    const again = (await openSpace(cookie, "direct")).body;
    const label = (await live.call<{ session: { label: string } }>(cookie, "GET", "/api/session")).body.session.label;
    expect(live.views.count(label)).toBe(1);
    await live.call(cookie, "POST", "/api/session/logout", {});
    expect(live.views.count(label)).toBe(0);
    const other = await live.login();
    const gone = await live.call(other, "POST", "/api/conversation/entries", { view: again.view.id, member: again.members[0]!.identity.key, older: true });
    expect([gone.status, gone.body.code]).toEqual([410, "view-gone"]);
  });

  test("a restarted bot (new token and instance) is verified again and used", async () => {
    const cookie = await live.login();
    const previous = bot;
    bot = await startBot(`admin-${crypto.randomUUID()}`);
    previous.stop(true);
    expect((await live.call(cookie, "GET", "/api/spaces")).status).toBe(200);
    for (const text of received) expect(text).not.toContain(TOKEN);
  });
});

describe("statistics", () => {
  test("member filter binds the view key and narrows totals, groups and exports without exposing the number", async () => {
    const cookie = await live.login();
    const view = (await live.call<{ view: ViewInfo }>(cookie, "POST", "/api/views/stats", { mode: "default" })).body.view.id;
    const all = (await live.call<StatsResponse>(cookie, "POST", "/api/stats", { view, period: "all" })).body;
    const member = all.ranking.find(row => row.identity.phone === "138****0002")!;
    const picked = await live.call<StatsResponse>(cookie, "POST", "/api/stats", { view, period: "all", member: member.identity.key });
    expect(picked.status).toBe(200);
    expect(picked.body.summary.asks).toBe(member.asks);
    expect(picked.body.summary.people).toBe(1);
    expect(picked.body.ranking.map(row => row.identity.key)).toEqual([member.identity.key]);
    expect(picked.body.groups.map(row => row.group)).toEqual(["direct"]);
    for (const number of NUMBERS) expect(picked.text).not.toContain(number);
    const other = (await live.call<{ view: ViewInfo }>(cookie, "POST", "/api/views/stats", { mode: "anonymous" })).body.view.id;
    for (const key of [member.identity.key, "13800000002", "unknown"]) {
      expect((await live.call(cookie, "POST", "/api/stats", { view: other, period: "all", member: key })).status).toBe(400);
        expect((await live.call(cookie, "POST", "/api/exports", {
          type: "stats", format: "csv", mode: "default", period: "all", view: other, member: key,
        })).status).toBe(400);
    }
    const foreign = await live.login();
    expect((await live.call(foreign, "POST", "/api/stats", { view, period: "all", member: member.identity.key })).status).toBe(410);
      expect((await live.call(foreign, "POST", "/api/exports", {
        type: "stats", format: "csv", mode: "default", period: "all", view, member: member.identity.key,
      })).status).toBe(410);
    for (const format of ["html", "csv"]) {
      const result = await live.call<ExportTicket>(cookie, "POST", "/api/exports", {
        type: "stats", format, mode: "default", period: "all", view, member: member.identity.key,
      });
      expect(result.status).toBe(200);
      const downloaded = await live.download(cookie, result.body.url);
      const text = await downloaded.text();
      expect(text).toContain("138****0002");
      expect(text).not.toContain("138****0001"); expect(text).not.toContain("138****0003");
      for (const number of NUMBERS) expect(text).not.toContain(number);
    }
  });

  test("default mode: names with masked numbers, cross-group ranking, group filter with members", async () => {
    const cookie = await live.login();
    const view = await live.call<{ view: ViewInfo }>(cookie, "POST", "/api/views/stats", { mode: "default" });
    const all = await live.call<StatsResponse>(cookie, "POST", "/api/stats", { view: view.body.view.id, period: "all" });
    expect(all.status).toBe(200);
    expect(all.body.summary.asks).toBe(6);
    expect(all.body.summary.people).toBe(3);
    expect(all.body.names.state).toBe("ok");
    expect(all.body.ranking[0]!.identity.label).toBe("张三（138****0001）");
    expect(all.body.ranking.find(row => row.identity.phone === "138****0002")!.identity.nameState).toBe("missing");
    expect(all.body.groups.map(group => [group.group, group.title]).sort()).toEqual([["100", "群 100"], ["direct", "单聊"]]);
    expect(all.body.members).toBeNull();

    const group = await live.call<StatsResponse>(cookie, "POST", "/api/stats", { view: view.body.view.id, period: "30d", group: "100", grain: "week" });
    expect(group.body.members!.map(row => row.identity.label).sort()).toEqual(["张三（138****0001）", "李四（138****0003）"].sort());
    expect(group.body.grain).toBe("week");
    // The same member keeps its key within the view.
    expect(group.body.members!.find(row => row.identity.name === "张三")!.identity.key).toBe(all.body.ranking[0]!.identity.key);
    for (const number of NUMBERS) { expect(all.text).not.toContain(number); expect(group.text).not.toContain(number); }

    const bad = await live.call(cookie, "POST", "/api/stats", { view: view.body.view.id, period: "custom", since: "2026-13-01" });
    expect([bad.status, bad.body.code]).toEqual([400, "input"]);
  });

  test("with the bot stopped, statistics still answer and every member says names are unavailable", async () => {
    const stopped = consoleWith(new BotLink({ instanceFile: join(fixture.root, "missing", "instance.json") }));
    const cookie = await stopped.login();
    const spaces = await stopped.call(cookie, "GET", "/api/spaces");
    expect([spaces.status, spaces.body.code]).toEqual([503, "bot-offline"]);
    const view = await stopped.call<{ view: ViewInfo }>(cookie, "POST", "/api/views/stats", { mode: "default" });
    const stats = await stopped.call<StatsResponse>(cookie, "POST", "/api/stats", { view: view.body.view.id, period: "all" });
    expect(stats.status).toBe(200);
    expect(stats.body.summary.asks).toBe(6);
    expect(stats.body.names.state).toBe("offline");
    for (const row of stats.body.ranking) expect(row.identity).toMatchObject({ nameState: "offline", nameNote: "机器人未运行，姓名不可用" });
    expect(stats.body.ranking.every(row => row.identity.name === undefined)).toBe(true);
  });

  test("a failed name lookup marks its members and never fails the statistics", async () => {
    const link = new BotLink({ instanceFile });
    const failing: BotReader = {
      read: <T>(op: ReadOp, signal?: AbortSignal) => op.op === "names" ? Promise.reject(new BotReadError("读取繁忙", 429, "ReadBusy")) : link.read<T>(op, signal),
    };
    const flaky = consoleWith(failing);
    const cookie = await flaky.login();
    const view = await flaky.call<{ view: ViewInfo }>(cookie, "POST", "/api/views/stats", { mode: "default" });
    const stats = await flaky.call<StatsResponse>(cookie, "POST", "/api/stats", { view: view.body.view.id, period: "all" });
    expect(stats.status).toBe(200);
    expect(stats.body.names.state).toBe("failed");
    for (const row of stats.body.ranking) expect(row.identity.nameState).toBe("failed");

    const space = await flaky.call<SpacesResponse>(cookie, "GET", "/api/spaces");
    const generation = space.body.spaces.find(row => row.space === "direct")!.generation!;
    const opened = await flaky.call<SpaceViewResponse>(cookie, "POST", "/api/views/space", { space: "direct", generation });
    expect(opened.status).toBe(200);
    expect(opened.body.names.state).toBe("failed");
    expect(opened.body.members.every(row => row.identity.nameNote === "姓名查询失败或暂不可用")).toBe(true);
  });

  test("anonymous statistics carry codes only, stable within the view", async () => {
    const cookie = await live.login();
    const view = await live.call<{ view: ViewInfo }>(cookie, "POST", "/api/views/stats", { mode: "anonymous" });
    const first = await live.call<StatsResponse>(cookie, "POST", "/api/stats", { view: view.body.view.id, period: "all" });
    const second = await live.call<StatsResponse>(cookie, "POST", "/api/stats", { view: view.body.view.id, period: "all" });
    expect(first.body.names.state).toBe("skipped");
    expect(first.body.ranking.map(row => row.identity)).toEqual(second.body.ranking.map(row => row.identity));
    for (const row of first.body.ranking) expect(Object.keys(row.identity).sort()).toEqual(["key", "label"]);
    expect(first.text).not.toMatch(PHONE);
    expect(first.text).not.toContain("张三");
  });
});

// ─── Exports ───────────────────────────────────────────────────────────────

type Console = ReturnType<typeof consoleWith>;

async function ticketFor(c: Console, cookie: string, request: Record<string, unknown>) {
  const ticket = await c.call<ExportTicket>(cookie, "POST", "/api/exports", request);
  expect(ticket.status).toBe(200);
  return ticket.body;
}

async function exportFile(c: Console, cookie: string, request: Record<string, unknown>) {
  const ticket = await ticketFor(c, cookie, request);
  const response = await c.download(cookie, ticket.url);
  // Keep a byte-order mark: Response.text() would drop it.
  return { ticket, response, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer()) };
}

async function viewOf(c: Console, cookie: string, space: string, mode = "default") {
  const spaces = await c.call<SpacesResponse>(cookie, "GET", "/api/spaces");
  const generation = spaces.body.spaces.find(row => row.space === space)!.generation!;
  return (await c.call<SpaceViewResponse>(cookie, "POST", "/api/views/space", { space, generation, mode })).body;
}

const statusOf = (c: Console, cookie: string, id: string) => c.call<ExportStatus>(cookie, "POST", "/api/exports/status", { id }).then(r => r.body);

type JsonExport = {
  schemaVersion: number; identityMode: string; personalInformation: string; history: { fixedAt: string | null };
  names: { state: string }; complete: boolean; error?: string; counts: { members: number; entries: number };
  members: { member: Record<string, string>; upperEntry: number | null; entries: { id: number; kind: string }[]; runRecords?: unknown }[];
};

/** A reader whose answers are slowed down, so a download can be caught mid-way. */
const slowReader = (link: BotReader, ms: number): BotReader =>
  ({ read: async <T>(op: ReadOp, signal?: AbortSignal) => { await Bun.sleep(ms); return link.read<T>(op, signal); } });

describe("exports", () => {
  test("a conversation JSON export: one-time ticket, fixed upper bounds, completion mark, masked numbers, body kept", async () => {
    const c = consoleWith(new BotLink({ instanceFile }));
    const cookie = await c.login();
    const view = await viewOf(c, cookie, "direct");
    const { ticket, response, text } = await exportFile(c, cookie, { type: "conversation", view: view.view.id, member: null, format: "json", mode: "default" });
    expect(ticket.url).toBe(`/download/${ticket.id}`);
    expect(ticket.filename).toMatch(/^会话-单聊-全部成员-含个人信息-默认身份-\d{8}-\d{6}\.json$/);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent(ticket.filename)}`);

    const file = JSON.parse(text) as JsonExport;
    expect([file.schemaVersion, file.identityMode, file.complete, file.names.state]).toEqual([1, "default", true, "ok"]);
    expect(file.personalInformation).toContain("含个人信息");
    expect(typeof file.history.fixedAt).toBe("string");
    const alice = file.members.find(row => row.member.name === "张三")!;
    expect(alice.member).toMatchObject({ label: "张三（138****0001）", phone: "138****0001", nameState: "named" });
    expect(alice.member.number).toMatch(/^[A-HJ-NP-Z]\d+$/);
    expect(alice.upperEntry).toBe(Math.max(...alice.entries.map(entry => entry.id)));
    expect(alice.entries.map(entry => entry.kind)).toContain("pi.reset");
    expect(text).toContain("你好，帮我总结周报 Quarterly");
    expect(text).toContain("<script>alert(1)</script>");
    expect(alice.runRecords).toMatchObject({ total: expect.any(Number) });
    expect(file.counts).toEqual({ members: 2, entries: file.members.reduce((n, row) => n + row.entries.length, 0) });
    for (const number of NUMBERS) expect(text).not.toContain(number);

    // The ticket is spent; its outcome is kept for the page.
    expect((await c.download(cookie, ticket.url)).status).toBe(410);
    const status = await statusOf(c, cookie, ticket.id);
    expect(status).toMatchObject({ state: "sent", rows: file.counts.entries, bytes: Buffer.byteLength(text) });
    const lines = (await auditLines()).filter(line => line.export === ticket.id);
    expect(lines.map(line => line.action)).toEqual(["export-request", "export-sent"]);
    expect(lines[1]).toMatchObject({ scope: "direct 全部 2 位成员", mode: "default", format: "json", rows: file.counts.entries, bytes: Buffer.byteLength(text) });
  });

  test("an anonymous Markdown export of one member: this export's own number, no names or numbers, honest wording", async () => {
    const c = consoleWith(new BotLink({ instanceFile }));
    const cookie = await c.login();
    const view = await viewOf(c, cookie, "groups/100", "anonymous");
    const member = view.members[0]!.identity;
    const { ticket, response, text } = await exportFile(c, cookie, { type: "conversation", view: view.view.id, member: member.key, format: "markdown", mode: "anonymous" });
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(ticket.filename).toMatch(/^会话-群 100-成员[A-HJ-NP-Z]\d+-匿名身份-\d{8}-\d{6}\.md$/);
    expect(text).toContain("匿名身份：成员只用本次导出内的编号表示");
    expect(text).toContain("本文件不是匿名化数据");
    expect(text).not.toContain("已匿名化");
    expect(text).toMatch(/\n## 成员 [A-HJ-NP-Z]\d+\n/);
    expect(text).toContain("<!-- mixin-console-export: complete; members=1;");
    expect(text).not.toMatch(PHONE);
    expect(text).not.toContain("张三");
    expect(text).not.toContain("李四");
    const lines = (await auditLines()).filter(line => line.export === ticket.id);
    expect(lines.map(line => line.action)).toEqual(["export-request", "export-sent"]);
    expect(String(lines[0]!.scope)).toMatch(/^groups\/100 成员 [A-HJ-NP-Z]\d+$/);
  });

  test("full identity needs this request's confirmation and is audited; days filter entries; bad ranges are refused", async () => {
    const c = consoleWith(new BotLink({ instanceFile }));
    const cookie = await c.login();
    const view = await viewOf(c, cookie, "direct");
    const base = { type: "conversation", view: view.view.id, member: null, format: "json" };
    const refused = await c.call(cookie, "POST", "/api/exports", { ...base, mode: "full" });
    expect([refused.status, refused.body.code]).toEqual([400, "input"]);
    const full = await exportFile(c, cookie, { ...base, mode: "full", confirm: true });
    const file = JSON.parse(full.text) as JsonExport;
    expect(file.members.map(row => row.member.phone).sort()).toEqual([ALICE, BOB]);
    expect(full.ticket.filename).toContain("含个人信息-完整身份");
    for (const number of NUMBERS) expect(full.ticket.filename).not.toContain(number);
    const lines = (await auditLines()).filter(line => line.export === full.ticket.id);
    expect(lines.map(line => line.action)).toEqual(["identity-full", "export-request", "export-sent"]);
    for (const number of NUMBERS) expect(JSON.stringify(lines)).not.toContain(number);

    const tomorrow = new Date(Date.now() + 86_400_000);
    const day = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    const later = JSON.parse((await exportFile(c, cookie, { ...base, mode: "default", since: day })).text) as JsonExport;
    expect([later.complete, later.counts.entries, later.counts.members]).toEqual([true, 0, 2]);
    const backwards = await c.call(cookie, "POST", "/api/exports", { ...base, mode: "default", since: day, until: "2020-01-01" });
    expect([backwards.status, backwards.body.code]).toEqual([400, "input"]);
    expect((await c.call(cookie, "POST", "/api/exports", { ...base, format: "pdf" })).status).toBe(400);
  });

  test("a bot that stops mid-export: the file still parses, says it is incomplete and why; the audit says failed", async () => {
    const link = new BotLink({ instanceFile });
    let pages = 0;
    const dying: BotReader = {
      read: <T>(op: ReadOp, signal?: AbortSignal) =>
        op.op === "entries" && ++pages > 1 ? Promise.reject(new BotOffline("机器人没有应答（连接被拒绝）")) : link.read<T>(op, signal),
    };
    const c = consoleWith(dying);
    const cookie = await c.login();
    const view = await viewOf(c, cookie, "direct");
    const json = await exportFile(c, cookie, { type: "conversation", view: view.view.id, member: null, format: "json", mode: "default" });
    const file = JSON.parse(json.text) as JsonExport;
    expect([file.complete, file.error]).toEqual([false, "机器人没有应答（连接被拒绝）"]);
    expect(file.members.length).toBe(2);
    expect(file.members[1]!.entries).toEqual([]);
    expect((await statusOf(c, cookie, json.ticket.id)).state).toBe("failed");
    expect((await auditLines()).find(line => line.export === json.ticket.id && line.action === "export-failed")).toMatchObject({ note: "机器人没有应答（连接被拒绝）" });

    pages = 0;
    const markdown = await exportFile(c, cookie, { type: "conversation", view: view.view.id, member: null, format: "markdown", mode: "default" });
    expect(markdown.text).toContain("**导出未完成**：机器人没有应答（连接被拒绝）");
    expect(markdown.text.trimEnd().endsWith("<!-- mixin-console-export: incomplete -->")).toBe(true);
    expect(markdown.text).not.toContain("mixin-console-export: complete");
  });

  test("a dropped download is interrupted; an ended login stops its export; tickets are one login's, short-lived and few", async () => {
    const c = consoleWith(slowReader(new BotLink({ instanceFile }), 40), { ticketMs: 300 });
    const cookie = await c.login();
    const view = await viewOf(c, cookie, "direct");
    const request = { type: "conversation", view: view.view.id, member: null, format: "json", mode: "default" };

    // The browser goes away after the first piece.
    const dropped = await ticketFor(c, cookie, request);
    const leave = new AbortController();
    const response = await c.download(cookie, dropped.url, {}, leave.signal);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"schemaVersion"');
    leave.abort();
    await reader.cancel();
    expect((await statusOf(c, cookie, dropped.id)).state).toBe("interrupted");
    expect((await auditLines()).find(line => line.export === dropped.id && line.action === "export-interrupted")).toMatchObject({ note: "浏览器断开了下载" });

    // Someone else's login, a cross-site page and a typed link get nothing.
    const other = await c.login();
    const ticket = await ticketFor(c, cookie, request);
    expect((await c.download(other, ticket.url)).status).toBe(404);
    expect((await c.download(cookie, ticket.url, { "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await c.download(cookie, ticket.url, { "sec-fetch-site": "none" })).status).toBe(403);
    // At most two exports wait or run at once.
    const second = await ticketFor(c, cookie, request);
    const busy = await c.call(cookie, "POST", "/api/exports", request);
    expect([busy.status, busy.body.code]).toEqual([429, "busy"]);
    // An unused ticket goes void.
    await Bun.sleep(400);
    expect((await statusOf(c, cookie, second.id)).state).toBe("expired");
    expect(await c.download(cookie, second.url).then(r => r.text())).toContain("已过期");

    // Logging out stops a running export: the file ends with the reason.
    const running = await ticketFor(c, cookie, request);
    const body = (await c.download(cookie, running.url)).text();
    await Bun.sleep(60);
    await c.call(cookie, "POST", "/api/session/logout", {});
    const file = JSON.parse(await body) as JsonExport;
    expect([file.complete, file.error]).toEqual([false, "登录已结束"]);
    expect((await auditLines()).find(line => line.export === running.id && line.action === "export-interrupted")).toMatchObject({ note: "登录已结束" });
  });

  test("statistics HTML in default mode and CSV in anonymous mode carry only what the mode allows", async () => {
    const c = consoleWith(new BotLink({ instanceFile }));
    const cookie = await c.login();
    const html = await exportFile(c, cookie, { type: "stats", format: "html", mode: "default", period: "all" });
    expect(html.response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.ticket.filename).toMatch(/^使用统计-全部-含个人信息-默认身份-\d{8}-\d{6}\.html$/);
    expect(html.text).toContain("含个人信息 · 默认（姓名＋打码号码）");
    expect(html.text).toContain("张三（138****0001）");
    for (const number of NUMBERS) expect(html.text).not.toContain(number);
    expect(await statusOf(c, cookie, html.ticket.id)).toMatchObject({ state: "sent", rows: 3 });

    const csv = await exportFile(c, cookie, { type: "stats", format: "csv", mode: "anonymous", period: "all", group: "100" });
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    const rows = csv.text.slice(1).split("\r\n").filter(line => line && !line.startsWith('"#'));
    expect(rows[0]).toBe('"群","群名称","成员编号","提问次数","活跃天数","首次提问","最近提问"');
    expect(rows.length).toBe(3);
    expect(rows.slice(1).every(row => /^"100","群 100","[A-HJ-NP-Z]\d+","1","1",/.test(row))).toBe(true);
    expect(csv.text).toContain("# 导出完成：2 行");
    expect(csv.text).not.toMatch(PHONE);
    expect(csv.text).not.toContain("张三");
  });

  test("CSV cells a spreadsheet would run as formulas are neutralised, names included", async () => {
    const link = new BotLink({ instanceFile });
    const hostile: BotReader = {
      read: async <T>(op: ReadOp, signal?: AbortSignal) => op.op === "names"
        ? { found: op.phones.map(phone => ({ phone, name: phone === BOB ? `=HYPERLINK("http://x","点我")` : "+SUM(A1)" })), observedAt: Date.now() } as T
        : link.read<T>(op, signal),
    };
    const c = consoleWith(hostile);
    const cookie = await c.login();
    const { text } = await exportFile(c, cookie, { type: "stats", format: "csv", mode: "default", period: "all", group: "direct" });
    expect(text).toContain(`"'=HYPERLINK(""http://x"",""点我"")"`);
    expect(text).toContain(`"'+SUM(A1)"`);
    expect(text).not.toMatch(/(^|,)"[=+\-@]/m);
  });
});

// Last: these write new messages, which the statistics and export counts above do not expect.
describe("member list refresh", () => {
  const DAVE = "13800000004", ERIN = "13800000005";
  const refresh = (c: Console, cookie: string, view: string) => c.call<MembersResponse>(cookie, "POST", "/api/conversation/activity", { view });
  const newRows = (rows: MemberRow[], before: { members: MemberRow[] }) =>
    rows.filter(row => !before.members.some(old => old.identity.key === row.identity.key));

  test("brings each member's newest activity and the members who joined since, keeping every key; names for the new ones only", async () => {
    const cookie = await live.login();
    const view = (await openSpace(cookie, "groups/100")).body;
    const anonymous = (await openSpace(cookie, "groups/100", "anonymous")).body;
    const carol = view.members.find(row => row.identity.name === "李四")!;
    const names = new Database(statePath, { strict: true });
    names.query("INSERT INTO member_directory VALUES (?, ?, ?, ?)").run(DAVE, "im-d", "王五", 1);
    names.close();
    await ask("100", CAROL, "刷新前的新问题", [fauxAssistantMessage("新回答")]);
    await ask("100", DAVE, "新成员的问题", [fauxAssistantMessage("欢迎")]);

    const refreshed = await refresh(live, cookie, view.view.id);
    expect(refreshed.status).toBe(200);
    expect([refreshed.body.added, refreshed.body.truncated, refreshed.body.members.length]).toEqual([1, false, 3]);
    const now = new Map(refreshed.body.members.map(row => [row.identity.key, row]));
    for (const row of view.members) expect(now.get(row.identity.key)!.identity).toEqual(row.identity);
    expect(now.get(carol.identity.key)!.lastEntry!).toBeGreaterThan(carol.lastEntry!);
    expect(now.get(carol.identity.key)!.lastAt!).toBeGreaterThanOrEqual(carol.lastAt!);
    const [dave] = newRows(refreshed.body.members, view);
    expect(dave!.identity).toMatchObject({ label: "王五（138****0004）", name: "王五", phone: "138****0004", nameState: "named" });
    expect(dave!.lastEntry).not.toBeNull();
    const page = await live.call<EntryPage>(cookie, "POST", "/api/conversation/entries",
      { view: view.view.id, member: dave!.identity.key, older: true, cursor: null, upper: null });
    expect(page.status).toBe(200);
    expect(page.text).toContain("新成员的问题");

    const again = await refresh(live, cookie, view.view.id);
    expect(again.body.added).toBe(0);
    expect(again.body.members.map(row => row.identity)).toEqual(refreshed.body.members.map(row => row.identity));
    for (const text of [refreshed.text, again.text, page.text]) for (const number of [...NUMBERS, DAVE]) expect(text).not.toContain(number);

    const masked = await refresh(live, cookie, anonymous.view.id);
    expect(masked.body.added).toBe(1);
    const [code] = newRows(masked.body.members, anonymous);
    expect(Object.keys(code!.identity).sort()).toEqual(["key", "label"]);
    expect(code!.identity.label).toMatch(/^成员 [A-HJ-NP-Z]\d+$/);
    expect(new Set(masked.body.members.map(row => row.identity.label)).size).toBe(3);
    expect(masked.text).not.toMatch(PHONE);
    expect(masked.text).not.toContain("王五");
  });

  test("a refresh that fails part-way leaves the view as it was; the next one adds the member", async () => {
    const link = new BotLink({ instanceFile });
    let failing = false;
    const flaky = consoleWith({
      read: <T>(op: ReadOp, signal?: AbortSignal) =>
        failing && op.op === "activity" ? Promise.reject(new BotReadError("读取繁忙", 429, "ReadBusy")) : link.read<T>(op, signal),
    });
    const cookie = await flaky.login();
    const view = await viewOf(flaky, cookie, "groups/100");
    await ask("100", ERIN, "又一位新成员", [fauxAssistantMessage("你好")]);
    failing = true;
    const failed = await refresh(flaky, cookie, view.view.id);
    expect([failed.status, failed.body.code]).toEqual([429, "busy"]);
    failing = false;
    const later = await refresh(flaky, cookie, view.view.id);
    expect([later.status, later.body.added, later.body.members.length]).toEqual([200, 1, view.members.length + 1]);
    expect(newRows(later.body.members, view)[0]!.identity).toMatchObject({ label: "138****0005", nameState: "missing" });
    const closed = await flaky.call(cookie, "POST", "/api/views/close", { view: view.view.id }).then(() => refresh(flaky, cookie, view.view.id));
    expect([closed.status, closed.body.code]).toEqual([410, "view-gone"]);
  });
});

// Last in the file: it adds the push tables to the bot's state database.
describe("registered group names", () => {
  test("a group registered for pushes is titled by its name in spaces, a space view and statistics", async () => {
    const db = new Database(statePath, { strict: true });
    try {
      const store = new PushStore(db);
      store.groupSeen("100", 1, 0);
      store.saveGroup("100", { name: "销售一部", state: "registered", registeredAt: 2, registeredBy: null });
    } finally { db.close(); }
    const cookie = await live.login();
    const spaces = await live.call<SpacesResponse>(cookie, "GET", "/api/spaces");
    expect(spaces.body.spaces.map(row => [row.space, row.title])).toEqual([["direct", "单聊"], ["groups/100", "群 销售一部"]]);
    const view = await openSpace(cookie, "groups/100");
    expect(view.body.space.title).toBe("群 销售一部");
    const stats = await live.call<{ view: ViewInfo }>(cookie, "POST", "/api/views/stats", { mode: "default" });
    const all = await live.call<StatsResponse>(cookie, "POST", "/api/stats", { view: stats.body.view.id, period: "all" });
    expect(all.body.groups.map(group => [group.group, group.title]).sort()).toEqual([["100", "群 销售一部"], ["direct", "单聊"]]);
  });
});
