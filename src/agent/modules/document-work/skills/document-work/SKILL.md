---
name: document-work
description: 基于本群资料修改 Word、选编和修改 PPT，或在产品资料和模板的版式上生成新的客户方案、交付文档和问题处理报告。查询资料或发送原件时无需使用。
---

# 文档加工

四类任务，各有一条主路径；先判断属于哪类，再读对应指南。

| 任务 | 主路径 | 指南 |
| --- | --- | --- |
| 改几处文字，保留原版式 | `document_inspect` 定位 → `document_patch` 改副本 | [word.md](references/word.md) · [slides.md](references/slides.md) |
| 从已有资料选页 / 选章节 | `document_inspect(outline)` 选 → `document_compose` 组装 | 同上 |
| 在资料和模板基础上写新内容 | 用 Markdown 写内容 → `document_build` 或 `document_compose` 的 `content` 项；需要原图时先 `document_images` 取素材 | [build.md](references/build.md) |
| 规划方案、交付文档、问题报告的内容 | 按读者要回答的问题组织，再走上面三条路径 | [content.md](references/content.md) |

底稿提供结构，当前正式资料提供事实，模板提供样式；三者可来自不同文件，都从本群 `workspace` 检索。旧客户方案中的参数、客户名和承诺必须重新核对。

## 工作原则

- **先看大纲再选材**。`document_inspect` 加 `outline: true` 返回 PPT 每页标题、文字量、图片与表格数，以及 Word 标题层级和可用样式；用它决定复用哪几页、以哪份文件为模板，不要通读全部段落。
- **复用优先于重写**。原页、原图、原表能直接用就用 `slides` / `start,end` 选进来；只有资料里没有的内容才用 Markdown 新写。新写内容放在 `content` 项里，工具会按第一份来源的母版和样式排版。打算把某页做成卡片、时间轴、指标、分层、流程、循环或金字塔时，在该页 `##` 标题后写对应注释（`<!-- timeline -->` 等），自动识别只是没写注释时的兜底；带判断和回退的流程图写 ```` ```mermaid ```` 代码块。资料里的架构图、流程图用 `document_images` 提取或按区域截取后在 Markdown 中引用。
- **只报告实际生成的版式**。`build.layouts` 列出本次新生成的页（`generatedPages`）中真正排成图示的页和类型，`build.attention` 说明退回普通版式的原因。向用户描述某个新页是“时间轴”“数字指标”前先核对 `layouts`；新页没有列出就是普通版式，要么补注释重新生成，要么如实说明。`keepSlides` 保留的模板页不在 `layouts` 里，它们的版式以大纲和渲染图为准。
- **一次组装成稿**。`document_compose` 的 `items` 可以混合 `{source, slides}`、`{source, start, end}` 和 `{content}`，输出一个文件和完整来源记录。不要先生成补充文件再二次组装。
- **成品要看图**。生成或修改后调用 `document_render`，用 `read` 读联系表和需要放大的单页，检查溢出、遮挡、断表、占位文字、旧客户名和图片缺失。`build.attention` 列出的页优先检查。渲染失败或不能看图时如实说明未完成视觉检查。
- **只写自己的临时目录**。所有工具只读资料、在当前用户 tmp 生成新文件；继续改稿以最近一次成品为底稿，操作前重新 `document_inspect` 取新摘要。

## 工具速查

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `document_inspect` | 结构清单、摘要、大纲 | `outline: true` |
| `document_patch` | 副本内精确替换文字 | `digest`、`part`、`paragraph`、`before`、`after` |
| `document_compose` | 选编 + 新增内容组装 | `items[]`：`source`+`slides` / `start`,`end` / `content` |
| `document_build` | 按模板整份生成 | `format`、`template`、`content`、`title`、`keepSlides`、`sequence` |
| `document_images` | 从 PDF/PPT/Word 提取图片素材或按区域截图 | `source`、`pages`、`crops` |
| `document_render` | 渲染逐页图片与联系表 | `pages` |

对现有页面加流程图，或需要和原页对齐的定制图示，先调用 `document_environment`，在固定环境运行本 skill 目录下的 `scripts/flowchart.py`，或用 python-docx / python-pptx 写针对性脚本处理副本；指南里有起点示例。

交付可编辑文件，简要说明改了什么、主要来源和待确认项。文件用 `send_file` 发送；来源记录和预览用于核对，按需提供。
