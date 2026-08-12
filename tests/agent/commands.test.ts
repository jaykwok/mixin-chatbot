import { describe, expect, test } from "bun:test";
import {
  canonicalCommand,
  HELP_TEXT,
  isCommandMessage,
  SUPPORTED_COMMANDS,
} from "../../src/agent/commands.ts";

describe("agent slash commands", () => {
  test("recognizes /clear case-insensitively", () => {
    expect(canonicalCommand("/clear")).toBe("/clear");
    expect(canonicalCommand("  /CLEAR  ")).toBe("/clear");
  });

  test("separates slash commands from ordinary prompt text", () => {
    expect(isCommandMessage("/status")).toBe(true);
    expect(isCommandMessage("  /HELP")).toBe(true);
    expect(isCommandMessage("/StOp now")).toBe(true);
    expect(isCommandMessage("/unknown")).toBe(false);
    expect(isCommandMessage("请帮我分析这段文字")).toBe(false);
  });

  test("advertises every supported command in help", () => {
    expect([...SUPPORTED_COMMANDS.keys()]).toEqual(["/help", "/clear", "/stop", "/status"]);
    for (const command of SUPPORTED_COMMANDS.keys()) {
      expect(HELP_TEXT).toContain(command);
    }
    expect(HELP_TEXT).toContain("大小写不敏感");
  });
});
