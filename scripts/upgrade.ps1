# Target-release terminal/bootstrap adapter. The shared TS core owns the lock, snapshot, stop, commit and recovery.
param([Parameter(Mandatory=$true)][string]$Project, [Parameter(Mandatory=$true)][string]$OriginalSha,
    [Parameter(Mandatory=$true)][string]$TargetSha, [string]$OriginalBranch = 'main', [switch]$Rollback,
    [string]$BunPath = '', [string]$GitPath = '', [string]$ConfirmedTransaction = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'lib\common.ps1')
$operation = Start-OperationLog $Project 'upgrade'
$operationExit = 1
# Normalized release paths: the core, logs and process listings name the files this release actually runs.
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$plan = ''
$directoryScopeChoice = ''
try {
    Set-Location -LiteralPath $Project
    $bun = if ($BunPath) { $BunPath } else { @(Get-ApplicationPaths 'bun.exe' | Select-Object -First 1)[0] }
    $git = if ($GitPath) { $GitPath } else { @(Get-ApplicationPaths 'git.exe' | Select-Object -First 1)[0] }
    if (-not $bun -or -not $git) { throw '缺少 Bun 或 Git' }
    $bunVersion = [string](& $bun --version)
    if ($LASTEXITCODE -ne 0 -or $bunVersion.Trim() -notmatch '^\d+\.\d+\.\d+(?:-.*)?$') { throw 'bun --version 执行失败或版本无法识别' }
    if ([Version]($bunVersion.Trim() -replace '-.*$', '') -lt [Version]'1.4.4') { throw '需要 Bun 1.4.4 或更高版本；升级尚未停止服务。' }
    $pending = Test-Path -LiteralPath (Join-Path $Project 'data\state\upgrade-transaction')
    $core = @('--no-env-file', 'run', (Join-Path $releaseRoot 'ops\core\cli.ts'), 'deployment', 'upgrade',
        '--project', $Project, '--original', $OriginalSha, '--target', $TargetSha, '--branch', $OriginalBranch, '--git-path', $git)
    $arguments = $core
    if ($Rollback) { $arguments += '--rollback' }
    if ($ConfirmedTransaction) { $arguments += @('--confirmation', $ConfirmedTransaction) }
    if (-not $pending -and -not $Rollback) {
        Assert-ConsoleLifecycle 'update' $Project $OriginalBranch
        if (-not (Test-Path -LiteralPath (Join-Path $Project 'data\config\app-bot.json') -PathType Leaf)) {
            throw '缺少 data\config\app-bot.json；升级沿用已有应用机器人配置，请先完成部署。服务尚未停止。'
        }
        $workspace = Get-SavedWorkspaceRoot $Project
        if ($workspace -and -not (Test-Path -LiteralPath $workspace -PathType Container)) { throw '共享资料目录不存在；服务尚未停止。' }
        $plan = Join-Path $Project ('tmp\data-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
        Set-OperationStage 'data-preparation-preview'
        $preview = Join-Path $releaseRoot 'ops\tools\data-current.ts'
        & $bun --no-env-file run $preview preview --project $Project --plan $plan --upgrade --workspace $(if ($workspace) { $workspace } else { Join-Path $Project 'data\workspace' })
        if ($LASTEXITCODE -ne 0) { throw '数据版本或配置校验未通过；旧服务尚未停止。' }
        # The core repeats these rules under deploy.lock; checking first means nothing is asked when main, the task or the switch refuse.
        Set-OperationStage 'upgrade-preflight'
        if ((Invoke-ConsoleProcess $bun ($core + '--preflight')) -ne 0) { throw '升级预检未通过（原因见上方）；旧服务尚未停止。' }
        $arguments += @('--plan', $plan)
        if (-not (Test-Path -LiteralPath (Join-Path $Project 'data\config\directory.json') -PathType Leaf)) {
            Set-OperationStage 'directory-scope'
            $directoryScopeChoice = Join-Path $Project ('tmp\directory-scope-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
            # This is terminal interaction only; the selected file is installed by the TS host after stopping.
            Select-DirectoryScope $bun (Join-Path $releaseRoot 'ops\config\directory-scope.ts') $Project $directoryScopeChoice
            $arguments += @('--directory-plan', $directoryScopeChoice)
        }
    }
    Set-OperationStage 'shared-deployment-core'
    $operationExit = Invoke-ConsoleProcess $bun $arguments
} catch {
    Write-OperationFailure $_
    throw
} finally {
    # Only files this invocation named; the published snapshot has its own copies and survives an interrupted host.
    if ($plan) { Remove-Item -LiteralPath $plan -Force -ErrorAction SilentlyContinue }
    if ($directoryScopeChoice) { Remove-Item -LiteralPath $directoryScopeChoice -Force -ErrorAction SilentlyContinue }
    Stop-OperationLog $operation $operationExit
}
exit $operationExit
