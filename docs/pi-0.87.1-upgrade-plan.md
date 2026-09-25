# Pi 0.85.1 → 0.87.1 升级研判与任务清单

研判日期：2026-09-23。目标版本为当日官网和 npm 均已发布的 **0.87.1（2026-09-22）**；比较范围包含 0.86.0、0.86.1、0.87.0、0.87.1。基线是当前工作区，包括尚未提交的统计账本改动，不仅是 Git HEAD。[官方更新记录](https://pi.dev/news)、[0.87.1 发布页](https://github.com/earendil-works/pi/releases/tag/v0.87.1)。

建议升级，并把运行时收敛到单一新版 SDK，不维护 0.85/0.87 双版本分支。**先修缓存接线、用量归属和 SDK 契约，再接新能力。** 当前架构已经大量使用官方 SessionManager、模型运行时、工具工厂、自动压缩和重试；全面重写的收益不足以抵消交付、取消、进程回收等既有行为的回归风险。可以拆分接线层，但不必更换会话存储或把整个机器人改成 Pi CLI/RPC。

实施更新：主项目依赖和源码已升级至 0.87.1，缓存配置采用断兼容设计，迁移工具已完成，配置迁移已纳入升级事务；[数据版本与升级流程](data-migrations.md)。部署数据和服务未迁移，需在部署端执行升级。[迁移步骤与设置示例](pi-0.87.1-migration.md)。当前机器没有 `data/runtime/pi/settings.json` 或 `data/config/runtime.json`，因此没有核验实际部署的模型、凭据及历史；下述模型相关收益均按部署选型决定。

**研判阶段验证记录（实施前基线）**

| 检查 | 结果与适用范围 |
| --- | --- |
| 原工作区 0.85.1 `bun run typecheck` | 通过 |
| 当前源码副本只升级两个 Pi 包至 0.87.1 | 类型错误集中在 3 处测试源码；生产源码没有类型报错 |
| 首轮相关测试 | 40 项中 38 通过、2 失败；失败为旧提示词读取方式及重试配置的精确断言 |
| 仅在副本修正上述 3 处测试 | typecheck 通过；SDK、选型、进度、runtime 生命周期及配置向导共 50 项测试通过 |
| 真实 0.85.1 SDK 生成的合成 JSONL，在 0.87.1 中续聊 | 旧消息可见，session ID 保留，头部仍为 v3 |
| 官方 `appendContextEdit` + `refreshContext` | 可从上下文省略消息，原始条目仍在，SDK token/cost 统计不变 |
| 缓存补丁探针 | `none` 实际传给 provider；补丁前、保温器看到的参数仍算出 short TTL=300000ms。验证的是策略不一致，没有等待或发送真实保温请求 |
| 用量归属探针 | `usage` 自带 warm-provider/warm-model，却被当前账本记到此前的 main-provider/main-model；总费用仍入账，模型维度错误 |
| 迁移准备工具 | 7 项合成数据验证通过：只读预览、原样备份、幂等、缓存冲突阻断、服务锁、损坏历史、已移除模型 |

最初探测的证据在 `tmp/pi087/`：`typecheck-087.txt`、`tests-087.txt`、`typecheck-adapted.txt`、`tests-adapted.txt`、`behavior-results.txt`、`migration-tests.txt`。隔离项目在 `tmp/pi087/probe/`，其中测试适配不等于主项目已经修改。测试使用 Bun 1.4.2 / Windows、faux provider 和本地模拟接口；隔离安装使用 `--ignore-scripts`。该探测阶段没有运行完整 `bun run check`、Linux/Docker 构建、生产模型调用或群内端到端交付；后续源码实施和完整检查结果见“实施补充”。

**破坏性变化及本项目命中情况**

| 上游变化 | 代码证据与研判 | 处置 |
| --- | --- | --- |
| provider-facing `Context` → `TranscriptContext`；system/tools 进入消息序列 | `tests/agent/sdk.test.ts:116` 仍读 `context.systemPrompt`，实际变成空字符串。生产代码通过 ModelRuntime 调用，没有自写 provider stream | 用 `getCurrentSystemPrompt(context.messages)`；需要工具声明时用 `getCurrentTools()`。不要机械改掉仍受支持的调用方 `Context` 入参 |
| `ToolCall.arguments` / `ToolResultMessage.details` 收紧为 JSON 值，数组 readonly | `tests/agent/model-progress.test.ts:165` 对联合类型的嵌套属性直接写入不再通过 TS。现有生产工具未出现类型错误 | 测试保留具体可变对象引用，再传给 ToolCall；保留进度监测对原地变更的验证。工具详情避免 Date/Map/Error 实例及循环对象，禁止用全局 `any` 掩盖问题 |
| `getRetrySettings()` 新增 `maxAgentDelayMs` | `tests/core/model-config.test.ts:50` 精确相等断言失败；新默认值实测为 60000ms。`src/core/model-config.ts:23` 的固定策略尚未显式约束它 | 明确摘要重试最大等待策略；建议显式 5000ms，与现有 provider 上限协调，并测试取消/总任务期限。探针为验证兼容性接受了 60000 默认值，正式实现应按最终策略改断言 |
| SessionManager 成为最终 provider context 的权威来源 | `src/agent/runtime.ts:172` 已用 `SessionManager.open`，没有写 `agent.state.messages` 或 `replaceMessages` | 无直接调用迁移；补真实恢复/压缩/失败重试契约测试，以后所有持久上下文编辑走官方 entry API |
| `SessionEntry` 增加 `context_edit`，并有 system 消息、usage 条目、compaction system checkpoint | 当前统计扫描器只投影需要的字段，不做穷尽 switch，未知记录不会直接崩溃；`usage` 的模型归属有实际缺陷 | 原始历史与模型上下文分开处理。账本忽略 context_edit 的上下文效果，保留真实消耗；修正 usage 的 provider/model 来源 |
| 删除 `shouldStopAfterTurn`，改用 `finishTurn` | 全项目未使用该接口 | 当前无迁移任务。以后使用时须处理 error/aborted 硬退出，不把普通结束逻辑套在它们上面 |
| extension `TurnEndEvent` 新边界字段、`agent_before_settle`、`emitBoundary`，settled 回调延后触发新运行 | 当前没有自定义 extension runner/事件构造，且关闭文件扩展发现。`session.subscribe` 中读取 `turn_end` 仅用于暂停计时 | 当前无直接迁移。不要把 extension 事件的变化误套到 host 订阅事件上；启用内联扩展时再按新契约接线 |
| `user_bash` handler fail-closed | 当前使用 bash **tool** 工厂的 operations，不注册 `user_bash` 交互事件 | 不命中；不能因此删掉本项目的子进程管理 |
| 移除 OpenAI Codex 目录的 GPT-5.4 / GPT-5.4 mini | 部署选型未知；`resolveModelSelection` 已在模型不存在时失败 | 迁移预检提示重新选型，不静默换模型。xAI 默认变化也不会覆盖项目显式保存的 defaultModel |

依据：[pi-ai 版本日志](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/CHANGELOG.md)、[agent-core 版本日志](https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/CHANGELOG.md)、[coding-agent 版本日志](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/CHANGELOG.md)。`maxAgentDelayMs` 另核对了安装包的 `settings-manager.js`。

**值得采用的新能力**

| 能力 | 对本项目的收益 | 采用条件 |
| --- | --- | --- |
| 官方缓存保温 `cacheWarming` | 长时间文档解析、渲染等工具运行期间，可能降低后续请求的缓存重建成本 | P0 先显式关闭；修好缓存参数与统计后再试 `streaming`。只有模型声明对应 `promptCache` 寿命且经济判断通过才会刷新；Coding Plan 的估算价格不能当实际额度收益 |
| `compaction.modelOverrides` | 大文档工具输出与不同上下文窗口，可用不同 reserveTokens / keepRecentTokens，无需自己做压缩预算分派 | 用原生 settings 维护，测超长文档、溢出恢复和重启；不先拍脑袋写一套所有模型共用的预算 |
| `inputLimits.images.resize` | 按视觉模型限制处理 PDF/PPT 渲染页与 read 图片，减少超限和重复编码 | 现有 read 包装仍调用官方工厂，可承接 ctx.model 的限制。配置向导应保留原生字段，不能把任意中转站视为和原厂同能力 |
| transcript 持久化 system/tool 变更 | 模块、提示词升级后，恢复历史能记录新的工具和指令状态 | 当前固定提示词无需额外自实现；若以后热切换模块，走 SDK 原生机制并测 resume/compaction，继续禁止加载群目录扩展和设置 |
| `context_edit` | 将过期文件路径、巨量旧工具输出替换成短摘要或省略，保留审计与费用 | 第二阶段再做明确的上下文清理策略；优先替换工具结果内容，验证 tool-call/result 配对。它不会删除落盘内容，也不是隐私删除功能 |
| `agent_before_settle` / 可返回结果的 `turn_end` | 将来可在文档未验证时要求一次后续检查；无需再包一层自己的 Agent 循环 | 有具体产品需求再接内联扩展，不改变 host 的一次请求/一次最终交付边界 |
| 新模型目录、provider 修复 | 新增 GPT-6 Sol/Luna、Opus 5.5 等；ZAI 溢出识别、未知兼容端点 strict schema、Claude 中转思考重放等修复对对应部署有价值 | 沿用 ModelRuntime 选型与配置校验；实际选择由管理员决定，不硬编码一份模型表 |

依据：[官方 settings](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/settings.md)、[模型输入与缓存元数据](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/models.md)、[会话格式](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/session-format.md)、[SDK](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/sdk.md)、[扩展边界](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/extensions.md)。

Meta OAuth 暂不安排：项目刻意用 models.json + 内存凭据存储，新增登录流程会扩展凭据持久化和运维范围。Fireworks 的原生 deferred tool loading 只在改用对应 provider 且工具数量确有需要时考虑；不能当成所有模型都新增了统一工具搜索。`ctx.modelRegistry.stream/streamSimple` 适用于未来扩展内部的辅助调用，目前生产代码已用 ModelRuntime，没有一套手写鉴权可删。Pi 的 CLI 编译缓存、剪贴板、终端滚动、`/bug` 不直接替代项目的 Bun 服务、运维 TUI 或群聊命令；不新增面向群成员的日志上传命令。

**哪些自实现可以删，哪些应保留**

| 现有代码 | 结论 | 原因 |
| --- | --- | --- |
| `local-tools.ts:31` 的 `asSdkTool` strict-prefer 包装 | 可删这层重复配置 | 0.86 起官方 read/bash/edit/write 工厂默认带 strict-prefer。自定义 send/document 工具的独立约束不在此删除范围 |
| `model-cache.ts` 对 `runtime.streamSimple` 的 monkey patch | 必须收敛，不能和保温默认开启直接组合 | SDK 先把原 options 交给 CacheWarmer，再调用被覆写的 streamSimple。保温不会看到后来补的 long/none/short；保温本身也不等于 retention 的替代品 |
| 模型目录、鉴权、压缩、重试、基础文件工具 | 已主要采用官方实现 | 不新增第二套 registry、压缩器、retry loop；使用官方修复与原生配置即可 |
| SessionQueue、IM 限流、DeliveryStore、外链账本 | 保留 | 负责群/用户 FIFO、取消、/clear 隔离、持久补发及真正交付，官方 steering/follow-up 队列不覆盖这些事务 |
| ModelProgress 与模型/任务期限 | 保留 | SDK 事件不等于“有效进展”监控；空白增量、参数原地变化、模型单次期限和 IM 最终发送有本项目语义 |
| AllowedPathGuard、进程监督、bash 大输出迁移 | 保留 | 群 workspace 只读、用户 tmp 隔离、Windows Job Object/Linux subreaper、命令结束回收后代不是官方工厂的等价保证 |
| session-reader、stats-ledger | 保留并修正投影 | 官方 getSessionStats 可作单会话校验基准，不能替代跨群、按日、保留已归档/已删除原件世代的业务账本 |
| 文档解析缓存、资料索引、Office 工具、运维 TUI | 保留 | 上游本次没有提供等价业务能力；图片缩放只替代模型输入编码工作，不替代 Office 解析/渲染/IM 图片交付 |

**实施补充**

实施验证：Windows / Bun 1.4.2 的完整 `bun run check` 通过，包含 TypeScript 与两种 Knip；升级事务复核修正后的最终结果为 599 pass、4 个 Linux 专属 skip、0 fail，日志为 `tmp/pi087/full-check-migration-review.txt`。迁移和部署专项共 30 项测试通过，Windows 升级测试覆盖 28 种运行状态与失败组合；四个关键回归先在修复前确认失败，再验证修正。三处修改的 Bash 脚本语法检查、全部 PowerShell 脚本语法和 UTF-8 BOM 检查通过。Windows 进程身份测试需要 CIM 访问，已在获准的沙箱外检查中通过。此前在新目录执行 `bun install --frozen-lockfile` 成功；旧配置迁移工具的 14 项合成检查及账目修复检查亦已通过。`tmp/pi087/tool-fixtures*` 残留已清理。本机没有 Docker，未执行真实容器构建或服务商/群聊验收；受限容器迁移验证已纳入 CI，部署待办仍保留。

- 两个直接依赖与 pi-agent-core/pi-tui/pi-telemetry/chord 均锁为 0.87.1；新增目录的 frozen-lockfile 安装通过，没有使用 --ignore-scripts。
- 缓存统一使用原生 PI_CACHE_RETENTION，保温默认 off。Pi abort 不取消 idle 保温，host 通过官方 API 取消当前保温并恢复下次请求策略；会话设置已隔离，避免影响其他用户。
- 独立 usage 按自带 provider/model 入账，不污染对话选型；context_edit 不减历史费用。离线修复保留缺原件账目、游标和总费用。
- runtime 拆分为 session-factory、session-events、session-control，SessionQueue 仍是唯一任务所有者；移除重复 strict 包装。
- 真实 SDK 合成测试覆盖 0.85.1 恢复、原生压缩、system/tool 更新、error/length 持久省略、保温 TTL、实际模拟刷新及取消、原生重试取消、图片缩放和非视觉提示。
- review 修正：统计账本改为每次任务结束后在该成员队列内入账；续读、首次入账和整份重建在提交前都核对该文件的账本记录未被改动，消除并发时的重复累加以及较旧读取覆盖新账、游标和归档标记。stat/TUI 用只读连接和只读版本检查，不建库、不改日志模式。迁移工具在群根不存在时阻断，只接受部署项目已安装的 proper-lockfile，并补充 Docker 容器内运行方式；repair-usage 改为只校验并重算已入账前缀，不再要求先扫账。
- 文件替换竞态修正：身份、摘要及内容读取共用文件句柄，读取期间变化则重试；未变化的原件不再写库，普通入账与重算保留归档标记。子进程回归覆盖路径检查后替换、句柄检查后替换、活跃和已归档会话，以及读取期间追加；旧实现已确认在首个场景失败。
- 兜底扫描重试修正：文件与目录错误逐项隔离并记录失败数，有失败不标记当天完成；成功文件指纹持久保存在现有 meta 中，同日重试和重启后跳过未变化原件，跨日或强制扫描重新读取。回归覆盖持续 EACCES、后续文件与群、进程重启、权限恢复、成功文件追加及强制扫描失败；旧实现已确认遇到第一个 EACCES 就中断。
- 新版 edit/write 会先为变更队列 realpath；路径差分测试改用子进程临时 home。完整检查还发现文档环境缓存的时间戳精度和失效证明复用问题，已修正为纳秒指纹及观察到变化即丢弃旧校验。

2026-09-25 运维补充：修复 PS5.1 的 `File.Replace` 空参数绑定；PS7 入口显式使用系统 PS5.1 子进程。升级、部署、迁移与早期启动失败写入有容量限制并脱敏的 `logs/operations/`，回滚保留诊断。旧升级器的导出清单可直接启动新预览，Docker 迁移共用宿主日志目录。真实 PS5.1 连续保存快照先在旧逻辑复现失败，再通过修复。专项 37 项通过，完整 `bun run check` 为 606 pass、4 个 Linux 专属 skip、0 fail，TypeScript 与两轮 Knip 通过；日志在 `tmp/pi087/full-check-operation-logs.txt`。本机未运行真实 Docker 构建。

**执行任务（按依赖顺序）**

- [x] **P0-1：统一升级与冻结依赖。** 修改 package.json 两个直接依赖到 0.87.1，重新生成 bun.lock，核对 pi-agent-core/pi-tui/pi-telemetry/chord 解析版本一致；更新 `docs/development.md` 和测试中版本标签。验收：干净安装与 typecheck 通过；正式构建允许并验证必要安装脚本，不能把本次 `--ignore-scripts` 当生产安装验证。
- [x] **P0-2：更新 SDK 契约及重试上限。** 修改前表列出的 3 个测试位置；在 `AGENT_SETTINGS.retry` 明确 maxAgentDelayMs；检查工具 details 的 JSON 边界。验收：真实 faux provider 测试能读取 system/tools；部分参数原地变化仍算有效进展；摘要重试等待/取消遵守最终策略。
- [x] **P0-3：解决缓存参数与保温分歧。** `openSettings` 对未配置的 warming 显式设 off；写入全局只读快照，不能只用会被 reload 清掉的 applyOverrides。保留 override 时，非 auto 与启用 warming 的冲突必须在启动预检报错或采用明确的一致接线。验收：auto/short/long/none × off/streaming/idle 的支持矩阵明确；不能出现 provider=none 而 warmer 按 short 调度；/stop、dispose 后无保温请求。
- [x] **P0-4：修正 usage 的模型归属。** `StatsRecord/project` 保留顶层 `model`；usage 桶使用该条自己的 provider/model，不沿用上一条 assistant/model_change，也不要让独立 usage 改变后续对话的选型状态。缺字段要标 unknown/异常，保留任意 kind。验收：跨 provider、只有 usage 的文件、未知 kind、跨日和增量续读均归属正确；提问/回复数不因保温增加；context_edit 不冲减已发生用量。
- [x] **P0-5：补会话兼容契约。** 用 0.85.1 fixture 测恢复、压缩、system/tool 更新、错误/长度恢复后持久 context_edit、重启后 provider 实际可见消息；接着做取消与最终交付回归。验收：不恢复已被官方省略的失败尝试，不丢工具定义，session ID 与原始历史保留。
- [ ] **P0-6：停机迁移与发布验收。** 通过升级事务迁移配置并保留数据快照。Windows 和 Linux/Docker 执行完整 `bun run check` 及安装/打包检查，部署端验证 doctor、普通回复、文档工具、附件/外链、/stop、/clear、/deliver、重启续聊。验收：无静默换模型；降级只从升级前配套快照恢复；新部署未配置 warming 也不会意外打开后台消费。
- [x] **P1-1：移除基础工具重复 strict 包装。** 删除 `asSdkTool` 的重复设置，保留 `defineTool` 所需类型边界与自定义工具声明。验收：官方四工具仍有 strict-prefer，未知 OpenAI-compatible 网关不会被强迫接受不支持的 strict schema，路径/取消测试照常通过。
- [x] **P1-2：决定并执行缓存配置断兼容。** 长期建议删除 BOT_MODEL_CACHE_RETENTION 和 streamSimple monkey patch，采用 SDK 原生默认；明确需要 long 的部署可使用官方 PI_CACHE_RETENTION=long，让保温和 provider 读取同一配置。该环境变量不能等价表达 none，不能把 none 误迁成 warming=off；有此要求的部署必须先决定放弃旧语义，或保留一条经过完整测试、且关闭 warming 的适配路径。验收：无未经说明的策略变化；先扩展一次性迁移工具，再删运行时旧字段。已删除旧运行时字段及补丁；离线工具转换 auto/short/long，none 与冲突需显式 --accept-native-cache。
- [ ] **P1-3：小范围试用官方保温及分模型预算。** P0-3/P0-4 完成后，以原生 `cacheWarming=streaming` 在适用 provider 试运行；暴露 warming 状态和独立费用种类，记录是否实际节省。按选中模型设置 `compaction.modelOverrides`，保留普通设置兜底。验收：长工具任务、未知价格/寿命、Coding Plan、保温失败、缓存过期均不影响用户任务；idle 不作为默认。
- [x] **P1-4：视觉输入参数接入与保留。** 在 models.json 使用 `inputLimits.images.resize`；向导重跑不丢 `inputLimits`/`promptCache`/modelOverrides，不给未验证代理盲目复制寿命/能力。验收：大图、中文文档页、非视觉模型、切换模型后历史图片不重编码；原有只读路径边界保持。
- [x] **P1-5：按职责拆 runtime 接线。** 可以把会话创建、SDK 事件→进度、单任务执行/交付拆成小模块；SessionManager 管上下文，host 管群任务和持久交付。验收：继续保有单一队列所有权；不新增平行的 Agent 循环、状态镜像或通用 provider 适配框架。
- [ ] **P2-1：有收益再做 context_edit 清理。** 明确哪些旧工具结果可压缩、何时保留完整上下文，使用官方 append-only edits；清理策略要在 resume 后一致且不破坏工具调用配对。验收：减少 provider 上下文，原件历史与费用不变。
- [ ] **P2-2：按具体需求采用生命周期扩展。** 需要文档收尾检查、模块热切换或辅助模型调用时，用项目自带的 inline extensionFactories 接线；继续关闭不可信文件扩展发现。验收：continue 至多满足一次后续请求，不重入最终交付，不产生无限自续跑；辅助调用的 usage 也须有明确入账方式。

以上勾选表示源码和离线验证已完成；P0-6 的跨平台发布与现场交付验收仍待部署端执行。P1-3 的配置支持、费用日志和本地模拟保温已实现，真实服务商成本试运行由管理员选择。P2 两项按原计划保持条件性暂缓，未加入自动上下文删减或自续跑。P1 可分开实施；P2 不作为升级的前置条件。`PI_CACHE_RETENTION` 行为已核对 [provider adapter](https://github.com/earendil-works/pi/blob/v0.87.1/packages/ai/src/api/openai-responses.ts) 与 [CacheWarmer](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/src/core/cache-warmer.ts)；不存在可以直接替代所有 BOT retention 语义的全局 settings.cacheRetention。

**迁移设计与工具**

常规升级使用已纳入仓库和镜像的 `scripts/migrations/`，详见[数据版本与升级事务](data-migrations.md)。代码实现清单：

- [x] 项目和群根独立登记数据版本与事务号，缺失仅表示尚未登记。
- [x] 服务与 TUI 使用轻量入口，在导入运行配置前检查版本；未迁移数据可进入升级 / 诊断菜单。
- [x] v1 迁移幂等执行，旧缓存和模型冲突在迁移写入前明确选择，最终调用当前业务校验器。
- [x] 统一执行器持有服务租约，按清单备份配置、版本和 SQLite 及其 sidecar；校验备份后恢复。
- [x] 新实例使用验证模式，不接消息、不跑维护；先发布群根版本，最后提交项目版本。
- [x] 提交阶段写入持久回执，单独恢复群根只触发重新校验登记，不能回滚旧数据库；同版本升级保留版本标记且不复制 SQLite。
- [x] 提交后忽略残留验证标志，默认健康检查拒绝只验证实例；预览只用配置副本和群根只读接口，Windows 清理本次升级导出目录。
- [x] Docker 使用目标镜像和服务 UID；Windows 使用目标提交的新进程。中断续做保留原快照、目标提交和运行状态。
- [x] 升级确认旧实例停止后才切换代码、安装依赖或构建镜像；同版本且标记配对时跳过迁移步骤和数据库备份，保留配置及新实例校验。
- [x] 迁移与部署的回归测试纳入常规检查，镜像包含迁移目录；受限容器验证纳入 CI。

历史一次性工具仍在被 Git 忽略的 `tmp/pi087`，需要单独使用时携带，说明见[迁移说明](pi-0.87.1-migration.md)：

- migrate.ts：默认预览；转换 runtime.json 的旧缓存字段、给未设置的 cacheWarming 写 off；--apply 获取服务租约，先逐字节备份再原子发布，失败回滚已发布配置。
- repair-usage.ts：默认预览；核验已入账原件并定向重算 usage 归属，按日/kind 核对 token、次数和费用，不删整库，保留原件缺失的世代。--archives 支持显式归档映射。
- test-migration.ts / test-repair-usage.ts：合成数据验证。所有模拟文件与 probe 均不含部署凭据。

无需改写 v3 JSONL；新版新增条目只能向前恢复。同为 v3 不允许原地降级，完整回退必须恢复升级前配套代码、锁文件、配置和数据快照。旧 none 不等价于 warming=off，迁移工具不会静默替换模型或禁用缓存语义。
