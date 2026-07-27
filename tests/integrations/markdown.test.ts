import { describe, expect, test } from "bun:test";
import {
  markdownToPlainText,
  requiresStructuredMarkdown,
} from "../../src/integrations/markdown.ts";

describe("Markdown reply adaptation", () => {
  test("reserves rich Markdown for tables and fenced code", () => {
    expect(
      requiresStructuredMarkdown("| 项目 | 状态 |\n| --- | --- |\n| 路由 | 正常 |")
    ).toBe(true);
    expect(requiresStructuredMarkdown("```ts\nconst ok = true;\n```")).toBe(true);
    expect(requiresStructuredMarkdown("~~~sh\necho ok\n~~~")).toBe(true);

    expect(
      requiresStructuredMarkdown("## 标题\n这是 **重点** 和 *说明*。")
    ).toBe(false);
    expect(requiresStructuredMarkdown("- 第一项\n- 第二项")).toBe(false);
    expect(
      requiresStructuredMarkdown("查看 [文档](https://example.com)")
    ).toBe(false);
  });

  test("converts presentation-only Markdown to readable text", () => {
    expect(
      markdownToPlainText(
        "## 标题\n> 说明\n\n这是 **重点**、*斜体*、`代码` 和 [链接](https://example.com)。"
      )
    ).toBe("标题\n说明\n\n这是 重点、斜体、代码 和 链接。");

    expect(markdownToPlainText("![图片](https://example.com/a.png)")).toBe("");
    expect(markdownToPlainText("```ts\nconst ok = true;\n```")).toBe(
      "const ok = true;"
    );
  });

  test("keeps table content readable when rich sending falls back", () => {
    expect(
      markdownToPlainText("| 项目 | 状态 |\n| --- | --- |\n| 路由 | 正常 |")
    ).toBe("项目 状态\n\n路由 正常");
  });
});
