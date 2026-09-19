# Word

## 看大纲选章节

`document_inspect` 加 `outline: true` 返回 `outline.headings`（标题层级、文字与正文块位置）、表格数、图片数、可用样式和页面尺寸。用它决定复用哪些正文块、哪份文件适合做模板。清单文件中的 `blocks` 是正文顶层段落和表格的位置（从 1 开始），`paragraphs` 含正文、表格内段落及页眉页脚。

## 局部改稿

用 `document_patch` 传入原文件摘要及 `part`、`paragraph`、`before`、`after`。替换保留未受影响的文字样式和其他文件部件；替换文字继承起始位置的样式。工具拒绝不唯一或已过期的匹配，也拒绝含域、修订记录的段落，这类修改需要专门脚本处理副本。不要把 `paragraph.text = ...` 用于需要保留混合样式、超链接或图片的段落。

## 章节组装与新增

`document_compose` 的每个 Word 来源可指定 `start`、`end`（含边界）；省略表示全文。`{content}` 项按第一份来源的样式生成新章节（约定见 [build.md](build.md)）。段落中的图片随所在块复用，表格整表为一个块。第一份来源提供页眉页脚和主样式；其他来源的页眉页脚不会带入。选章节时包含相关标题、图注、编号和说明，合并后检查列表编号与分页。

整份新写时用 `document_build`，`template` 指向同类正式文档，标题、列表、表格和图注都会套用它的样式。

## 需要脚本的情况

目录、交叉引用、复杂表格合并单元格、多节不同页眉等，先调用 `document_environment`，用 `uv run --no-project --python "$PI_PYTHON" "$PI_USER_TMP/adjust.py"` 处理成稿副本。起点：

```python
import os
from pathlib import Path
from docx import Document
from docx.shared import Cm, Pt
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

tmp = Path(os.environ['PI_USER_TMP'])
doc = Document(tmp / '成稿.docx')
# 在第一个标题后插入目录域，打开文件后按 F9 更新
heading = next(p for p in doc.paragraphs if p.style.name.startswith('Heading'))
toc = heading.insert_paragraph_before()
field = OxmlElement('w:fldSimple')
field.set(qn('w:instr'), 'TOC \\o "1-3" \\h \\z \\u')
toc._p.append(field)
# 合并表格首行单元格
table = doc.tables[0]
table.cell(0, 0).merge(table.cell(0, len(table.columns) - 1))
doc.save(tmp / '成稿-调整.docx')
```

生成后调用 `document_render` 查看实际分页，修正后重新渲染。预览依赖服务器 LibreOffice，客户 Office 的字体和分页可能不同。

## 带分支的流程图

问题处理、审批、验收等带判断和回退的流程，用 Mermaid 子集描述（写法见 [slides.md](slides.md#带分支的流程图)），有两种进入 Word 的方式：

- 新文档或新章节：在 `content` 的 Markdown 里写 ```` ```mermaid ```` 代码块，生成时自动转成插图并居中。
- 现有文档：把 Mermaid 写到 `$PI_USER_TMP/flow.mmd`，用本 skill 的 `scripts/flowchart.py` 生成 PNG 并插到指定段落之后：

```sh
uv run --no-project --python "$PI_PYTHON" "<skill目录>/scripts/flowchart.py" "$PI_USER_TMP/flow.mmd" \
  --docx "$PI_USER_TMP/成稿.docx" --after "处理流程" --caption "图 1 问题处理流程" --out "$PI_USER_TMP/成稿-调整.docx"
```

`--after` 匹配第一个包含该文字的段落，省略则放在文末；`--width-cm` 控制图宽；`--png 路径` 只输出图片。Word 里的流程图是位图，需要服务器有中文字体（Docker 镜像自带 Noto CJK，Windows 用微软雅黑）；没有字体时脚本报错、生成时保留源码并在 `warnings` 中说明。
