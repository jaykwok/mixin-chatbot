# 运维手册

[返回 README](../README.md) · [部署与配置](deployment.md) · [管理台与报表](tui.md)

本文用于命令行管理、故障排查、配置调整和数据维护。首次安装请从[部署与配置](deployment.md)开始。

使用管理台时，先到“监控 → 体检”查看逐项结果，按页面建议进入对应菜单，例如 Windows 的“系统 → 服务部署 → 修复隧道”。部署或修复返回后会丢弃旧体检，重新进入该页即可检查新实例，无需关闭终端。读取期间动画持续更新，仍可切换页面；需要修改 Cloudflare 控制台或配置文件时，按具体说明处理。

**排查**：[长时间没有回复](#长时间没有回复) · [按任务编号提取日志](#按任务编号提取日志) · [HTTP 拒绝日志](#http-拒绝日志)

**命令行**：[日常控制](#日常控制)

**配置**：[高级运行参数](#高级运行参数) · [大文件外链](#配置可选的大文件外链) · [隧道连接模式](#隧道连接模式) · [隧道日志](#隧道日志)

**维护**：[重新配置模型](#重新配置模型) · [数据维护](#数据维护) · [回调路由恢复](#回调路由恢复) · [磁盘保留](#磁盘保留) · [隧道托管](#隧道托管)

## 命令行运维

日常交互操作从[运维界面](tui.md#运维界面)进入。这里保留命令行入口，便于脚本调用和没有装 Bun 的 Docker 宿主机使用；排查与数据维护步骤见本文后面的对应章节。

### 日常控制

在项目根目录选择对应平台的命令行入口。

Windows：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/ops.ps1 doctor
```

Linux / Docker：

```sh
bash scripts/ops/ops.sh doctor
```

将示例中的 `doctor` 替换为所需命令：

| 命令 | 用途 |
| --- | --- |
| `doctor` | 检查配置、实例、群数据根及已配置的网络入口；加 `--json`（Windows 为 `-Json`）输出单行 JSON |
| `start` / `stop` / `restart` | 启动、正常关闭或重启实例 |
| `logs` | 持续查看日志 |
| `tunnel-logging off\|on` | 关闭或开启隧道文件日志，应用时重启正在运行的本项目隧道 |
| `tunnel-protocol auto\|http2\|quic` | 设置隧道连接模式，默认 auto，应用时重启正在运行的本项目隧道 |
| `update` | 同步 origin/main 并部署，保留原运行或停止状态 |
| `deploy` | 部署当前代码；可重新配置并重建现有部署，失败恢复原部署 |

`update` 要求已跟踪文件没有本地改动，代码已最新也会检查数据版本。Windows 和 Docker 都先确认旧实例停止，再切换工作树、安装依赖或构建镜像；下载目标提交和只读检查可在停机前完成。需要迁移时先备份再转换，随后使用只验证实例检查，提交后恢复原运行状态。同版本且标记配对时跳过数据迁移和数据库备份，仍做配置、schema 和新实例校验。提交前失败恢复数据、原提交和部署；提交后启动失败保留新代码与数据，检查日志后重试。首次升级和中断续做参见[数据版本与升级事务](data-migrations.md)。

升级与迁移失败时，按终端打印的路径查看 `logs/operations/` 下的日志；其中包含失败阶段、异常、退出码与回滚结果。服务早期启动错误写入同目录的 `startup-*.log`，详见[失败日志](data-migrations.md#失败日志)。

Windows `update` 会显示更新前后的提交 hash。依赖清单、锁文件、安装配置和补丁未变，且已安装的直接依赖版本匹配时，会保留 `node_modules` 并跳过安装；缺包、版本不匹配或依赖输入发生变化时，才备份旧依赖并按锁文件安装。版本更高也不视为匹配，避免偏离经过验证的依赖组合。

部署、升级和连接器安装的备份放在 `backup/snapshots`，被替换的旧文件放在 `backup/rm`。普通部署和连接器安装成功后删除本次部署快照，并清空整个 `backup/rm`，包括历史目录、散落文件和手动清理的会话归档；Docker 升级也采用该清理策略。Windows 新升级器保留部署快照和归档，供人工清理。两平台都保留 `migration-*` 数据迁移快照；其他历史快照不自动删除。操作失败时保留回滚现场。Windows 会移除空的 `backup` 目录；Linux 保留空的容器挂载目录，避免运行中的容器丢失后续归档。部署锁保存在 `data/state/deploy.lock`。

关闭服务使用 `stop`：Windows 验证实例身份后先请求优雅关闭，超时再复核归属并终止进程树；Linux 使用 Docker 停止期限。

## 长时间没有回复

“消息发送成功（处理中提示）”只表示发送了“正在处理”，最终回答需要看到“回复发送完成”或“任务完成”。`/status` 显示任务编号、当前阶段、已用时间、最近进展距今和时限；服务器每 60 秒输出一次仍在运行的任务摘要，每个模型响应结束时输出“模型流结束”。流日志只记录统计和响应标识，不记录模型输出、思考正文或工具参数。

1. 在异常群发送 `/status`，记下任务编号。用[日常控制](#日常控制)里的 `logs` 入口查看日志，或在 PowerShell 执行 `Get-Content logs/mixin-chatbot.log -Tail 200`，按任务编号、群号定位。
2. “模型调用准备”涵盖 Pi 的校验与历史检查；“等待模型响应”表示进入模型轮次；“接收模型输出”表示 SDK 正在收到流事件；“压缩会话历史”表示正在压缩该群该用户的历史。工具执行和最终发送也分别记录。
3. 只有某个群异常时，发送 `/stop`，等待 `/status` 变为空闲，再发 `/clear`。收到归档确认后，用“只回复 OK”测试。`/clear` 归档当前用户在本群的会话，不清除群资料。若恢复，旧会话上下文是重要线索；若仍失败，保留这一轮阶段日志继续检查 Pi 请求与模型服务。
4. 普通 HTTP 流探测成功只验证该次请求，不能验证机器人的完整历史、工具定义、思考模式和压缩请求。`doctor`/健康检查也不能证明模型回答正常。

### 深入排查：模型超时、进展判定与日志字段

模型等待或输出期间，默认连续 180 秒无有效进展就主动取消；计时从每个模型轮次开始，包含首个内容到达前的等待。正文、思考增量中的非空白字符会刷新进展时间；工具参数则比较 SDK 解析后的参数 JSON，仅在参数发生变化时刷新。原始工具参数增量再多，只要解析结果不变，就不算进展。空增量、纯空白正文/思考、块开始/结束、工具名称/调用 ID 和初始空参数对象也不续期。“最近进展距今”在接收模型输出时随上述进展刷新。

解析参数最多每秒采样一次，模型响应结束或准备因无进展取消时补查尚未采样的变化；只保留摘要用于比较，不把参数内容写入运行日志，也不提前执行尚未结束的工具调用。每个工具分别比较，再合并为本次响应的进展。采样比较不等于判断语义有用性：反复改写参数或重复输出正文仍可能续期，因此另设**单次模型响应 600 秒上限**，持续有进展也不能延长。

这两种模型时限都只在等待模型或接收输出时生效；工具执行、历史压缩、重试等待和最终发送期间暂停，下个模型轮次重新计时。检测随流事件及每秒定时检查触发。

任务摘要中的 `模型流` 按当前模型响应累计，`response` 标识本任务的第几个模型响应：

| 字段 | 含义 |
| --- | --- |
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

也可在 TUI 的“监控 → 日志”按 `t` 输入任务编号。扫描在后台进行，不影响翻阅日志；离开日志页会取消未完成的扫描，需要完整结果时请留在该页等待完成，或使用下方独立脚本。

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

`stat` 读使用统计账本 `<群数据根>/stats.sqlite`，区分模型轮次和成功资料工具结果；链接生成不等于用户收到。每次任务结束后即入账，任务之间的缓存保温用量由每日兜底扫描补入。账本与会话历史相互独立：`/clear` 和 `history clear` 会在归档前把那段历史入账，清空上下文不影响已统计的数字，群目录被删掉后账本里的历史也还在。统计区间按自然日裁剪。维护写操作与服务通过 proper-lockfile 租约互斥，异常退出后约 35 秒可恢复陈旧锁。运维包装器的 `history-clear` 会自动停机并恢复原运行状态，其他写操作先 `stop`，完成后按需 `start`。

兜底扫描遇到权限等错误时会逐项记录“统计账本扫描失败”，并继续处理后续成员和群。当天有失败就保留未完成状态，下轮维护重试；已成功且未变化的文件只检查元数据，不会反复计算前缀摘要，重启后也保留该进度。修正日志所指路径的权限后，后续维护会自动补账；未完成期间的汇总日志列出失败数和跳过数。

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
| --- | --- | --- |
| `suspected_probe` | 疑似探测，也可能是调用地址配置错误，需结合 IP、频率与路径判断 | `webhook_secret_mismatch`、`webhook_secret_missing`、`route_not_found` |
| `request_validation` | 请求格式、大小或字段校验拒绝，不直接认定为扫描 | `invalid_request`、`payload_too_large`、`unsupported_media_type` |
| `runtime_protection` | 停机、容量或 callback 路由保护，不计入疑似探测 | `service_stopping`、`callback_route_capacity`、`callback_route_conflict`、`request_capacity` |

每个应用实例的每个 60 秒窗口、每类最多输出 10 条 WARN 明细，其余只计数。窗口从第一条拒绝开始；窗口结束即使没有新请求也会输出 `拒绝请求汇总`，包含该类总数、已记录数、已抑制数和原因计数。窗口结束后恢复明细配额；服务开始关闭时提前输出当前汇总。空窗口不写日志，正常 `/health` 不写拒绝日志。

同类的原因共享明细配额：普通路径扫描可能占满 `suspected_probe` 的配额，使随后错误密钥请求的 IP 和路径明细被抑制，但其数量仍计入汇总的 `webhook_secret_mismatch`。当前不为猜密钥单独预留明细配额。即使“已抑制”为 0，也保留有请求窗口的汇总，以便统一按汇总统计总量；因此零星拒绝会产生一条明细和一条汇总。未提供具体原因的 409/5xx 使用 `runtime_rejected`，归入 `runtime_protection`。

统计请求量应使用汇总的“总数”（已经包含明细），不要再叠加明细行；实时排查可先看尚未汇总的明细。汇总只保留固定分类与原因的计数，不按 IP 或路径建表，因此换 IP 也不能绕过日志配额。进程强制退出时，尚未汇总的计数可能丢失。已有业务日志仍按原逻辑输出；日志限速不代表请求限流，也不改变响应状态。

明细包含 IP、方法、脱敏路径和状态码；不记录查询参数、请求体、Authorization 或错误消息中的外部字段。`/webhook/` 后的路径全部隐藏。IP 沿用 X-Forwarded-For 第一跳、X-Real-IP 回退的提取规则，仅作为排查线索，不作为可信鉴权依据。代理层直接拦截的请求不会出现在应用日志里。

## 磁盘保留

| 内容 | 保留策略 |
| --- | --- |
| 配置、SQLite 状态库、群资料 | 持久保存，纳入停机备份 |
| Pi 设置与模型目录缓存 | `data/runtime/pi/settings.json` 与 `data/runtime/models-store.json` 随配置备份；动态目录服务商需缓存才能离线启动 |
| 使用统计账本 | `<群数据根>/stats.sqlite` 持久保存，纳入停机备份；清空会话不影响它，删掉就只能从现存会话回填，已归档的历史补不回来 |
| 会话、用户 tmp | 清理时归档到 `backup/rm`，下次部署、升级或连接器安装成功后清空；归档前机器人已把该段历史入账 |
| 部署备份 | 普通部署、连接器安装和 Docker 升级成功后删除本次部署快照并清空 `backup/rm`；Windows 新升级器与失败操作保留现场 |
| 数据版本迁移备份 | 有格式迁移时创建 `backup/snapshots/migration-*`；同版本升级不复制 SQLite、不新增迁移快照。已有快照保留，确认业务验收通过且不再需要人工恢复后清理；已提交事务不能执行 `rollback` |
| 历史账本迁移备份 | 按当时工具的保留规则处理，确认数据转换及新实例验收完成后再清理 |
| 测试与诊断现场 | 放在顶层 `tmp/`，确认没有测试、诊断或维护任务使用后可清理 |
| TUI 统计报表 | 每次导出独立保存在 `backup/reports`，按需保留或手动清理 |
| 上传快照 | 完成、失败或取消后直接删除 |
| 应用日志 | 约 5 MiB 轮转，当前文件加 3 份备份，最旧备份直接删除 |
| 升级、迁移与启动诊断 | `logs/operations/` 保留最近 20 份，每份约 2 MiB；命令输出约 1 MiB 后为后续阶段与错误保留空间，回滚保留日志 |

归档不会立即释放磁盘空间，部署快照可能含凭据。应用日志常规预算约 20 MiB，运维诊断约 40 MiB，单条日志可使文件短暂超限；强制终止留下的临时现场需离线清理。

## 隧道托管

首次使用本项目的 Cloudflare 公网域名模式时，先在控制台准备域名和隧道：

1. 将根域名（如 `example.com`）添加到 Cloudflare，按指引在域名注册商修改 NS，等待状态变为 **Active（已激活）**。域名无需转移注册商，但 DNS 需托管到 Cloudflare。部署交互中填写机器人使用的子域名，如 `bot.example.com`。
2. 在同一 Cloudflare 账户打开 **Networking → Tunnels**（[控制台入口](https://dash.cloudflare.com/?to=/:account/tunnels)），创建 Cloudflared 隧道；已有隧道则选择它，再打开 **Add a replica（添加副本）**。在安装连接器页面，只复制安装命令中 `eyJ` 开头的完整 token 值。在部署的“隧道 token 或文件路径”提示中直接粘贴，或保存到项目的 `data/config/cloudflared-token` 后留空读取，也可填写其他 token 文件的路径。输入会隐藏；Windows 文件名不要带 `.txt` 后缀。连接器由项目脚本安装。
3. 在该隧道的 **Published application** 路由中填写相同子域名，服务地址设为 `http://127.0.0.1:<BOT_PORT>`（类型选 HTTP，URL 填 `127.0.0.1:<BOT_PORT>`；默认端口为 `1011`）。DNS 接入与公开路由需在控制台完成；部署脚本填写域名不会自动创建它们。域名可在部署时留空、稍后配置，公网回调需这些步骤完成后才能使用。

`<BOT_PORT>` 使用部署时选择的端口。Cloudflare 模式下机器人监听 IPv4 回环地址，源站显式使用 `127.0.0.1`，避免 `localhost` 解析为 IPv6 `::1`。已有隧道需在控制台手动更新服务地址；修改仓库或重新部署不会自动更新远程路由。

脚本使用项目根目录的 `cloudflared.exe`（Windows）或 `cloudflared`（Linux）。已有可运行副本会直接复用；缺失或不可用时，从 [Cloudflare 官方 GitHub 发布](https://github.com/cloudflare/cloudflared/releases) 下载对应架构的版本，先校验 SHA-256，再检查可执行性并保存。下载版本与校验值统一记录在 `scripts/tunnel/cloudflared-release.txt`；更新清单只影响后续下载。下载失败或校验失败会保留原文件并清理下载残留，也可提前将官方可执行文件放到项目根目录。

token 来源优先级为：本次输入的 token 或文件路径 → `TUNNEL_TOKEN_FILE` → `TUNNEL_TOKEN` → `data/config/cloudflared-token`。指定的来源无效会报错，不会自动切换到另一条隧道。文件支持裸 token 或包含 `TUNNEL_TOKEN=...` 的 .env 格式。外部文件、环境变量和直接粘贴的值会规范化保存到 `data/config/cloudflared-token`；已规范化的默认文件直接复用。

常驻命令使用同一个 `data/config/cloudflared-token` 文件。Windows 通过服务控制管理器注册项目根目录的可执行文件，命令行只包含受 ACL 保护的 token 文件路径，并核对注册后的命令；交互粘贴的 token 不作为子进程命令行参数传入。已有 Windows 服务继续沿用当前连接，更改文件后通过“修复隧道”应用新 token。Linux 记录 PID、启动时间和系统启动 ID 验证归属，内置 nohup 仅负责当前运行，开机托管需运维配置 systemd 等服务管理方式。

## 隧道连接模式

运行 `bun run tui`，进入 **系统 → 设置 → Cloudflared 连接模式**：

| 选项 | 行为 |
| --- | --- |
| 自动（默认） | `auto`：优先 QUIC，无法建立 UDP 连接时回退 HTTP2；不保证每次短暂超时都立即切换 |
| HTTP2（TCP） | `http2`：固定使用 TCP 7844，UDP 不稳定时可尝试 |
| QUIC（UDP） | `quic`：固定使用 UDP 7844，不回退 HTTP2 |

配置保存到 `data/config/cloudflared-protocol`，缺失时为 `auto`。Windows 服务、前台启动和 Linux 启动都显式传入 `--protocol`，因此项目设置优先于 `TUNNEL_TRANSPORT_PROTOCOL` 和 cloudflared 配置文件中的协议值。连接模式与日志开关分别保存，切换其中一项会保留另一项。是否经过代理由系统及代理路由决定；协议选择本身不控制直连或代理。

命令行也可使用 `scripts/ops/ops.ps1 tunnel-protocol http2` 或 `bash scripts/ops/ops.sh tunnel-protocol http2`，将 `http2` 换成 `auto` 或 `quic` 即可切换。

TUI 保存前会显示确认预览；命令行直接应用指定模式。应用时只重启正在运行的本项目连接器，公网访问短暂中断；已停止时保持停止，尚未安装时下次部署生效。启动或写入失败会尝试恢复原配置与运行状态。启动检查只确认服务或进程保持运行，不保证已经连通 Cloudflare；切换后请结合隧道注册日志及外部请求验证可用性。

Windows 修改已安装的服务需要管理员权限。连接器必须使用当前项目生成的启动参数；此前没有 `--protocol` 的服务不做兼容迁移，Windows 先执行 **系统 → 服务部署 → 修复隧道**，Linux 停止原连接器后用当前脚本重新启动。无需删除日志。

## 隧道日志

运行 `bun run tui`，进入 **系统 → 设置 → Cloudflared 日志**，选择“关闭 / 开启”，默认关闭。开启后记录隧道连接、HTTP 请求和源站响应，写入项目 `logs/cloudflared.log`。配置持久化到 `data/config/cloudflared-logging`（`off` / `on`），部署和前台启动都会读取。命令行也可使用 `scripts/ops/ops.ps1 tunnel-logging on` 或 `bash scripts/ops/ops.sh tunnel-logging on`；关闭时将 `on` 改为 `off`。

保存时只重启正在运行的本项目连接器，公网访问会短暂中断；Windows 服务已停止时更新启动参数并保持停止，尚未安装或 Linux 连接器已停止时在下次启动生效。应用失败会尝试恢复原设置和运行状态。Windows 修改已安装的服务需要管理员权限；没有项目归属标记或使用自定义启动参数的连接器会拒绝自动修改。

使用 cloudflared 自带的目录轮转，不把控制台输出重复追加到同一文件。项目当前固定版本每个文件达到 1 MiB 后轮转，最多保留 5 个备份，文件名为 `cloudflared-<时间戳>.log`；关闭不删除已有日志。Linux 后台启动检查的输出只临时保存，启动结束后清理。

在 **监控 → 隧道日志** 查看当前文件尾部，`/` 搜索路径、错误或 `cfRay`，`l` 筛选警告和错误，`o` 返回日志设置。界面把 UTC 时间转换为本机时间；直接查询原始文件时需自行换算。较早记录需查询 `logs/` 中的轮转文件。

请求详情只证明流量到过当前连接器；源站响应不代表客户端完整收到了文件。开启之前、其他连接器处理、Cloudflare 边缘缓存命中或尚未到达本机的请求不会出现在这里，不能单凭没有日志认定平台未投递。日志包含完整 URL 和请求头，可能包括 webhook 密钥、外链签名或认证信息，分享前请脱敏。

## 高级运行参数

运行 `bun run tui`，进入 **系统 → 设置 → 高级运行参数**。参数分为并发与附件、超时与退出、缓存与索引、文档与诊断四类；默认值和数值范围与机器人共用定义。端口、监听地址及群数据目录放在服务部署中设置。

按 Enter 修改当前参数，`d` 将选中项恢复默认，`s` 展示所有改动并确认保存。恢复默认会移除对应的 `runtime.json` 覆盖项；未编辑的参数保持原值。Esc 返回上一层会保留当前 TUI 中的草稿，操作菜单可放弃草稿；退出 TUI 时会提醒尚未保存的内容。

设置只读取当前选中项，配置读取不启动 Docker、模型或网络探测；等待期间使用 TUI 现有的持续动画和后台读取机制，仍可切换分类或页面。保存通过运维执行面板显示进度：先校验草稿、环境覆盖及服务归属，再短暂停止原本运行中的机器人；写入后恢复并检查健康状态。已停止或尚未部署时只保存，保持停止状态。应用或健康检查失败会尝试回滚，恢复也失败时保留 `data/config/.runtime-draft-*.json.rollback` 供排查。

显式环境变量仍优先于保存值。Windows 检查当前运维进程的环境，Linux 检查既有容器的相关环境变量；被覆盖的修改会在停机前拒绝。自定义 Windows 启动脚本还需检查其单独设置的环境变量。配置在编辑期间被其他操作修改时，本次保存会拒绝覆盖；放弃草稿后重新读取再编辑。

## 配置可选的大文件外链

运行 `bun run tui`，进入 **系统 → 设置 → 外链配置**；已有外链的查看与清理在 **数据 → 外链**。部署向导只提示配置入口，不要求填写外链配置。基础设置为 WebDAV 上传目录、指向同一目录的公开下载地址，以及可选认证；高级设置可调整文件上限、有效期和 [OpenList](https://github.com/OpenListTeam/OpenList) 兼容签名。

填写时保持机器人运行，密码与签名密钥隐藏输入，已有密码可留空沿用。向导先展示保存预览；确认后才停止原本运行中的机器人，复用启动校验来提交 `data/config/relay.json`，随后恢复运行并检查本地健康。原本停止的服务保持停止，取消不修改配置也不停机。Windows 前台实例若没有计划任务可供恢复，须先手动停止再配置；Linux 使用已部署镜像内的 Bun 和依赖。

停用会将配置归档到 `backup/rm`，保留外链账本和远端文件；停用期间机器人不再清理过期对象，后端签名仍按自己的期限失效。设置有效期但不启用签名时，到期会删除远端文件；启用兼容签名后，到期只使签名失效。保存预览会显示具体规则。这里校验配置格式，不会向远端上传测试文件；两个地址是否映射同一目录、后端权限及签名规则需按存储服务配置。

### 查看并验证下载链接

在部署机的项目目录运行 `bun run relay list`，或在 TUI 中进入 **数据 → 外链 → 列出在册外链**。启用签名时，列表会按当前配置为账本内的文件重新签发带 `?sign=...` 的地址，有效期从查看时起算；列表本身不验证下载是否成功。机器人最终交付的链接也会重新签名，而“外链上传完成”日志打印的是存储地址，不含签名。

下载验证应使用完整的带签名链接。部分网盘直链拒绝 `HEAD`，但允许正常的 `GET` 下载；机器人在 `HEAD` 无法核验文件大小时，会从公开链接重新发起 `Range: bytes=0-0` 的 GET 请求，核对响应中的文件总大小后取消响应体。无法确认大小的错误响应仍会阻止交付。

排查时分别查看公开域名和最终网盘域名的状态码。若公开域名返回 302、最终 OSS 直链对 HEAD 返回 403，而同一链接的 GET 成功，应检查最终响应的 `x-oss-ec`：例如 `0002-00000201` 表示 [OSS V4 签名不匹配](https://help.aliyun.com/zh/oss/user-guide/0002-00000201)。[OSS 签名包含 HTTP 请求方法](https://help.aliyun.com/zh/oss/developer-reference/recommend-to-use-signature-version-4)，按 GET 签发的下载链接不能直接改用 HEAD 验证；它与机器人公开链接中的 [OpenList](https://github.com/OpenListTeam/OpenList) `sign` 是两层签名。

公开链接保留原始文件名及扩展名。若链接会跳转到网盘，浏览器采用的下载名称还取决于最终响应的 `Content-Disposition`；中文文件名应由后端通过 `filename*=UTF-8''...` 返回。排查时同时检查最终下载响应和浏览器保存的名称。

### [OpenList](https://github.com/OpenListTeam/OpenList) 与 Cloudflare 子域名示例

以 [OpenList](https://github.com/OpenListTeam/OpenList) 监听本机 `5244` 端口、对外挂载路径为 `/relay`、文件子域名为 `files.example.com` 为例。以下 `5244` 均需替换为 [OpenList](https://github.com/OpenListTeam/OpenList) 实际监听端口；外链设置会保留填写的端口：

1. 在 [OpenList](https://github.com/OpenListTeam/OpenList) 中挂载支持上传、建目录和删除的存储，挂载路径填 `/relay`。这里指 [OpenList](https://github.com/OpenListTeam/OpenList) 对外展示的虚拟路径；它也可以是某个挂载下的子目录，例如 `/网盘/relay`，不必和磁盘物理目录同名。示例账号基本路径为 `/`，需有该目录的 **WebDAV 读取、WebDAV 管理、创建目录或上传、删除** 权限。使用受限账号时，以该账号实际可访问的 WebDAV 目录为准，确保它与公开下载地址映射到同一存储目录。
2. 按[隧道托管](#隧道托管)的方式，将根域名 `example.com` 的 DNS 接入 Cloudflare 并等待激活。在已有 Cloudflared 隧道中新增 **Published application** 路由：子域名 `files`、域名 `example.com`，Path 留空，服务类型选 **HTTP**，URL 填 `127.0.0.1:5244`（完整服务地址为 `http://127.0.0.1:5244`）。这里的服务地址应从运行连接器的位置可达；机器人与 [OpenList](https://github.com/OpenListTeam/OpenList) 使用各自的子域名和路由。
3. 在 **系统 → 设置 → 外链配置** 中，上传地址填写到 [OpenList](https://github.com/OpenListTeam/OpenList) 挂载目录，例如 `127.0.0.1:5244/dav/relay`，此处挂载目录为 `relay`。公开下载项可以只填文件域名，向导会推导对应目录。DNS 和隧道路由在 Cloudflare 控制台完成；外链向导只保存机器人配置。

| 用途 | 完整地址 | 向导也接受的输入 |
| --- | --- | --- |
| WebDAV 上传目录 `webdavUrl` | `http://127.0.0.1:5244/dav/relay/` | `127.0.0.1:5244/dav/relay` |
| 公开下载目录 `publicBaseUrl` | `https://files.example.com/d/relay/` | `files.example.com`（自动推导），也可填 `files.example.com/d/relay` |

`/dav/` 是 WebDAV 入口，`/d/` 是下载入口，后面均接实际挂载目录。例如上传地址填 `127.0.0.1:5244/dav/网盘/relay`，公开下载只填 `files.example.com`，即可推导为 `https://files.example.com/d/网盘/relay/`；向导会将中文路径编码为有效 URL。

只填域名、带协议的域名或末尾带 `/` 的域名时，均从上传地址的 `/dav/` 后提取挂载目录，拼到下载域名的 `/d/` 下。若已填写完整下载目录（例如 `https://files.example.com/custom/relay/`），则保留填写的目录。自动推导仅识别标准 [OpenList](https://github.com/OpenListTeam/OpenList) 上传路径；其他 WebDAV 后端、反代子路径或不同的目录映射，请填写实际公开下载地址。

浏览页面地址 `http://127.0.0.1:5244/relay/` 可帮助确认挂载路径，但上传时应使用 `/dav/relay/`，公开下载时使用 `/d/relay/`。不要把已生成文件的 `<日期>-<UUID>/<文件名>` 或 `?sign=...` 填进目录配置。

省略协议时，WebDAV 的 `localhost`、回环及私有 IP 自动补 `http://`；其余地址（包括公开下载目录）自动补 `https://`。显式填写的 HTTP/HTTPS 会保留，末尾 `/` 自动补齐，保存预览可核对最终地址；配置文件始终保存完整 URL。

隧道源站使用 `127.0.0.1` 的前提是连接器能通过本机 IPv4 回环访问 [OpenList](https://github.com/OpenListTeam/OpenList)；上传地址使用 `127.0.0.1` 的前提是机器人能通过该地址访问 [OpenList](https://github.com/OpenListTeam/OpenList)。在其他主机或独立容器网络中，两者分别填写连接器、机器人实际可达的 [OpenList](https://github.com/OpenListTeam/OpenList) 地址和端口。公开下载需要填写接收者能访问的域名。[OpenList](https://github.com/OpenListTeam/OpenList) 若对该目录开启签名，需在高级设置中配置匹配的签名密钥和规则。

路径及权限依据：[WebDAV 文档](https://doc.oplist.org/guide/advanced/webdav)、[挂载路径说明](https://doc.oplist.org/guide/drivers/common#挂载路径)、[官方下载路由](https://github.com/OpenListTeam/OpenList/blob/main/server/router.go)。

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
