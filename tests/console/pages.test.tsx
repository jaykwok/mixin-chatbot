/** @jsxImportSource preact */
// The conversations and stats pages under happy-dom with a scripted console API: safe Markdown, reading and paging a
// conversation, identity mode switches (complete numbers need a confirmation and keep the member), bot-offline and
// expired views, run records that never claim a message was read, search, the member list refresh, exports (including
// late answers after a login change) and the stats page.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
  EntryView, ExportStatus, MemberRow, MembersResponse, Overview, RequestsResponse, SessionResponse, SpacesResponse, SpaceViewResponse, StatsResponse,
} from "../../console/ui/src/contract.ts";
import { dateTime, stamp } from "../../console/ui/src/format.ts";

const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register({ url: "http://127.0.0.1:10001/" });
const { render } = await import("preact");
const { Root } = await import("../../console/ui/src/app.tsx");
const { Markdown } = await import("../../console/ui/src/markdown.tsx");

type Call = { path: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
type Reply = { status: number; body: unknown } | "offline";

let calls: Call[] = [];
let routes: Record<string, (call: Call) => Reply | Promise<Reply>> = {};
let container: HTMLElement;
let downloads: string[] = [];
const realFetch = globalThis.fetch;
const realClick = HTMLAnchorElement.prototype.click;

beforeAll(() => {
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const call: Call = { path: String(input), method: init.method ?? "GET", headers: Object.fromEntries(Object.entries(init.headers ?? {})),
      body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const reply = await routes[`${call.method} ${call.path}`]?.(call) ?? (call.method === "GET" && call.path === "/api/runtime"
      ? { status: 200, body: { current: true } } : { status: 404, body: { error: "没有这个接口", code: "not-found" } });
    if (reply === "offline") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // Downloads are recorded, not navigated.
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.hasAttribute("download")) downloads.push(this.getAttribute("href")!);
    else realClick.call(this);
  };
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  HTMLAnchorElement.prototype.click = realClick;
  if (registered) await GlobalRegistrator.unregister();
});
afterEach(() => { render(null, container); container.remove(); calls = []; routes = {}; downloads = []; location.hash = ""; });

const NOW = Date.now();
const T = NOW - 3_600_000;
const session: SessionResponse = { session: { label: "s-test", createdAt: NOW, idleExpiresAt: NOW + 1_800_000, expiresAt: NOW + 8 * 3_600_000 }, now: NOW };
const overview: Overview = {
  checkedAt: NOW, console: { version: "1.0.1", build: "abc", hostname: "synthetic-host", platform: "linux", port: 10001, pid: 1, startedAt: NOW },
  deployment: null, deploymentError: null, recovery: null, pending: null, service: { state: "ready", attention: [] }, versions: [],
};
const GEN = "00000000-0000-4000-8000-000000000001";
const spaces: SpacesResponse = {
  observedAt: NOW,
  spaces: [
    { space: "direct", title: "单聊", state: "ready", generation: GEN, members: 2, lastEntry: 15, lastAt: T },
    { space: "groups/g1", title: "群 g1", state: "empty" },
  ],
};
const viewOf = (id: string, mode: "default" | "full" | "anonymous", kept?: string): SpaceViewResponse => ({
  view: { id, kind: "space", mode, createdAt: NOW },
  space: { space: "direct", title: "单聊", state: "ready", generation: GEN, members: 2, lastAt: T },
  members: mode === "anonymous"
    ? [{ identity: { key: `${id}-a`, label: "成员 A3" }, createdAt: T, lastAt: T, lastEntry: 15 },
      { identity: { key: `${id}-b`, label: "成员 K7" }, createdAt: T, lastAt: null, lastEntry: null }]
    : [{ identity: { key: `${id}-a`, label: `张三（${mode === "full" ? "13800000001" : "138****0001"}）`, phone: mode === "full" ? "13800000001" : "138****0001",
        name: "张三", nameState: "named", nameObservedAt: NOW }, createdAt: T, lastAt: T, lastEntry: 15 },
      { identity: { key: `${id}-b`, label: "139****0002", phone: "139****0002", nameState: "missing", nameNote: "当前通讯录缓存未找到" }, createdAt: T, lastAt: null, lastEntry: null }],
  truncated: false, names: { state: "ok", observedAt: NOW }, observedAt: NOW, ...(kept ? { kept } : {}),
});

const entries: EntryView[] = [
  { id: 10, kind: "pi.user", at: T, chars: 1, role: "user", parts: [{ type: "text", text: "你好 <img src=x onerror=alert(1)>" }] },
  { id: 11, kind: "pi.assistant", at: T, chars: 1, role: "assistant",
    parts: [
      { type: "text", text: "## 标题\n**粗体** [安全](https://example.com/a) [危险](javascript:alert(1)) <script>alert(1)</script>\n\n- 项一\n- 项二\n\n```js\nconst a = 1;\n```" },
      { type: "toolCall", callId: "c1", name: "bash", arguments: "{\n  \"cmd\": \"ls\"\n}" },
    ],
    assistant: { provider: "deepseek", model: "deepseek-chat", stopReason: "toolUse", durationMs: 1500, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120, cost: null } } },
  { id: 12, kind: "pi.tool-result", at: T, chars: 1, role: "toolResult", parts: [{ type: "text", text: "file.txt" }], tool: { callId: "c1", name: "bash", isError: false, durationMs: 30 } },
  { id: 13, kind: "pi.reset", at: null, chars: 1, head: 13, parts: [] },
  { id: 14, kind: "pi.system", at: T, chars: 1, role: "system", parts: [], system: { chars: 5000, sections: ["tools", "skills"], toolsAdded: [], toolsRemoved: [] } },
  { id: 15, kind: "pi.compaction", at: T, chars: 1, head: 12, parts: [{ type: "text", text: "压缩后的摘要" }] },
];
const newestFirst = { items: [...entries].reverse(), next: 10 };

function mount(route: string) {
  location.hash = `#/${route}`;
  container = document.createElement("div");
  document.body.append(container);
  render(<Root loginToken={null} />, container);
}

async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}\n${container.textContent?.slice(0, 2_000)}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const text = () => container.textContent ?? "";
const shows = (needle: string, ms?: number) => until(() => text().includes(needle), needle, ms);
const count = (selector: string) => container.querySelectorAll(selector).length;
const callsTo = (path: string) => calls.filter(call => call.path === path);
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
const click = (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`没有按钮：${label}`);
  target.click();
};

const base = () => ({
  "GET /api/session": (): Reply => ({ status: 200, body: session }),
  "GET /api/overview": (): Reply => ({ status: 200, body: overview }),
  "POST /api/views/close": (): Reply => ({ status: 200, body: { ok: true } }),
});

test("Markdown 只生成安全元素：原始 HTML 是文字，只有 http(s) 生成链接，图片不加载；病态输入也很快", () => {
  const box = container = document.createElement("div");
  document.body.append(box);
  render(<Markdown text={"# 题\n<script>alert(1)</script><img src=x>\n[a](https://ok.example/x) [b](javascript:alert(1)) [c](/relative) ![图](https://img.example/i.png)\n裸链接 https://bare.example/p?q=1。\n\n> 引用\n\n| 列一 | 列二 |\n| --- | ---: |\n| `x` | **y** |"} />, box);
  expect(box.querySelectorAll("script, img, iframe, style").length).toBe(0);
  expect(box.textContent).toContain("<script>alert(1)</script><img src=x>");
  const hrefs = [...box.querySelectorAll("a")].map(link => link.getAttribute("href"));
  expect(hrefs).toEqual(["https://ok.example/x", "https://bare.example/p?q=1"]);
  for (const link of box.querySelectorAll("a")) expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  expect(box.textContent).toContain("图片：图（未加载）");
  expect(box.querySelectorAll("table td").length).toBe(2);
  expect(box.querySelectorAll("blockquote").length).toBe(1);

  const started = performance.now();
  render(<Markdown text={"*".repeat(40_000) + "\n" + "**a ".repeat(8_000) + "\n" + ">".repeat(5_000) + " x\n" + "[".repeat(20_000) + "\n" + "_a".repeat(10_000)} />, box);
  expect(performance.now() - started).toBeLessThan(1_500);
});

test("会话：选择空间与成员后按页阅读；用户正文不当 Markdown，工具、/clear、系统提示、压缩各自标识", async () => {
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": () => ({ status: 200, body: viewOf("v1", "default") }),
    "POST /api/conversation/entries": call => ({ status: 200, body: call.body!.cursor === null ? newestFirst : { items: [], next: null } }),
  };
  mount("conversations");
  await shows("群 g1");
  expect(text()).toContain("还没有会话");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("张三");
  expect(callsTo("/api/views/space")[0]!.body).toEqual({ space: "direct", generation: GEN, mode: "default" });
  expect(callsTo("/api/views/space")[0]!.headers["X-Console-Intent"]).toBe("user");
  expect(text()).toContain("当前通讯录缓存未找到");

  container.querySelector<HTMLButtonElement>(".member-row")!.click();
  await shows("压缩后的摘要");
  expect(callsTo("/api/conversation/entries")[0]!.body).toEqual({ view: "v1", member: "v1-a", older: true, cursor: null });
  // Oldest first on screen.
  const ids = [...container.querySelectorAll("[data-entry]")].map(node => Number(node.getAttribute("data-entry")));
  expect(ids).toEqual([10, 11, 12, 13, 14, 15]);
  // The user's text is shown as written; the assistant's Markdown is rendered safely.
  expect(text()).toContain("你好 <img src=x onerror=alert(1)>");
  expect(count(".transcript img, .transcript script")).toBe(0);
  expect(count(".message.assistant .md-h")).toBe(1);
  expect([...container.querySelectorAll(".message.assistant a")].map(link => link.getAttribute("href"))).toEqual(["https://example.com/a"]);
  expect(text()).toContain("<script>alert(1)</script>");
  expect(text()).toContain("deepseek/deepseek-chat");
  expect(text()).toContain("120 token");
  expect(count(".tool-call")).toBe(1);
  expect(count(".tool-result")).toBe(1);
  expect(text()).toContain("/clear：此后开始新的上下文");
  expect(text()).toContain("系统提示 · 5,000 字 · 段：tools、skills");
  expect(text()).toContain("此后模型上下文从 #12 起保留");

  click("加载更早的记录");
  await until(() => callsTo("/api/conversation/entries").length === 2, "第二页");
  expect(callsTo("/api/conversation/entries")[1]!.body).toMatchObject({ older: true, cursor: 10 });
  await shows("已到这段会话的开头");
});

test("完整身份需要本次确认；切换模式保留当前成员并重新读取，返回列表后回到默认", async () => {
  let opened = 0;
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": call => {
      opened++;
      return { status: 200, body: call.body!.mode === "full" ? viewOf("v2", "full", "v2-a") : viewOf(`v${opened}`, "default") };
    },
    "POST /api/conversation/entries": () => ({ status: 200, body: { items: [entries[0]!], next: null } }),
  };
  mount("conversations");
  await until(() => container.querySelector(".space-card") !== null, "空间卡片");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("138****0001");
  container.querySelector<HTMLButtonElement>(".member-row")!.click();
  await until(() => callsTo("/api/conversation/entries").length === 1, "读取会话");

  container.querySelector<HTMLButtonElement>('[role="radio"][data-value="full"]')!.click();
  await shows("我确认需要查看完整号码");
  const confirm = button("确认并显示")!;
  expect(confirm.disabled).toBe(true);
  const box = container.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!;
  box.click();
  await until(() => !button("确认并显示")!.disabled, "勾选后可确认");
  click("确认并显示");
  await shows("13800000001");
  expect(callsTo("/api/views/space")[1]!.body).toEqual({ space: "direct", generation: GEN, mode: "full", confirm: true, keep: { view: "v1", member: "v1-a" } });
  // The kept member is read again through the new view, and the old view is closed.
  await until(() => callsTo("/api/conversation/entries").some(call => call.body!.view === "v2" && call.body!.member === "v2-a"), "新视图读取");
  expect(callsTo("/api/views/close").map(call => call.body)).toContainEqual({ view: "v1" });
  expect(container.querySelector(".mode-badge")?.textContent).toBe("完整身份");

  click("全部空间");
  await shows("群 g1");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("138****0001");
  expect(callsTo("/api/views/space").at(-1)!.body).toMatchObject({ mode: "default" });
  expect(callsTo("/api/views/space").at(-1)!.body!.confirm).toBeUndefined();
});

test("机器人未运行时会话页显示不可用；视图过期时提示重新打开", async () => {
  routes = { ...base(), "GET /api/spaces": () => ({ status: 503, body: { error: "机器人未运行", code: "bot-offline" } }) };
  mount("conversations");
  await shows("机器人未运行，实时会话不可用");
  expect(text()).toContain("不会在机器人停止时直接打开会话库");
  render(null, container);
  calls = [];

  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": () => ({ status: 200, body: viewOf("v1", "default") }),
    "POST /api/conversation/entries": () => ({ status: 410, body: { error: "这个视图已关闭或过期，请重新打开", code: "view-gone" } }),
  };
  render(<Root loginToken={null} />, container);
  await until(() => container.querySelector(".space-card") !== null, "空间卡片");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("张三");
  container.querySelector<HTMLButtonElement>(".member-row")!.click();
  await shows("这个视图已过期");
  click("重新打开");
  await until(() => callsTo("/api/views/space").length === 2, "重新打开空间");
  expect(callsTo("/api/spaces").length).toBe(2);
});

test("运行记录区分平台已接收、结果不确定、失败与重试、已放弃，不声称对方已读", async () => {
  const records: RequestsResponse = {
    total: 1, observedAt: NOW,
    items: [{
      requestId: "r1", createdAt: T, closedAt: null, cancelled: false, summary: "帮我写周报", receivedAt: T, sentAt: T, entry: 10, answer: 11, status: "done",
      delivery: { kind: "reply", abandoned: true, abandonedReason: "expired", parts: [
        { id: "p1", kind: "markdown", state: "sent", attempts: 1, at: T },
        { id: "p2", kind: "markdown", state: "uncertain", attempts: 1, error: "发送过程中服务中断，结果未知" },
        { id: "p3", kind: "file", state: "failed", attempts: 2, retryAt: NOW + 60_000, error: "平台拒绝" },
        { id: "p4", kind: "links", state: "failed", attempts: 5 },
      ] },
      files: [{ name: "周报.docx", state: "sent", size: 2048, mode: "relay" }],
      deliverables: [{ name: "周报.docx", status: "checked", size: 2048, complete: true }],
    }],
  };
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": () => ({ status: 200, body: viewOf("v1", "default") }),
    "POST /api/conversation/entries": () => ({ status: 200, body: newestFirst }),
    "POST /api/conversation/requests": () => ({ status: 200, body: records }),
  };
  mount("conversations");
  await until(() => container.querySelector(".space-card") !== null, "空间卡片");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("张三");
  container.querySelector<HTMLButtonElement>(".member-row")!.click();
  await shows("压缩后的摘要");
  container.querySelector<HTMLButtonElement>('[role="radio"][data-value="runs"]')!.click();
  await shows("帮我写周报");
  const chips = [...container.querySelectorAll(".run-card .chip")].map(chip => chip.textContent);
  expect(chips).toEqual(["已完成", "已放弃：超出发送时限", "平台已接收", "结果不确定", "失败", "失败", "平台已接收", "已检查"]);
  expect(chips.some(chip => chip?.includes("已读"))).toBe(false);
  expect(text()).toContain("没有已读证据");
  expect(text()).toContain("不再重试");
  expect(text()).toMatch(/将于 \d\d:\d\d:\d\d 重试/);
  expect(text()).toContain("外链");

  // Jumping to the answer opens the conversation at that entry.
  click("回答 #11");
  await until(() => callsTo("/api/conversation/entries").some(call => call.body!.older === false && call.body!.cursor === 10), "跳到回答");
});

test("搜索：没有命中时在本次点击的额度内继续往前读；命中后可跳到其他成员的那一条", async () => {
  let blocks = 0;
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": () => ({ status: 200, body: viewOf("v1", "default") }),
    "POST /api/conversation/entries": () => ({ status: 200, body: { items: entries.slice(0, 2), next: null } }),
    "POST /api/conversation/search": () => {
      blocks++;
      return { status: 200, body: blocks === 1 ? { hits: [], scanned: 500, next: 900, terms: ["报销"] }
        : { hits: [{ id: 42, member: "v1-b", kind: "pi.user", at: T, snippet: "…报销单在哪里" }], scanned: 120, next: null, terms: ["报销"] } };
    },
  };
  mount("conversations");
  await until(() => container.querySelector(".space-card") !== null, "空间卡片");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("张三");
  click("搜索");
  await searchFor(".search-pane", "报销");
  await shows("已检查 620 条，找到 1 处，已搜到最早的记录");
  const searches = callsTo("/api/conversation/search").map(call => call.body);
  const none = { kinds: null, from: null, to: null };
  expect(searches).toEqual([{ view: "v1", text: "报销", member: null, ...none, cursor: null }, { view: "v1", text: "报销", member: null, ...none, cursor: 900 }]);
  expect(container.querySelector(".hit mark")?.textContent).toBe("报销");
  container.querySelector<HTMLButtonElement>(".hit")!.click();
  await until(() => callsTo("/api/conversation/entries").some(call => call.body!.member === "v1-b" && call.body!.cursor === 41), "跳到命中");
});

test("搜索筛选：内容类型和时间范围随请求发出，多个词各自标出；结束日期早于起始日期时不发请求", async () => {
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": () => ({ status: 200, body: viewOf("v1", "default") }),
    "POST /api/conversation/entries": () => ({ status: 200, body: { items: entries.slice(0, 2), next: null } }),
    "POST /api/conversation/search": () => ({ status: 200, body: {
      hits: [{ id: 42, member: "v1-a", kind: "pi.assistant", at: T, snippet: "报销单在三楼财务室，发票也交那里" }], scanned: 30, next: null, terms: ["报销", "发票"] } }),
  };
  mount("conversations");
  await until(() => container.querySelector(".space-card") !== null, "空间卡片");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("张三");
  click("搜索");
  await until(() => container.querySelector(".search-pane .kind-toggles") !== null, "筛选");
  const pane = container.querySelector<HTMLElement>(".search-pane")!;
  const toggle = [...pane.querySelectorAll<HTMLButtonElement>(".kind-toggles button")].find(item => item.textContent === "回答")!;
  toggle.click();
  await until(() => toggle.getAttribute("aria-pressed") === "true", "回答已选");
  const range = pane.querySelector<HTMLSelectElement>("select[aria-label='时间范围']")!;
  range.value = "custom";
  range.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => pane.querySelector("input[aria-label='起始日期']") !== null, "自定义日期");
  const setDate = (label: string, value: string) => {
    const field = pane.querySelector<HTMLInputElement>(`input[aria-label='${label}']`)!;
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };
  setDate("起始日期", "2026-10-05");
  setDate("结束日期", "2026-10-01");
  await shows("起始日期晚于结束日期");
  await searchFor(".search-pane", "报销 发票", false);
  expect(callsTo("/api/conversation/search")).toEqual([]);

  setDate("结束日期", "2026-10-07");
  await until(() => !text().includes("起始日期晚于结束日期"), "日期改对");
  await searchFor(".search-pane", "报销 发票");
  await shows("已搜完所选时间");
  const body = callsTo("/api/conversation/search")[0]!.body!;
  expect([body.kinds, body.from, body.to]).toEqual([["answer"], new Date(2026, 9, 5).getTime(), new Date(2026, 9, 8).getTime()]);
  expect([...container.querySelectorAll(".search-pane .hit mark")].map(mark => mark.textContent)).toEqual(["报销", "发票"]);
  // With results shown, changing a filter searches again with it rather than leaving the old results.
  toggle.click();
  await until(() => callsTo("/api/conversation/search").length === 2, "按新筛选重搜");
  expect(callsTo("/api/conversation/search")[1]!.body).toMatchObject({ text: "报销 发票", kinds: null, cursor: null });
});

test("搜索全部会话：有结果后改内容类型或身份模式，即按新条件重新搜索", async () => {
  let views = 0;
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/search": call => { views++; return { status: 200, body: { view: { id: `s${views}`, kind: "search", mode: call.body!.mode, createdAt: NOW }, spaces: 1 } }; },
    "POST /api/search": call => ({ status: 200, body: { hits: call.body!.kinds ? [] : [{ id: 7, space: spaces.spaces[0]!.space, title: "单聊",
      member: { key: "x", label: "成员 Q4" }, kind: "pi.user", at: T, snippet: "周报几点交" }], scanned: 3, next: null, terms: ["周报"], title: "单聊", skipped: [] } }),
  };
  mount("conversations");
  await searchFor(".global-search", "周报");
  await shows("已检查 3 条，找到 1 处");
  const box = container.querySelector<HTMLElement>(".global-search")!;
  [...box.querySelectorAll<HTMLButtonElement>(".kind-toggles button")].find(item => item.textContent === "回答")!.click();
  await until(() => callsTo("/api/search").length === 2, "按类型重搜");
  expect(callsTo("/api/search")[1]!.body).toMatchObject({ view: "s2", text: "周报", kinds: ["answer"], cursor: null });
  await shows("已检查 3 条，找到 0 处");
  [...box.querySelectorAll<HTMLButtonElement>(".segmented button")].find(item => item.textContent === "匿名")!.click();
  await until(() => callsTo("/api/search").length === 3, "按身份模式重搜");
  expect(callsTo("/api/views/search").map(call => call.body)).toEqual([{ mode: "default" }, { mode: "default" }, { mode: "anonymous" }]);
  // Each new search closes the view of the one before (the previous test's space view may close late, so only search views count).
  const closed = () => callsTo("/api/views/close").map(call => call.body!.view).filter(view => String(view).startsWith("s"));
  await until(() => closed().length === 2, "关闭旧视图");
  expect(closed()).toEqual(["s1", "s2"]);
});

test("搜索全部会话：先建搜索视图再逐个空间搜；跳过的空间说明原因；点命中按搜索的身份模式打开空间并保留成员", async () => {
  const groupGen = "00000000-0000-4000-8000-000000000002";
  const twoSpaces: SpacesResponse = { observedAt: NOW, spaces: [spaces.spaces[0]!, { space: "groups/g2", title: "群 g2", state: "ready", generation: groupGen, members: 1, lastEntry: 3, lastAt: T }] };
  let blocks = 0;
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: twoSpaces }),
    "POST /api/views/search": () => ({ status: 200, body: { view: { id: "s1", kind: "search", mode: "anonymous", createdAt: NOW }, spaces: 2 } }),
    "POST /api/search": () => {
      blocks++;
      return { status: 200, body: blocks === 1
        ? { hits: [], scanned: 0, next: { space: 1, entry: null }, terms: [], title: "单聊", skipped: [{ title: "单聊", reason: "会话库已更换" }] }
        : { hits: [{ id: 7, space: "groups/g2", title: "群 g2", member: { key: "s1-x", label: "成员 Q4" }, kind: "pi.user", at: T, snippet: "周报几点交" }],
          scanned: 3, next: null, terms: ["周报"], title: "群 g2", skipped: [] } };
    },
    "POST /api/views/space": () => ({ status: 200, body: { ...viewOf("v2", "anonymous", "v2-a"),
      space: { space: "groups/g2", title: "群 g2", state: "ready", generation: groupGen, members: 1, lastAt: T } } }),
    "POST /api/conversation/entries": () => ({ status: 200, body: { items: entries.slice(0, 2), next: null } }),
  };
  mount("conversations");
  await until(() => container.querySelector(".global-search .search-form") !== null, "全部会话搜索");
  const anonymous = [...container.querySelectorAll<HTMLButtonElement>(".global-search .segmented button")].find(item => item.textContent === "匿名")!;
  anonymous.click();
  await until(() => anonymous.getAttribute("aria-checked") === "true", "匿名已选");
  await searchFor(".global-search", "周报");
  await shows("已检查 3 条，找到 1 处，全部空间已搜到最早的记录");
  expect(callsTo("/api/views/search").map(call => call.body)).toEqual([{ mode: "anonymous" }]);
  expect(callsTo("/api/search").map(call => call.body!.cursor)).toEqual([null, { space: 1, entry: null }]);
  expect(text()).toContain("跳过了 1 个空间");
  expect(text()).toContain("单聊（会话库已更换）");
  expect(container.querySelector(".global-search .hit")?.textContent).toContain("成员 Q4 · 群 g2");

  container.querySelector<HTMLButtonElement>(".global-search .hit")!.click();
  await until(() => callsTo("/api/conversation/entries").some(call => call.body!.member === "v2-a" && call.body!.cursor === 6), "跳到命中");
  expect(callsTo("/api/views/space")[0]!.body).toEqual({ space: "groups/g2", generation: groupGen, mode: "anonymous", keep: { view: "s1", member: "s1-x" } });
  expect(container.querySelector<HTMLElement>(".global-search")!.hidden).toBe(true);
  // Back on the list the results are where they were; clearing them closes the search view.
  click("全部空间");
  await until(() => container.querySelector<HTMLElement>(".global-search")?.hidden === false, "回到列表");
  expect(text()).toContain("成员 Q4 · 群 g2");
  click("清除结果");
  await until(() => callsTo("/api/views/close").some(call => call.body!.view === "s1"), "关闭搜索视图");
  expect(container.querySelector(".global-search .hit")).toBeNull();
});

/** Types the text into the search form under the selector and submits it (or checks the button stays disabled). */
async function searchFor(scope: string, value: string, submits = true) {
  await until(() => container.querySelector(`${scope} .search-form input`) !== null, "搜索框");
  const input = container.querySelector<HTMLInputElement>(`${scope} .search-form input`)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const submit = () => container.querySelector<HTMLButtonElement>(`${scope} .search-form button[type='submit']`);
  if (!submits) {
    await until(() => input.value === value, "已输入");
    expect(submit()?.disabled).toBe(true);
    return;
  }
  await until(() => submit()?.disabled === false, "输入后可搜索");
  container.querySelector<HTMLFormElement>(`${scope} .search-form`)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

test("会话：刷新（阅读区或成员列表）带回成员最近活动与新成员，聊天框也重读；失败时保留上一次的列表并可重试", async () => {
  const LATER = NOW - 60_000;
  const [alice, other] = viewOf("v1", "default").members;
  const newcomer: MemberRow = { identity: { key: "v1-c", label: "王五（138****0004）", phone: "138****0004", name: "王五", nameState: "named", nameObservedAt: NOW },
    createdAt: LATER, lastAt: LATER - 5_000, lastEntry: 20 };
  const refreshed: MembersResponse = { members: [{ ...alice!, lastAt: LATER, lastEntry: 21 }, newcomer, other!], added: 1, truncated: false, observedAt: NOW };
  let busy = false;
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": () => ({ status: 200, body: viewOf("v1", "default") }),
    "POST /api/conversation/entries": () => ({ status: 200, body: { items: [entries[0]!], next: null } }),
    "POST /api/conversation/activity": () => busy
      ? { status: 429, body: { error: "机器人正忙于其他读取，请稍后重试", code: "busy" } }
      : { status: 200, body: refreshed },
  };
  const aliceTime = () => container.querySelector(".member-row .member-sub")?.textContent ?? "";
  mount("conversations");
  await shows("群 g1");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("张三");
  container.querySelector<HTMLButtonElement>(".member-row")!.click();
  await until(() => callsTo("/api/conversation/entries").length === 1, "读取会话");
  expect(text()).toContain(`最近 ${dateTime(T)}`);
  expect(aliceTime()).toBe(stamp(T, NOW));

  click("回到最新");
  await shows(`最近 ${dateTime(LATER)}`);
  expect(callsTo("/api/conversation/activity")[0]!.body).toEqual({ view: "v1" });
  expect(callsTo("/api/conversation/activity")[0]!.headers["X-Console-Intent"]).toBe("user");
  await until(() => callsTo("/api/conversation/entries").length === 2, "聊天框重新读取");
  expect(aliceTime()).toBe(stamp(LATER, NOW));
  expect(count(".member-row")).toBe(3);
  expect(text()).toContain("王五");
  expect(text()).toContain("3 位成员");

  busy = true;
  click("刷新成员列表");
  await shows("刷新成员列表失败");
  expect(text()).toContain("机器人正忙于其他读取，请稍后重试（列表仍是上一次读取的结果）");
  expect(count(".member-row")).toBe(3);
  expect(text()).toContain(`最近 ${dateTime(LATER)}`);
  busy = false;
  click("重试");
  await until(() => !text().includes("刷新成员列表失败"), "重试后横幅消失");
  expect(callsTo("/api/conversation/activity").length).toBe(3);
  // The member pane's button reads the list only; the open conversation stays as it is.
  expect(callsTo("/api/conversation/entries").length).toBe(2);
});

test("导出：申请一次性链接后由浏览器下载，托盘跟踪到发送完毕；并发已满时说明原因", async () => {
  let busy = false;
  const status: ExportStatus = { id: "e1", state: "sent", filename: "会话-单聊-成员x.json", rows: 6, bytes: 2048 };
  routes = {
    ...base(),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": () => ({ status: 200, body: viewOf("v1", "default") }),
    "POST /api/conversation/entries": () => ({ status: 200, body: newestFirst }),
    "POST /api/exports": () => busy ? { status: 429, body: { error: "已有 2 个导出在进行", code: "busy" } }
      : { status: 200, body: { id: "e1", url: "/download/e1", filename: status.filename, expiresAt: NOW + 60_000 } },
    "POST /api/exports/status": () => ({ status: 200, body: status }),
  };
  mount("conversations");
  await until(() => container.querySelector(".space-card") !== null, "空间卡片");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("张三");
  container.querySelector<HTMLButtonElement>(".member-row")!.click();
  await shows("压缩后的摘要");
  click("导出");
  await shows("导出会话");
  container.querySelector<HTMLButtonElement>('[role="dialog"] [role="radio"][data-value="json"]')!.click();
  await until(() => container.querySelector('[role="dialog"] [data-value="json"]')?.getAttribute("aria-checked") === "true", "选中 JSON");
  click("开始导出");
  await until(() => downloads.length === 1, "开始下载");
  expect(downloads).toEqual(["/download/e1"]);
  expect(callsTo("/api/exports")[0]!.body).toEqual({ type: "conversation", view: "v1", member: "v1-a", format: "json", mode: "default" });
  await shows("已发送完毕", 4_000);
  expect(text()).toContain("是否保存成功以浏览器下载记录为准");
  expect(callsTo("/api/exports/status")[0]!.body).toEqual({ id: "e1" });
  expect(callsTo("/api/exports/status")[0]!.headers["X-Console-Intent"]).toBeUndefined();

  busy = true;
  click("导出");
  await shows("导出会话");
  click("开始导出");
  await shows("同时最多 2 个导出");
  expect(downloads.length).toBe(1);
});

test("导出：换了登录之后，旧页面迟到的导出链接和状态应答都不改动新页面（不下载、托盘不出现、不再轮询）", async () => {
  let releaseStatus!: () => void, releaseTicket!: () => void;
  const statusHeld = new Promise<void>(resolve => { releaseStatus = resolve; });
  const ticketHeld = new Promise<void>(resolve => { releaseTicket = resolve; });
  let tickets = 0;
  routes = {
    ...base(),
    "POST /api/session/exchange": () => ({ status: 200, body: session }),
    "GET /api/spaces": () => ({ status: 200, body: spaces }),
    "POST /api/views/space": () => ({ status: 200, body: viewOf("v1", "default") }),
    "POST /api/conversation/entries": () => ({ status: 200, body: newestFirst }),
    "POST /api/exports": async () => {
      const id = `e${++tickets}`;
      if (tickets === 2) await ticketHeld;
      return { status: 200, body: { id, url: `/download/${id}`, filename: `旧导出-${id}.json`, expiresAt: NOW + 60_000 } };
    },
    "POST /api/exports/status": async () => {
      await statusHeld;
      return { status: 200, body: { id: "e1", state: "running", filename: "旧导出-e1.json", rows: 1, bytes: 10 } };
    },
  };
  mount("conversations");
  await until(() => container.querySelector(".space-card") !== null, "空间卡片");
  container.querySelector<HTMLButtonElement>(".space-card")!.click();
  await shows("张三");
  container.querySelector<HTMLButtonElement>(".member-row")!.click();
  await shows("压缩后的摘要");
  click("导出");
  await shows("导出会话");
  click("开始导出");
  await until(() => downloads.length === 1 && callsTo("/api/exports/status").length === 1, "第一个导出开始下载并查询状态", 4_000);
  click("导出");
  await shows("导出会话");
  click("开始导出");
  await until(() => callsTo("/api/exports").length === 2, "第二个导出申请链接");

  location.hash = `#login=${"n".repeat(43)}`;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await until(() => callsTo("/api/session/exchange").length === 1 && callsTo("/api/overview").length === 2 && count(".layout") === 1, "新登录的页面");
  releaseStatus();
  releaseTicket();
  await Bun.sleep(1_300);
  expect(downloads).toEqual(["/download/e1"]);
  expect(callsTo("/api/exports/status")).toHaveLength(1);
  expect(text()).not.toContain("旧导出");
});

const stats = (group: string | null, names: StatsResponse["names"] = { state: "ok", observedAt: NOW }): StatsResponse => ({
  window: { label: "近 30 天（2026-09-28 ~ 2026-10-27）", since: T, until: NOW, period: "30d" }, group, member: null, observedAt: NOW, names,
  summary: { asks: 42, people: 5, average: 8.4, activeDays: 3, days: 30, dailyAverage: 1.4, activeRate: 0.1, peak: { date: "2026-10-26", asks: 30 }, topFiveShare: 1,
    tokens: { input: 120_000, output: 30_000, cacheRead: 0, cacheWrite: 0, totalTokens: 150_000 } },
  comparisons: [{ label: "环比", window: "2026-08-29 ~ 2026-09-27", asks: 21, people: 5, average: 4.2 }],
  trend: [{ date: "2026-10-25", asks: 2, people: 1, tokens: 100 }, { date: "2026-10-26", asks: 30, people: 4, tokens: 1000 }, { date: "2026-10-27", asks: 0, people: 0, tokens: 0 }],
  grain: "day",
  groups: [{ group: "direct", title: "单聊", asks: 12, people: 2, activeDays: 2, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, firstAt: T, lastAt: NOW },
    { group: "g1", title: "群 g1", asks: 30, people: 4, activeDays: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, firstAt: T, lastAt: NOW }],
  ranking: [{ identity: { key: "k1", label: "138****0001", phone: "138****0001", nameState: "offline", nameNote: "机器人未运行，姓名不可用" }, asks: 20, activeDays: 2, groups: 2 }],
  members: group ? [{ identity: { key: "k1", label: "138****0001", phone: "138****0001", nameState: "offline", nameNote: "机器人未运行，姓名不可用" }, asks: 20, activeDays: 2, firstAt: T, lastAt: NOW }] : null,
  models: [{ key: "deepseek/deepseek-chat", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 150_000 } }], tools: [],
  notes: { stats: "统计口径说明", tokens: "token 说明", identity: "身份说明" },
});

test("统计：打开视图后按筛选读取；趋势有逐柱提示和表格视图；点群只看该群；停机时注明没有姓名", async () => {
  let viewGone = true;
  routes = {
    ...base(),
    "POST /api/views/stats": call => ({ status: 200, body: { view: { id: `s-${callsTo("/api/views/stats").length}`, kind: "stats", mode: call.body!.mode, createdAt: NOW } } }),
    "POST /api/stats": call => {
      // The first view has gone by the first read: the page opens another and reads again.
      if (viewGone) { viewGone = false; return { status: 410, body: { error: "这个视图已关闭或过期，请重新打开", code: "view-gone" } }; }
      return { status: 200, body: stats((call.body!.group as string | null) ?? null, { state: "offline", note: "机器人未运行" }) };
    },
  };
  mount("stats");
  await shows("提问次数");
  expect(callsTo("/api/views/stats").map(call => call.body)).toEqual([{ mode: "default" }, { mode: "default" }]);
  expect(callsTo("/api/stats").at(-1)!.body).toEqual({ view: "s-2", period: "30d", group: null, grain: "day" });
  expect(text()).toContain("42");
  expect(text()).toContain("15 万");
  expect(text()).toContain("机器人未运行，姓名不可用");
  expect(text()).toContain("↑ +100.0%");
  // Two non-zero days drawn; every day has a hover target.
  expect(count(".chart-bar")).toBe(2);
  expect(count(".chart-hit")).toBe(3);
  container.querySelectorAll(".chart-hit")[1]!.dispatchEvent(new MouseEvent("mouseenter"));
  await until(() => container.querySelector(".chart-tip") !== null, "提示");
  expect(container.querySelector(".tip-value")?.textContent).toBe("30 次");
  // The keyboard reaches every column too.
  container.querySelector(".chart-focus")!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  await until(() => container.querySelector(".tip-value")?.textContent === "0 次", "键盘到最后一柱");
  container.querySelector(".chart-focus")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => container.querySelector(".chart-tip") === null, "Esc 关闭提示");
  click("以表格显示");
  await until(() => count(".table-wrap.tall tbody tr") >= 3, "趋势表格");

  click("只看此群");
  await until(() => callsTo("/api/stats").at(-1)!.body!.group === "g1", "按群筛选");
  await shows("群 g1的成员");
  click("清除群筛选");
  await until(() => callsTo("/api/stats").at(-1)!.body!.group === null, "清除筛选");

  // Custom ranges are checked before asking.
  const more = container.querySelector<HTMLSelectElement>('select[aria-label="更多区间"]')!;
  more.value = "custom";
  more.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => container.querySelector('input[aria-label="起始日期"]') !== null, "自定义日期");
  const before = callsTo("/api/stats").length;
  const since = container.querySelector<HTMLInputElement>('input[aria-label="起始日期"]')!;
  const until_ = container.querySelector<HTMLInputElement>('input[aria-label="结束日期"]')!;
  since.value = "2026-10-20";
  since.dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => callsTo("/api/stats").length > before, "自定义起点");
  until_.value = "2026-10-01";
  until_.dispatchEvent(new Event("change", { bubbles: true }));
  await shows("起始日期晚于结束日期");
  const after = callsTo("/api/stats").length;
  await Bun.sleep(30);
  expect(callsTo("/api/stats").length).toBe(after);
});

test("统计：完整身份需要确认，过期后回到默认并说明；导出的完整号码要在对话框里单独确认", async () => {
  let gone = false;
  routes = {
    ...base(),
    "POST /api/views/stats": call => ({ status: 200, body: { view: { id: `s-${callsTo("/api/views/stats").length}`, kind: "stats", mode: call.body!.mode, createdAt: NOW } } }),
    "POST /api/stats": () => gone ? { status: 410, body: { error: "这个视图已关闭或过期，请重新打开", code: "view-gone" } } : { status: 200, body: stats(null) },
    "POST /api/exports": () => ({ status: 200, body: { id: "e2", url: "/download/e2", filename: "统计.csv", expiresAt: NOW + 60_000 } }),
    "POST /api/exports/status": () => ({ status: 200, body: { id: "e2", state: "sent", filename: "统计.csv", rows: 3, bytes: 300 } }),
  };
  mount("stats");
  await shows("提问次数");
  container.querySelector<HTMLButtonElement>('[role="radio"][data-value="full"]')!.click();
  await shows("我确认需要查看完整号码");
  click("取消");
  await until(() => container.querySelector('[role="dialog"]') === null, "取消确认");
  expect(callsTo("/api/views/stats").length).toBe(1);

  container.querySelector<HTMLButtonElement>('[role="radio"][data-value="full"]')!.click();
  await shows("我确认需要查看完整号码");
  container.querySelector<HTMLInputElement>('[role="dialog"] input[type="checkbox"]')!.click();
  await until(() => !button("确认并显示")!.disabled, "勾选后可确认");
  click("确认并显示");
  await until(() => container.querySelector(".mode-badge")?.textContent === "完整身份", "完整身份视图");
  expect(callsTo("/api/views/stats")[1]!.body).toEqual({ mode: "full", confirm: true });
  expect(callsTo("/api/views/close").map(call => call.body)).toContainEqual({ view: "s-1" });

  gone = true;
  click("刷新统计");
  await shows("统计视图已过期，已回到默认模式");
  // The notice renders first; the new view is opened by the effect after that render.
  await until(() => callsTo("/api/views/stats").length === 3, "重新打开默认视图");
  expect(callsTo("/api/views/stats")[2]!.body).toEqual({ mode: "default" });
  gone = false;
  click("刷新统计");
  await until(() => container.querySelector(".mode-badge")?.textContent === "默认", "默认视图");
  await until(() => !button("导出")!.disabled, "默认视图的统计结果就绪");

  click("导出");
  await shows("导出统计");
  const dialog = () => container.querySelector('[role="dialog"]')!;
  dialog().querySelector<HTMLButtonElement>('[role="radio"][data-value="csv"]')!.click();
  dialog().querySelector<HTMLButtonElement>('[role="radio"][data-value="full"]')!.click();
  await until(() => dialog().querySelector('input[type="checkbox"]') !== null, "导出的完整号码确认");
  expect(button("开始导出")!.disabled).toBe(true);
  dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await until(() => !button("开始导出")!.disabled, "勾选后可导出");
  click("开始导出");
  await until(() => downloads.length === 1, "开始下载");
  expect(callsTo("/api/exports")[0]!.body).toEqual({ type: "stats", format: "csv", mode: "full", confirm: true, period: "30d", group: null });
  // The page's own view stays in its mode.
  expect(container.querySelector(".mode-badge")?.textContent).toBe("默认");
});

test("统计：成员筛选与导出使用当前视图键；切换身份重置选择且不沿用旧名单", async () => {
  let release: (() => void) | undefined;
  routes = {
    ...base(),
    "POST /api/views/stats": call => ({ status: 200, body: { view: { id: `s-${callsTo("/api/views/stats").length}`, kind: "stats", mode: call.body!.mode, createdAt: NOW } } }),
    "POST /api/stats": async call => {
      const result = stats(null);
      const anonymous = call.body!.view === "s-2";
      const identity = anonymous ? { key: "anon-key", label: "成员 A7" } : result.ranking[0]!.identity;
      result.ranking = [{ identity, asks: 20, activeDays: 2, groups: 2 }];
      if (call.body!.member) {
        await new Promise<void>(resolve => { release = resolve; });
        result.member = identity;
        result.summary = { ...result.summary, asks: 20, people: 1 };
      }
      return { status: 200, body: result };
    },
    "POST /api/exports": () => ({ status: 200, body: { id: "member-export", url: "/download/member-export", filename: "统计.csv", expiresAt: NOW + 60_000 } }),
    "POST /api/exports/status": () => ({ status: 200, body: { id: "member-export", state: "sent", filename: "统计.csv", rows: 2, bytes: 300 } }),
  };
  mount("stats");
  await shows("提问次数");
  const picker = () => container.querySelector<HTMLSelectElement>('select[aria-label="成员筛选"]')!;
  picker().value = "k1";
  picker().dispatchEvent(new Event("change", { bubbles: true }));
  await until(() => release !== undefined, "筛选请求");
  expect(callsTo("/api/stats").at(-1)!.body).toMatchObject({ view: "s-1", member: "k1" });
  await until(() => button("导出")!.disabled, "结果到达前不可导出旧合计");
  release!();
  await until(() => !button("导出")!.disabled, "筛选结果就绪");
  expect(container.querySelector(".page-desc")!.textContent).toContain("138****0001");
  click("导出");
  await shows("导出统计");
  expect(container.querySelector('[role="dialog"]')!.textContent).toContain("138****0001");
  click("开始导出");
  await until(() => downloads.length === 1 && container.querySelector('[role="dialog"]') === null, "成员导出");
  expect(callsTo("/api/exports")[0]!.body).toMatchObject({ type: "stats", view: "s-1", member: "k1", group: null, mode: "default" });
  expect(JSON.stringify(callsTo("/api/exports"))).not.toContain("13800000001");
  container.querySelector<HTMLButtonElement>('[role="radio"][data-value="anonymous"]')!.click();
  await shows("成员 A7");
  expect(picker().value).toBe("");
  expect([...picker().options].map(option => option.value)).toEqual(["", "anon-key"]);
  expect(text()).not.toContain("138****0001");
  expect(callsTo("/api/stats").filter(call => call.body!.view === "s-2").every(call => call.body!.member === undefined)).toBe(true);
  expect(callsTo("/api/views/close").map(call => call.body)).toContainEqual({ view: "s-1" });
});

test("统计：筛选读取失败时保留旧结果但不能将旧成员与新范围一起导出", async () => {
  routes = {
    ...base(),
    "POST /api/views/stats": () => ({ status: 200, body: { view: { id: "s-error", kind: "stats", mode: "default", createdAt: NOW } } }),
    "POST /api/stats": call => call.body!.member
      ? { status: 503, body: { error: "账本暂不可读", code: "unavailable" } }
      : { status: 200, body: stats(null) },
  };
  mount("stats");
  await shows("提问次数");
  const picker = container.querySelector<HTMLSelectElement>('select[aria-label="成员筛选"]')!;
  picker.value = "k1"; picker.dispatchEvent(new Event("change", { bubbles: true }));
  await shows("读取统计失败");
  expect(text()).toContain("上一次读取的结果");
  expect(button("导出")!.disabled).toBe(true);
});

test("统计：新开的视图读取时又已过期，只重开一次，然后显示错误；重试再重开一次", async () => {
  routes = {
    ...base(),
    "POST /api/views/stats": call => ({ status: 200, body: { view: { id: `s-${callsTo("/api/views/stats").length}`, kind: "stats", mode: call.body!.mode, createdAt: NOW } } }),
    "POST /api/stats": () => ({ status: 410, body: { error: "这个视图已关闭或过期，请重新打开", code: "view-gone" } }),
  };
  mount("stats");
  await shows("读取统计失败");
  await Bun.sleep(50);
  expect(callsTo("/api/views/stats").length).toBe(2);
  expect(callsTo("/api/stats").length).toBe(2);
  click("重试");
  await until(() => callsTo("/api/stats").length === 4, "重试后再读两次");
  await shows("读取统计失败");
  await Bun.sleep(50);
  expect(callsTo("/api/views/stats").length).toBe(3);
  expect(callsTo("/api/stats").length).toBe(4);
});
