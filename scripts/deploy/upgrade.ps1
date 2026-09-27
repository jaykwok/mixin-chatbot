# Target-release orchestrator, launched from a read-only Git export before changing the live tree.
param([Parameter(Mandatory=$true)][string]$Project, [Parameter(Mandatory=$true)][string]$OriginalSha,
    [Parameter(Mandatory=$true)][string]$TargetSha, [string]$OriginalBranch = 'main', [switch]$RestartTunnel, [switch]$Rollback,
    [string]$BunPath = '', [string]$GitPath = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot '..\lib\common.ps1')
$operation = Start-OperationLog $Project 'upgrade'
$operationExit = 1
try {
Set-Location -LiteralPath $Project
$TaskName = 'mixin-chatbot'
$bun = if ($BunPath) { $BunPath } else { @(Get-ApplicationPaths 'bun.exe' | Select-Object -First 1)[0] }
$git = if ($GitPath) { $GitPath } else { @(Get-ApplicationPaths 'git.exe' | Select-Object -First 1)[0] }
if (-not $bun -or -not $git) { throw '缺少 Bun 或 Git' }
# 未完成的升级固定使用事务记录中的群根；续做和回滚不重新读取默认值。
$pendingPointer = Join-Path $Project 'data\state\upgrade-transaction'
$pendingPath = $null
$pendingRecord = $null
if (Test-Path -LiteralPath $pendingPointer) {
    $pendingName = "$(Get-Content -LiteralPath $pendingPointer -Raw)".Trim()
    if ($pendingName -notmatch '^deploy-[0-9a-f]{32}$') { throw '升级事务快照名称无效' }
    $pendingPath = Join-Path $Project ('backup\snapshots\' + $pendingName)
    $pendingRecord = Read-DeploymentTransaction $pendingPath
} elseif ($Rollback) { throw '没有未完成的升级' }
$groups = if ($pendingRecord) { $pendingRecord.target_group_root } else { Get-SavedGroupDataRoot $Project }
# 挂载缺失时明确停止，绝不重新创建空的群数据总根。
if ($pendingPath -and -not (Test-Path -LiteralPath $groups -PathType Container)) {
    throw "上次升级的群数据总根不存在：$groups；原服务和新服务都依赖它，请恢复后重试。"
}
$plan = Join-Path $Project ('tmp\migration-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
$recordedPlan = if ($pendingPath) { Join-Path $pendingPath 'migration-plan.json' } else { '' }
$applyPlan = $plan
$previewRunner = Join-Path $PSScriptRoot '..\migrations\run.ts'
$runner = Join-Path $Project 'scripts\migrations\run.ts'
function Invoke-Migration([string]$Action) {
    & $bun run $runner $Action --project $Project --groups $groups --plan $applyPlan
    if ($LASTEXITCODE -ne 0) { throw "数据迁移 $Action 失败 ($LASTEXITCODE)" }
}

# This phase uses built-ins only, so even a changed Pi dependency cannot block decisions.
try {
Write-OperationEvent 'info' ("original=$OriginalSha target=$TargetSha rollback=$([bool]$Rollback)")
if (-not $Rollback) {
Set-OperationStage 'migration-preview'
if ($recordedPlan -and (Test-Path -LiteralPath $recordedPlan -PathType Leaf)) {
    # 续做沿用停机前确认的迁移计划；apply 会重新核对配置和版本标记，变化即中止。
    $applyPlan = $recordedPlan
    Write-Host '继续上次升级：沿用停机前确认的迁移计划。'
} else {
    # 续做不能等待输入：旧版事务没有保存计划时只做非交互预览，需要确认就停止。
    $previewMode = if ($pendingPath) { @() } else { @('--interactive') }
    & $bun run $previewRunner preview --decisions-only @previewMode --project $Project --groups $groups --plan $plan
    if ($LASTEXITCODE -ne 0) {
        if ($pendingPath) { throw "续做无法沿用迁移确认（原因见上方）；请使用 $(Get-OpsCommandHint 'rollback') 回滚后重新升级。" }
        throw '迁移预览未完成；旧服务尚未停止'
    }
}
Set-OperationStage 'upgrade-preflight'
if ((Invoke-OperationNative $git @('-C', $Project, 'show-ref', '--verify', '--quiet', 'refs/heads/main')) -ne 0) { throw '本地 main 分支不存在；旧服务尚未停止' }
if ((Invoke-OperationNative $git @('-C', $Project, 'merge-base', '--is-ancestor', 'main', $TargetSha)) -ne 0) { throw '本地 main 无法快进到目标提交；旧服务尚未停止' }
if (-not $pendingPath -and -not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw '未安装计划任务，请先部署；旧服务尚未停止' }
}
Set-OperationStage 'deployment-snapshot'
# 新升级沿用现有设置；端口、入口和域名只用于展示，不重新配置。续做和回滚只打开原快照，不读取这些设置。
$upgradeRecord = $null
if (-not $pendingPath) {
    $readState = { param([string]$Name) $path = Join-Path $Project ('data\state\' + $Name); if (Test-Path -LiteralPath $path -PathType Leaf) { "$(Get-Content -LiteralPath $path -Raw)".Trim() } else { '' } }
    $recordPort = & $readState 'bot-port'
    if (-not (Test-TransactionValue 'bot_port' $recordPort)) { $recordPort = '1011' }
    $recordMode = if ((& $readState 'deploy-mode') -eq 'cloudflare') { 'cloudflare' } else { 'direct' }
    $savedDomain = & $readState 'bot-domain'
    $recordDomain = if ($savedDomain) { [string](ConvertTo-Hostname $savedDomain) } else { '' }
    # 升级不改防火墙，来源 IP 同样只用于展示。
    $recordPlatformIp = Get-PlatformIp
    if (-not (Test-TransactionValue 'platform_ip' $recordPlatformIp)) { $recordPlatformIp = $DefaultPlatformIp }
    $upgradeRecord = @{
        format = '1'; operation = 'upgrade'; snapshot = ''; target_sha = $TargetSha; original_sha = $OriginalSha; original_branch = $OriginalBranch
        original_group_root = $groups; target_group_root = $groups; was_running = '0'; bot_port = $recordPort; deploy_mode = $recordMode
        bot_domain = $recordDomain; domain_action = 'keep'; unmanaged_tunnel = ''; platform_ip = $recordPlatformIp; reconfigure_ai = '0'
    }
}
$snapshot = Open-UpgradeSnapshot $Project $TaskName $OriginalSha $OriginalBranch $TargetSha $upgradeRecord $plan
Write-OperationEvent 'info' ('snapshot=' + $snapshot.Path)
$OriginalSha = $snapshot.UpgradeOriginal
$OriginalBranch = $snapshot.UpgradeBranch
$transactionPointer = Join-Path $Project 'data\state\upgrade-transaction'
$committed = $false
$mutated = $false
$migrationAttempted = Test-Path -LiteralPath (Join-Path $Project 'data\state\migration.json')
try {
    if (-not $snapshot.TaskXml) { throw '升级快照没有计划任务，请先部署；旧服务尚未停止' }
    # Use the exported built-in-only command before dependency installation: if a
    # previous process committed and died, installation failure must never roll back data.
    & $bun run $previewRunner committed --project $Project --groups $groups --deployment (Split-Path $snapshot.Path -Leaf)
    $committed = $LASTEXITCODE -eq 0
    if ($Rollback) {
    # 数据已提交只能继续；判定在停止服务或改动代码之前。
    if ($committed) { throw "上次升级的数据已经提交，不能回滚；请使用 $(Get-OpsCommandHint 'resume') 完成新实例启动。" }
    Write-Host '回滚上次升级：恢复数据、代码、依赖、计划任务和原运行状态...'
    $mutated = $true
    } else {
    Set-OperationStage 'stop-service'
    if ($snapshot.WasRunning) { Write-Host "正在停止机器人服务（计划任务 $TaskName）..." }
    if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '机器人服务未能停止，升级未改动代码和数据' }
    if ($snapshot.WasRunning) { Write-Host "已停止机器人服务（计划任务 $TaskName）；升级完成前不处理消息。" }
    else { Write-Host "机器人服务升级前未运行（计划任务 $TaskName），升级后保持停止。" }
    $mutated = $true
    Set-OperationStage 'checkout'
    if ((Invoke-OperationNative $git @('-C', $Project, 'checkout', '--quiet', 'main') -Quiet) -ne 0) { throw '切换 main 失败' }
    if ((Invoke-OperationNative $git @('-C', $Project, 'merge', '--ff-only', '--quiet', $TargetSha) -Quiet) -ne 0) { throw '目标提交无法快进' }
    $checkedOut = [string](& $git -C $Project rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $checkedOut.Trim() -ne $TargetSha) { throw '当前代码不是预览的目标提交，拒绝执行迁移' }
    Write-Host ('代码已更新：' + $OriginalSha.Substring(0, 7) + ' -> ' + $TargetSha.Substring(0, 7))
    if (Test-DeploymentDependenciesReusable $Project $git $OriginalSha $TargetSha) { Write-Host '依赖未变化，沿用现有依赖。' }
    else {
        Set-OperationStage 'install-dependencies'
        Write-Host '安装依赖（bun install --frozen-lockfile）...'
        Save-DeploymentDependencies $snapshot
        if ((Invoke-OperationNative $bun @('install', '--frozen-lockfile')) -ne 0) { throw '依赖安装失败' }
    }
    if ($committed) { Write-Host '数据已在上次中断前提交，直接启用新版本。' }
    else {
    Set-OperationStage 'migration-apply'
    $migrationAttempted = $true
    Invoke-Migration 'apply'
    Set-OperationStage 'verification-service'
    Set-Content -LiteralPath (Join-Path $Project 'data\state\verify-only') -Value 'verify' -Encoding ASCII
    Write-Host '启动验证实例，等待部署预检通过（最长 90 秒）...'
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    $ready = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while ([DateTime]::UtcNow -lt $deadline) {
        & $bun run (Join-Path $Project 'scripts\ops\health-check.ts') --allow-verification
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { throw '部署预检未通过：验证实例 90 秒内未就绪' }
    Write-Host '部署预检通过。'
    if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '验证实例未停止' }
    if ($RestartTunnel -and (Get-Service Cloudflared -ErrorAction SilentlyContinue)) { Restart-Service Cloudflared -ErrorAction Stop }
    Set-OperationStage 'migration-commit'
    Invoke-Migration 'commit'
    $committed = $true
    Write-Host '升级已提交；此后失败不再回退数据。'
    }
    Set-OperationStage 'activate-service'
    Remove-Item -LiteralPath (Join-Path $Project 'data\state\verify-only') -Force -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $TaskName -Xml $snapshot.TaskXml -Force | Out-Null
    if ($snapshot.WasRunning) {
        Write-Host '启动机器人服务，等待健康检查（最长 90 秒）...'
        Enable-ScheduledTask -TaskName $TaskName | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        $ready = $false
        $deadline = [DateTime]::UtcNow.AddSeconds(90)
        while ([DateTime]::UtcNow -lt $deadline) {
            & $bun run (Join-Path $Project 'scripts\ops\health-check.ts')
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw "数据已经提交，但业务实例未就绪；保留新版本，请检查日志后使用 $(Get-OpsCommandHint 'resume') 继续" }
        Write-Host '机器人已启动。'
    } else { Write-Host '机器人服务保持停止（升级前未运行）。' }
    Remove-Item -LiteralPath $transactionPointer -Force
    Write-Host ('升级完成：' + $OriginalSha.Substring(0, 7) + ' -> ' + $TargetSha.Substring(0, 7))
    }
} catch {
    Write-OperationFailure $_
    throw
} finally {
    try {
    if (-not $committed -and $mutated) {
        Set-OperationStage 'rollback'
        if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '无法停止新实例，拒绝恢复数据；请人工处理' }
        if ($migrationAttempted) {
            & $bun run $runner rollback --project $Project --groups $groups --deployment (Split-Path $snapshot.Path -Leaf)
            if ($LASTEXITCODE -eq 42) { throw '数据已提交，保留新代码；请检查后启动，禁止回退' }
            if ($LASTEXITCODE -ne 0) { throw '数据恢复失败；保持停机，保留新代码和备份' }
        }
        Remove-Item -LiteralPath (Join-Path $Project 'data\state\verify-only') -Force -ErrorAction SilentlyContinue
        if ($OriginalBranch -eq 'HEAD') { & $git -C $Project checkout --force $OriginalSha }
        else {
            & $git -C $Project checkout $OriginalBranch
            if ($LASTEXITCODE -ne 0) { throw '原分支恢复失败' }
            & $git -C $Project reset --hard $OriginalSha
        }
        if ($LASTEXITCODE -ne 0) { throw '原代码恢复失败' }
        Restore-DeploymentSnapshot $snapshot
        Remove-Item -LiteralPath $transactionPointer -Force
        Write-OperationEvent 'info' 'data, code and service restored'
        $serviceState = if ($snapshot.WasRunning) { '机器人服务已重新启动' } else { '机器人服务保持停止' }
        Write-Host ('升级已回滚：数据、代码和计划任务已恢复到 ' + $OriginalSha.Substring(0, 7) + '；' + $serviceState + '。')
    }
    } finally {
    $snapshot.Lock.Dispose()
    $env:BOT_DEPLOY_BACKUP_ID = $snapshot.PreviousBackupId
    }
    # Keep the deployment and migration backups for recovery; housekeeping is explicit.
}
} finally {
    Remove-Item -LiteralPath $plan -Force -ErrorAction SilentlyContinue
}
$operationExit = 0
} catch { Write-OperationFailure $_; throw }
finally { Stop-OperationLog $operation $operationExit }
