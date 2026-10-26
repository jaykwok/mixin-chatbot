import { expect, test } from "bun:test";
import { createApp } from "../../src/server/http-app.ts";
import { APP_BUILD, APP_VERSION } from "../../src/core/version.ts";
import type { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { DirectoryClient } from "../../src/integrations/open-platform/directory.ts";

function app(options: { stopping?: boolean; shutdown?: () => void; health?: () => Record<string, unknown> } = {}) {
  return createApp({
    isStopping: () => options.stopping ?? false,
    adminToken: "test-admin-token",
    shutdown: options.shutdown ?? (() => { throw new Error("Unauthorized shutdown"); }),
    instanceId: "instance",
    startedAt: 1,
    ...(options.health ? { health: options.health } : {}),
  });
}

test("health reports the instance, readiness and the supplied status fields", async () => {
  const response = await app({ health: () => ({ stream: { connected: true } }) }).request("/health");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ service: "mixin-chatbot", version: 1, appVersion: APP_VERSION, build: APP_BUILD, instanceId: "instance", status: "ready", stream: { connected: true } });
  expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  const stopping = await app({ stopping: true }).request("/health");
  expect(stopping.status).toBe(503);
  expect((await stopping.json() as { status: string }).status).toBe("stopping");
});

test("health stays available when a status source throws", async () => {
  const response = await app({ health: () => { throw new Error("broken"); } }).request("/health");
  expect(response.status).toBe(200);
});

test("shutdown requires the instance token and hides the route otherwise", async () => {
  expect((await app().request("/_admin/shutdown", { method: "POST" })).status).toBe(404);
  expect((await app().request("/_admin/shutdown", { method: "POST", headers: { Authorization: "Bearer wrong" } })).status).toBe(404);
  const called = Promise.withResolvers<void>();
  const response = await app({ shutdown: () => called.resolve() }).request("/_admin/shutdown", { method: "POST", headers: { Authorization: "Bearer test-admin-token" } });
  expect(response.status).toBe(200);
  await called.promise;
});

test("the webhook entry no longer exists", async () => {
  expect((await app().request("/webhook", { method: "POST", body: "{}" })).status).toBe(404);
});

test("directory confirmation requires the instance token and a valid round, and reports stale or busy rounds", async () => {
  const calls: number[] = [];
  let result: "started" | "stale" | "busy" = "started";
  const confirming = createApp({ isStopping: () => false, adminToken: "test-admin-token", shutdown: () => {}, confirmRevocations: scanId => { calls.push(scanId); return result; } });
  const post = (body: unknown, token = "test-admin-token") => confirming.request("/_admin/directory/confirm", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await post({ scanId: 3 }, "wrong")).status).toBe(404);
  // Without a directory (verification instance) the route does not exist.
  expect((await app().request("/_admin/directory/confirm", { method: "POST", headers: { Authorization: "Bearer test-admin-token" }, body: "{}" })).status).toBe(404);
  for (const scanId of [0, -1, 1.5, "3", null]) expect((await post({ scanId })).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await post({ scanId: 3 })).status).toBe(202);
  result = "stale";
  const stale = await post({ scanId: 4 });
  expect(stale.status).toBe(409); expect((await stale.json() as { message: string }).message).toContain("已不是待确认的撤销");
  result = "busy";
  const busy = await post({ scanId: 3 });
  expect(busy.status).toBe(409); expect((await busy.json() as { message: string }).message).toContain("正在进行");
  expect(calls).toEqual([3, 4, 3]);
});

/** The three directory routes that wait on the platform, each with a body the route accepts. */
const waitingRoutes = [["/_admin/directory/departments", { parent: "1" }], ["/_admin/directory/department-details", { ids: ["100"] }],
  ["/_admin/directory/scope", { departments: ["100"] }]] as const;
const adminPost = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}),
  headers: { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" } });

test("directory routes that wait on the platform answer 504 at their deadline, keep other failures, and get a connection limit past it", async () => {
  const hang = (_: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const waiting = createApp({ isStopping: () => false, adminToken: "test-admin-token", shutdown: () => {}, platformWaitMs: 50,
    listDepartments: hang, describeDepartments: hang, changeScope: hang });
  const expired = [];
  for (const [path, body] of waitingRoutes) {
    const response = await waiting.request(path, adminPost(body));
    expired.push([response.status, (await response.json() as { message: string }).message]);
  }
  expect(expired).toEqual([[504, "读取部门超过 1 秒没有完成，请稍后重试"], [504, "读取部门详情超过 1 秒没有完成，请稍后重试"],
    [504, "核对部门超过 1 秒没有完成；范围未改，请稍后重试"]]);
  // A failure of the work itself is reported as before.
  const broken = async () => { throw new Error("部门 999：部门不属于当前组织（code=422010）；范围未改"); };
  const failing = createApp({ isStopping: () => false, adminToken: "test-admin-token", shutdown: () => {},
    listDepartments: broken, describeDepartments: broken, changeScope: broken });
  const statuses = [];
  for (const [path, body] of waitingRoutes) statuses.push((await failing.request(path, adminPost(body))).status);
  expect(statuses).toEqual([502, 502, 409]);
  // Bun.serve's idleTimeout would cut a quiet connection: these requests get the deadline plus ten seconds; others keep the server's limit.
  const limits: number[] = [];
  const server = { timeout: (_request: Request, seconds: number) => { limits.push(seconds); } };
  const quick = createApp({ isStopping: () => false, adminToken: "test-admin-token", shutdown: () => {}, confirmRevocations: () => "stale",
    listDepartments: async () => [], describeDepartments: async () => ({ departments: [], unavailable: [] }), changeScope: async () => "unchanged" });
  for (const [path, body] of waitingRoutes) expect((await quick.fetch(new Request("http://localhost" + path, adminPost(body)), server)).status).toBe(200);
  await quick.fetch(new Request("http://localhost/_admin/directory/confirm", adminPost({ scanId: 1 })), server);
  await quick.fetch(new Request("http://localhost/health"), server);
  expect(limits).toEqual([70, 70, 70]);
});

test("only the platform's listed refusal codes mark a department refused; any other code, inherited object keys too, fails the lookup", async () => {
  const outcomes = [];
  for (const code of ["422010", "404002", "400002", "toString", "constructor", "__proto__"]) {
    const platform = { request: async () => ({ status: 200, json: { code, msg: "?" }, headers: new Headers() }) } as unknown as PlatformClient;
    const directory = new DirectoryClient(platform);
    const service = createApp({ isStopping: () => false, adminToken: "test-admin-token", shutdown: () => {},
      describeDepartments: (ids, signal) => directory.describe(ids, signal) });
    const response = await service.request("/_admin/directory/department-details", adminPost({ ids: ["100"] }));
    const body = await response.json() as { unavailable?: { message: string }[]; message?: string };
    outcomes.push([code, response.status, body.unavailable?.[0]?.message ?? body.message]);
  }
  expect(outcomes).toEqual([
    ["422010", 200, "部门不属于当前组织（code=422010）"], ["404002", 200, "部门不存在（code=404002）"], ["400002", 200, "部门 ID 格式无效（code=400002）"],
    ...["toString", "constructor", "__proto__"].map(code => [code, 502, `读取部门详情失败：部门 100：通讯录 /open/v2/dept/get 失败：HTTP 200 code=${code}`]),
  ]);
});

test("a caller that goes away cancels the department lookups it started: queued ones never reach the platform", async () => {
  const release = Promise.withResolvers<void>(), finished = Promise.withResolvers<unknown>();
  const asked: string[] = [];
  class Slow extends DirectoryClient {
    override async department(id: string) { asked.push(id); await release.promise; return { id, name: id, parentId: "1" }; }
  }
  const directory = new Slow({} as PlatformClient);
  const service = createApp({ isStopping: () => false, adminToken: "test-admin-token", shutdown: () => {},
    describeDepartments: async (ids, signal) => {
      try { const described = await directory.describe(ids, signal); finished.resolve(described); return described; }
      catch (error) { finished.resolve(error); throw error; }
    } });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: service.fetch });
  try {
    const caller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${server.port}/_admin/directory/department-details`,
      adminPost({ ids: Array.from({ length: 8 }, (_, i) => String(100 + i)) }, caller.signal)).catch(error => error);
    for (const end = Date.now() + 3000; asked.length < 4 && Date.now() < end;) await Bun.sleep(5);
    caller.abort();
    await pending;
    // The service gives up at once, without waiting for the four in flight.
    expect(String(await finished.promise)).toContain("Abort");
    release.resolve();
    await Bun.sleep(20);
    expect(asked).toEqual(["100", "101", "102", "103"]);
  } finally { release.resolve(); await server.stop(true); }
});
