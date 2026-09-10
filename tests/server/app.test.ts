import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MAX_WEBHOOK_BODY_BYTES } from "../../src/core/config.ts";
import { log } from "../../src/core/log.ts";
import { createApp } from "../../src/server/app.ts";

const secret = "a".repeat(64);
const app = createApp({
  signal: new AbortController().signal,
  webhookSecret: secret,
  allowInsecure: false,
  isStopping: () => false,
  adminToken: "test-admin-token",
  shutdown: () => { throw new Error("Unauthorized shutdown"); },
});

let warnings: ReturnType<typeof spyOn<typeof log, "warn">>;
afterEach(() => warnings?.mockRestore());

describe("HTTP rejection logging", () => {
  test.each([
    ["/webhook/wrong-secret?token=private-query", "POST", "webhook_secret_mismatch", "/webhook/<redacted>"],
    ["/webhook", "POST", "webhook_secret_missing", "/webhook"],
    ["/.env?token=private-query", "GET", "route_not_found", "/.env"],
    [`/webhook/${secret}`, "GET", "route_not_found", "/webhook/<redacted>"],
    [`/webhook/${secret}/extra`, "POST", "route_not_found", "/webhook/<redacted>"],
    ["/_admin/shutdown", "POST", "route_not_found", "/_admin/shutdown"],
  ])("logs one WARN for %s (%s)", async (url, method, reason, path) => {
    warnings = spyOn(log, "warn").mockImplementation(() => {});
    const response = await app.request(url, {
      method,
      headers: { "X-Forwarded-For": "203.0.113.5, 10.0.0.1", "X-Real-IP": "203.0.113.6" },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: "error", message: "Not Found" });
    expect(warnings).toHaveBeenCalledTimes(1);
    const line = warnings.mock.calls[0]![0];
    expect(line).toContain("IP: 203.0.113.5");
    expect(line).toContain(`方法: ${method}, 路径: ${path}, 状态码: 404, 原因: ${reason}`);
    for (const sensitive of [secret, "wrong-secret", "private-query", "10.0.0.1", "203.0.113.6"]) {
      expect(line).not.toContain(sensitive);
    }
  });

  const rejectionCases: { status: number; body: string; headers: Record<string, string> }[] = [
    { status: 415, body: "private-body", headers: { "Content-Type": "text/plain" } },
    { status: 400, body: "private-body", headers: { "Content-Type": "application/json" } },
    { status: 400, body: "{}", headers: { "Content-Type": "application/json" } },
    { status: 400, body: "{}", headers: { "Content-Length": "invalid" } },
    { status: 413, body: "{}", headers: { "Content-Length": String(MAX_WEBHOOK_BODY_BYTES + 1) } },
    { status: 413, body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1), headers: {} },
  ];
  test.each(rejectionCases)("logs HTTP $status rejections", async ({ status, body, headers }) => {
    warnings = spyOn(log, "warn").mockImplementation(() => {});
    const response = await app.request(`/webhook/${secret}?token=private-query`, {
      method: "POST",
      headers: { ...headers, "X-Real-IP": "203.0.113.6" },
      body,
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ status: "error" });
    expect(warnings).toHaveBeenCalledTimes(1);
    const line = warnings.mock.calls[0]![0];
    expect(line).toContain(`IP: 203.0.113.6, 方法: POST, 路径: /webhook/<redacted>, 状态码: ${status}, 原因: http_error`);
    for (const sensitive of [secret, "private-query", "private-body"]) {
      expect(line).not.toContain(sensitive);
    }
  });

  test("uses Unknown without IP headers and keeps health checks quiet", async () => {
    warnings = spyOn(log, "warn").mockImplementation(() => {});
    expect((await app.request("/health")).status).toBe(200);
    expect(warnings).not.toHaveBeenCalled();
    expect((await app.request("/unknown")).status).toBe(404);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0]![0]).toContain("IP: Unknown");
  });
});
