import { describe, expect, test } from "bun:test";
import {
  constantTimeEqual,
  isJsonContentType,
} from "../../src/server/http.ts";

describe("HTTP security helpers", () => {
  test("compares equal and unequal secrets through fixed-size digests", () => {
    const secret = "a".repeat(64);
    expect(constantTimeEqual(secret, secret)).toBe(true);
    expect(constantTimeEqual(secret, "b".repeat(64))).toBe(false);
    expect(constantTimeEqual(secret, `${secret}00`)).toBe(false);
  });

  test("accepts JSON media types without accepting arbitrary json substrings", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/problem+json")).toBe(true);
    expect(isJsonContentType("text/json")).toBe(false);
    expect(isJsonContentType("text/notjson")).toBe(false);
    expect(isJsonContentType("application/jsonp")).toBe(false);
    expect(isJsonContentType("application/json/extra")).toBe(false);
  });
});
