import { describe, expect, test } from "bun:test";
import {
  canonicalCommand,
  HELP_TEXT,
  isCommandMessage,
  stripLeadingMention,
  SUPPORTED_COMMANDS,
} from "../../src/agent/commands.ts";

describe("agent slash commands", () => {
  test("recognizes /clear case-insensitively", () => {
    expect(canonicalCommand("/clear")).toBe("/clear");
    expect(canonicalCommand("  /CLEAR  ")).toBe("/clear");
    expect(canonicalCommand("@BOT /ClEaR")).toBe("/clear");
  });

  test("separates slash commands from ordinary prompt text", () => {
    expect(isCommandMessage("/status")).toBe(true);
    expect(isCommandMessage("  /HELP")).toBe(true);
    expect(isCommandMessage("/StOp now")).toBe(true);
    expect(isCommandMessage("@BOT /clear")).toBe(true);
    expect(isCommandMessage("@任意机器人名称    /clear")).toBe(true);
    expect(isCommandMessage("@张三 @BOT /STATUS")).toBe(false);
    expect(isCommandMessage("@BOT/clear")).toBe(false);
    expect(isCommandMessage("/unknown")).toBe(false);
    expect(isCommandMessage("@BOT 请解释 /clear")).toBe(false);
    expect(isCommandMessage("请解释 /clear")).toBe(false);
    expect(isCommandMessage("请帮我分析这段文字")).toBe(false);
  });

  test("removes only the transport-level leading mention from prompts", () => {
    expect(stripLeadingMention("@BOT 请分析这段文字")).toBe("请分析这段文字");
    expect(stripLeadingMention("@量子助手    请通知 @张三")).toBe("请通知 @张三");
    expect(stripLeadingMention("请通知 @张三")).toBe("请通知 @张三");
    expect(stripLeadingMention("@BOT/clear")).toBe("@BOT/clear");
  });

  test("advertises every supported command in help", () => {
    expect([...SUPPORTED_COMMANDS.keys()]).toEqual(["/help", "/clear", "/stop", "/status"]);
    for (const command of SUPPORTED_COMMANDS.keys()) {
      expect(HELP_TEXT).toContain(command);
    }
    expect(HELP_TEXT).toContain("大小写不敏感");
    expect(HELP_TEXT).toContain("@机器人名");
  });
});
