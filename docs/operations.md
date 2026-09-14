# 运维手册

[README](../README.md) 讲怎么把服务跑起来、日常用哪个界面；这里放出事才需要翻的内容：排查、取证、数据维护和磁盘策略。

**排查**：[长时间没有回复](#长时间没有回复) · [按任务编号提取日志](#按任务编号提取日志) · [HTTP 拒绝日志](#http-拒绝日志)

**维护**：[重新配置模型](#重新配置模型) · [数据维护](#数据维护) · [回调路由恢复](#回调路由恢复) · [磁盘保留](#磁盘保留) · [隧道托管](#隧道托管)

## 长时间没有回复

“消息发送成功（处理中提示）”只表示发送了“正在处理”，最终回答需要看到“回复发送完成”或“任务完成”。`/status` 显示任务编号、当前阶段、已用时间、最近进展距今和时限；服务器每 60 秒输出一次仍在运行的任务摘要，每个模型响应结束时输出“模型流结束”。流日志只记录统计和响应标识，不记录模型输出、思考正文或工具参数。

1. 在异常群发送 `/status`，记下任务编号。用[日常控制](../README.md#日常控制)里的 `logs` 入口查看日志，或在 PowerShell 执行 `Get-Content logs/mixin-chatbot.log -Tail 200`，按任务编号、群号定位。
2. “模型调用准备”涵盖 Pi 的校验与历史检查；“等待模型响应”表示进入模型轮次；“接收模型输出”表示 SDK 正在收到流事件；“压缩会话历史”表示正在压缩该群该用户的历史。工具执行和最终发送也分别记录。
3. 只有某个群异常时，发送 `/stop`，等待 `/status` 变为空闲，再发 `/clear`。收到归档确认后，用“只回复 OK”测试。`/clear` 归档当前用户在本群的会话，不清除群资料。若恢复，旧会话上下文是重要线索；若仍失败，保留这一轮阶段日志继续检查 Pi 请求与模型服务。
4. 普通 HTTP 流探测成功只验证该次请求，不能验证机器人的完整历史、工具定义、思考模式和压缩请求。`doctor`/健康检查也不能证明模型回答正常。

### 深入排查：模型超时、进展判定与日志字段

模型等待或输出期间，默认连续 180 秒无有效进展就主动取消；计时从每个模型轮次开始，包含首个内容到达前的等待。正文、思考增量中的非空白字符会刷新进展时间；工具参数则比较 SDK 解析后的参数 JSON，仅在参数发生变化时刷新。原始工具参数增量再多，只要解析结果不变，就不算进展。空增量、纯空白正文/思考、块开始/结束、工具名称/调用 ID 和初始空参数对象也不续期。“最近进展距今”在接收模型输出时随上述进展刷新。

解析参数最多每秒采样一次，模型响应结束或准备因无进展取消时补查尚未采样的变化；只保留摘要用于比较，不把参数内容写入运行日志，也不提前执行尚未结束的工具调用。每个工具分别比较，再合并为本次响应的进展。采样比较不等于判断语义有用性：反复改写参数或重复输出正文仍可能续期，因此另设**单次模型响应 600 秒上限**，持续有进展也不能延长。

这两种模型时限都只在等待模型或接收输出时生效；工具执行、历史压缩、重试等待和最终发送期间暂停，下个模型轮次重新计时。检测随流事件及每秒定时检查触发。

任务摘要中的 `模型流` 按当前模型响应累计，`response` 标识本任务的第几个模型响应：

| 字段 | 含义 |
|---|---|
| `events` / `lastEvent` | SDK 流事件类型与数量（含 assistant 的 `message_start`、`message_end`），不是原始网络包 |
| `emptyDeltas` / `whitespaceDeltas` | 空字符串 / 仅空白的增量数量 |
| `textChars` / `thinkingChars` / `toolArgsChars` | 已收到的正文 / 思考 / 工具参数增量字符量，包含空白，按 UTF-16 计数 |
| `effectiveChars` | 上述原始增量中非空白字符的累计量，保留用于诊断；工具参数部分的增长不再用于刷新无进展时限 |
| `parsedToolArgsChars` | 最近采样的所有工具参数 JSON 长度之和（UTF-16，含 JSON 语法字符），可增可减，与原始增量累计量不同 |
| `toolArgsChanges` / `toolArgsLastChangeSecondsAgo` | 所有工具的已观察参数变化次数之和 / 距最后一次参数变化的秒数；从未观察到变化时为 `null` |
| `toolCalls` / `tools` | 已观察工具调用数 / 前 8 个工具的名称、内容块序号、解析参数长度、变化次数及距变化的时间；进展检测覆盖全部调用 |
| `active` / `elapsedSeconds` / `idleSeconds` / `lastEventSecondsAgo` | 检测是否启用 / 本轮次开始至今的秒数 / 距上述有效进展或轮次开始的秒数 / 距流事件的秒数；暂停后时长冻结 |
| `responseId` / `stopReason` / `rawStopReason` | 上游响应标识 / SDK 结束原因 / 上游原始结束原因；未提供时为 `null` |

事件持续增加但 `effectiveChars` 不增长时，说明仍收到事件却没有新的非空白增量。若 `toolArgsChars` 持续增长，而 `parsedToolArgsChars` 很小、`toolArgsChanges` 不再增加、`toolArgsLastChangeSecondsAgo` 持续变大，则原始工具参数流没有推动可观察的解析结果变化。只看参数长度不能判断内容是否改变，需结合变化次数。`rawStopReason=null` 只表示未观察到上游结束原因；取消后 `stopReason=aborted` 是本地取消结果，需结合取消前记录判断。日志另记 `取消原因`，区分 `model_idle`、`model_response_timeout`、`task_timeout`、`user_cancel`、`shutdown`。这些信息本身不能确定故障在上游服务还是 SDK。

整轮时限仍为 1200 秒，覆盖准备、模型、工具和交付，三种时限以先到者为准。可通过 `data/config/runtime.json` 或环境变量设置 `BOT_MODEL_IDLE_TIMEOUT_SECONDS` 和 `BOT_MODEL_RESPONSE_TIMEOUT_SECONDS`，重启生效；无可见增量的长思考模型、耗时较长的正常生成可按实测调整。超时后仍需等待 SDK 取消清理完毕，再执行同一用户的下一条消息，因此最终报错耗时可能超过阈值。上游只返回 `The operation timed out.` 时不直接断言网络不通。若日志已到“等待取消清理”却长期不结束，先保存日志，再用运维 `restart` 恢复实例。

## 按任务编号提取日志

将群内报错或 `/status` 中的任务编号传给脚本即可。在项目根目录运行：

Windows PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/task-logs.ps1 555d838a
```

Linux（在部署主机上运行，支持 Docker 部署，无需主机安装 Bun）：

```sh
bash scripts/ops/task-logs.sh 555d838a
```

脚本读取项目 `logs/mixin-chatbot.log` 及数字后缀的轮转日志，按旧到新提取完整的 8 位任务编号。
默认附带前后各 3 行，跨轮转文件保留上下文，重叠行只输出一次。每次运行在
`tmp/task-logs-<任务ID>-<时间>-<随机后缀>/` 下新建：

- `task.log`：仅任务匹配行，附原文件名和行号。
- `context.log`：任务行及前后文；`--` 表示中间省略了其他日志。
- `summary.txt`：扫描范围、匹配数量、首次匹配前最近的模型就绪信息、首末记录、最后运行心跳、三种超时记录及最后的模型流结束统计。

可选参数：Windows 用 `-Context 5 -LogDir "D:\saved-logs"`；Linux 用
`--context 5 --log-dir /path/to/saved-logs`。上下文范围为 0–100 行，日志目录默认相对脚本定位项目，
显式指定的相对日志目录则相对当前工作目录。从其他目录调用脚本时，结果仍保存到脚本所属项目的 `tmp/`。

脚本可在服务运行或停止时执行，保留源日志和之前的提取结果，不读取模型凭据配置。
Linux 使用 Bash、awk 和 GNU coreutils；Windows 支持 PowerShell 5.1+。
退出码 `0` 表示找到任务，`2` 表示没有匹配日志，`1` 表示参数或读写失败。正在运行的任务可能继续写日志，
已轮转覆盖的历史无法从当前日志恢复。日志保留原文，前后文可能包含其他任务，分享前请脱敏。

## 数据维护

以下命令在安装了 Bun 的项目根目录运行；将尖括号占位内容替换为实际值。

```sh
bun run stat
bun run history list
bun run tmp list
bun run relay list
bun run routes list

# 写操作前先停止服务
bun run history clear "<群号>"
bun run tmp purge --days 7
bun run tmp purge --days 30 --group "<群号>" --user "<手机号>"
bun run relay purge "<关键字>"
```

`stat` 只统计尚未归档的 Pi 历史，区分模型轮次和成功资料工具结果；链接生成不等于用户收到。维护写操作与服务通过 proper-lockfile 租约互斥，异常退出后约 35 秒可恢复陈旧锁。运维包装器的 `history-clear` 会自动停机并恢复原运行状态，其他写操作先 `stop`，完成后按需 `start`。

## 回调路由恢复

1. 在平台修正 key 与群的对应关系，每个群使用独立 key。
2. 使用 `stop` 停止机器人，再执行下面的查看与重绑命令。
3. 确认绑定后 `start`；若平台仍跨群复用 key，会再次隔离。

```sh
bun run routes list
bun run routes reset "<指纹>" --group "<目标群号>"

# 已废弃的 key：移除绑定并释放容量
bun run routes forget "<指纹>"
```

指纹支持日志中的 12 位前缀；有歧义时使用 `list` 输出的完整值，无需输入 callback 密钥。普通绑定闲置 24 小时后可回收；冲突绑定不会因重启或 TTL 自动解除，仍计入 1000 条总容量。`forget` 后，该 key 再次入站将建立新绑定。

Linux 主机没有 Bun 时，用运维包装器执行同一个 CLI：

```sh
bash scripts/ops/ops.sh routes list
bash scripts/ops/ops.sh routes reset "<指纹>" --group "<目标群号>"
bash scripts/ops/ops.sh routes forget "<指纹>"
```

容器在运行就 `docker exec` 进去，否则用已构建镜像起一次性容器，以 `data/` 的属主运行并按部署时记录的群数据根挂载。写操作仍受维护租约限制，机器人运行时会被拒绝，因此 `reset`/`forget` 之前照样要先 `stop`。

Windows 包装器使用 PowerShell 原生参数：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/ops.ps1 routes list
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/ops.ps1 routes reset -Fingerprint "<指纹>" -Group "<目标群号>"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/ops.ps1 routes forget -Fingerprint "<指纹>"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/ops.ps1 tmp-purge -Days 30 -Group "<群号>" -User "<手机号>"
```

## HTTP 拒绝日志

错误或缺失 webhook 密钥、未知路由、管理 token 错误对外保持相同的 `404 / Not Found`。已通过密钥校验的请求保留实际的校验或运行状态码。

### 日志分类、计数与脱敏规则

| 日志分类 | 含义 | 原因标签示例 |
|---|---|---|
| `suspected_probe` | 疑似探测，也可能是调用地址配置错误，需结合 IP、频率与路径判断 | `webhook_secret_mismatch`、`webhook_secret_missing`、`route_not_found` |
| `request_validation` | 请求格式、大小或字段校验拒绝，不直接认定为扫描 | `invalid_request`、`payload_too_large`、`unsupported_media_type` |
| `runtime_protection` | 停机、容量或 callback 路由保护，不计入疑似探测 | `service_stopping`、`callback_route_capacity`、`callback_route_conflict`、`request_capacity` |

每个应用实例的每个 60 秒窗口、每类最多输出 10 条 WARN 明细，其余只计数。窗口从第一条拒绝开始；窗口结束即使没有新请求也会输出 `拒绝请求汇总`，包含该类总数、已记录数、已抑制数和原因计数。窗口结束后恢复明细配额；服务开始关闭时提前输出当前汇总。空窗口不写日志，正常 `/health` 不写拒绝日志。

同类的原因共享明细配额：普通路径扫描可能占满 `suspected_probe` 的配额，使随后错误密钥请求的 IP 和路径明细被抑制，但其数量仍计入汇总的 `webhook_secret_mismatch`。当前不为猜密钥单独预留明细配额。即使“已抑制”为 0，也保留有请求窗口的汇总，以便统一按汇总统计总量；因此零星拒绝会产生一条明细和一条汇总。未提供具体原因的 409/5xx 使用 `runtime_rejected`，归入 `runtime_protection`。

统计请求量应使用汇总的“总数”（已经包含明细），不要再叠加明细行；实时排查可先看尚未汇总的明细。汇总只保留固定分类与原因的计数，不按 IP 或路径建表，因此换 IP 也不能绕过日志配额。进程强制退出时，尚未汇总的计数可能丢失。已有业务日志仍按原逻辑输出；日志限速不代表请求限流，也不改变响应状态。

明细包含 IP、方法、脱敏路径和状态码；不记录查询参数、请求体、Authorization 或错误消息中的外部字段。`/webhook/` 后的路径全部隐藏。IP 沿用 X-Forwarded-For 第一跳、X-Real-IP 回退的提取规则，仅作为排查线索，不作为可信鉴权依据。代理层直接拦截的请求不会出现在应用日志里。

## 磁盘保留

| 内容 | 保留策略 |
|---|---|
| 配置、SQLite 状态库、群资料 | 持久保存，纳入停机备份 |
| Pi 设置与模型目录缓存 | `data/runtime/pi/settings.json` 与 `data/runtime/models-store.json` 随配置备份；动态目录服务商需缓存才能离线启动 |
| 会话、用户 tmp | 清理时归档到 `backup/rm`，下次部署、升级或连接器安装成功后清空 |
| 部署备份 | 成功后删除本次 `backup/snapshots` 快照并清空整个 `backup/rm`；失败时保留 |
| 历史账本迁移备份 | 按当时工具的保留规则处理，确认数据转换及新实例验收完成后再清理 |
| 测试与诊断现场 | 放在顶层 `tmp/`，确认没有测试、诊断或维护任务使用后可清理 |
| TUI 统计报表 | 每次导出独立保存在 `backup/reports`，按需保留或手动清理 |
| 上传快照 | 完成、失败或取消后直接删除 |
| 应用日志 | 约 5 MiB 轮转，当前文件加 3 份备份，最旧备份直接删除 |

归档不会立即释放磁盘空间，部署快照可能含凭据。日志常规预算约 20 MiB，单条日志可使文件短暂超限；强制终止留下的临时现场需离线清理。

## 隧道托管

Cloudflared 常驻命令使用 token 文件。Windows 通过服务控制管理器注册官方可执行文件，命令行只包含受 ACL 保护的 token 文件路径，并核对注册后的命令；token 不作为命令行参数传入。Linux 记录 PID、启动时间和系统启动 ID 验证归属，内置 nohup 仅负责当前运行，开机托管需运维配置 systemd 等服务管理方式。

## 重新配置模型

模型配置使用 `data/config/models.json` 的 Pi 原生 `providers` 和 `data/runtime/pi/settings.json` 的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`。旧顶层 `modelId` / `thinkingLevel` 不参与选型，也不做兼容迁移。旧配置需要重建时，先停机并将这两个文件及 `data/runtime/models-store.json` 归档到 `backup/rm`，再运行 `bun run configure`；没有宿主机 Bun 的 Docker 部署可重新运行部署脚本，由镜像内的向导生成配置。`backup/rm` 会在部署成功后清空，需要长期保留的配置副本请另行备份。

凭证由 Pi 从 `models.json` 解析，支持直接 Key、环境变量引用和命令引用；磁盘 `auth.json` 不参与解析。运行中的模型、设置及目录使用启动时的只读视图，更改配置后需重启。群工作区的 `.pi/settings.json` 不参与配置；重试、自动压缩开关及遥测策略由应用固定，编辑 Pi 设置也不会覆盖这些策略。

向导先在暂存目录中刷新所选服务商的模型清单、写入 Pi 设置并完成离线校验，再提交配置和缓存。取消不会更改当前文件；提交过程中发生错误会恢复原文件。服务商的扩展字段及同一端点、同一模型的原生字段会保留；选择推理级别时，会清除所选模型的 `modelThinkingLevels` 覆盖，保证启动后使用本次选择。

Pi 目录刷新遵循 `PI_OFFLINE`：设置此环境变量时使用随包目录和已有缓存；未设置时可联网刷新。该开关不禁止自定义端点的模型清单探测。机器人启动和 `doctor` 都只读本地目录，动态目录服务商缺少缓存时需重新运行向导联网刷新。

改完用 `bash scripts/ops/ops.sh doctor`（Windows 用 `scripts\ops\ops.ps1 doctor`）确认「模型配置（models.json + Pi 设置）」一行通过再启动。部署快照同时保存 `data/config`、Pi 设置和模型目录缓存。

## 旧待补发账本（历史升级）

此节仅适用于尚未完成 2026-09-13 账本转换的旧部署，首次部署无需执行。旧待补发账本需转换为附件引用结构，新版在启动时检查格式；即使待补发为 0 条，也可能需要更新表结构。

当时单独交付的 `migrate-audit-2026-09-13.ts` 不随 Git 更新分发，需要宿主机 Bun 和项目依赖。已持有该工具的旧部署，应在切换到当前模型配置之前，将脚本放到旧项目的 `tmp/`，用部署账户先执行 `stop` 停机，再在项目根目录执行：

```sh
bun run tmp/migrate-audit-2026-09-13.ts
bun run tmp/migrate-audit-2026-09-13.ts --apply
```

第一条只预览。第二条取得服务锁，先备份再迁移待补发附件；SQLite 备份包含已提交的 WAL 记录。无法由本地外链账本确认的附件会暂停补发，脚本列出记录 ID，不会发送旧链接或重新上传附件。全部成功后可选择删除本次迁移备份，默认保留；失败或有挂起记录时始终保留。

该历史工具还会检查并补齐旧格式的顶层 `modelId`，不能生成当前的 Pi 原生选型；已切换到当前配置的实例不要重跑它。账本转换完成后，归档旧模型配置，再升级或部署，由新版向导按[重新配置模型](#重新配置模型)重建选型。停机升级会保留停止状态，完成后需主动启动并查看健康页。
