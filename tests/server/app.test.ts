import { expect, test } from "bun:test";
import { createApp } from "../../src/server/http-app.ts";
import { APP_BUILD, APP_VERSION } from "../../src/core/version.ts";

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
