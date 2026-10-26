import { describe, expect, test } from "bun:test";
import { constantTimeEqual } from "../../src/server/http.ts";

describe("HTTP security helpers", () => {
  test("compares equal and unequal secrets through fixed-size digests", () => {
    const secret = "a".repeat(64);
    expect(constantTimeEqual(secret, secret)).toBe(true);
    expect(constantTimeEqual(secret, "b".repeat(64))).toBe(false);
    expect(constantTimeEqual(secret, `${secret}00`)).toBe(false);
  });
});
