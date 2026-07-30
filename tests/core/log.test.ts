import { describe, expect, test } from "bun:test";
import { sanitizeLogMessage } from "../../src/core/log.ts";

describe("log sanitization", () => {
  test("keeps external values on one terminal-safe line", () => {
    expect(sanitizeLogMessage("first\nsecond\r\t\u001b[31m\u2028last")).toBe(
      "first\\nsecond\\r\\t\\u001b[31m\\u2028last"
    );
  });
});
