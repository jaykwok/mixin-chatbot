import { describe, expect, test } from "bun:test";
import { markdownToBlocks } from "../../src/agent/modules/document-work/markdown.ts";

describe("document markdown block model", () => {
  test("maps the supported dialect to blocks and keeps inline styles", () => {
    const parsed = markdownToBlocks(`<!-- notes: 讲稿一 -->
# 客户交流目标
段落 **重点** 与 *强调*、\`代码\` 和 [链接](https://example.com)。

![架构图](images/arch.png "width=8cm")

- 一级
  - 二级 **加粗**
  1. 编号
- [x] 已完成

| 项目 | 说明 |
|:--|--:|
| A | 1 |

> 引用一行

\`\`\`
code
\`\`\`

---
<!-- 分页 -->
## 第二节
<div>纯文本</div>
`);
    expect(parsed.blocks.map(block => block.type)).toEqual([
      "note", "heading", "paragraph", "image", "list", "table", "quote", "code", "pagebreak", "pagebreak", "heading", "paragraph",
    ]);
    const paragraph = parsed.blocks[2] as Extract<typeof parsed.blocks[number], { type: "paragraph" }>;
    expect(paragraph.runs).toEqual([
      { text: "段落 " }, { text: "重点", bold: true }, { text: " 与 " }, { text: "强调", italic: true }, { text: "、" },
      { text: "代码", code: true }, { text: " 和 " }, { text: "链接", link: "https://example.com" }, { text: "。" },
    ]);
    expect(parsed.blocks[3]).toEqual({ type: "image", path: "images/arch.png", alt: "架构图", width: "width=8cm" });
    const list = parsed.blocks[4] as Extract<typeof parsed.blocks[number], { type: "list" }>;
    expect(list.items.map(item => [item.level, item.ordered, item.runs.map(r => r.text).join("")])).toEqual([
      [0, false, "一级"], [1, false, "二级 加粗"], [1, true, "编号"], [0, false, "☑ 已完成"],
    ]);
    const table = parsed.blocks[5] as Extract<typeof parsed.blocks[number], { type: "table" }>;
    expect(table.align).toEqual(["left", "right"]);
    expect(table.rows).toEqual([[[{ text: "A" }], [{ text: "1" }]]]);
    expect(parsed.blocks[0]).toEqual({ type: "note", text: "讲稿一" });
    expect(parsed.images).toEqual(["images/arch.png"]);
    expect(parsed.warnings).toEqual(["HTML 标签已按纯文本处理"]);
  });

  test("rejects empty or oversized content and too many images", () => {
    expect(() => markdownToBlocks("   ")).toThrow("不能为空");
    expect(() => markdownToBlocks("a".repeat(200001))).toThrow("200000");
    const images = Array.from({ length: 41 }, (_, i) => `![i](p${i}.png)`).join("\n\n");
    expect(() => markdownToBlocks(images)).toThrow("40");
  });

  test("keeps the fence language so mermaid blocks can become flowcharts", () => {
    const parsed = markdownToBlocks("```mermaid  \nflowchart TB\n  A --> B\n```\n\n```\nplain\n```\n\n```Python extra\nprint(1)\n```");
    expect(parsed.blocks).toEqual([
      { type: "code", text: "flowchart TB\n  A --> B", lang: "mermaid" }, { type: "code", text: "plain" }, { type: "code", text: "print(1)", lang: "python" },
    ]);
  });

  test("ignores unknown comments and non-web link targets", () => {
    const parsed = markdownToBlocks("<!-- 自由注释 -->\n\n[本地文件](file:///c/secret.txt) 与 [网页](http://a.b)");
    expect(parsed.blocks).toHaveLength(1);
    const runs = (parsed.blocks[0] as Extract<typeof parsed.blocks[number], { type: "paragraph" }>).runs;
    expect(runs[0]).toEqual({ text: "本地文件" });
    expect(runs[2]).toEqual({ text: "网页", link: "http://a.b" });
  });

  test("lifts an image out of its paragraph without leaving a stray line break", () => {
    const parsed = markdownToBlocks("![图](a.png)\n说明文字与图片同页。\n第二行");
    expect(parsed.blocks.map(block => block.type)).toEqual(["paragraph", "image"]);
    const runs = (parsed.blocks[0] as Extract<typeof parsed.blocks[number], { type: "paragraph" }>).runs;
    expect(runs).toEqual([{ text: "说明文字与图片同页。\n第二行" }]);
  });
});

describe("document markdown layout directives", () => {
  test("recognises card, timeline and plain directives and ignores them elsewhere", () => {
    const parsed = markdownToBlocks("## 能力\n<!-- cards -->\n### 一\n文\n### 二\n文\n\n## 流程\n<!-- 时间轴 -->\n1. 第一阶段：调研\n2. 第二阶段：部署\n\n## 普通\n<!-- plain -->\n- 项");
    expect(parsed.blocks.filter(block => block.type === "layout")).toEqual([
      { type: "layout", mode: "cards" }, { type: "layout", mode: "timeline" }, { type: "layout", mode: "plain" },
    ]);
    expect(parsed.warnings).toEqual([]);
  });
});
