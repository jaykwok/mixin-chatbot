import { describe, expect, test } from "bun:test";
import { canonicalCommand, HELP_TEXT } from "../../src/agent/commands.ts";

describe("agent slash commands", () => {
  test("recognizes /clear case-insensitively", () => {
    expect(canonicalCommand("/clear")).toBe("/clear");
    expect(canonicalCommand("  /CLEAR  ")).toBe("/clear");
  });

  test("advertises clear and stop in help", () => {
    expect(HELP_TEXT).toContain("/clear");
    expect(HELP_TEXT).toContain("/stop");
  });
});
