import { describe, expect, test } from "bun:test";
import {
  markdownToPlainText,
  shouldRenderMarkdown,
} from "../../src/integrations/markdown.ts";

describe("Markdown reply adaptation", () => {
  test("renders actual Markdown syntax but not ordinary paragraphs", () => {
    expect(
      shouldRenderMarkdown("| 项目 | 状态 |\n| --- | --- |\n| 路由 | 正常 |")
    ).toBe(true);
    expect(shouldRenderMarkdown("```ts\nconst ok = true;\n```")).toBe(true);
    expect(shouldRenderMarkdown("~~~sh\necho ok\n~~~")).toBe(true);

    expect(shouldRenderMarkdown("## 标题\n这是 **重点** 和 *说明*。")).toBe(true);
    expect(shouldRenderMarkdown("- 第一项\n- 第二项")).toBe(true);
    expect(shouldRenderMarkdown("查看 [文档](https://example.com)")).toBe(true);
    expect(shouldRenderMarkdown("第一段普通文字。\n\n第二段普通文字。")).toBe(false);
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
