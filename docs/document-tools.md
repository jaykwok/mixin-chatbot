# 文档加工设计

[开发指南](development.md) · [使用示例](usage.md#文档怎么提需求) · [部署环境](deployment.md#python-与文档预览)

## 设计取舍

第一版同时覆盖修改 Word、选编和修改 PPT、整合资料生成新文档。2026-09 补充了按模板生成：模型只写 Markdown，工具负责按模板排版，并可在一次组装中混合复用页与新内容。售前、交付、售后三类业务共享工具，按需参考内容指南。原件提供可复用内容，正式资料提供事实，模板提供样式；不要求模型每次按固定步骤执行。改造方案与执行记录见 [document-work-plan.md](document-work-plan.md)。

| 层次 | 负责什么 | 入口 |
| --- | --- | --- |
| Skill | 说明复用原则、工具选择和交付标准，复杂任务才编排章节或页面 | [SKILL.md](../src/agent/modules/document-work/skills/document-work/SKILL.md) |
| 按需指南 | Word/PPT 编辑要点、Markdown 生成约定与模板行为、流程图脚本，以及售前、交付、问题处理的内容要点和交付检查清单 | [references](../src/agent/modules/document-work/skills/document-work/references) |
| 工具 | 文件定位、摘要校验、大纲、局改、组装、按模板生成、图片素材、渲染、来源记录 | [tools.ts](../src/agent/modules/document-work/tools.ts) |
| 固定环境 | 各群按需 `uv sync`，统一 Python 3.14 与依赖锁 | [python-toolchain.ts](../src/agent/python-toolchain.ts) |

Skill 不绑定模型名称或推理级别。内容取舍、篇章逻辑和布局仍由模型决定；工具负责把容易写错的文件操作做可靠。模型升级后可继续使用；是否提升质量，需要拿真实任务比较，当前文件测试不代表 GLM、DeepSeek 等模型的效果评测。

模块启用时，Pi 只加载项目维护的这一个 skill，初始提示词中保留名称、描述和路径，正文与指南按需读取。群资料目录的 `.pi/skills`、设置和上下文文件继续禁止自动加载。

## 开关、对比测试与移除

`BOT_DOCUMENT_WORK_ENABLED` 是实例级开关，默认 `1`（开启），设为 `0` 关闭。可在运维 TUI 的「设置 → 高级运行参数 → 文档与诊断 → 文档加工模块」修改并应用；也可在 `data/config/runtime.json` 中合并这一项，再重启机器人：

```json
{
  "BOT_DOCUMENT_WORK_ENABLED": "0"
}
```

进程环境变量的同名设置优先于文件；重新开启时改为 `1`。关闭会同时移除六个文档工具、skill 列表项、模块提示词及其额外 `read` 权限，也不会导入或检查模块文件。基础资料索引、`document_extract`、`document_environment`、原文件发送和 `read/bash/edit/write` 保留；Python 3.14、uv 与已有 venv 不卸载。基础 `bash` 仍可编写文档，开关控制的是这组增强能力。

群聊效果测试建议使用相同 workspace、模型和任务，各在开启、关闭状态运行一次。每次应用设置并重启后，由测试用户发送 `/clear` 归档自己在本群的旧会话，再发送任务。比较原件复用、事实准确性、内容结构、版式、耗时和修改便利程度；测试关闭后能否检索和发送原资料。测试输入与输出保留在群 workspace 和用户 tmp 的既有边界内。

实现集中在 [document-work 模块目录](../src/agent/modules/document-work)，包括入口、skill、指南、工具和操作脚本。[modules.ts](../src/agent/modules.ts) 是唯一注册点；会话运行时只接收模块返回的工具、提示词、skill 和只读资源目录。

若最终决定从代码中移除：

1. 先关闭并重启；原资料、已生成文件及现有 venv 都保留。
2. 删除模块目录及 `modules.ts` 中对应的条件注册分支，清理相关文档、模块测试/文件夹具和模型请求测试中的模块断言。
3. 如需缩减安装体积，移除专用的 `pptx-automizer`、`docxcompose`、`pypdfium2` 依赖及对应 Python 就绪检查，重新生成 `bun.lock`、`uv.lock`；LibreOffice 及预览字体也可从镜像中移除。保留基础提取仍使用的 python-docx、python-pptx、pypdf 等库和 uv 机制。重新运行 `bun run check` 验证。

日常效果对比只需开关，无需删除源码、依赖或群文件。

skill 与工具同在模块目录内，根目录没有单独的 `skills/` 目录。默认每群独立使用 `<群目录>/venv`；TUI 的「共享文档环境覆盖」留空即可，仅显式指定时共享环境。

## 操作与产物

- `document_inspect`：返回完整内容清单路径、SHA-256 摘要、Word 正文块或 PPT 实际页序。文字位置包括正文、表格、页眉页脚或备注。`outline: true` 时在响应里直接给出大纲：PPT 每页推断标题、文字量、图片/表格/图表数、版式与推断的标题样式；Word 标题层级、表格与图片数、可用样式和页面尺寸。用于选页、选章节和选模板。
- `document_patch`：用摘要、部件、段落位置和唯一的原文字匹配编辑。支持跨文字片段匹配；替换文字继承起始位置格式，未改部件的解压后字节保持一致。
- `document_compose`：按顺序组装。`{source, slides}` 选 PPT 页码（实际演示顺序，允许重排及重复），`{source, start, end}` 选 Word 正文块，`{content}` 用 Markdown 在第一份来源的母版或样式上生成新页、新章节。组装后清理不可达部件，核对图表和媒体引用。
- `document_build`：用 Markdown 按模板整份生成 Word 或 PPT。Word 以模板为底，清空正文后保留节设置、页眉页脚（含后续节继承的页眉页脚）、样式与主题；PPT 继承母版，从样例页推断标题位置、字体、字号、颜色和内容区域，`#`/`##` 起新页，文字超出时先缩字号（不低于 14pt）再按句拆分续页（显式换行按行计），表格按单元格换行后的实际行高续页，图文同页自动分栏；页内 2–6 个 `###` 短段自动排成多栏卡片（名称都以“层”结尾则排成分层架构图），“A → B → C”段落排成箭头流程图，以阶段或日期标签开头的 3–6 项列表排成横向时间轴，数字标签列表排成大号指标；循环图、金字塔及以上各种都可用 `<!-- cards | flow | layers | timeline | cycle | pyramid | stats | plain -->` 指定；标签开头的表情符号或小节内的一张图片作为图标；```` ```mermaid ```` 代码块按 Mermaid 子集自动分层布局，PPT 画成原生流程图形状，Word 插入 PNG；装不下时退回普通版式并提示；`keepSlides` 与 `sequence` 保留模板页并决定顺序。结果的 `build.layouts` 列出本次新生成页中实际排成图示的页与类型（保留的模板页不在其中），`build.attention` 列出需重点看图的页，包括看起来像图示却没有命中识别规则的页及原因，避免静默退回列表。
- `document_images`：从 PDF、PPTX、DOCX 提取内嵌位图到本用户 tmp，返回页码、像素尺寸、页面位置比例，按内容去重并标出重复页与整页大图；`crops` 按页面比例截取渲染区域（PDF 直接可用，Office 经 LibreOffice），用于矢量图和组合图示。结果路径可直接写入 Markdown 图片引用。
- `document_render`：Office 经本机 LibreOffice 转 PDF，PDF 用 PDFium 生成单页 PNG 和联系表。返回未渲染页与 `visuallyReviewed: false`，模型实际读取图片后才能报告视觉检查。

所有来源先复制到本用户 tmp 中再处理；原资料不被这些工具覆盖。Markdown 引用的图片同样先复制到任务目录，只接受本群 workspace 和本用户 tmp 中的 png/jpg/gif/bmp/tiff，单张不超过 32 MiB。修改、组装与生成同时输出来源路径、摘要和选编信息的 JSON。后续编辑以最近成品为底稿，不必从最初材料重做。

生产运行中的原始资料、历史方案和模板均来自当前群的 `workspace`，复用现有资料索引；没有额外的 `materials` 生产目录约定。离线试验可将准备好的目录作为 `workspaceDir` 传入同一工具，但不能将试验路径写入生产提示词或配置。

Markdown 方言只包含标题、段落、粗斜体、代码、链接、列表、表格、图片、引用、代码块、分页、备注和版面注释，由 [markdown.ts](../src/agent/modules/document-work/markdown.ts) 用 marked 解析为块模型，再由 [document_build.py](../src/agent/modules/document-work/scripts/document_build.py) 渲染。七种图示都是确定性版面（圆角矩形、箭头形、连接线、圆点与文本框的组合，颜色取模板标题色或主题强调色），图标来自表情符号徽标或 Markdown 图片。带分支的流程图由 skill 自带的 [flowchart.py](../src/agent/modules/document-work/skills/document-work/scripts/flowchart.py) 处理：解析 Mermaid 子集，按分层算法（回边识别、最长路径分层、重心排序、虚拟节点）布局，PPT 输出原生形状、连接线与分组，Word 输出 Pillow 绘制的 PNG；生成路径与模型用 bash 直接运行脚本共用同一引擎。和原页对齐的图示等定制版面仍由模型在固定环境用 python-docx / python-pptx 对成稿副本做针对性调整，指南提供起点。

## 能力边界

| 情形 | 当前行为 |
| --- | --- |
| Word 组装 | 第一份提供主样式与页眉页脚，后续来源的页眉页脚不导入；正文块范围包含边界 |
| PPT 尺寸不同 | 拒绝直接组装，先按目标尺寸重排所需内容 |
| 文字改长 | 局改保留原容器，不自动放大文本框；需要渲染后检查溢出 |
| 模板推断 | PPT 标题样式取自模板样例页中位于上部、宽度足够的文本框或标题占位符；模板没有内容页或版式差异大时用 `styleFrom` 指定样例页。行数按字宽估算，最终以渲染图为准 |
| 封面 | 版式自带封面设计时 `cover: true` 生成封面；封面元素画在第 1 页上的产品方案应改用 `keepSlides` 保留原封面并局改 |
| 卡片、流程、分层、时间轴、指标、循环、金字塔 | 自动识别只针对短段落和明确的标签模式；超出 14pt 可容纳的量退回普通版式并提示。颜色取模板标题色或主题强调色，不模仿原资料中的图示样式；表情图标依赖客户端字体，Windows 用 Segoe UI Emoji。分层、金字塔、循环、指标不放图片图标，含图片的小节退回普通版式或卡片并提示 |
| Mermaid 流程图 | 子集：节点形状、带标签的连线、虚线与粗线、`&` 汇合；subgraph、style、click 忽略并提示；最多 40 个节点、80 条连线。PPT 默认在 TB 与 LR 中取更合适的方向，装不下时整体缩小并提示；Word/PNG 需要中文字体（镜像含 Noto CJK，Windows 用微软雅黑），无字体时保留源码 |
| 图片素材 | 只提取位图；EMF/WMF/SVG 和多形状组合图示需用 `crops` 从渲染页截取。PDF 默认前 20 页、PPT 默认前 50 页，单次最多 50 页、返回 60 张，长边缩到 2000 像素；`minSize` 对三种来源一致生效，按完整像素内容去重 |
| 保留页中的链接 | `keepSlides` 保留的页若链接到未保留的页，链接被移除并提示，避免残留页面部件 |
| 域、修订记录 | 局改工具拒绝受影响段落，需要专门脚本处理副本 |
| 复杂 PPT 对象 | 动画、SmartArt、媒体、外部链接及布局上的复杂图形需实际核对；不承诺全部无损。若跨页关联会带入未选页面，组装报错 |
| PPT 自定义标签 | 组装库不保留部分非视觉标签元数据；清理失去页面引用的标签关联并返回提示，仍被使用的缺失关联继续报错 |
| 外部关联 | 检查器提示关联数量，不访问其内容；结构检查不等同于完整 Office 校验或文件脱敏 |
| 预览 | 默认前 20 页，单次最多指定 50 页；可以继续指定剩余页。Office 预览依赖 LibreOffice，最终字体和分页以客户软件为准 |

单来源最大 128 MiB，一次来源总量最大 256 MiB，Office 解压总量最大 256 MiB；组装最多 20 个来源、PPT 最多 200 页。文档操作全局并发 2，单次总期限 5 分钟，受任务取消与进程监督约束。大文件或首次依赖准备较慢时，可先调用 `document_environment`。

每次调用在用户 tmp 下建立独立目录；源文件副本、图片副本、组装中间稿、Office 配置与中间 PDF 位于其中的 .work，结束时自动删除。成功保留成品、预览图片和报告供后续读取与发送；失败或取消时清理本次目录。进程被强制终止留下的目录与已交付成品仍通过 TUI 临时文件清理管理。

`read` 对项目 skill 只读，文件工具与文档工具只访问各自允许的目录。`bash` 保有运行账户权限，边界与[开发指南](development.md#提示词与工具)一致。

## 参考项目与许可

| 项目 | 用法 |
| --- | --- |
| [pptx-automizer](https://github.com/singerla/pptx-automizer)（MIT） | 以固定 npm 依赖复用跨文件页面、母版及关联资源导入；项目另做页序转换、输出清理与检查 |
| [docxcompose](https://github.com/4teamwork/docxcompose)（MIT） | 以固定 Python 依赖复用 Word 组装，遵循首文档页眉页脚规则 |
| [Anthropic document skills](https://github.com/anthropics/skills) | 查阅能力划分思路；其 [PPTX 许可](https://github.com/anthropics/skills/blob/main/skills/pptx/LICENSE.txt)包含复制与再分发限制，因此未复制其 skill 正文、脚本或素材 |

本项目 skill 和胶水代码独立编写；第三方包保留自身许可证。`image-size` 通过 overrides 固定到修复已知解析循环漏洞的 2.0.4；PPT 依赖升级时同步检查此覆盖及 `bun audit`。

## 开发验证

常规检查：`bun run check`、`bun audit`。测试始终在隔离 cwd 中运行。真实文件测试使用单独测试 venv，不修改群环境或启动机器人。

项目根目录的 PowerShell 示例：

```powershell
$env:UV_PROJECT_ENVIRONMENT = (Join-Path $PWD 'tmp/document-validation/group/venv')
uv sync --locked --no-dev --no-install-project
if ($LASTEXITCODE -ne 0) { throw 'uv sync failed' }
bun scripts/runtime/document-manifest.ts . $env:UV_PROJECT_ENVIRONMENT
bun tests/helpers/document-work-integration.ts $env:UV_PROJECT_ENVIRONMENT --office
Remove-Item Env:UV_PROJECT_ENVIRONMENT
```

`--office` 要求可运行的 LibreOffice 并检查 Word/PPT 转 PDF；省略时仍验证 PDF 预览。测试覆盖：原件未变、跨样式文字替换、Word 表格与章节、PPT 页序与重复页、不同母版、图片和可编辑图表、备注保留、失效摘要与越界页码拒绝、大纲输出、按夹具模板生成 Word/PPT（样式与页眉继承、表头重复、图片宽度、备注、列表层级、长文续页、保留页顺序）、组装中的内联 Markdown、自动与指定的七种图示版面（含表情与图片图标）、Mermaid 流程图（内联生成、脚本绘制现有页、PNG 与 Word 插入、解析失败保留源码）、PDF/PPT/Word 图片提取与区域截取，以及指南里的调整脚本示例。产物和报告保留在 `tmp/document-validation/run-*`，供人工看图；自动检查不会声称已经看过图片。容器 CI 配置了只读镜像中带 `--office` 的回归。

Windows 开发机没有安装 LibreOffice 时，可把官方 MSI 以管理安装方式解压到 `tmp/`（`msiexec /a LibreOffice.msi /qn TARGETDIR=...`），再把其中的 `program` 目录临时加入 PATH 运行 `--office`；首次启动会初始化配置，可能需要一到两分钟。
