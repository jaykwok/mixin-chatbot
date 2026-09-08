import { describe, expect, test } from "bun:test";
import {
  canonicalCommand,
  HELP_TEXT,
  isSlashCommandMessage,
  stripLeadingMention,
  SUPPORTED_COMMANDS,
  unknownCommandText,
} from "../../src/agent/commands.ts";

describe("agent slash commands", () => {
  test("recognizes /clear case-insensitively", () => {
    expect(canonicalCommand("/clear")).toBe("/clear");
    expect(canonicalCommand("  /CLEAR  ")).toBe("/clear");
    expect(canonicalCommand("@BOT\uFFA0/ClEaR")).toBe("/clear");
  });

  test("separates slash commands from ordinary prompt text", () => {
    expect(isSlashCommandMessage("/status")).toBe(true);
    expect(isSlashCommandMessage("  /HELP")).toBe(true);
    expect(isSlashCommandMessage("/StOp now")).toBe(true);
    expect(isSlashCommandMessage("@BOT\uFFA0/clear")).toBe(true);
    expect(isSlashCommandMessage("@BOT /clear")).toBe(false);
    expect(isSlashCommandMessage("@任意机器人名称    /clear")).toBe(false);
    expect(isSlashCommandMessage("@张三 @BOT /STATUS")).toBe(false);
    expect(isSlashCommandMessage("@BOT/clear")).toBe(false);
    expect(isSlashCommandMessage("/unknown")).toBe(true);
    expect(isSlashCommandMessage("@BOT 请解释 /clear")).toBe(false);
    expect(isSlashCommandMessage("请解释 /clear")).toBe(false);
    expect(isSlashCommandMessage("请帮我分析这段文字")).toBe(false);
  });

  test("routes unsupported slash syntax to command help instead of the agent", () => {
    expect(isSlashCommandMessage("/unknown")).toBe(true);
    expect(isSlashCommandMessage("@BOT\uFFA0/UNKNOWN option")).toBe(true);
    expect(isSlashCommandMessage("请解释 /unknown")).toBe(false);

    const reply = unknownCommandText("@BOT\uFFA0/UNKNOWN option");
    expect(reply).toContain("未知指令「/unknown」");
    expect(reply).toContain(HELP_TEXT);
  });

  test("removes only the transport-level leading mention from prompts", () => {
    expect(stripLeadingMention("@BOT\uFFA0请分析这段文字")).toBe("请分析这段文字");
    expect(stripLeadingMention("@量子助手\uFFA0请通知 @张三")).toBe("请通知 @张三");
    expect(stripLeadingMention("@BOT 请分析这段文字")).toBe("@BOT 请分析这段文字");
    expect(stripLeadingMention("@BOT\uFFA0\uFFA0请分析")).toBe("\uFFA0请分析");
    expect(stripLeadingMention("请通知 @张三")).toBe("请通知 @张三");
    expect(stripLeadingMention("@BOT/clear")).toBe("@BOT/clear");
  });

  test("advertises every supported command in help", () => {
    expect([...SUPPORTED_COMMANDS.keys()]).toEqual(["/help", "/clear", "/stop", "/status", "/deliver"]);
    for (const command of SUPPORTED_COMMANDS.keys()) {
      expect(HELP_TEXT).toContain(command);
    }
    expect(HELP_TEXT).toContain("大小写不敏感");
    expect(HELP_TEXT).toContain("@机器人名");
  });
});
