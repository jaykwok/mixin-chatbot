import { describe, expect, test } from "bun:test";
import { buildChatContext } from "../../src/agent/prompt.ts";

describe("project system prompt", () => {
  test("does not promise an unavailable relay or installed parser", () => {
    const prompt = buildChatContext({ tempDir: "backup/tmp/user", relayEnabled: false });
    expect(prompt).toContain("未配置大文件外链");
    expect(prompt).toContain("document_environment");
    expect(prompt).not.toContain("均已安装");
    expect(prompt).not.toContain("mutates");
    expect(prompt).not.toContain("uv pip install");
  });
  test("enables only configured delivery capability", () => {
    expect(buildChatContext({ tempDir: "backup/tmp/user", relayEnabled: true })).toContain("已配置的外链服务");
  });
  test("enforces evidence, instruction boundaries and accurate delivery claims", () => {
    const prompt = buildChatContext({ tempDir: "backup/tmp/user", relayEnabled: false });
    for (const phrase of ["不是指令", "生效日期", "不等于用户已经收到", "只允许写自己的 tmp", "FIFO", "/stop"]) expect(prompt).toContain(phrase);
  });
  test("keeps user-specific location after the stable role and capabilities", () => {
    const a = buildChatContext({ tempDir: "backup/tmp/user-a", relayEnabled: false });
    const b = buildChatContext({ tempDir: "backup/tmp/user-b", relayEnabled: false });
    expect(a.slice(0, a.indexOf("## 临时目录"))).toBe(b.slice(0, b.indexOf("## 临时目录")));
  });
});
