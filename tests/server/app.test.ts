import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MAX_WEBHOOK_BODY_BYTES, REJECTION_LOG_DETAIL_LIMIT } from "../../src/core/config.ts";
import { log } from "../../src/core/log.ts";
import { createApp } from "../../src/server/app.ts";
import { observeCallbackRoute } from "../../src/integrations/callback-route.ts";

const secret = "a".repeat(64);
let app: ReturnType<typeof createApp>;
let controller: AbortController;
let stopping = false;
beforeEach(() => {
  stopping = false;
  controller = new AbortController();
  app = createApp({
    signal: controller.signal,
    webhookSecret: secret,
    allowInsecure: false,
    isStopping: () => stopping,
    adminToken: "test-admin-token",
    shutdown: () => { throw new Error("Unauthorized shutdown"); },
  });
});

let warnings: ReturnType<typeof spyOn<typeof log, "warn">>;
afterEach(() => {
  controller.abort();
  warnings?.mockRestore();
});

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
    expect(line).toContain("分类: suspected_probe");
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
    expect(line).toContain("分类: request_validation");
    expect(line).toContain(`IP: 203.0.113.6, 方法: POST, 路径: /webhook/<redacted>, 状态码: ${status}`);
    expect(line).toContain(`原因: ${status === 400 ? "invalid_request" : status === 413 ? "payload_too_large" : "unsupported_media_type"}`);
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

  test("bounds rotating-IP scans without hiding validation or stopping traffic", async () => {
    warnings = spyOn(log, "warn").mockImplementation(() => {});
    for (let i = 0; i < 100; i++) {
      const response = await app.request(`/scan-${i}`, { headers: { "X-Forwarded-For": `203.0.113.${i}` } });
      expect(response.status).toBe(404);
    }
    expect(warnings).toHaveBeenCalledTimes(REJECTION_LOG_DETAIL_LIMIT);
    expect((await app.request(`/webhook/${secret}`, { method: "POST", body: "{}" })).status).toBe(400);
    expect(warnings.mock.calls.at(-1)![0]).toContain("分类: request_validation");
    stopping = true;
    expect((await app.request(`/webhook/${secret}`, { method: "POST", body: "{}" })).status).toBe(503);
    expect(warnings.mock.calls.at(-1)![0]).toContain("分类: runtime_protection");
    expect(warnings.mock.calls.at(-1)![0]).toContain("原因: service_stopping");
    // 关机前写出尚未到时间的三个类别汇总；明细配额不影响 HTTP 响应。
    controller.abort();
    const summaries = warnings.mock.calls.map(([line]) => line).filter(line => line.startsWith("拒绝请求汇总"));
    expect(summaries).toHaveLength(3);
    expect(summaries[0]).toContain(`分类: suspected_probe, 总数: 100, 已记录: ${REJECTION_LOG_DETAIL_LIMIT}, 已抑制: ${100 - REJECTION_LOG_DETAIL_LIMIT}`);
    expect(summaries[0]).toContain('"route_not_found":100');
  });

  test("classifies callback conflicts as runtime protection while retaining 409", async () => {
    warnings = spyOn(log, "warn").mockImplementation(() => {});
    const callbackUrl = `https://imtwo.zdxlz.com/im-external/v1/webhook/send?key=${crypto.randomUUID()}`;
    observeCallbackRoute(callbackUrl, "original-group");
    const response = await app.request(`/webhook/${secret}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "text", textMsg: { content: "private-content" },
        phone: "+8613800000000", groupId: "different-group", callBackUrl: callbackUrl }),
    });
    expect(response.status).toBe(409);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0]![0]).toContain("分类: runtime_protection");
    expect(warnings.mock.calls[0]![0]).toContain("原因: callback_route_conflict");
    expect(warnings.mock.calls[0]![0]).not.toContain(callbackUrl);
    expect(warnings.mock.calls[0]![0]).not.toContain("private-content");
  });
});
