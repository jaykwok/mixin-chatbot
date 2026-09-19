# PPT

## 看大纲选页

`document_inspect` 加 `outline: true` 返回 `outline.slides`：每页的推断标题、文字量、图片/表格/图表数、版式名和是否隐藏，以及 `outline.layouts` 和推断出的 `titleStyle`。用它决定复用哪几页、哪份文件适合做模板；只有需要精确文字时才读清单文件中的 `paragraphs`。

页码是实际演示顺序，从 1 开始，不要从 ZIP 内文件名推断。

## 选页与组装

`document_compose` 的 `items` 按顺序拼接：`{source, slides: [页码...]}` 复用页面，顺序与重复都保留，跨文件时导入来源母版；`{content: "## 标题\n..."}` 用第一份来源的母版生成新页（约定见 [build.md](build.md)）。不同画布尺寸会报错，先按目标尺寸重排再组装。

组装会处理页面关联资源，但复杂动画、SmartArt、外部链接和嵌入对象仍需实际打开核对；跨页链接若指向未选页面会报错。来源备注可能含内部信息，交付前检查。工具的结构检查不等同于完整 Office 兼容性认证。

只需要原页里的一张图而不是整页时，用 `document_images` 按页提取位图，或 `crops` 截取渲染区域，再在 `content` 项的 Markdown 中引用；约定见 [build.md](build.md)。

## 改页

`document_patch` 使用 inspect 的 `digest` 和 `part`、`paragraph`、`before`、`after` 定位修改；可处理分散在多个文字片段中的短语。替换继承起始位置的格式，不改变文本框尺寸。内容变长时要检查是否溢出。普通段落、表格文字、备注可定位；母版文字影响多个页面，谨慎修改。

改完后检查：旧客户名、绝对化承诺（“零风险”“全覆盖”）、历史日期与版本条件、占位文字。

## 带分支的流程图

判断、汇合、回退这类流程图不用手写形状：用 Mermaid 子集描述，由本 skill 自带的 `scripts/flowchart.py`（与 SKILL.md 同目录下的 `scripts/`）做分层布局，画成可编辑的原生形状和连接线，颜色沿用母版主题。

- **新页**：在 `document_build` 或 `content` 项的 Markdown 里写 ```` ```mermaid ```` 代码块，工具自动画在该页标题与引导文字之下（约定见 [build.md](build.md)）。
- **现有页**：把 Mermaid 写到 `$PI_USER_TMP/flow.mmd`，再运行（`<skill目录>` 换成 SKILL.md 所在目录的绝对路径）：

```sh
uv run --no-project --python "$PI_PYTHON" "<skill目录>/scripts/flowchart.py" "$PI_USER_TMP/flow.mmd" \
  --pptx "$PI_USER_TMP/成稿.pptx" --slide 5 --out "$PI_USER_TMP/成稿-调整.pptx"
```

默认画在标题和引导文字之下；`--region x,y,w,h`（英寸）指定区域，`--direction LR` 强制横向，`--accent RRGGBB` 换色，`--check` 只解析不绘制。输出 JSON 摘要；`warnings` 出现“已整体缩小”说明图太大，应拆成两页或精简节点文字。

Mermaid 子集：

```text
flowchart TB                      方向 TB / LR / BT / RL；省略时 PPT 在 TB 与 LR 中自动选更合适的
S([收到告警]) --> A[自动归类]      ([ ]) 起止   [ ] 处理   ( ) 圆角   { } 判断   [/ /] 输入输出   [( )] 数据库   (( )) 圆
A --> B{是否高危?}
B -- 是 --> C[立即阻断]           分支标签也可写 B -->|是| C
B -- 否 --> D[进入工单队列]
C & D --> E[安全大脑研判]         多个来源汇合
E --> F{处置是否有效?}
F -- 否 --> A                     指向前面节点的连线自动画成返回线
F -- 是 --> G([结束])
A -.-> L[(留存日志)]              -.-> 虚线，==> 粗线，--- 无箭头
```

节点 ID 可用中文；文字里的 `<br/>` 换行。不支持 subgraph、style、click（忽略并提示）；最多 40 个节点、80 条连线。节点文字尽量不超过 10 字，长文字会自动换行但会把图撑大。

## 需要脚本的布局调整

先调用 `document_environment`，用 `uv run --no-project --python "$PI_PYTHON" "$PI_USER_TMP/adjust.py"` 执行。以下起点在成稿副本上调整一页的文本框并加一张图：

```python
import os
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt

tmp = Path(os.environ['PI_USER_TMP'])
prs = Presentation(tmp / '成稿.pptx')
slide = prs.slides[4]  # 第 5 页
for shape in slide.shapes:
    if shape.has_text_frame and '实施阶段' in shape.text_frame.text:
        shape.width, shape.height = Inches(6.2), Inches(5.2)
        for paragraph in shape.text_frame.paragraphs:
            for run in paragraph.runs:
                run.font.size = Pt(16)
picture = slide.shapes.add_picture(str(tmp / 'flow.png'), Inches(7.2), Inches(1.4), width=Inches(5.4))
prs.save(tmp / '成稿-调整.pptx')
```

不要用 `text_frame.text = ...` 改保留混合样式的段落，改 `run.text`。python-pptx 不能复制页面，也不能读 SVG / EMF 图片；这些情况回到 `document_compose` 复用原页。

生成或修改后调用 `document_render`，读取联系表及需要放大检查的单页图片。工具返回未渲染页时可用 `pages` 指定余下页码。渲染字体可能与客户 Office 不同，为中文和长标题留足空间。
