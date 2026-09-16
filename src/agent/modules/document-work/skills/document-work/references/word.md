# Word

## 局部改稿

`document_inspect` 返回一个 JSON 清单路径和 `digest`。清单中的 `paragraphs` 给出 `part`、`paragraph`（从 1 开始）和文字；也包含表格内段落及页眉页脚。用这些位置调用 `document_patch`，传入原文件摘要及 `before`、`after`。替换保留未受影响的文字样式和其他文件部件，替换文字继承起始位置的样式。工具拒绝不唯一或已过期的匹配。

工具面向普通文字编辑。修订记录、域和特殊控件中的复杂修改需要专门处理；遇到明确的不支持提示，可在固定环境中编写针对该文件的脚本，生成副本并检查。不要把 `paragraph.text = ...` 用于需要保留原有混合样式、超链接或图片的段落。

## 章节组装

清单的 `blocks` 是正文顶层段落和表格的位置（从 1 开始）。`document_compose` 的每个 Word 来源可以指定 `start`、`end`，均包含边界；省略表示全文。段落中的图片随所在块复用。表格以整表为一个块。

第一份来源提供页眉页脚和主样式。合并采用 docxcompose；其他来源的页眉页脚不会带入。选择章节时包含相关标题、图注、编号和说明，合并后检查列表及分页。不要承诺所有复杂 Office 对象无损。

## 新建或补写

先 `document_environment`，用 `uv run --no-project --python "$PI_PYTHON" "$PI_USER_TMP/build.py"` 执行脚本。此示例生成可编辑 Word；可按材料和模板调整：

```python
import os
from pathlib import Path
from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

doc = Document()  # 有适用底稿时传入其路径
section = doc.sections[0]
section.top_margin = section.bottom_margin = Cm(2.2)
section.left_margin = section.right_margin = Cm(2.4)
normal = doc.styles['Normal']
normal.font.name = 'Noto Sans CJK SC'
normal.font.size = Pt(11)
normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), 'Noto Sans CJK SC')
normal.paragraph_format.space_after = Pt(7)
normal.paragraph_format.line_spacing = 1.2
for name in ['Title', 'Heading 1', 'Heading 2']:
    style = doc.styles[name]
    style.font.name = 'Noto Sans CJK SC'
    style.font.color.rgb = RGBColor.from_string('16324F')
    style.paragraph_format.keep_with_next = True
doc.add_heading('客户方案', 0)
doc.add_paragraph('按本次客户背景填写摘要；产品结论需有资料依据。')
doc.add_heading('部署建议', 1)
table = doc.add_table(rows=1, cols=2)
table.style = 'Light Shading Accent 1'
table.rows[0].cells[0].text = '事项'
table.rows[0].cells[1].text = '建议与依据'
repeat = OxmlElement('w:tblHeader')
table.rows[0]._tr.get_or_add_trPr().append(repeat)
cells = table.add_row().cells
cells[0].text, cells[1].text = '部署条件', '根据本群正式资料及客户环境填写'
doc.save(Path(os.environ['PI_USER_TMP']) / '客户方案.docx')
```

示例文字应替换为实际内容。目录、图片、交叉引用等按需要添加。生成后调用 `document_render` 查看实际分页，修正后重新渲染。预览依赖服务器 LibreOffice，客户 Office 的字体和分页可能有所不同。
