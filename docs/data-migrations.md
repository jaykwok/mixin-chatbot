# 数据版本与自动重置升级

[返回运维手册](operations.md) · [部署与配置](deployment.md)

当前应用数据版本为 **6**，Pi 为 **1.3.0**。正式运行时只支持当前配置和群会话格式；不保留 v1–v5 转换链、JSONL 导入或旧字段别名。统计账本仍是 **schema 2**，本轮无需转换，历史账目不依赖旧会话存在。

## 什么时候提示清理

升级检查项目 `data/state/data-version.json` 和群根 `data-version.json`，以应用数据版本判断，不以应用发布号或 Pi 版本号判断。

| 状态 | 行为 |
| --- | --- |
| 两侧版本、登记 ID 一致，且是当前版本 | 正常升级，沿用配置和会话，不提示清理 |
| 两侧一致，版本低于当前版本 | 停机前提示保留统计并重置，确认后重新配置模型 |
| 标记缺失一侧、损坏或两侧不一致 | 拒绝自动清理，先恢复一致状态 |
| 数据版本高于程序版本 | 拒绝降级，不能借重置绕过 |
| 全新实例、两侧均未登记 | 按首次部署规则校验并登记；已有未登记运行数据仍拒绝 |

只有配置或会话存储发生不兼容变化才提高 `DATA_VERSION`。同一数据版本的普通更新直接升级。

## 保留与清理范围

保留整个 `stats.sqlite`，包括提问/回复/工具次数、人数去重信息、日/月趋势、token、费用、缺失或未知标记、来源键和游标。保留 `data/config/webhook-secret`、已有 `cloudflared-token`、入口模式、端口、域名和群根位置，webhook URL 与隧道凭证不重新生成。计划任务启动器、容器任务隔离元数据等部署资源继续由发布事务管理。

以停止服务后的**现有统计账本**为准，已有账目原样保留；不再从旧会话补算。尚未入账的完整消息、不完整 JSONL 尾行和未完成任务都随旧会话清理。账本中的历史跳过标记继续保留。

清理旧群会话、消息队列、控制状态、旧 outbox、群 workspace 资料、索引、临时文件和虚拟环境；模型与可选功能配置重新生成，外链、MCP、辅助模型等需重新配置。资料源也需重新接入。旧任务与待交付事项不会由新实例承接。项目日志和不属于本次事务的历史备份不会被批量清空。

新群库会生成持久 UUID，新的统计来源带这个代际，避免重建后的 conversationId 与旧来源碰撞；群号和成员标识不变，代际不参与人数去重。

## 自动运行顺序

Windows 使用 `scripts\ops\ops.ps1 update`；Linux 使用 `bash scripts/ops/ops.sh update`。rootful Docker 用 root，rootless Docker 用其所属用户。TUI 的「系统 → 服务部署 → 升级」调用同一 `update` 入口，并交出终端供升级器确认及配置；继续和回滚也共用 CLI 事务。首次从旧入口切换时见下节。

1. 旧服务继续运行时，导出目标发布、检查数据版本。跨代更新提示清理范围；Windows 输入 `RESET`，Linux 确认继续。未确认或非交互输入不作自动同意。
2. 在隔离目录运行新版配置向导，生成并离线校验新模型配置。只保留入口凭证和部署参数，其余使用当前默认设置。取消、配置失败或停机前复核失败时，原服务与数据不变。
3. 记录发布事务和新配置草稿，停止旧服务。由**目标版本**的工具取得项目和群根维护租约，只读取现有统计账本并保存摘要、时区和冻结回执。Windows 使用导出目录的依赖，Docker 使用已固定的目标镜像；不依赖旧代码、旧依赖或旧会话读者。
4. 核查统计结构、完整性及冻结前后一致性，使用 SQLite 一致快照写入 `backup/statistics/<发布事务>/stats.sqlite`，并逐表有序计算摘要，核对原账本与备份的全部行。
5. 将旧会话暂存于群根 `.reset-<发布事务>/`，旧配置及运行状态暂存于 `data/.reset-<发布事务>/`，发布新配置。移动始终留在原挂载/卷内，逐项改名之前先持久化日志到发布快照，中断后可以继续或回滚。
6. 只启动验证实例，不接收业务消息。提交前再次核对统计和入口凭证；通过后成对登记当前数据版本，再恢复原服务运行状态。
7. 新实例健康检查通过后，自动删除本次旧会话及配置的回滚副本。独立的 `backup/statistics/<发布事务>/` 继续保留，其中 `baseline.json` 记录全表摘要、时区、时间和历史 JSONL 不完整尾行的来源数及行数。原服务本就停止时保持停止，在验证通过并提交后清理。

确认和模型配置完成后，停机阶段不再提问。中断后使用 `resume` 沿用已保存计划，无须重复输入模型密钥。提交前失败会恢复旧会话、配置、代码、依赖及原运行状态；已经提交后不允许回退旧数据，启动或清理失败保留事务，修复原因后 `resume` 收尾。

确认 reset 后不再打开或验证旧群库、JSONL、任务队列和外链索引；旧会话损坏、缺少群库代际或包含未完成任务都不阻挡清理。历史来源的投影版本和 pending 标记按账本原值保留，不要求旧版收尾。`baseline.json` 的 `incompleteJsonl`（`sources` / `lines`）记录账本已有的 pending 来源数和总量，不扫描原会话。

仍会核对需要保留的统计账本、入口凭证和清理路径：统计库缺失、schema 不是 2、完整性失败、冻结后变化或备份不一致时停止，保留原数据；不能通过创建空账本绕过。未来统计格式变化使用一次性转换工具处理，不把旧会话兼容逻辑加回正式运行时。

## 第一次从旧版升级

旧版 `ops update` 可能仍导出已删除的 `scripts/migrations`，会在执行目标升级器之前失败，只显示“无法导出升级器”；旧 TUI 的升级也走这个旧入口，因此同样需要下面的一次性引导。已安装的旧脚本无法显示新版本的提示。第一次可在原项目目录直接导出目标升级器；代码必须已经提交至目标 ref，生产工作树保持干净。即使工作树已经切到新版、磁盘仍为成对旧数据，也可使用此入口或新版 `update` 重置，无须恢复旧版读者或手改版本标记。

Linux / Docker：

```bash
git fetch origin main
mkdir -p tmp
stage=$(mktemp -d "$PWD/tmp/upgrade-XXXXXXXX")
git archive origin/main scripts/deploy/upgrade.sh scripts/lib scripts/runtime src/core/data-version.ts Dockerfile | tar -x -C "$stage"
bash "$stage/scripts/deploy/upgrade.sh" "$PWD" origin/main
```

Windows（管理员 PowerShell，在原项目目录执行）：

```powershell
git fetch origin main
$projectPath = (Get-Location).Path
$originalSha = (git rev-parse HEAD).Trim()
$originalBranch = (git rev-parse --abbrev-ref HEAD).Trim()
$targetSha = (git rev-parse origin/main).Trim()
$stagePath = Join-Path $projectPath ('tmp\upgrade-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagePath | Out-Null
$archivePath = Join-Path $stagePath 'target.zip'
git archive --format=zip --output=$archivePath $targetSha
Expand-Archive -LiteralPath $archivePath -DestinationPath $stagePath
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $stagePath 'scripts\deploy\upgrade.ps1') -Project $projectPath -OriginalSha $originalSha -TargetSha $targetSha -OriginalBranch $originalBranch
```

这两个入口与正常 update 使用同一个目标升级器，仍有版本检查、确认、配置、统计冻结与备份核对及失败回滚。保留临时导出目录直到事务结束，再删除对应的 `$stage` / `$stagePath`（先核对完整路径位于项目 `tmp` 内）；其中可能有配置凭证，不能分享或提交。成功切换后使用普通 `update`。

首次引导中断、旧入口仍不可用时，保留原导出目录和目标提交：Linux 在最后一条调用后加 `continue` 或 `rollback`；Windows 重复最后一条调用以继续，或加 `-Rollback` 回滚。沿用第一次记录的参数，不重新计算目标提交。不要删除事务指针或先手工切代码。

## 统计检查和备份

自动核对覆盖以下六张表的全部行，同时执行 `PRAGMA integrity_check` 和外键检查：

```sql
SELECT * FROM stats_schema ORDER BY id;
SELECT * FROM sources ORDER BY id;
SELECT * FROM activity ORDER BY source, day;
SELECT * FROM tool_counts ORDER BY source, day, kind, tool;
SELECT * FROM usage_totals ORDER BY source, day, kind, provider, model;
SELECT * FROM meta ORDER BY key;
```

可用 `bun run stat`、TUI **数据 → 统计** 和 HTML 报表复核。验证新问题只增加一次、同一成员再次提问不增加去重人数。自动验证为离线配置与服务验证，实际服务商仍需最小真实请求验收。

统计库是长期数据，不能随会话删除。新业务启动后账目继续增长，冻结备份只覆盖切换时点；仍需日常备份当前账本。若未来统计 schema 改变，应提供独立的一次性转换脚本，对备份转换并逐表核对，不建立长期版本转换链，也不能删库重建空统计绕过检查。
