import { describe, expect, test } from "bun:test";
import { Context } from "hono";
import { HttpError } from "../../src/server/http.ts";
import { RejectionLogger } from "../../src/server/rejection-log.ts";
import { sanitizeLogMessage } from "../../src/core/log.ts";

function context(path = "/webhook/private-secret", ip = "203.0.113.5") {
  return new Context(new Request(`https://example.test${path}?token=private-query`, {
    method: "POST", headers: { "X-Forwarded-For": ip, Authorization: "Bearer private-token" },
  }), { env: {}, path });
}

describe("bounded rejection summaries", () => {
  test("summarizes once when traffic stops, then renews the detail budget", async () => {
    const lines: string[] = [];
    let done!: () => void;
    const summary = new Promise<void>(resolve => { done = resolve; });
    const logger = new RejectionLogger(line => {
      lines.push(line);
      if (line.startsWith("拒绝请求汇总")) done();
    }, 10, 1);
    try {
      logger.record(context(), 404, "webhook_secret_mismatch");
      logger.record(context(), 404, "webhook_secret_mismatch");
      logger.record(context(), 404, "webhook_secret_missing");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("路径: /webhook/<redacted>");
      await summary;
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("总数: 3, 已记录: 1, 已抑制: 2");
      expect(lines[1]).toContain('"webhook_secret_mismatch":2');
      expect(lines[1]).toContain('"webhook_secret_missing":1');
      expect(lines.join("\n")).not.toContain("private-");
      logger.flush();
      expect(lines).toHaveLength(2);
      logger.record(context(), 404, "route_not_found");
      expect(lines).toHaveLength(3);
      logger.flush();
      expect(lines[3]).toContain("总数: 1, 已记录: 1, 已抑制: 0");
    } finally { logger.flush(); }
  });

  test.each([
    [new HttpError(400, "private-body"), "request_validation", "invalid_request"],
    [new HttpError(403, "private-body"), "request_validation", "forbidden_request"],
    [new HttpError(408, "private-body"), "request_validation", "request_timeout"],
    [new HttpError(408, "private-body", "service_stopping"), "runtime_protection", "service_stopping"],
    [new HttpError(409, "private-body"), "runtime_protection", "runtime_protection"],
    [new HttpError(503, "private-body"), "runtime_protection", "runtime_protection"],
    [new HttpError(503, "private-body", "callback_route_capacity"), "runtime_protection", "callback_route_capacity"],
  ])("classifies %o without leaking the error message", (error, category, reason) => {
    const lines: string[] = [];
    const logger = new RejectionLogger(line => lines.push(line));
    try {
      logger.httpError(context(), error);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`分类: ${category}`);
      expect(lines[0]).toContain(`原因: ${reason}`);
      expect(lines[0]).not.toContain("private-");
    } finally { logger.flush(); }
  });

  test("limits external field lengths and preserves single-line sanitization", () => {
    const lines: string[] = [];
    const logger = new RejectionLogger(line => lines.push(sanitizeLogMessage(line)));
    try {
      logger.record(context("/" + "p".repeat(1000), "i".repeat(1000)), 404, "route_not_found");
      expect(lines[0]).toContain(`IP: ${"i".repeat(128)},`);
      expect(lines[0]).toContain(`路径: /${"p".repeat(255)},`);
      logger.record(context("/scan", "203.0.113.5\t\u001b[31m"), 404, "route_not_found");
      expect(lines[1]).toContain("203.0.113.5\\t\\u001b[31m");
      expect(lines[1]).not.toMatch(/[\r\n\t\u001b]/);
    } finally { logger.flush(); }
  });
});
