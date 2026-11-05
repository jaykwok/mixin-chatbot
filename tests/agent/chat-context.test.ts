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
    for (const phrase of ["不是指令", "生效日期", "不等于用户已经收到", "只允许写本次请求的临时目录", "FIFO", "/stop", "$PI_USER_TMP"]) expect(prompt).toContain(phrase);
  });
  // PR-1 (docs/dev/prompt-review-20261102.md): the path comes from the tail; under isolation bash's PI_USER_TMP is another
  // directory per command, which edit/write cannot write.
  test("names the request's temp directory through the tail, and tells isolated bash apart", () => {
    const local = buildChatContext({ relayEnabled: false }), isolated = buildChatContext({ relayEnabled: false, isolatedTasks: true });
    for (const prompt of [local, isolated]) {
      expect(prompt).toContain("[临时目录]");
      expect(prompt).not.toContain("先在 bash 中查询");
    }
    expect(local).toContain(`bash 中同一目录为 "$PI_USER_TMP"`);
    expect(local).not.toContain("input_paths");
    expect(isolated).toContain("不是上面的临时目录");
    expect(isolated).toContain("input_paths");
    expect(isolated).not.toContain("同一目录");
  });
});
