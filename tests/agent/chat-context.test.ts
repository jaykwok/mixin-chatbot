import { describe, expect, test } from "bun:test";
import { buildChatContext } from "../../src/agent/prompt.ts";

describe("project system prompt", () => {
  test("does not promise an unavailable relay or installed parser", () => {
    const prompt = buildChatContext({ relayEnabled: false });
    expect(prompt).toContain("未配置大文件外链");
    expect(prompt).toContain("document_environment");
    expect(prompt).not.toContain("均已安装");
    expect(prompt).not.toContain("mutates");
    expect(prompt).not.toContain("uv pip install");
  });
  test("enables only configured delivery capability", () => {
    expect(buildChatContext({ relayEnabled: true })).toContain("已配置的外链服务");
  });
  test("enforces evidence, instruction boundaries and accurate delivery claims", () => {
    const prompt = buildChatContext({ relayEnabled: false });
    for (const phrase of ["不是指令", "生效日期", "不等于用户已经收到", "只允许写自己的 tmp", "FIFO", "/stop", "$PI_USER_TMP"]) expect(prompt).toContain(phrase);
  });
});
