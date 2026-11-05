/** @jsxImportSource preact */
// Page components under happy-dom with a scripted fetch: the login gate, losing the session (never through a late
// answer to an earlier login's page), the command palette, and which requests renew the idle timer.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Overview, SessionResponse } from "../../ui/console/src/contract.ts";

GlobalRegistrator.register({ url: "http://127.0.0.1:11012/" });
const { render } = await import("preact");
const { Root } = await import("../../ui/console/src/app.tsx");
const { takeLoginToken } = await import("../../ui/console/src/login.ts");

type Call = { path: string; method: string; headers: Record<string, string>; body?: string; signal: boolean };
type Reply = { status: number; body: unknown } | "offline";

let calls: Call[] = [];
let routes: Record<string, (call: Call) => Reply | Promise<Reply>> = {};
let container: HTMLElement;
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const call: Call = { path: String(input), method: init.method ?? "GET", headers: Object.fromEntries(Object.entries(init.headers ?? {})), body: init.body as string | undefined, signal: init.signal != null };
    calls.push(call);
    const reply = await routes[`${call.method} ${call.path}`]?.(call) ?? (call.path === "/api/runtime" ? { status: 200, body: { current: true } } : { status: 404, body: { error: "没有这个接口", code: "not-found" } });
    if (reply === "offline") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterAll(async () => { globalThis.fetch = realFetch; await GlobalRegistrator.unregister(); });
afterEach(() => { render(null, container); container.remove(); calls = []; routes = {}; location.hash = ""; });

const NOW = Date.now();
const session = (idleMs = 30 * 60_000): SessionResponse => ({ session: { label: "s-test", createdAt: NOW, idleExpiresAt: NOW + idleMs, expiresAt: NOW + 8 * 3_600_000 }, now: NOW });
const overview: Overview = {
  checkedAt: NOW, console: { version: "1.0.1", build: "abc", hostname: "synthetic-host", platform: "linux", port: 11012, pid: 1, startedAt: NOW },
  deployment: { platform: "linux", runtime: "docker", mode: "rootless", port: 11011, dataRoot: "/srv/data", workspaceRoot: "/srv/workspace" },
  deploymentError: null, recovery: null, pending: null, service: { state: "ready", pid: 2, latency: 3, attention: [] }, versions: [["机器人", "1.0.1"]],
};
const unauthorized: Reply = { status: 401, body: { error: "登录已失效，请重新登录", code: "session" } };

function mount(token: string | null) {
  container = document.createElement("div");
  document.body.append(container);
  render(<Root loginToken={token} />, container);
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}\n${container.textContent}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const text = () => container.textContent ?? "";
// Booleans, not nodes: a failed expect on a happy-dom node prints the whole document graph (hundreds of MB).
const has = (selector: string) => container.querySelector(selector) !== null;
const shows = (needle: string) => until(() => text().includes(needle), needle);

test("登录链接兑换成功后进入总览；兑换和轮询都不带续期标记，所有请求都带请求标记", async () => {
  routes = { "POST /api/session/exchange": () => ({ status: 200, body: session() }), "GET /api/overview": () => ({ status: 200, body: overview }) };
  mount("t".repeat(43));
  await shows("机器人运行中");
  expect(text()).toContain("synthetic-host");
  expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(["POST /api/session/exchange", "GET /api/runtime", "GET /api/overview"]);
  expect(JSON.parse(calls[0]!.body!)).toEqual({ token: "t".repeat(43) });
  for (const call of calls) {
    expect(call.headers["X-Console-Request"]).toBe("1");
    expect(call.headers["X-Console-Intent"]).toBeUndefined();
  }
  // W1b read pages are now reachable. Write pages still wait for their stage.
  const planned = [...container.querySelectorAll(".nav-item.disabled")].map(item => item.textContent);
  expect(planned).not.toContain("体检规划中");
  expect(planned).not.toContain("会话规划中");
  expect(has('a[href="#/health"]')).toBe(true);
  expect(has('a[href="#/conversations"]')).toBe(true);
  expect(has('a[href="#/stats"]')).toBe(true);
});

test("通讯录卡片显示保存的范围是否已生效，应用失败时写明之前的范围仍然生效；同步进行中显示同步中", async () => {
  const failed: Overview = { ...overview, service: { ...overview.service, directory: { mappings: 40, scope: "2 个部门（100、200）及其子部门", state: "failed",
    stateText: "应用失败：部门遍历失败：HTTP 500；之前的范围（整个通讯录）仍然生效，5 分钟后自动重试", lastCompleteAt: NOW - 3_600_000 } } };
  let body = failed;
  routes = { "GET /api/session": () => ({ status: 200, body: session() }), "GET /api/overview": () => ({ status: 200, body }) };
  mount(null);
  await shows("应用失败：部门遍历失败");
  expect(text()).toContain("之前的范围（整个通讯录）仍然生效");
  expect([...container.querySelectorAll(".pill.danger")].map(pill => pill.textContent)).toContain("应用失败");
  expect(text()).not.toContain("已生效");
  body = { ...failed, service: { ...failed.service, directory: { ...failed.service.directory!, state: "applying", stateText: "正在应用，完成前之前的范围（整个通讯录）仍然生效",
    running: "应用新范围：遍历部门" } } };
  render(null, container);
  container.remove();
  mount(null);
  await shows("应用新范围：遍历部门");
  expect(text()).toContain("同步中");
  expect(text()).toContain("正在应用，完成前之前的范围（整个通讯录）仍然生效");
});

test("登录链接无效、已用或过期时显示不可用，并提示在终端获取新链接", async () => {
  routes = { "POST /api/session/exchange": () => unauthorized };
  mount("used-token-0123456789");
  await shows("登录链接不可用");
  expect(text()).toContain("按 Enter 获取新链接");
  expect(calls.map(call => call.path)).toEqual(["/api/session/exchange"]);
});

test("没有登录链接且没有会话时显示需要登录", async () => {
  routes = { "GET /api/session": () => unauthorized };
  mount(null);
  await shows("需要登录");
  expect(text()).toContain("bun run console");
});

test("旧运行包在代码变化后仅显示任务结果和手动重开提示，不再打开会话或写配置", async () => {
  routes = {
    "GET /api/session": () => ({ status: 200, body: session() }),
    "GET /api/runtime": () => ({ status: 200, body: { current: false } }),
    "GET /api/tasks": () => ({ status: 200, body: { tasks: [] } }),
  };
  location.hash = "#/settings"; mount(null);
  await shows("代码已变化"); await shows("bun run console");
  expect(has('a[href="#/settings"]')).toBe(false);
  expect(has('a[href="#/conversations"]')).toBe(false);
  expect(has('a[href="#/maintain"]')).toBe(true);
  expect(text()).not.toContain("扫描备份");
  expect(text()).not.toContain("预览清空全部会话");
  expect(text()).not.toContain("机器人运行");
  // Nothing claims to be loading what this console no longer reads.
  expect(text()).toContain("只看任务结果"); expect(text()).toContain("不再读取部署");
  expect(text()).not.toContain("正在检查"); expect(text()).not.toContain("读取部署中");
  expect(calls.some(call => call.path === "/api/overview" || call.path.startsWith("/api/configuration/"))).toBe(false);
});

test("已有会话时直接进入；轮询发现会话失效后撤下页面内容", async () => {
  let overviewCalls = 0;
  routes = { "GET /api/session": () => ({ status: 200, body: session() }), "GET /api/overview": () => (++overviewCalls === 1 ? unauthorized : { status: 200, body: overview }) };
  mount(null);
  await shows("登录已失效");
  expect(text()).not.toContain("synthetic-host");
  expect(has(".layout")).toBe(false);
});

test("会话按页面时钟到期也撤下内容，即使服务器没有应答", async () => {
  routes = { "GET /api/session": () => ({ status: 200, body: session(-1) }), "GET /api/overview": () => ({ status: 200, body: overview }) };
  mount(null);
  await shows("登录已失效");
  expect(has(".layout")).toBe(false);
});

test("控制台无法连接时显示离线提示；恢复后“重新连接”凭原登录回到页面，不需要新链接", async () => {
  let reply: Reply = "offline";
  routes = { "GET /api/session": () => reply, "GET /api/overview": () => ({ status: 200, body: overview }) };
  mount(null);
  await shows("无法连接控制台");
  expect(text()).toContain("SSH 端口转发断开");
  container.querySelector<HTMLButtonElement>(".gate-actions button")!.click();
  await until(() => calls.filter(call => call.path === "/api/session").length === 2, "第二次检查登录");
  await shows("无法连接控制台");
  reply = { status: 200, body: session() };
  container.querySelector<HTMLButtonElement>(".gate-actions button")!.click();
  await shows("机器人运行中");
  expect(calls.some(call => call.path === "/api/session/exchange")).toBe(false);
});

test("总览：进程就绪但 Stream 断开时不说“正在接收”；需要恢复时指向维护页", async () => {
  const disconnected: Overview = { ...overview, recovery: "上次升级尚未完成",
    service: { ...overview.service, stream: { connected: false, reconnects: 3, lastDisconnectReason: "换取 token 失败：HTTP 401" } } };
  routes = { "GET /api/session": () => ({ status: 200, body: session() }), "GET /api/overview": () => ({ status: 200, body: disconnected }) };
  mount(null);
  await shows("事件 Stream 已断开");
  expect(text()).toContain("运行中 · Stream 已断开");
  expect(text()).not.toContain("正在接收并处理");
  expect(text()).toContain("部署恢复");
});

test("Ctrl+K 打开命令面板，输入过滤，Enter 执行；用户刷新带续期标记", async () => {
  routes = { "GET /api/session": () => ({ status: 200, body: session() }), "GET /api/overview": () => ({ status: 200, body: overview }) };
  mount(null);
  await shows("机器人运行中");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await until(() => has('[role="dialog"]'), "命令面板");
  const input = container.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  // The palette focuses its input in an effect, which runs after paint: later than the dialog under load.
  await until(() => document.activeElement === input, "输入框获得焦点");
  const options = () => [...container.querySelectorAll('[role="option"]')].map(option => option.textContent ?? "");
  expect(options().some(option => option.startsWith("前往总览"))).toBe(true);
  // Planned sections are not offered as jump targets.
  expect(options().some(option => option.startsWith("前往会话"))).toBe(true);
  expect(options().some(option => option.startsWith("前往体检"))).toBe(true);

  input.value = "刷新";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => options().length === 1, "过滤结果");
  expect(options()[0]).toBe("刷新数据");
  input.value = "没有这一项";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await shows("没有匹配的页面或操作");
  input.value = "reload";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => options().length === 1, "关键词过滤");

  const before = calls.filter(call => call.path === "/api/overview").length;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => calls.filter(call => call.path === "/api/overview").length > before, "刷新请求");
  expect(has('[role="dialog"]')).toBe(false);
  expect(calls.at(-1)).toMatchObject({ path: "/api/overview", headers: { "X-Console-Request": "1", "X-Console-Intent": "user" } });
});

test("退出登录发送带续期标记的请求并撤下内容", async () => {
  routes = {
    "GET /api/session": () => ({ status: 200, body: session() }), "GET /api/overview": () => ({ status: 200, body: overview }),
    "POST /api/session/logout": () => ({ status: 200, body: { ok: true } }),
  };
  mount(null);
  await shows("机器人运行中");
  container.querySelector<HTMLButtonElement>('button[aria-label="退出登录"]')!.click();
  await shows("已退出登录");
  expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/api/session/logout", headers: { "X-Console-Intent": "user" } });
  expect(text()).not.toContain("synthetic-host");
});

const ready = () => ({
  "GET /api/session": (): Reply => ({ status: 200, body: session() }),
  "GET /api/overview": (): Reply => ({ status: 200, body: overview }),
});
const clickLogout = () => container.querySelector<HTMLButtonElement>('button[aria-label="退出登录"]')!.click();
const logoutCalls = () => calls.filter(call => call.path === "/api/session/logout");

test("退出请求未得到确认时不声称已退出：内容立即撤下，提示可能仍有效，重试成功后才显示已退出", async () => {
  let reply: Reply = "offline";
  routes = { ...ready(), "POST /api/session/logout": () => reply };
  mount(null);
  await shows("机器人运行中");
  clickLogout();
  await shows("无法确认已退出");
  expect(text()).toContain("无法连接控制台");
  expect(text()).toContain("可能仍然有效");
  expect(text()).not.toContain("已退出登录");
  expect(has(".layout")).toBe(false);
  // A half-open tunnel must not leave the page waiting forever.
  expect(logoutCalls()[0]!.signal).toBe(true);

  reply = { status: 500, body: { error: "控制台内部错误，详情见运行控制台的终端", code: "internal" } };
  container.querySelector<HTMLButtonElement>(".gate-actions button")!.click();
  await until(() => logoutCalls().length === 2 && text().includes("控制台内部错误"), "第二次退出失败");
  expect(text()).toContain("无法确认已退出");

  reply = { status: 200, body: { ok: true } };
  container.querySelector<HTMLButtonElement>(".gate-actions button")!.click();
  await shows("已退出登录");
  expect(logoutCalls()).toHaveLength(3);
  for (const call of logoutCalls()) expect(call.headers["X-Console-Intent"]).toBe("user");
});

test("控制台已不认识这次会话（401）时退出视为完成", async () => {
  routes = { ...ready(), "POST /api/session/logout": () => unauthorized };
  mount(null);
  await shows("机器人运行中");
  clickLogout();
  await shows("已退出登录");
  expect(text()).not.toContain("登录已失效");
});

test("同一标签页打开新的登录链接：取出令牌、清除地址栏并重新兑换", async () => {
  const token = "n".repeat(43);
  routes = { ...ready(), "GET /api/session": () => unauthorized, "POST /api/session/exchange": () => ({ status: 200, body: session() }) };
  mount(null);
  await shows("需要登录");
  location.hash = `#login=${token}`;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await shows("机器人运行中");
  expect(location.hash).toBe("");
  expect(location.href).not.toContain(token);
  const exchanges = calls.filter(call => call.path === "/api/session/exchange");
  expect(exchanges).toHaveLength(1);
  expect(JSON.parse(exchanges[0]!.body!)).toEqual({ token });
  // Ordinary navigation is not a login.
  location.hash = "#/overview";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await Bun.sleep(20);
  expect(calls.filter(call => call.path === "/api/session/exchange")).toHaveLength(1);
});

test("已登录时打开新链接会重新登录；较早的兑换晚于新链接返回时不覆盖新结果", async () => {
  const OLD = "o".repeat(43), NEW = "w".repeat(43);
  let releaseOld!: () => void;
  const oldAnswered = new Promise<void>(resolve => { releaseOld = resolve; });
  routes = {
    ...ready(),
    "POST /api/session/exchange": async call => {
      if (JSON.parse(call.body!).token === OLD) { await oldAnswered; return { status: 401, body: { error: "登录链接无效、已使用或已过期。", code: "session" } }; }
      return { status: 200, body: session() };
    },
  };
  mount(OLD);
  // The first exchange starts in the same effect that begins listening for new links.
  await until(() => calls.some(call => call.path === "/api/session/exchange"), "第一次兑换");
  expect(text()).toContain("正在登录");
  location.hash = `#login=${NEW}`;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await shows("机器人运行中");
  releaseOld();
  await Bun.sleep(30);
  expect(text()).toContain("机器人运行中");
  expect(text()).not.toContain("登录链接不可用");

  // From the shell: the new link replaces the session and the page loads again.
  const before = calls.filter(call => call.path === "/api/overview").length;
  location.hash = `#login=${NEW}`;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await until(() => calls.filter(call => call.path === "/api/overview").length > before && text().includes("机器人运行中"), "重新登录后的总览");
  expect(calls.filter(call => call.path === "/api/session/exchange")).toHaveLength(3);
});

// Audit 2026-10-27 (W0 re-review): an old page's request answered after a new link logged in took the new login down.
for (const [what, late, gone] of [["401", unauthorized, "登录已失效"], ["网络错误", "offline", "无法连接控制台"]] as const) {
  test(`旧页面的请求在新链接登录之后才失败（${what}）：不撤下新登录；新页面自己的失败照常撤下`, async () => {
    let releaseOld!: () => void;
    const oldAnswered = new Promise<void>(resolve => { releaseOld = resolve; });
    let overviewCalls = 0;
    let reply: Reply = { status: 200, body: overview };
    routes = {
      ...ready(),
      "POST /api/session/exchange": () => ({ status: 200, body: session() }),
      "GET /api/overview": async () => {
        if (++overviewCalls === 1) { await oldAnswered; return late; }
        return reply;
      },
    };
    mount(null);
    await until(() => overviewCalls === 1 && has(".layout"), "旧登录开始读取总览");
    location.hash = `#login=${"z".repeat(43)}`;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await shows("机器人运行中");
    expect(overviewCalls).toBe(2);
    releaseOld();
    await Bun.sleep(30);
    expect(text()).toContain("机器人运行中");
    expect(text()).not.toContain(gone);

    reply = late;
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "刷新")!.click();
    await shows(gone);
    expect(has(".layout")).toBe(false);
  });
}

test("登录片段在读取时即从地址栏移除，其他片段不受影响", () => {
  location.hash = "#login=abc%2Ddef";
  expect(takeLoginToken()).toBe("abc-def");
  expect(location.hash).toBe("");
  location.hash = "#login=%E0%A4%A";
  expect(takeLoginToken()).toBe("%E0%A4%A");
  expect(location.hash).toBe("");
  location.hash = "#/overview";
  expect(takeLoginToken()).toBeNull();
  expect(location.hash).toBe("#/overview");
});
