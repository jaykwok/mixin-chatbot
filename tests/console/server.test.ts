import { expect, test } from "bun:test";
import { Auth } from "../../console/server/auth.ts";
import type { Bundle } from "../../console/server/bundle.ts";
import { guardConfig, SECURITY_HEADERS } from "../../console/server/guard.ts";
import { createHandler, startServer } from "../../console/server/server.ts";
import type { Overview, SessionResponse } from "../../console/ui/src/contract.ts";

const PORT = 10001, ORIGIN = `http://127.0.0.1:${PORT}`;
const bundle: Bundle = {
  index: { path: "/", type: "text/html; charset=utf-8", body: new TextEncoder().encode("<!doctype html><title>t</title>") },
  assets: new Map([["/assets/app.abc.js", { path: "/assets/app.abc.js", type: "text/javascript; charset=utf-8", body: new TextEncoder().encode("1") }]]),
};

function setup(forwarded: number[] = []) {
  const time = { now: 1_000_000 };
  const auth = new Auth({ exchangeMs: 300_000, idleMs: 1_800_000, absoluteMs: 28_800_000 }, () => time.now);
  let overviews = 0;
  const handle = createHandler({ port: PORT, guard: guardConfig(PORT, forwarded), bundle, auth, instanceId: "instance-1",
    overview: async () => { overviews++; return { checkedAt: 1 } as Overview; } });
  return { time, auth, handle, overviews: () => overviews };
}

type Init = { method?: string; headers?: Record<string, string>; body?: string; host?: string };

/** Requests as a same-origin page would send them, unless a test overrides a header. */
function request(path: string, init: Init = {}): Request {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { host: init.host ?? `127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin", "x-console-request": "1" };
  if (method !== "GET" && method !== "HEAD") { headers.origin = ORIGIN; headers["content-type"] = "application/json"; }
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    if (value === "") delete headers[key]; else headers[key] = value;
  }
  return new Request(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: init.body });
}

async function login(env: ReturnType<typeof setup>): Promise<{ cookie: string; setCookie: string }> {
  const { token } = env.auth.issueToken();
  const response = await env.handle(request("/api/session/exchange", { method: "POST", body: JSON.stringify({ token }) }));
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie")!;
  return { cookie: setCookie.split(";")[0]!, setCookie };
}

test("Host 必须精确匹配，Origin/Sec-Fetch-Site 只接受控制台自身，API 必须带请求标记", async () => {
  const env = setup();
  const refusedWith = async (req: Request, text: string) => {
    const response = await env.handle(req);
    expect(response.status, text).toBe(403);
    expect((await response.json() as { error: string }).error).toContain(text);
  };
  await refusedWith(request("/api/instance", { host: "localhost:10001" }), "Host");
  await refusedWith(request("/api/instance", { host: "127.0.0.1:11013" }), "Host");
  await refusedWith(request("/api/instance", { host: "evil.example" }), "Host");
  await refusedWith(request("/api/instance", { headers: { host: "" } }), "Host");
  await refusedWith(request("/api/instance", { headers: { "x-console-request": "" } }), "请求标记");
  // Another port of the same host is same-site: SameSite=Strict cookies would ride along, so it must still be refused.
  await refusedWith(request("/api/session", { headers: { "sec-fetch-site": "same-site" } }), "控制台页面发起");
  await refusedWith(request("/api/session", { headers: { "sec-fetch-site": "cross-site" } }), "控制台页面发起");
  await refusedWith(request("/api/session", { headers: { "sec-fetch-site": "none" } }), "控制台页面发起");
  await refusedWith(request("/api/session", { headers: { origin: "http://127.0.0.1:9999" } }), "来源");
  await refusedWith(request("/api/session", { headers: { origin: "null" } }), "来源");
  await refusedWith(request("/api/session/exchange", { method: "POST", headers: { origin: "" }, body: "{}" }), "写请求缺少来源");
  await refusedWith(request("/", { headers: { "sec-fetch-site": "same-site" } }), "页面只能直接打开");
  await refusedWith(request("/", { method: "POST", body: "{}" }), "方法");
  await refusedWith(request("/assets/app.abc.js", { headers: { "sec-fetch-site": "cross-site" } }), "资源");

  // Typing the link is "none"; older clients send no Sec-Fetch-Site at all.
  for (const site of ["none", "same-origin", ""]) {
    const response = await env.handle(request("/", { headers: { "sec-fetch-site": site, "x-console-request": "" } }));
    expect(response.status, site).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  }
  expect((await env.handle(request("/assets/app.abc.js"))).status).toBe(200);
  expect((await env.handle(request("/assets/missing.js"))).status).toBe(404);
  expect((await env.handle(request("/elsewhere"))).status).toBe(404);
  expect(await (await env.handle(request("/api/instance"))).json()).toEqual({ instanceId: "instance-1" });
});

test("SSH 转发端口只有显式指定时才是允许的来源", async () => {
  const plain = setup(), forwarded = setup([22222]);
  const viaForward = (env: ReturnType<typeof setup>) =>
    env.handle(request("/api/instance", { host: "127.0.0.1:22222", headers: { origin: "http://127.0.0.1:22222" } }));
  expect((await viaForward(plain)).status).toBe(403);
  expect((await viaForward(forwarded)).status).toBe(200);
});

test("升级后的旧入口只保留登录和任务结果，拒绝新读取/写入/下载；已开始的旧查询不返回新版数据", async () => {
  const auth = new Auth(), login = auth.exchange(auth.issueToken().token)!;
  let current = true, reads = 0, writes = 0, downloads = 0, settle: (value: unknown) => void = () => {};
  const handle = createHandler({ port: PORT, guard: guardConfig(PORT), bundle, auth, instanceId: "frozen",
    current: () => current, overview: async () => { reads++; return {} as Overview; },
    download: () => { downloads++; return new Response("private"); },
    routes: {
      "POST /api/read/logs": { run: async () => { reads++; return await new Promise(resolve => { settle = resolve; }); } },
      "POST /api/plans": { run: async () => { writes++; return {}; } },
      "GET /api/tasks": { run: async () => ({ tasks: [] }) },
    } });
  const headers = { cookie: auth.cookieName + "=" + login.sessionId };
  const late = handle(request("/api/read/logs", { method: "POST", body: "{}", headers }));
  await Bun.sleep(10); expect(reads).toBe(1);
  current = false; settle({ content: "should-not-be-delivered" });
  expect((await late).status).toBe(409);
  for (const path of ["/api/overview", "/download/fixture"]) expect((await handle(request(path, { headers }))).status).toBe(409);
  expect((await handle(request("/api/plans", { method: "POST", body: "{}", headers }))).status).toBe(409);
  expect({ reads, writes, downloads }).toEqual({ reads: 1, writes: 0, downloads: 0 });
  expect(await (await handle(request("/api/runtime", { headers }))).json()).toEqual({ current: false });
  expect((await handle(request("/api/tasks", { headers }))).status).toBe(200);
  expect((await handle(request("/api/session", { headers }))).status).toBe(200);
  expect((await handle(request("/api/session/logout", { method: "POST", body: "{}", headers }))).status).toBe(200);
  expect((await handle(request("/api/tasks", { headers }))).status).toBe(401);
});

test("每个响应（含拒绝和错误）都带安全响应头", async () => {
  const env = setup();
  for (const req of [request("/"), request("/api/instance"), request("/api/overview"), request("/x"), request("/api/session", { host: "x" })]) {
    const response = await env.handle(req);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name), `${req.url} ${name}`).toBe(value);
  }
  const csp = SECURITY_HEADERS["Content-Security-Policy"]!;
  for (const directive of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "connect-src 'self'"]) {
    expect(csp).toContain(directive);
  }
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
});

test("兑换签发 HttpOnly、SameSite=Strict 的会话 cookie，链接重复使用被拒绝，令牌不出现在响应体", async () => {
  const env = setup();
  const { token } = env.auth.issueToken();
  const exchange = () => env.handle(request("/api/session/exchange", { method: "POST", body: JSON.stringify({ token }) }));
  const first = await exchange();
  expect(first.status).toBe(200);
  const setCookie = first.headers.get("set-cookie")!;
  expect(setCookie).toMatch(new RegExp(`^${env.auth.cookieName}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
  expect(setCookie).not.toMatch(/Domain|Secure/i);
  const body = await first.text();
  expect(body).not.toContain(token);
  expect(body).not.toContain(setCookie.split(";")[0]!.split("=")[1]!);

  const second = await exchange();
  expect(second.status).toBe(401);
  expect(second.headers.get("set-cookie")).toBeNull();
  expect((await second.json() as { code: string }).code).toBe("session");

  for (const bad of ["{}", "not json", JSON.stringify({ token: 1 }), JSON.stringify({ token: "x".repeat(40) })]) {
    expect((await env.handle(request("/api/session/exchange", { method: "POST", body: bad }))).status).toBeOneOf([400, 401]);
  }
  const plainText = await env.handle(request("/api/session/exchange", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }));
  expect(plainText.status).toBe(400);
});

test("会话接口需要 cookie；轮询不续期，带用户操作标记的请求续期；退出后失效", async () => {
  const env = setup();
  const { cookie } = await login(env);
  const get = (path: string, headers: Record<string, string> = {}) => env.handle(request(path, { headers: { cookie, ...headers } }));

  expect((await env.handle(request("/api/overview"))).status).toBe(401);
  expect((await env.handle(request("/api/overview", { headers: { cookie: `${env.auth.cookieName}=forged` } }))).status).toBe(401);
  const overview = await get("/api/overview");
  expect(overview.status).toBe(200);
  expect(env.overviews()).toBe(1);

  const idle = async (headers: Record<string, string> = {}) => (await (await get("/api/session", headers)).json() as SessionResponse).session.idleExpiresAt;
  const before = await idle();
  env.time.now += 10 * 60_000;
  expect(await idle()).toBe(before);
  expect(await idle({ "x-console-intent": "user" })).toBe(env.time.now + 30 * 60_000);
  const touched = await env.handle(request("/api/session/touch", { method: "POST", headers: { cookie } }));
  expect(touched.status).toBe(200);

  env.time.now += 31 * 60_000;
  const expired = await get("/api/session");
  expect(expired.status).toBe(401);
  expect(expired.headers.get("set-cookie")).toContain("Max-Age=0");

  const again = await login(env);
  const logout = await env.handle(request("/api/session/logout", { method: "POST", headers: { cookie: again.cookie } }));
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await env.handle(request("/api/session", { headers: { cookie: again.cookie } }))).status).toBe(401);
  expect((await env.handle(request("/api/unknown", { headers: { cookie: (await login(env)).cookie } }))).status).toBe(404);
});

test("只监听 127.0.0.1；端口被占用时报错而不换端口", async () => {
  const auth = new Auth();
  const first = startServer({ port: 0, guard: guardConfig(0), bundle, auth, instanceId: "a", overview: async () => ({} as Overview) });
  try {
    expect(first.hostname).toBe("127.0.0.1");
    expect(() => startServer({ port: first.port!, guard: guardConfig(first.port!), bundle, auth, instanceId: "b", overview: async () => ({} as Overview) }))
      .toThrow(`端口 ${first.port} 已被占用`);
  } finally { first.stop(true); }
});
