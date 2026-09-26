# Target-release orchestrator, launched from a read-only Git export before changing the live tree.
param([Parameter(Mandatory=$true)][string]$Project, [Parameter(Mandatory=$true)][string]$OriginalSha,
    [Parameter(Mandatory=$true)][string]$TargetSha, [string]$OriginalBranch = 'main', [switch]$RestartTunnel, [string]$BunPath = '', [string]$GitPath = '')
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
$groupsFile = Join-Path $Project 'data\state\group-data-root'
$groups = if (Test-Path -LiteralPath $groupsFile) { (Get-Content -LiteralPath $groupsFile -Raw).Trim() } else { Join-Path $Project 'data\groups' }
$groups = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($groups)) { $groups } else { Join-Path $Project $groups }))
$plan = Join-Path $Project ('tmp\migration-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
$previewRunner = Join-Path $PSScriptRoot '..\migrations\run.ts'
$runner = Join-Path $Project 'scripts\migrations\run.ts'
function Invoke-Migration([string]$Action) {
    & $bun run $runner $Action --project $Project --groups $groups --plan $plan
    if ($LASTEXITCODE -ne 0) { throw "数据迁移 $Action 失败 ($LASTEXITCODE)" }
}

# This phase uses built-ins only, so even a changed Pi dependency cannot block decisions.
try {
Set-OperationStage 'migration-preview'
Write-OperationEvent 'info' ("original=$OriginalSha target=$TargetSha")
& $bun run $previewRunner preview --decisions-only --interactive --project $Project --groups $groups --plan $plan
if ($LASTEXITCODE -ne 0) { throw '迁移预览未完成；旧服务尚未停止' }
Set-OperationStage 'upgrade-preflight'
if ((Invoke-OperationNative $git @('-C', $Project, 'show-ref', '--verify', '--quiet', 'refs/heads/main')) -ne 0) { throw '本地 main 分支不存在；旧服务尚未停止' }
if ((Invoke-OperationNative $git @('-C', $Project, 'merge-base', '--is-ancestor', 'main', $TargetSha)) -ne 0) { throw '本地 main 无法快进到目标提交；旧服务尚未停止' }
if (-not (Test-Path -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction')) -and
    -not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { throw '未安装计划任务，请先部署；旧服务尚未停止' }
Set-OperationStage 'deployment-snapshot'
$snapshot = Open-UpgradeSnapshot $Project $TaskName $OriginalSha $OriginalBranch $TargetSha
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
        if (-not $ready) { throw '数据已经提交，但业务实例未就绪；保留新版本，请检查日志后重试升级' }
        Write-Host '机器人已启动。'
    } else { Write-Host '机器人服务保持停止（升级前未运行）。' }
    Remove-Item -LiteralPath $transactionPointer -Force
    Write-Host ('升级完成：' + $OriginalSha.Substring(0, 7) + ' -> ' + $TargetSha.Substring(0, 7))
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
