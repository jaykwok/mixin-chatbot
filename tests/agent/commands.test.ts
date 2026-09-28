import { describe, expect, test } from "bun:test";
import {
  canonicalCommand,
  HELP_TEXT,
  isSlashCommandMessage,
  SUPPORTED_COMMANDS,
  unknownCommandText,
} from "../../src/agent/commands.ts";

describe("agent slash commands", () => {
  test("recognizes /clear case-insensitively", () => {
    expect(canonicalCommand("/clear")).toBe("/clear");
    expect(canonicalCommand("  /CLEAR  ")).toBe("/clear");
    expect(canonicalCommand("/ClEaR\n")).toBe("/clear");
  });

  test("separates slash commands from ordinary prompt text", () => {
    expect(isSlashCommandMessage("/status")).toBe(true);
    expect(isSlashCommandMessage("  /HELP")).toBe(true);
    expect(isSlashCommandMessage("/StOp now")).toBe(true);
    expect(isSlashCommandMessage("@张三 /status")).toBe(false);
    expect(isSlashCommandMessage("/unknown")).toBe(true);
    expect(isSlashCommandMessage("请解释 /clear")).toBe(false);
    expect(isSlashCommandMessage("请帮我分析这段文字")).toBe(false);
  });

  test("routes unsupported slash syntax to command help instead of the agent", () => {
    expect(isSlashCommandMessage("/unknown")).toBe(true);
    expect(isSlashCommandMessage("/UNKNOWN option")).toBe(true);
    expect(isSlashCommandMessage("请解释 /unknown")).toBe(false);

    const reply = unknownCommandText("/UNKNOWN option");
    expect(reply).toContain("未知指令「/unknown」");
    expect(reply).toContain(HELP_TEXT);
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
