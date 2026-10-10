# 开发指南

[返回 README](../README.md) · [部署与配置](deployment.md) · [运维手册](operations.md)

**本页内容**：[工作原理](#工作原理) · [提示词与工具](#提示词与工具) · [资料解析](#资料索引与文档解析) · [文档加工](#文档加工) · [缓存与费用统计](#缓存与费用统计) · [开发与检查](#开发与检查) · [数据版本与升级](#数据版本与升级)

只调整机器人的用途时，从 [prompt.ts](../src/agent/prompt.ts) 开始。修改代码后，按[开发与检查](#开发与检查)验证。

## 工作原理

基于 **Bun + Hono + Pi Durable 引擎**，支持 Windows 原生部署和 Linux / Docker。每个群一个 Durable 数据库（`<群目录>/durable.sqlite`），群内每位成员一个对话。下面是任务处理与取消、交付之间的关系：

```mermaid
flowchart TD
  W["Webhook<br/>鉴权与有界读体"] --> A["普通消息<br/>容量与限流"]
  W --> C["/stop · /clear"]
  A --> Q["成员收件箱<br/>群库内 FIFO"]
  C -->|取消 / 重置| Q
  Q --> P["Durable 对话"]
  P --> T["文件与解析工具<br/>受监督子进程"]
  P --> D["待交付记录<br/>SQLite"]
  T -->|附件直发| I["出站队列<br/>限流与交付期限"]
  D --> I
  R["根取消与关机期限"] -.-> Q
  R -.-> T
  R -.-> I
```

普通消息先写入该成员的收件箱（群库内的一次提交），提交成功后 webhook 才回 200；服务重启后从收件箱和未结束的运行继续。一轮任务覆盖准备、模型执行、工具调用和最终交付。同一群、同一用户按 FIFO 串行处理，不同用户可以并发；默认全局最多接收 32 个普通请求。

停止与清理走独立控制路径，不受普通消息容量、入站限流或去重阻挡；控制命令记入群库的控制流，执行完才移除，中途停机的会在下次启动时重新执行。图中虚线表示根级取消约束：关机先广播取消，进程和出站请求在统一期限内收尾。

最终文本和必要外链先持久化，平台确认后才移除记录；未送达内容可用 `/deliver` 补发。文件附件由发送工具直接交付。callback key 必须对应一个群，跨群复用会触发持久隔离，修正平台配置后按[回调路由恢复](operations.md#回调路由恢复)解除。出站以 callback key 为单位有界排队，并为最终回复预留限流额度。

## 提示词与工具

基础系统提示词在 [prompt.ts](../src/agent/prompt.ts) 中维护，由 Durable 扩展 [durable/prompt.ts](../src/durable/prompt.ts) 组装成系统提示词（与 Pi 的 `systemPromptOverride` 相同的段落）。不自动发现 extensions、skills、prompt templates、themes 和上下文文件，也不读取群工作区的 `.pi/settings.json`。[模块注册入口](../src/agent/modules.ts) 按开关一起提供工具、skill、提示词补充和只读资源目录；文档加工模块见[下文](#文档加工)。群资料中的 skill 不能改变指令或运行设置。

回答以本群资料为依据，尽可能标明文件、页码或 sheet。资料内容作为证据处理，原始资料按用户要求直接发送。

| 工具 | 用途与边界 |
| --- | --- |
| `read` | 读取本群 workspace、index、本用户 tmp 及项目文档 skill |
| `edit` / `write` | 仅写本用户 tmp，检查规范路径 |
| `bash` | 执行命令，统一管理超时、取消、输出上限及后代回收 |
| `document_environment` | 按需准备解析环境，验证实际解释器、版本和库导入 |
| `document_extract` | 提取 PDF/DOCX/PPTX/XLSX，按内容与解析器版本复用缓存，返回可检索的文本路径 |
| `document_inspect` | 检查 DOCX/PPTX 包及内部引用，返回段落位置、正文块、实际页序和内容摘要；可附带页面或章节大纲 |
| `document_patch` | 按摘要与精确位置修改副本中的文字，保留未修改的文档部件 |
| `document_compose` | 选编 Word 正文块或 PPT 页面，可混合 Markdown 新内容，生成新文件与来源记录 |
| `document_build` | 用 Markdown 在模板的母版、版式与样式上整份生成 Word 或 PPT |
| `document_images` | 从 PDF/PPTX/DOCX 提取内嵌图片或按区域截取渲染页，作为 Markdown 图片素材 |
| `document_render` | 将 DOCX/PPTX/PDF 渲染为逐页图片及联系表；Office 需要 LibreOffice |
| `send_file` / `send_image` | 发送文件或图片；本地路径复用文件工具的解析规则 |
| `codemode` | 在沙箱里运行模型写的 JavaScript，并行或按依赖顺序调用其他工具，只把筛选后的结果交给模型 |

每个对话都接入 codemode：沿用 Pi 官方 codemode 的脚本运行时和说明文字（[durable/codemode](../src/durable/codemode)，与上游的差异写在 `upstream.ts` 开头），不向脚本开放模型目录。六个 `document_*` 加工工具只能在脚本里调用：不直接声明给模型，列在 codemode 的说明里，用法说明由脚本里的 `describeNamespace("document_work")` 取得。`send_file` / `send_image` 只给模型直接调用，脚本拿不到；其余工具两种方式都能调用。脚本里的调用走同一套工具包装、路径边界和文档并发上限（解析与加工各同时 2 个）。脚本输出过长时，完整输出和超长的子调用结果直接写在本用户 tmp 的 `codemode/<任务>-<调用>/` 下，只有本人的 `read` 能打开，不经过共享的系统临时目录。

Windows 用 Job Object 管理工具进程及后代，Linux 用 subreaper 和父进程死亡通知回收后代；主命令退出、超时、取消或机器人父进程强制结束都会触发收尾。输出总量限制为 16 MiB，并保留错误尾部。

**bash 保有运行账户的操作系统权限，进程监督不构成文件沙箱。** 当前部署面向可信内部成员；Docker 使用非 root、只读镜像与移除 capabilities，但资料 bind mount 仍可写。不可信用户需要独立的 OS 隔离方案。

### 资料索引与文档解析

索引用于定位文件，未命中时仍需定向查找资料。`index/ignore.txt` 每行一个 workspace 相对路径前缀，`#` 表示注释；扫描受文件数和深度限制，无法读取的目录会使清单标记为不完整。

PDF、DOCX、PPTX、XLSX 文本优先使用 `document_extract`，它会按需检查解析环境，并按原件 SHA-256、解析器与依赖锁版本复用缓存：群共享资料的结果位于群 `index/parsed`，用户私有文件的结果只放本用户 tmp。特殊解析或文件生成先调用 `document_environment`；模型不能自行安装包或改写共享环境。不提供 OCR，文档工具只接受现代 Office 格式。

Python 依赖由 [pyproject.toml](../pyproject.toml) 和 [uv.lock](../uv.lock) 管理，[.python-version](../.python-version) 选择 3.14 系列，各群默认使用自己的 `<群目录>/venv`。Docker 构建、原生准备和就绪检测共用 [document-manifest.ts](../scripts/runtime/document-manifest.ts)。修改依赖后运行 `uv lock`，再做[文档回归](#文档回归)。

## 文档加工

文档加工是默认开启的可选模块，覆盖修改 Word、选编和修改 PPT、整合资料或按模板生成新文档。原件提供可复用内容，正式资料提供事实，模板提供样式；内容取舍和版面由模型决定，工具负责把容易写错的文件操作做可靠。

| 层次 | 负责什么 | 入口 |
| --- | --- | --- |
| Skill | 复用原则、工具选择和交付标准 | [SKILL.md](../src/agent/modules/document-work/skills/document-work/SKILL.md) |
| 按需指南 | Word/PPT 编辑要点、Markdown 生成约定、流程图脚本和各类文档的内容要点 | [references](../src/agent/modules/document-work/skills/document-work/references) |
| 工具 | 摘要校验、大纲、局改、组装、按模板生成、图片素材、渲染、来源记录 | [tools.ts](../src/agent/modules/document-work/tools.ts) |
| 固定环境 | 各群按需 `uv sync`，统一 Python 与依赖锁 | [python-toolchain.ts](../src/agent/python-toolchain.ts) |

**开关。** `BOT_DOCUMENT_WORK_ENABLED` 默认 `1`，设为 `0` 关闭：在 TUI 的「设置 → 高级运行参数 → 文档与诊断 → 文档加工模块」修改并应用，或在 `data/config/runtime.json` 中设置后重启；进程环境变量优先于文件。关闭会移除六个文档工具（codemode 脚本也调用不到）、skill、模块提示词及其额外 `read` 权限；资料索引、`document_extract`、`document_environment`、原文件发送和 `read/bash/edit/write` 保留，已有 venv 不卸载。

实现集中在 [document-work 模块目录](../src/agent/modules/document-work)，[modules.ts](../src/agent/modules.ts) 是唯一注册点。要从代码中移除，先关闭并重启，再删除模块目录和对应的注册分支，清理相关测试和专用依赖（`pptx-automizer`、`docxcompose`、`pypdfium2`），重新生成锁文件并运行 `bun run check`。

所有来源先复制到本用户 tmp 中再处理，原资料不被覆盖；修改、组装与生成同时输出来源路径、摘要和选编信息。每次调用的中间文件在结束时删除，成功保留成品、预览图片和报告。

### 能力边界

| 情形 | 当前行为 |
| --- | --- |
| Word 组装 | 第一份提供主样式与页眉页脚，后续来源的页眉页脚不导入；正文块范围包含边界 |
| PPT 尺寸不同 | 拒绝直接组装，先按目标尺寸重排所需内容 |
| 文字改长 | 局改保留原容器，不自动放大文本框；需要渲染后检查溢出 |
| 模板推断 | PPT 标题样式取自模板样例页；模板没有内容页或版式差异大时用 `styleFrom` 指定样例页。行数按字宽估算，最终以渲染图为准 |
| 自动图示 | 卡片、流程、分层、时间轴、指标、循环、金字塔只识别短段落和明确的标签模式，装不下时退回普通版式并提示；颜色取模板标题色或主题强调色 |
| Mermaid 流程图 | 子集：节点形状、带标签的连线、虚线与粗线、`&` 汇合；subgraph、style、click 忽略并提示；最多 40 个节点、80 条连线。Word/PNG 需要中文字体，无字体时保留源码 |
| 图片素材 | 只提取位图；EMF/WMF/SVG 和组合图示需用 `crops` 从渲染页截取 |
| 域、修订记录 | 局改工具拒绝受影响段落，需要专门脚本处理副本 |
| 复杂 PPT 对象 | 动画、SmartArt、媒体、外部链接及复杂图形需实际核对，不承诺全部无损 |
| 外部关联 | 检查器提示关联数量，不访问其内容；结构检查不等同于完整 Office 校验或文件脱敏 |
| 预览 | 默认前 20 页，单次最多 50 页。Office 预览依赖 LibreOffice，最终字体和分页以客户软件为准 |

单来源最大 128 MiB，一次来源总量和 Office 解压总量各最大 256 MiB；组装最多 20 个来源、PPT 最多 200 页。文档操作全局并发 2，单次总期限 5 分钟，受任务取消与进程监督约束。

### 参考项目与许可

| 项目 | 用法 |
| --- | --- |
| [pptx-automizer](https://github.com/singerla/pptx-automizer)（MIT） | 以固定 npm 依赖复用跨文件页面、母版及关联资源导入；项目另做页序转换、输出清理与检查 |
| [docxcompose](https://github.com/4teamwork/docxcompose)（MIT） | 以固定 Python 依赖复用 Word 组装，遵循首文档页眉页脚规则 |
| [Anthropic document skills](https://github.com/anthropics/skills) | 查阅能力划分思路；其 [PPTX 许可](https://github.com/anthropics/skills/blob/main/skills/pptx/LICENSE.txt)包含复制与再分发限制，因此未复制其 skill 正文、脚本或素材 |

本项目 skill 和胶水代码独立编写；第三方包保留自身许可证。Pi 路径适配代码的许可保留在对应源码中。

## 缓存与费用统计

模型缓存使用 Pi 原生 `PI_CACHE_RETENTION` 与 provider 的 cacheRetention 策略。Durable 引擎不做缓存保温，数据版本 4 移除旧 warming 配置；保温是额外模型请求，与是否允许服务端缓存是两个选项。原生 retry、stream、按模型压缩预算、上下文缓存以及可选辅助模型和 MCP，见[运行设置与可选工具](runtime-tools.md)。模型 `inputLimits.images.resize` 控制图片尺寸。

统计包含普通回复、历史压缩、辅助模型以及旧记录中的分支摘要、缓存保温等调用的 input/output/cacheRead/cacheWrite，按模型、日期及调用类型分组。新辅助模型用量按 provider/model 单独入账，不并入父工具重复累计。费用是 SDK 根据配置价格的估算，**不代表 Coding Plan 实际账单或套餐配额**；升级不按新价格重算历史费用。

工具调用分两层计：模型发出的调用（一个 codemode 脚本算一次）和脚本运行时调用的工具（子调用）。SDK 把子调用的用量并进那条工具结果，账本按“工具”类型记一次，模型记为 unknown，不和外层回复重复累计；子调用记录被截断或未结束时单独标出“不完整”，计数可能偏少。数据版本 2 之前入账、原件已无法核对的会话没有这两项，统计页标为旧口径（见 [数据版本 2](data-migrations.md#数据版本-2统计账本)）。

统计数据独立存放在 `<群数据根>/stats.sqlite`，CLI、TUI 和 HTML 报表都读这一份。账本由 [stats-ledger.ts](../src/agent/stats-ledger.ts) 维护：Durable 对话由 [projection.ts](../src/durable/projection.ts) 在每次回复前、`/clear` 和维护时按条目游标增量入账；数据版本 3 之前的会话文件原地保留，由每日兜底扫描补入尚未入账的部分。两者都不重复累加，也不会用较旧的读取覆盖新账；读取方只用只读连接。**不得删库重建**：原件可能已删除，账本是仅存的历史。

## 开发与检查

```sh
bun install --frozen-lockfile
bun run check
bun audit
```

配置向导和配置变更需要先停止服务。已有模型配置与 webhook 密钥时，用 `bun run start` 前台运行、`bun run dev` 监听代码变化。仅隔离开发可显式设置 `ALLOW_INSECURE_WEBHOOK=1` 使用无密钥的 `/webhook`。

`bun run check` 包含 TypeScript、隔离 cwd 的 Bun 测试、普通 Knip 和 production Knip。单独运行测试也使用 `bun run test`，以免直接 `bun test` 读取开发者的真实配置。每次运行的隔离 cwd 是工作根目录下的 `tests-*`，工作根目录由 `MIXIN_TEST_WORK_ROOT` 指定；未设置时 Windows 用系统临时目录，WSL 用 Linux 文件系统中的 `/tmp/mixin-tests`，其余平台用项目 `tmp/`。Windows 的夹具放在工作区之外，减少编辑器目录扫描对重命名的干扰。全部通过后删除，失败时保留现场并打印路径，诊断日志仍在项目 `tmp/`。

`package.json` 的 overrides 把个别传递依赖固定到修复已知问题的版本。`scripts/patches` 保留两处构建期补丁：Knip 传播 Bun 脚本入口的 production 标记；Pi Durable 的 `beforeSummarize` 钩子让压缩请求也经过请求门与用量记账。Knip 6.40.0 原版仍会排除这个生产入口，即使在配置中显式声明；`tests/ops/knip.test.ts` 同时验证已用代码不误报、无用文件和依赖仍会报错。依赖均精确固定版本，升级时同步检查覆盖、补丁、锁文件和 `bun audit`，并跑普通与 production 两种死代码检查。

命令行入口放在 `scripts/{config,ops,runtime}` 下，由 `package.json` 和 `knip.json` 登记为生产入口；新增命令时同步更新入口声明。`bun run tui:preview [页面] [列] [行]` 用固定的演示数据把管理台页面渲染成文本（`--plain` 去色），用来核对排版；截图维护见[截图说明](assets/README.md)。

| 工程入口 | 职责 |
| --- | --- |
| [index.ts](../src/server/index.ts)、[app.ts](../src/server/app.ts) | 轻量版本检查与服务生命周期；验证模式独立启动 |
| [http-app.ts](../src/server/http-app.ts)、[webhook.ts](../src/server/webhook.ts) | HTTP 接入、鉴权与控制路径 |
| [service.ts](../src/durable/service.ts)、[inbox.ts](../src/durable/inbox.ts) | 消息服务：收件箱、控制流、成员调度与恢复 |
| [groups.ts](../src/durable/groups.ts)、[sqlite.ts](../src/durable/sqlite.ts)、[door.ts](../src/durable/door.ts) | 每群 Durable 数据库与 Harness、模型请求门 |
| [registry.ts](../src/durable/registry.ts)、[tools.ts](../src/durable/tools.ts)、[codemode](../src/durable/codemode) | 对话的扩展、工具与 codemode |
| [projection.ts](../src/durable/projection.ts)、[compaction.ts](../src/durable/compaction.ts) | 用量入账与上下文压缩 |
| [prompt.ts](../src/agent/prompt.ts)、[local-tools.ts](../src/agent/local-tools.ts) | 资料助手提示词与本地工具边界 |
| [process.ts](../src/core/process.ts)、[process-supervisor.ts](../src/core/process-supervisor.ts) | 工具进程执行与后代回收 |
| [delivery-store.ts](../src/agent/delivery-store.ts)、[im.ts](../src/integrations/im.ts)、[relay.ts](../src/integrations/relay.ts) | 持久交付、平台发送与外链对象 |
| [scripts/ops](../scripts/ops)、[scripts/deploy](../scripts/deploy) | 日常运维与部署事务 |
| [scripts/ops/tui](../scripts/ops/tui) | 全屏运维界面：渲染层、宿主机数据读取与操作转调 |

CI 配置了 Windows/Linux 检查及受限 Linux 镜像中的解析器与进程回收验证。部署验收还需检查目标机器的服务、入口和真实交付流程。

### Linux 任务隔离与物理回收

Linux 可配置每任务 rootless Docker 隔离：`BOT_TASK_IMAGE` 必须是本机已存在的完整 `sha256:` 镜像 ID；`BOT_TASK_CONTROL_ROOT` 指向用户 tmp 之外、管理端拥有的普通 0700 目录。daemon 必须通过当前身份拥有的本机 Unix socket 连接，并报告 rootless。管理端本身需要访问 Docker；工作进程不获得 socket、宿主 PID namespace 或管理回执。启用前停止旧实例并确认旧工作进程退出，管理端、原生 MCP 和其他宿主服务仍属于可信控制面。0700 本身不能隔离同一宿主身份的恶意进程。

bash、文档操作与解析在任务容器中运行。镜像需要预先具备 bash、Python 所需系统库、字体、LibreOffice 等实际使用的能力；环境准备是管理操作。容器禁止网络、使用只读根文件系统、移除 capabilities，限制为 128 个 PID、1 GiB 内存和 2 CPU；来源、资料索引和解释器环境只读，只有本任务 `work` 可写。`PI_USER_TMP` 指向本任务工作目录，其他已封存任务的产物通过只读快照读取。管理端签名登记的 results 任务也可在 codemode 仍执行时提供只读快照，供后续子调用读取；results 任务不允许启动容器。其他活动工作任务不进入快照。管理根即使被列入额外只读目录，也不向 read/write/edit 工具开放。导出的产物拒绝链接、FIFO 和其他特殊文件。超过输入限制或隔离依赖失败时调用报错。

管理端持久保存任务 ID、随机身份、daemon/镜像身份、挂载清单和阶段，确认容器及全部写者退出后才允许按登记 ID 回收。管理根的统一路径校验同时用于文件工具、文档加工与解析，在复制、哈希和命中解析缓存之前执行；workspace 内的管理目录及其符号链接别名也拒绝读取。未确认创建、状态损坏、命名实体替换、设备变化等情况保留目录与回执。仍被历史或待交付内容引用的产物不回收；完成回收的回执保留用于重复调用和重启恢复。旧共享目录无法证明父目录受保护、写者已退出时，在递归删除之前保留整个目录，并将逻辑过期和待物理回收分开记录。

删除 scratch 或任务目录前，管理端还会永久撤销已登记容器 ID，并向同一 daemon 确认该 ID 已不存在。客户端取消与一次“不运行”快照不能撤销 daemon 已受理的迟到启动。确认失败时保留整个工作目录和 stopping 回执；已登记的固定 ID 与未确认创建名称分别处理，未确认名称暂时不存在仍不能证明创建不会稍后完成。

初始化的并发调用复用同一次检查；失败只使当前尝试失效，后续调用可重新检查根目录、管理身份、daemon 和固定镜像，成功检查仍复用。任务分配在 allocating 阶段登记，成功后才交付 active 任务。失败状态及最后完成步骤进入签名回执，回收不会把未交付的失败任务当作 PID 存活的活跃任务；实体或归属标记证据不足仍保留并报告具体原因。失败回执暂时无法保存时汇总错误，同一后端在存储恢复后先补写失败检查点；真正 active 或尚在分配的任务继续受保护。

可选验收使用 `MIXIN_REAL_TASKS=1 MIXIN_TASK_TEST_IMAGE=sha256:<完整镜像 ID> bun run test tests/ops/real-rootless-tasks.test.ts`，仅在无真实服务的 Linux 测试环境运行，使用已有镜像和合成数据；不自动安装 Docker、拉取镜像或更改现有服务。

隔离文档环境使用镜像内预先锁定的 `/app/.venv/bin/python`，不会在宿主群环境按需安装依赖；现有 Dockerfile 会准备此环境及 Office 能力。管理端需要在本机 Linux 上以 rootless daemon 的身份运行；原生模式的 `BOT_DOCUMENT_ENV` 仍用于原生文档环境。成功文档任务在写者退出后回收 `.work`，产物与报告按引用/保留期稍后回收。可用现有文档集成入口加 `BOT_TASK_IMAGE`、独立 `BOT_TASK_CONTROL_ROOT` 和 `--root <合成目录>` 验证新模式。

常规测试里的 Docker 都是桩。真实 Docker 的部署和升级由可选测试 [real-docker.test.ts](../tests/ops/real-docker.test.ts) 验证，**只能在没有真实服务的 Linux 测试机**（WSL 发行版或虚拟机）上运行：`MIXIN_REAL_DOCKER=1 bun run test tests/ops/real-docker.test.ts`。测试用合成数据，只清理挂载源在其目录下的容器和本次测试项目的镜像，发现其他 `mixin-chatbot*` 容器时拒绝运行；失败或设置 `MIXIN_REAL_DOCKER_KEEP=1` 时保留现场。SELinux 强制模式尚未验证。

### 文档回归

真实文件回归使用单独的测试 venv，不修改群环境或启动机器人。项目根目录的 PowerShell 示例：

```powershell
$env:UV_PROJECT_ENVIRONMENT = (Join-Path $PWD 'tmp/document-validation/group/venv')
uv sync --locked --no-dev --no-install-project
if ($LASTEXITCODE -ne 0) { throw 'uv sync failed' }
bun scripts/runtime/document-manifest.ts . $env:UV_PROJECT_ENVIRONMENT
bun tests/helpers/document-work-integration.ts $env:UV_PROJECT_ENVIRONMENT --office
bun tests/helpers/document-office-integration.ts $env:UV_PROJECT_ENVIRONMENT
Remove-Item Env:UV_PROJECT_ENVIRONMENT
```

`--office` 要求可运行的 LibreOffice 并检查 Word/PPT 转 PDF；省略时仍验证 PDF 预览。产物和报告保留在 `tmp/document-validation/run-*` 供人工看图，自动检查不会声称已经看过图片。`document-office-integration.ts` 同样需要 LibreOffice，在长群根和哈希命名的群目录下渲染，并检查两名成员同时转换各用各的 profile、取消后 LibreOffice 进程退出且临时目录删除、之前的产物仍可经受控 read 读取；产物在 `tmp/document-validation/office-*`。

## 数据版本与升级

参见[数据版本与升级事务](data-migrations.md)。业务入口 `src/server/index.ts` 和 TUI 入口在加载配置前检查项目与群根的版本；历史迁移集中在 `scripts/migrations/`。升级在提交前仅启动验证实例，提交后恢复正常业务。
