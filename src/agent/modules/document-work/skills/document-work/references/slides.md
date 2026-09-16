# PPT

## 选页与改页

`document_inspect` 的 `slides` 按实际演示顺序返回页码、文件部件及文本位置。页码从 1 开始，不要从 ZIP 内文件名推断顺序。

`document_compose` 接受有序来源，每个来源的 `slides` 数组指定实际页码，顺序和重复页都会保留。跨文件组装使用 pptx-automizer 并导入来源母版和布局。只挑相关页面即可，不需要先重写原页内容。不同画布尺寸会报错：可先根据目标尺寸重排相关内容，再组装。

`document_patch` 使用 inspect 的 `digest` 和 `part`、`paragraph`、`before`、`after` 定位修改；可处理分散在多个文字片段中的短语。替换继承起始位置的格式，不改变文本框尺寸。内容增长时要检查是否溢出；需要调整布局时用 python-pptx 修改副本。普通段落、表格文字、备注可定位，母版文字应谨慎修改，因为会影响多个页面。

组装会处理页面关联资源，但复杂动画、SmartArt、外部链接和嵌入对象仍需实际打开核对；来源布局上的图片、图表也可能需要专门处理。跨页链接若指向未选页面，工具会报错，需处理链接或调整选页。来源备注可能包含内部信息，交付前检查是否适合给目标读者。工具的结构检查不等同于完整 Office 兼容性认证。

## 补页或新建

先调用 `document_environment`。可以用固定环境的 python-pptx 生成补充页面，再与原页组装。按内容选择文字、图示、对比表、时间线或原图；页数和布局由需求决定。复用现成模板时沿用其字体和色彩。

以下是一个可调整的 16:9 起点，用 `uv run --no-project --python "$PI_PYTHON" "$PI_USER_TMP/build.py"` 执行：

```python
import os
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333333), Inches(7.5)
slide = prs.slides.add_slide(prs.slide_layouts[6])
background = slide.background.fill
background.solid()
background.fore_color.rgb = RGBColor.from_string('FFFFFF')

def text_box(x, y, w, h, lines, size=22, color='263445', bold=False):
    frame = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h)).text_frame
    frame.word_wrap = True
    for i, line in enumerate(lines):
        p = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        p.space_after = Pt(12)
        run = p.add_run()
        run.text = line
        run.font.name = 'Noto Sans CJK SC'
        run.font.size, run.font.bold = Pt(size), bold
        run.font.color.rgb = RGBColor.from_string(color)
    return frame

text_box(0.7, 0.5, 11.9, 0.9, ['面向客户的部署建议'], 32, '16324F', True)
text_box(0.7, 1.9, 5.6, 4.3, ['根据需求填写关键建议', '明确适用条件和边界'])
text_box(7.0, 1.9, 5.6, 4.3, ['在此复用适用的产品原图，或绘制可编辑的部署示意'])
prs.save(Path(os.environ['PI_USER_TMP']) / '补充页面.pptx')
```

替换示例内容；如有原图可用 `slide.shapes.add_picture` 插入，保留比例。为中文及长标题预留空间，避免用缩到难以阅读的字号来塞满一页。

生成或修改后调用 `document_render`，读取联系表及需要放大检查的单页图片。工具返回未渲染页时可用 `pages` 指定余下页码。检查文字溢出、图表标签、母版装饰、旧客户名称、占位文字和页面之间的风格衔接。
