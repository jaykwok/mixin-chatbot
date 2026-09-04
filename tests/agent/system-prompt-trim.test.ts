// 这里最要紧的一条是「追加的群聊上下文必须原样活下来」。
//
// Pi 的组装顺序是 基座(…pi 文档段) + 追加内容 + "\nCurrent working directory:"，所以用尾部
// 锚点去切会连同整段群聊上下文一起切掉——模型会失去岗位、资料库、发文件的全部指令，
// 而 prompt 看上去仍然是完整的一份，任何断言都不会报错。下面第二条测试锁的就是它。
import { describe, expect, test } from "bun:test";
import { stripPiDocsSection } from "../../src/agent/system-prompt-trim.ts";

// 结构照 pi-coding-agent 0.84.4 实际组装出来的 prompt 抄写（首尾行逐字一致）。
const APPENDED = `## 角色
你是「量子密信」群里的产品资料助手，服务群里的销售与售前同事。

## 资料库
当前工作目录就是本群资料库。`;

const assembled = `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)

Guidelines:
- Use read to examine files instead of cat or sed.
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /app/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /app/node_modules/@earendil-works/pi-coding-agent/docs
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

${APPENDED}
Current working directory: /app/data/groups/g/workspace`;

describe("pi docs section trimming", () => {
  test("removes the whole documentation block and nothing else", () => {
    const trimmed = stripPiDocsSection(assembled);
    expect(trimmed).toBeString();
    expect(trimmed).not.toContain("Pi documentation");
    expect(trimmed).not.toContain("node_modules");
    expect(trimmed).not.toContain("tui.md");
    // 工具清单与 guidelines 是 Pi 随版本演进的部分，必须留下。
    expect(trimmed).toContain("Available tools:");
    expect(trimmed).toContain("- Be concise in your responses");
    expect(trimmed).toContain("Current working directory: /app/data/groups/g/workspace");
    expect(trimmed!.length).toBeLessThan(assembled.length);
  });

  test("keeps the appended group-chat context intact", () => {
    const trimmed = stripPiDocsSection(assembled)!;
    expect(trimmed).toContain(APPENDED);
    expect(trimmed).toContain("## 角色");
    expect(trimmed).toContain("## 资料库");
  });

  test("leaves the prompt alone when the block is not found", () => {
    expect(stripPiDocsSection("You are an assistant.\n\nCurrent working directory: /x"))
      .toBeUndefined();
    expect(stripPiDocsSection("")).toBeUndefined();
  });

  test("handles the block running to the very end of the prompt", () => {
    const tail = `Guidelines:
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself):
- Main documentation: /app/README.md`;
    const trimmed = stripPiDocsSection(tail);
    expect(trimmed).toBe("Guidelines:\n- Be concise in your responses");
  });
});
