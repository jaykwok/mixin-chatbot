# mixin-chatbot - Windows Server 部署（原生 Bun，无需 Docker）。
# agent 的 bash 工具需要 bash.exe；请安装 Git for Windows（同时提供 git）。
# 运行时：Bun（https://bun.sh）。
# 持久化：Windows 计划任务（优先开机启动、无需用户登录；失败自动重试）。
# 消息经平台事件 Stream 主动连出接收（imtwo.zdxlz.com、imfl.zdxlz.com 的 443 端口）；HTTP 只监听 127.0.0.1，无需入站端口。
#
# 请在管理员 PowerShell 中运行：
#   powershell -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1
# -Resume / -Rollback 处理中断的部署（ops resume / rollback 传入）；续做的设置全部来自事务记录。
param([switch]$Resume, [switch]$Rollback, [string]$ConfirmedTransaction = '')
$ErrorActionPreference = "Stop"
$Project  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Project
# 加载共享实例控制、部署事务和辅助函数。
$CommonLib = Join-Path $PSScriptRoot "..\lib\common.ps1"
if (-not (Test-Path -LiteralPath $CommonLib -PathType Leaf)) {
    Write-Host "缺少 $CommonLib；请从仓库完整获取脚本目录后重试。" -ForegroundColor Red
    exit 1
}
. $CommonLib
$operation = Start-OperationLog $Project 'deploy'
$operationExit = 1
try {
$Entry    = Join-Path $Project "src\server\index.ts"
$TaskName = "mixin-chatbot"
$DataDir = Join-Path $Project "data"
$ConfigDir = Join-Path $DataDir "config"
$StateDir = Join-Path $DataDir "state"
$RuntimeDir = Join-Path $DataDir "runtime"
$ModelsFile = Join-Path $ConfigDir "models.json"
$AppBotFile = Join-Path $ConfigDir "app-bot.json"
$PortFile = Join-Path $StateDir "bot-port"
$WorkspaceRootFile = Join-Path $StateDir "workspace-root"
$LauncherFile = Join-Path $RuntimeDir "bot-launcher.ps1"
$WindowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) { $WindowsPowerShell = "powershell.exe" }

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan; Set-OperationStage $m }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green; Write-OperationEvent 'info' $m }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow; Write-OperationEvent 'warn' $m }
function Fail($m) { Write-Host $m -ForegroundColor Red; Write-OperationEvent 'error' $m }
function Test-VersionedApplication([string]$Path, [string]$RequiredPattern = "") {
    try {
        $output = @(& $Path --version 2>$null)
        $exitCode = $LASTEXITCODE
    } catch {
        return $null
    }
    if ($exitCode -ne 0) { return $null }
    $text = ($output -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    if ($RequiredPattern -and $text -notmatch $RequiredPattern) { return $null }
    return [pscustomobject]@{ Path = $Path; Version = ($output | Select-Object -First 1) }
}
function Wait-BotHealth([string]$ListenPort, [int]$Attempts = 18, [switch]$AllowVerification) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if (Test-ProjectBotHealth $Project ([int]$ListenPort) -AllowVerification:$AllowVerification) { return $true }
        if ($attempt -lt $Attempts) { Start-Sleep -Seconds 3 }
    }
    return $false
}
function Get-ResultCodeHex($Value) {
    $unsigned = [int64]$Value -band [int64]0xffffffff
    return "0x" + [Convert]::ToString($unsigned, 16).PadLeft(8, '0').ToUpperInvariant()
}
function Test-S4ULogonFailure($Value) {
    # ERROR_LOGON_FAILURE / ERROR_LOGON_TYPE_NOT_GRANTED
    return (Get-ResultCodeHex $Value) -in @("0x8007052E", "0x80070569")
}

function Register-BotTask($Action, $Settings, [string]$UserId, [bool]$UseS4U) {
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        if ($existingTask.State -eq "Running") {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    if ($UseS4U) {
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType S4U -RunLevel Limited
    } else {
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
        $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    }
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $trigger -Settings $Settings -Principal $principal -Force | Out-Null
}

# ---- 1. 前置检查 ----
Step "检查运行环境..."
$gitPaths = @(Get-ApplicationPaths "git")
$knownGitRoots = @()
if ($env:ProgramFiles) { $knownGitRoots += (Join-Path $env:ProgramFiles "Git") }
if (${env:ProgramFiles(x86)}) { $knownGitRoots += (Join-Path ${env:ProgramFiles(x86)} "Git") }
if ($env:LOCALAPPDATA) { $knownGitRoots += (Join-Path $env:LOCALAPPDATA "Programs\Git") }
foreach ($candidateRoot in $knownGitRoots) {
    foreach ($candidateGit in @(
        (Join-Path $candidateRoot "cmd\git.exe"),
        (Join-Path $candidateRoot "bin\git.exe")
    )) {
        if ((Test-Path -LiteralPath $candidateGit -PathType Leaf) -and $gitPaths -notcontains $candidateGit) {
            $gitPaths += $candidateGit
        }
    }
}
$workingGitPaths = @()
foreach ($gitPathCandidate in $gitPaths) {
    $gitProbe = Test-VersionedApplication $gitPathCandidate '(?i)^git version\b'
    if ($gitProbe) { $workingGitPaths += $gitProbe.Path }
}
if ($workingGitPaths.Count -eq 0) {
    Fail "缺少 git。请安装 Git for Windows（同时提供 agent bash 工具所需的 bash.exe）："
    Write-Host "  https://git-scm.com/download/win"
    exit 1
}
$gitPath = $workingGitPaths[0]
$bashCandidates = @()
foreach ($workingGitPath in $workingGitPaths) {
    $candidateRoot = Split-Path (Split-Path $workingGitPath -Parent) -Parent
    foreach ($candidateBash in @(
        (Join-Path $candidateRoot "bin\bash.exe"),
        (Join-Path $candidateRoot "usr\bin\bash.exe")
    )) {
        if ((Test-Path -LiteralPath $candidateBash -PathType Leaf) -and $bashCandidates -notcontains $candidateBash) {
            $bashCandidates += $candidateBash
        }
    }
}
foreach ($candidateRoot in $knownGitRoots) {
    foreach ($candidateBash in @(
        (Join-Path $candidateRoot "bin\bash.exe"),
        (Join-Path $candidateRoot "usr\bin\bash.exe")
    )) {
        if ((Test-Path -LiteralPath $candidateBash -PathType Leaf) -and $bashCandidates -notcontains $candidateBash) {
            $bashCandidates += $candidateBash
        }
    }
}
foreach ($candidateBash in @(Get-ApplicationPaths "bash")) {
    # 排除 Windows 自带的 WSL 启动器；它不是 agent bash 工具需要的 GNU bash.exe。
    if ($candidateBash -match '(?i)(\\Windows\\System32\\bash\.exe$|\\WindowsApps\\bash\.exe$)') { continue }
    if ($bashCandidates -notcontains $candidateBash) { $bashCandidates += $candidateBash }
}
$BashPath = $null
$bashVersion = $null
foreach ($candidateBash in $bashCandidates) {
    $bashProbe = Test-VersionedApplication $candidateBash '(?i)GNU bash'
    if ($bashProbe) {
        $BashPath = $bashProbe.Path
        $bashVersion = $bashProbe.Version
        break
    }
}
if (-not $BashPath) {
    Fail "缺少 bash.exe。请安装并启用 Git Bash；agent bash 工具需要它。"
    exit 1
}
$BashDir = Split-Path $BashPath -Parent
Done "已找到 git（$gitPath）和 GNU bash（$BashPath）"
# npm 风格的 Bun 安装可能同时暴露 bun.cmd 和 bun；逐个探测具体路径，
# 避免 PowerShell 将多个匹配项拼成一个命令字符串。
$bunPaths = @(Get-ApplicationPaths "bun")
$knownBunPaths = @()
if ($env:USERPROFILE) { $knownBunPaths += (Join-Path $env:USERPROFILE ".bun\bin\bun.exe") }
if ($env:LOCALAPPDATA) { $knownBunPaths += (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\bun.exe") }
foreach ($knownBunPath in $knownBunPaths) {
    if ((Test-Path -LiteralPath $knownBunPath -PathType Leaf) -and $bunPaths -notcontains $knownBunPath) {
        $bunPaths += $knownBunPath
    }
}
if ($bunPaths.Count -eq 0) {
    Fail "缺少 bun。请选择一种方式安装："
    Write-Host "  powershell -c ""irm bun.sh/install.ps1 | iex"""
    Write-Host "  winget install Oven-sh.Bun"
    Write-Host "安装后请重新打开管理员 PowerShell，再运行部署脚本。"
    exit 1
}
$bunPath = $null
$bunVersion = $null
foreach ($bunPathCandidate in $bunPaths) {
    $bunProbe = Test-VersionedApplication $bunPathCandidate '^\d+(?:\.\d+)+'
    if ($bunProbe) {
        $bunPath = $bunProbe.Path
        $bunVersion = $bunProbe.Version
        break
    }
}
if (-not $bunPath) { Fail "bun --version 执行失败；找到的 bun 命令都不可用。"; exit 1 }
Done "bun 版本：$bunVersion"

# 从此处开始才允许修改持久配置、依赖和服务。
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "部署需要管理员权限；请在管理员终端中使用 $(Get-OpsCommandHint 'deploy')。" }
if ([Version]($bunVersion -replace '-.*$', '') -lt [Version]'1.4.4') { throw '需要 Bun 1.4.4 或更高版本。' }
$UvPath = @(Get-ApplicationPaths 'uv.exe' | Where-Object { Test-VersionedApplication $_ '^uv ' } | Select-Object -First 1)
if ($UvPath.Count -ne 1) { throw '缺少原生 uv.exe，请先安装 uv 并加入 PATH。' }
$UvDir = Split-Path $UvPath[0] -Parent
$env:PATH = $UvDir + ';' + $BashDir + ';' + $env:PATH

# 回滚未完成的部署。数据已提交时拒绝，只能继续完成新实例启动；判定在改动任何服务之前。
function Invoke-PendingDeploymentRollback($Snapshot) {
    $record = $Snapshot.Record
    $name = Split-Path $Snapshot.Path -Leaf
    $journal = Join-Path $StateDir 'release-data.json'
    try {
        $original = $record.original_workspace_root
        if ($original -and -not (Test-Path -LiteralPath $original -PathType Container)) {
            throw "原共享资料目录不存在：$original；原服务依赖它，请恢复原位置后再回滚。"
        }
        if (Test-Path -LiteralPath $journal) {
            & $bunPath run $dataPreparationRunner committed --project $Project --deployment $name
            if ($LASTEXITCODE -eq 0) { throw "上次操作的数据已经提交，不能回滚；请选择继续（$(Get-OpsCommandHint 'resume')）完成新实例启动。" }
        }
        Set-OperationStage 'rollback'
        Step "回滚上次部署：恢复数据、配置、依赖、计划任务和原运行状态..."
        if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '机器人进程未停止，拒绝恢复数据。' }
        if (Test-Path -LiteralPath $journal) {
            & $bunPath run $dataPreparationRunner rollback --project $Project --deployment $name
            if ($LASTEXITCODE -eq 42) { throw "上次操作的数据已经提交，不能回滚；请选择继续（$(Get-OpsCommandHint 'resume')）完成新实例启动。" }
            if ($LASTEXITCODE -ne 0) { throw '数据恢复失败；保持停机，保留快照和迁移备份。' }
        }
        Remove-Item -LiteralPath (Join-Path $StateDir 'verify-only') -Force -ErrorAction SilentlyContinue
        Restore-DeploymentSnapshot $Snapshot
        Remove-Item -LiteralPath (Join-Path $StateDir 'deploy-transaction') -Force
        Write-OperationEvent 'info' ('pending deployment rolled back; snapshot=' + $Snapshot.Path)
        $serviceState = if ($Snapshot.WasRunning) { '机器人服务已重新启动' } else { '机器人服务保持停止' }
        Done "上次部署已回滚：配置、依赖和计划任务已恢复到部署前；$serviceState。"
    } finally {
        $Snapshot.Lock.Dispose()
        $env:BOT_DEPLOY_BACKUP_ID = $Snapshot.PreviousBackupId
    }
}

# ---- 未完成的事务：先继续或回滚，再读取普通部署设置 ----
# 续做和回滚只使用事务记录，不重新读取默认值或环境变量。
if ($Resume -and $Rollback) { throw '-Resume 与 -Rollback 只能选择一个。' }
if ($ConfirmedTransaction -and -not ($Resume -or $Rollback)) { throw '事务确认凭据只能用于继续或回滚' }
$dataPreparationRunner = Join-Path $Project 'scripts\runtime\data-current.ts'
if (Test-Path -LiteralPath (Join-Path $StateDir 'upgrade-transaction')) {
    throw "发现未完成的升级；请使用 $(Get-OpsCommandHint 'resume') 继续，或 $(Get-OpsCommandHint 'rollback') 回滚。"
}
$pendingSnapshot = $null
$record = $null
if (Test-Path -LiteralPath (Join-Path $StateDir 'deploy-transaction')) {
    $confirmedAction = if ($Rollback) { 'rollback' } else { 'continue' }
    $pendingSnapshot = Open-DeploymentTransaction $Project $ConfirmedTransaction $confirmedAction
    $record = $pendingSnapshot.Record
    Warn (Format-DeploymentTransaction $record)
    $transactionAction = if ($Resume) { 'continue' } elseif ($Rollback) { 'rollback' } else {
        try { Read-TransactionAction } catch { $pendingSnapshot.Lock.Dispose(); throw }
    }
    if (-not $transactionAction) {
        $pendingSnapshot.Lock.Dispose()
        Warn '未处理上次操作，服务保持当前状态。'
        exit 1
    }
    if ($transactionAction -eq 'rollback') {
        Invoke-PendingDeploymentRollback $pendingSnapshot
        $operationExit = 0
        return
    }
    try {
        $head = [string](& $gitPath -C $Project rev-parse HEAD 2>$null)
        if ($record.target_sha -and $head.Trim() -ne $record.target_sha) {
            throw "当前代码不是上次部署的目标提交 $($record.target_sha.Substring(0, 7))；请切回该提交后继续，或回滚。"
        }
        $pendingName = Split-Path $pendingSnapshot.Path -Leaf
        $pendingCommitted = $false
        if (Test-Path -LiteralPath (Join-Path $StateDir 'release-data.json')) {
            & $bunPath run $dataPreparationRunner committed --project $Project --deployment $pendingName
            $pendingCommitted = $LASTEXITCODE -eq 0
        }
        if ($pendingCommitted) {
            # 数据在上次中断前已经提交：配置和计划任务都已就位，只需启动新实例。
            # 不重新迁移；实例未就绪时保留事务指针，可再次继续。
            Set-OperationStage 'activate-service'
            Step "上次部署的数据已经提交，启动新实例（不再迁移）..."
            if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '验证实例未停止' }
            Remove-Item -LiteralPath (Join-Path $StateDir 'verify-only') -Force -ErrorAction SilentlyContinue
            Enable-ScheduledTask -TaskName $TaskName | Out-Null
            Start-ScheduledTask -TaskName $TaskName
            if (-not (Wait-BotHealth $record.bot_port)) { throw "数据已提交，但业务实例未就绪；保留新版本，请使用 $(Get-OpsCommandHint 'logs') 检查后使用 $(Get-OpsCommandHint 'resume') 继续。" }
            Remove-Item -LiteralPath (Join-Path $StateDir 'deploy-transaction') -Force
            try { Remove-CompletedBackup $pendingSnapshot.Path $Project }
            catch { Warn ('部署已完成，但备份清理未完成，请检查 backup/snapshots 和 backup/rm：' + $_.Exception.Message) }
            Done "上次部署已完成，机器人已启动。"
            $operationExit = 0
        }
    } catch { $pendingSnapshot.Lock.Dispose(); $env:BOT_DEPLOY_BACKUP_ID = $pendingSnapshot.PreviousBackupId; throw }
    if ($pendingCommitted) {
        $pendingSnapshot.Lock.Dispose()
        $env:BOT_DEPLOY_BACKUP_ID = $pendingSnapshot.PreviousBackupId
        return
    }
    Step "继续上次部署：端口和共享资料目录取自事务记录"
} elseif ($Resume -or $Rollback) {
    if ($ConfirmedTransaction) { throw '确认后的部署事务已消失，请刷新预览' }
    Done '没有未完成的部署。'
    $operationExit = 0
    return
}
$resuming = [bool]$pendingSnapshot
if ($resuming) {
    # 续做的运行参数沿用 runtime.json；当前终端的环境变量既不校验也不写入。
    foreach ($key in @('BOT_MAX_ACTIVE_REQUESTS', 'BOT_BASH_TIMEOUT', 'BOT_INDEX_TTL_MINUTES', 'BOT_INDEX_MAX_FILES', 'BOT_INDEX_MAX_DEPTH',
        'BOT_RUN_TIMEOUT_SECONDS', 'BOT_MODEL_IDLE_TIMEOUT_SECONDS', 'BOT_MODEL_RESPONSE_TIMEOUT_SECONDS', 'BOT_SHUTDOWN_TIMEOUT_SECONDS',
        'BOT_DOCUMENT_ENV', 'BOT_DOCUMENT_WORK_ENABLED', 'BOT_DOCUMENT_PPTX_TEMPLATE', 'BOT_DOCUMENT_DOCX_TEMPLATE',
        'PI_CACHE_RETENTION', 'BOT_ATTACHMENT_CONCURRENCY')) {
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    }
}

# 运行参数属于普通部署设置：回滚和已提交的续做在上方已经结束，不读取也不校验它们。
$savedRuntime = @{}
$runtimeFile = Join-Path $ConfigDir 'runtime.json'
if (Test-Path -LiteralPath $runtimeFile) {
    try { $savedRuntime = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch {
        $next = if ($resuming) { "修正后重试继续，或使用 $(Get-OpsCommandHint 'rollback') 回滚" } else { '修正后重新部署' }
        throw "data\config\runtime.json 无法解析（$($_.Exception.Message)）；$next。"
    }
}
$BotMaxActiveRequests = if ($env:BOT_MAX_ACTIVE_REQUESTS) { $env:BOT_MAX_ACTIVE_REQUESTS.Trim() }
    elseif ($savedRuntime.BOT_MAX_ACTIVE_REQUESTS) { [string]$savedRuntime.BOT_MAX_ACTIVE_REQUESTS } else { '32' }
$parsedMaxActiveRequests = 0
if (-not [int]::TryParse($BotMaxActiveRequests, [ref]$parsedMaxActiveRequests) -or
    $parsedMaxActiveRequests -lt 1 -or $parsedMaxActiveRequests -gt 1000) {
    Fail "BOT_MAX_ACTIVE_REQUESTS 必须是 1–1000 的整数。"
    exit 1
}

# ---- 4b. 共享资料目录（默认 data\workspace；WORKSPACE_ROOT 可指向已存在的外置目录，服务只读）----
# 续做沿用事务记录；否则取 WORKSPACE_ROOT，未设置时沿用已保存设置。设为 data\workspace 即恢复默认。外置目录不创建。
$DefaultWorkspace = Join-Path $DataDir 'workspace'
$workspaceRequest = if ($resuming) { $record.target_workspace_root }
    elseif (-not [string]::IsNullOrWhiteSpace($env:WORKSPACE_ROOT)) { $env:WORKSPACE_ROOT.Trim() }
    else { Get-SavedWorkspaceRoot $Project }
$WorkspaceRoot = ''
if ($workspaceRequest) {
    try {
        $workspaceCandidate = if ([System.IO.Path]::IsPathRooted($workspaceRequest)) { [System.IO.Path]::GetFullPath($workspaceRequest) }
            else { [System.IO.Path]::GetFullPath((Join-Path $Project $workspaceRequest)) }
    } catch { throw "WORKSPACE_ROOT 路径无效：$workspaceRequest；服务尚未停止。" }
    if ($workspaceCandidate.TrimEnd('\') -ne $DefaultWorkspace.TrimEnd('\')) {
        if (-not (Test-Path -LiteralPath $workspaceCandidate -PathType Container)) {
            $next = if ($resuming) { '请恢复该目录后重试继续，或回滚' } else { '外置资料目录必须已存在；服务尚未停止' }
            throw "共享资料目录不存在或不是目录：$workspaceCandidate；$next。"
        }
        $WorkspaceRoot = (Resolve-Path -LiteralPath $workspaceCandidate).Path
    }
}
Done "共享资料目录：$(if ($WorkspaceRoot) { "$WorkspaceRoot（外置，服务只读）" } else { "$DefaultWorkspace（默认）" })"
# 数据预检与提交都按最终资料目录核对布局（runtime.json 要到预检之后才写入新值）；空字符串参数会被 Windows PowerShell 丢弃，默认目录写全路径。
$finalWorkspace = if ($WorkspaceRoot) { $WorkspaceRoot } else { $DefaultWorkspace }

$dataPreparationPlan = Join-Path $Project ('tmp\data-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
$dataPreparationPlanned = $false
$dataPreparationAttempted = $resuming -and (Test-Path -LiteralPath (Join-Path $StateDir 'release-data.json'))
$recordedDataPreparationPlan = if ($resuming) { Join-Path $pendingSnapshot.Path 'data-plan.json' } else { '' }
# 续做不能提问：迁移预览不带 --interactive，需要确认时停止。
# 外层 @() 保留数组；if 的单元素输出会变成字符串，传给原生程序时被 splat 拆成逐个字符。

# 数据版本在停机前核对：有数据但没有有效版本标记（含旧版 webhook 数据）时拒绝，旧服务不受影响。
if (-not $resuming) {
    & $bunPath run $dataPreparationRunner check --project $Project --workspace $finalWorkspace
    if ($LASTEXITCODE -ne 0) { throw '数据版本核对未通过（原因见上方）；旧服务尚未停止' }
}
if ($recordedDataPreparationPlan -and (Test-Path -LiteralPath $recordedDataPreparationPlan -PathType Leaf)) {
    # 续做沿用停机前的数据预检计划；apply 会重新核对版本标记，变化即中止。
    $dataPreparationPlan = $recordedDataPreparationPlan
    $dataPreparationPlanned = $true
} elseif ((Test-Path -LiteralPath $ModelsFile) -and (Test-Path -LiteralPath (Join-Path $RuntimeDir 'pi\settings.json'))) {
    & $bunPath run $dataPreparationRunner preview --project $Project --plan $dataPreparationPlan --workspace $finalWorkspace
    if ($LASTEXITCODE -ne 0) {
        if ($resuming) { throw '续做无法沿用数据预检（原因见上方）；服务保持停止，请回滚后重新部署。' }
        throw '数据预检未通过；旧服务尚未停止'
    }
    $dataPreparationPlanned = $true
}
# ---- 停机前的交互选择：只读取和校验，全部答完才停止机器人服务 ----
$reconfigureAi = $false
if ($resuming) {
    # 续做不运行需要交互的配置向导；缺少模型配置时停止，由回滚后的部署完成配置。
    foreach ($required in @($ModelsFile, $AppBotFile)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "缺少 data\config\$(Split-Path $required -Leaf)；续做不运行配置向导，服务保持停止。请回滚（$(Get-OpsCommandHint 'rollback')）后重新部署。"
        }
    }
    if ($record.reconfigure_ai -eq '1') { Warn '上次选择的 AI 重新配置不会在续做中运行；需要时请在部署完成后重新部署修改。' }
} elseif (Test-Path -LiteralPath $ModelsFile -PathType Leaf) {
    Done "data\config\models.json 已存在"
    $reconfigureAi = Read-YesNo "是否重新配置 AI（provider/key/model）？[y/N]" $false
    if ($reconfigureAi) { Write-Host "  配置向导需要新安装的依赖，将在停止机器人服务并安装依赖后打开。" }
}

# 量子密信的 HTTP 回调已停用：消息经平台事件 Stream 主动连出接收，HTTP 只监听本机，供健康检查和管理使用。
$BotHost = '127.0.0.1'

# ---- 4c. 本机管理端口（不询问：事务记录 > 显式 BOT_PORT 高级覆盖 > 已保存值 > 1011）----
# 无效或被其他程序占用的端口在停机前停止并说明改法，不自动换成别的端口。
$savedPort = if (Test-Path -LiteralPath $PortFile) { "$(Get-Content -LiteralPath $PortFile -Raw)".Trim() } else { $null }
$portSource = ""
$rawPort = if ($resuming) {
    $portSource = "事务记录"
    $record.bot_port
} elseif (-not [string]::IsNullOrWhiteSpace($env:BOT_PORT)) {
    $portSource = "BOT_PORT"
    $env:BOT_PORT.Trim()
} elseif ($null -ne $savedPort) {
    $portSource = "data\state\bot-port"
    $savedPort
} else {
    "1011"
}
$portFix = if ($resuming) {
    "续做沿用事务记录的端口；请回滚后再设置 BOT_PORT 重新部署改端口"
} else {
    "改端口：设置环境变量 BOT_PORT=<端口> 后重新部署（$(Get-OpsCommandHint deploy)）；服务尚未停止"
}
$portNumber = 0
if (-not ([int]::TryParse($rawPort, [ref]$portNumber) -and $portNumber -ge 1 -and $portNumber -le 65535)) {
    throw "$portSource 中的端口无效（应为 1–65535 的整数）：$rawPort；$portFix"
}
$Port = "$portNumber"
# 沿用的端口可能正由原服务监听，不探测；新端口（含首次部署）要先确认没有其他程序占用。
if (-not $resuming -and $Port -ne $savedPort) {
    $probe = [System.Net.Sockets.TcpClient]::new()
    try {
        $inUse = $false
        try { $inUse = $probe.ConnectAsync('127.0.0.1', $portNumber).Wait(2000) } catch { $inUse = $false }
    } finally { $probe.Dispose() }
    if ($inUse) { throw "本机端口 $Port 已被其他程序占用；$portFix" }
}
Done "本机管理端口：127.0.0.1:$Port$(if ($portSource) { "（来自 $portSource）" })"

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

Set-OperationStage 'deployment-snapshot'
$transactionPointer = Join-Path $StateDir 'deploy-transaction'
if ($resuming) {
    $snapshot = $pendingSnapshot
} else {
    $snapshot = New-DeploymentSnapshot $Project $TaskName
    try {
        # 解压得到的部署没有 Git 提交，目标提交留空。
        $targetSha = ''
        try {
            $head = [string](& $gitPath -C $Project rev-parse HEAD 2>$null)
            if ($LASTEXITCODE -eq 0) { $targetSha = $head.Trim() }
        } catch { $targetSha = '' }
        Publish-DeploymentTransaction $snapshot @{
            format = '2'; operation = 'deploy'; snapshot = (Split-Path $snapshot.Path -Leaf); target_sha = $targetSha
            original_sha = ''; original_branch = ''; original_workspace_root = (Get-SavedWorkspaceRoot $Project); target_workspace_root = $WorkspaceRoot
            was_running = $(if ($snapshot.WasRunning) { '1' } else { '0' }); bot_port = $Port
            reconfigure_ai = $(if ($reconfigureAi) { '1' } else { '0' })
        } $transactionPointer $(if ($dataPreparationPlanned) { $dataPreparationPlan } else { '' })
    } catch { $snapshot.Lock.Dispose(); $env:BOT_DEPLOY_BACKUP_ID = $snapshot.PreviousBackupId; throw }
}
Write-OperationEvent 'info' ('snapshot=' + $snapshot.Path)
$deploymentCommitted = $false
$deploymentActivated = $false
# 续做的快照在上次运行中已经改动过部署，失败同样回滚。
$deploymentMutated = $resuming
try {
    if ($snapshot.WasRunning) { Step "停止机器人服务（计划任务 $TaskName）..." }
    if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '机器人服务未能停止，部署已取消。' }
    $deploymentMutated = $true
    if ($snapshot.WasRunning) { Done "已停止机器人服务（计划任务 $TaskName）；部署完成前不处理消息。" }
    elseif ($snapshot.TaskXml) { Done "机器人服务当前未运行（计划任务 $TaskName），部署完成后启动。" }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
    Save-DeploymentDependencies $snapshot
# ---- 2. 依赖 ----
Step "安装依赖（bun install --frozen-lockfile）..."
$bunInstallExitCode = Invoke-OperationNative $bunPath @('install', '--frozen-lockfile')
if ($bunInstallExitCode -ne 0) { Fail "bun install 执行失败（退出码 $bunInstallExitCode）。"; exit 1 }
if ($dataPreparationPlanned) {
    $dataPreparationAttempted = $true
    & $bunPath run $dataPreparationRunner apply --project $Project --plan $dataPreparationPlan
    if ($LASTEXITCODE -ne 0) { throw '数据准备失败' }
}

# ---- 3. 持久化目录 + 应用机器人凭据 + AI 配置 ----
New-Item -ItemType Directory -Force -Path $ConfigDir, $StateDir, $RuntimeDir, (Join-Path $Project "logs") | Out-Null
Protect-ProjectSecretPath $ConfigDir
Protect-ProjectSecretPath $StateDir
# 向导全程是中文提示，不切 UTF-8 就没法读，见 Invoke-WithUtf8Output。
function Invoke-ConfigureWizard([string]$Script, [string]$Label) {
    $previousErrorActionPreference = $ErrorActionPreference
    $configureExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        Invoke-WithUtf8Output { & $bunPath run $Script }
        $configureExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($configureExitCode -ne 0) { throw "$($Label)失败（退出码 $configureExitCode）。" }
}
if (-not (Test-Path -LiteralPath $ModelsFile -PathType Leaf)) {
    # 首次配置先问应用机器人凭据（缺少时），再问模型。
    Step "首次配置应用机器人凭据和 AI（provider/key/model）..."
    Invoke-ConfigureWizard configure '配置'
    if (-not (Test-Path -LiteralPath $ModelsFile -PathType Leaf)) { throw "未生成 data\config\models.json，部署中止。" }
} elseif (-not (Test-Path -LiteralPath $AppBotFile -PathType Leaf)) {
    Step "配置应用机器人凭据..."
    Invoke-ConfigureWizard configure-app-bot '应用机器人配置'
}
if ($reconfigureAi) {
    # 是否重配已在停机前确认；向导依赖刚安装的依赖，只能在这里运行。
    Step "重新配置 AI（provider/key/model）..."
    Invoke-ConfigureWizard configure 'AI 配置'
}

if (-not (Test-ModelConfiguration $Project)) { throw '模型配置无效，正在恢复原部署。' }
if (-not (Test-Path -LiteralPath $AppBotFile -PathType Leaf)) { throw '缺少 data\config\app-bot.json（应用机器人凭据），正在恢复原部署。' }
Protect-ProjectSecretPath $AppBotFile

# 旧服务已在依赖和配置变更之前停止，所有后续失败统一进入 finally 回滚。
function Sq($s) { return "'" + ($s -replace "'", "''") + "'" }
function Save-DeploymentState {
    Set-Content -LiteralPath $PortFile -Value $Port -NoNewline -Encoding ASCII
    Set-Content -LiteralPath $WorkspaceRootFile -Value $WorkspaceRoot -NoNewline -Encoding UTF8
}
# 原生服务从 runtime.json 读取 WORKSPACE_ROOT；默认目录不写入（runtime-settings.ts 删除该项）。
$env:WORKSPACE_ROOT = if ($WorkspaceRoot) { $WorkspaceRoot } else { $DefaultWorkspace }
# 构建标识（src/core/version.ts 的 APP_BUILD）随提交记入部署记录；启动器每次启动时按检出重新取得。
$env:APP_BUILD = Get-CheckoutBuild $gitPath $Project
$env:BOT_PORT = $Port
$env:BOT_HOST = $BotHost
$env:BOT_MAX_ACTIVE_REQUESTS = $BotMaxActiveRequests
if (-not $dataPreparationPlanned) {
    & $bunPath run $dataPreparationRunner preview --project $Project --plan $dataPreparationPlan --workspace $finalWorkspace
    if ($LASTEXITCODE -ne 0) { throw '数据预检失败' }
    $dataPreparationAttempted = $true
    & $bunPath run $dataPreparationRunner apply --project $Project --plan $dataPreparationPlan
    if ($LASTEXITCODE -ne 0) { throw '数据准备失败' }
}
Set-Content -LiteralPath (Join-Path $StateDir 'verify-only') -Value 'verify' -Encoding ASCII
Invoke-WithUtf8Output { & $bunPath run scripts/config/runtime-settings.ts }
if ($LASTEXITCODE -ne 0) { throw '运行配置持久化失败' }
$launcherBody = @"
`$ErrorActionPreference = 'Stop'
`$env:PATH = $(Sq ($UvDir + ";" + $BashDir + ";")) + `$env:PATH
Set-Location $(Sq $Project)
. $(Sq (Join-Path $Project 'scripts\lib\bot-supervisor.ps1'))
`$botExitCode = Invoke-BotSupervision -BunPath $(Sq $bunPath) -Entry $(Sq $Entry) -GitPath $(Sq $gitPath)
exit `$botExitCode
"@
$utf8WithBom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($LauncherFile, $launcherBody, $utf8WithBom)

Step "安装 Windows 计划任务 '$TaskName'（优先开机启动，失败自动重试）..."
$fileArg = '-NoProfile -ExecutionPolicy Bypass -File "' + $LauncherFile + '"'
$action    = New-ScheduledTaskAction -Execute $WindowsPowerShell -Argument $fileArg -WorkingDirectory $Project
$settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
# RunLevel Limited：bot 只需监听所选端口并写入 data/ 与 logs/，无需管理员；
# 降权可缩小 agent bash 工具（非 cwd 沙箱）的影响范围。
$taskStartDescription = "开机启动（无需用户登录）"
$taskUsesS4U = $true
try {
    Register-BotTask $action $settings $currentUser $true
} catch {
    # 某些服务器安全策略禁止 S4U；回退到兼容性更好的交互式登录任务。
    Warn "无法注册无需登录的开机任务：$($_.Exception.Message)"
    Warn "回退为 $currentUser 登录时启动；如需无人值守，请授予该账户“作为批处理作业登录”权限后重新部署。"
    Register-BotTask $action $settings $currentUser $false
    $taskUsesS4U = $false
    $taskStartDescription = "$currentUser 登录时启动"
}
try {
    Start-ScheduledTask -TaskName $TaskName
} catch {
    if (-not $taskUsesS4U) { throw }
    Warn "无需登录的开机任务无法启动：$($_.Exception.Message)"
    Warn "自动回退为 $currentUser 登录时启动。"
    Register-BotTask $action $settings $currentUser $false
    $taskUsesS4U = $false
    $taskStartDescription = "$currentUser 登录时启动"
    Start-ScheduledTask -TaskName $TaskName
}
if ($taskUsesS4U) {
    Start-Sleep -Seconds 2
    $probeTaskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($probeTaskInfo -and (Test-S4ULogonFailure $probeTaskInfo.LastTaskResult)) {
        $probeCode = Get-ResultCodeHex $probeTaskInfo.LastTaskResult
        Warn "系统拒绝 S4U 任务登录（$probeCode），自动回退为 $currentUser 登录时启动。"
        Register-BotTask $action $settings $currentUser $false
        $taskUsesS4U = $false
        $taskStartDescription = "$currentUser 登录时启动"
        Start-ScheduledTask -TaskName $TaskName
    }
}
Step "等待部署预检通过..."
$healthy = Wait-BotHealth $Port -AllowVerification
if (-not $healthy) {
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    $lastResult = if ($taskInfo) { "$(Get-ResultCodeHex $taskInfo.LastTaskResult) / $($taskInfo.LastTaskResult)" } else { "未知" }
    Fail "部署预检未通过（任务结果：$lastResult）。请在 $(Get-OpsCommandHint 'logs') 查看日志，并使用 $(Get-OpsCommandHint 'doctor')。"
    throw "新部署未通过预检"
}
Done "部署预检通过"
# 登录时启动意味着无人值守重启后不会自动运行，需要提醒；正常的开机任务只做说明。
if ($taskUsesS4U) { Done "任务启动方式：$taskStartDescription。" } else { Warn "任务启动方式：$taskStartDescription。" }

# 部署预检通过后再提交，避免 doctor 读取半完成配置。
Step "提交部署..."
Save-DeploymentState
Done "部署状态已写入 data\state。"
if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '验证实例未停止' }
& $bunPath run $dataPreparationRunner commit --project $Project --deployment (Split-Path $snapshot.Path -Leaf) --workspace $finalWorkspace
if ($LASTEXITCODE -ne 0) { throw '数据提交失败' }
$deploymentCommitted = $true
Remove-Item -LiteralPath (Join-Path $StateDir 'verify-only') -Force
Step "启动机器人并等待健康检查..."
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName
if (-not (Wait-BotHealth $Port)) { throw "数据已提交，但业务实例未就绪；保留新版本，请使用 $(Get-OpsCommandHint 'logs') 检查后使用 $(Get-OpsCommandHint 'resume') 继续。" }
$deploymentActivated = $true
Done "机器人已启动（共享资料目录=$(if ($WorkspaceRoot) { $WorkspaceRoot } else { $DefaultWorkspace })）。停止请用 $(Get-OpsCommandHint 'stop')；日志：$(Get-OpsCommandHint 'logs')"
Done "消息接收：平台事件 Stream（主动连出 imtwo.zdxlz.com、imfl.zdxlz.com 的 443 端口，无需入站端口或公网域名）。"
Done "可选大文件外链：不超过 30 MiB 的文件直接发送；更大的文件需要外链，运行 bun run tui，进入「系统 → 设置 → 外链配置」按需启用。"

} catch { Write-OperationFailure $_; throw } finally {
    if (-not $deploymentCommitted -and $deploymentMutated) {
        Set-OperationStage 'rollback'
        try {
            if ($dataPreparationAttempted) {
                if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '验证实例未停止，拒绝恢复数据' }
                & $bunPath run $dataPreparationRunner rollback --project $Project --deployment (Split-Path $snapshot.Path -Leaf)
                if ($LASTEXITCODE -ne 0) { throw '数据已提交或恢复失败；保持停机，保留备份' }
            }
            Remove-Item -LiteralPath (Join-Path $StateDir 'verify-only') -Force -ErrorAction SilentlyContinue
            Restore-DeploymentSnapshot $snapshot
            Remove-Item -LiteralPath $transactionPointer -Force -ErrorAction Stop
            Write-OperationEvent 'info' ('data and deployment restored; snapshot=' + $snapshot.Path)
            $serviceState = if ($snapshot.WasRunning) { '机器人服务已重新启动' } else { '机器人服务保持停止' }
            Write-Host ('部署已回滚：配置、依赖和计划任务已恢复到部署前；' + $serviceState + '。') -ForegroundColor Yellow
        }
        catch {
            Write-OperationFailure $_
            Write-Host ("自动回滚未完成，保留快照 " + $snapshot.Path + "：" + $_.Exception.Message) -ForegroundColor Red
            Write-Host "处理后可用 $(Get-OpsCommandHint 'resume') 继续，或 $(Get-OpsCommandHint 'rollback') 重试回滚。" -ForegroundColor Red
        }
    } elseif ($deploymentActivated) {
        Remove-Item -LiteralPath $transactionPointer -Force -ErrorAction SilentlyContinue
        try { Remove-CompletedBackup $snapshot.Path $Project }
        catch { Warn ('部署已完成，但备份清理未完成，请检查 backup/snapshots 和 backup/rm：' + $_.Exception.Message) }
    } elseif ($deploymentCommitted) {
        # 数据已提交但新实例未就绪：保留事务，继续时只启动新实例，不再迁移。
        Write-OperationEvent 'warn' ('committed deployment awaits activation; snapshot=' + $snapshot.Path)
    } else {
        # 停机前失败，部署未被改动。
        Remove-Item -LiteralPath $transactionPointer -Force -ErrorAction SilentlyContinue
    }
    $snapshot.Lock.Dispose()
    $env:BOT_DEPLOY_BACKUP_ID = $snapshot.PreviousBackupId
}
$operationExit = 0
} catch { Write-OperationFailure $_; throw }
finally { Stop-OperationLog $operation $operationExit }
