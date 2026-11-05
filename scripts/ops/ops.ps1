# mixin-chatbot 运维工具（Windows Server）。
# 一站式运维：诊断/修复、服务安装与卸载、前台运行、日志和完整清理。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 <命令>
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 doctor -Repair
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 update
#   不带参数显示完整帮助。
#
# 部署、修复和服务控制可能需要管理员权限。
param(
    [Parameter(Position = 0)]
    [string]$Command = "",
    # relay-purge 的关键字、stat/history-clear 的群号、backup-clean 的报告名，
    # 或 directory-scope 的 all（部门在控制台的通讯录页勾选）。
    [Parameter(Position = 1)]
    [string]$Target = "",
    [switch]$Repair,
    # doctor 以单行 JSON 输出逐项结果，供控制台读取；人类可读的输出保持原样。
    [switch]$Json,
    # tmp-purge 的范围。PowerShell 会把 --days 这种 token 当参数名去绑定，所以这里用原生
    # 开关，由脚本翻译成 tmp-admin.ts 的 --days/--all/--user/--group。
    [int]$Days = -1,
    [switch]$All,
    [string]$User = "",
    [string]$Plan = "",
    [string]$Digest = "",
    # stat 的统计区间（YYYY-MM-DD），同样翻译成脚本的 --since/--until。
    [string]$Since = "",
    [string]$Until = "",
    [string]$Period = "",
    # stat/history 的群；也可用于限定 tmp-ls/tmp-purge 的群（-Group direct 为单聊空间）。
    [string]$Group = "",
    [switch]$StorageSegment,
    [switch]$GroupId,
    # history-clear / history-compact 选择单聊空间而不是某个群。
    [switch]$Direct,
    # backup-clean 的确认码（预演时给出）；不用 -Confirm，那是 PowerShell 的通用参数名。
    [string]$ConfirmCode = "",
    # revision-cleanup shrink / shrink-preview 只处理这些空间（direct 或 groups/<目录名>，多个用逗号分隔并加引号）；
    # restore 从备份恢复的那一个空间；shrink-remove-old 加 -Yes 才删除。
    [string]$Space = "",
    [switch]$Yes,
    [string]$ConfirmedTransaction = "",
    [string]$Expect = "",
    [string]$RequestBase64 = ""
)

$ErrorActionPreference = "Stop"
$script:OpsInputNames = @($PSBoundParameters.Keys)

# 控制台按 UTF-8 读取 stdout/stderr，不能沿用 Windows PowerShell 5.1 的系统代码页。
if ($RequestBase64) {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $OutputEncoding = [Console]::OutputEncoding
}

# 先解码控制台的请求：恢复入口要在读取普通设置之前识别。
# Decode data after PowerShell parameter binding; no expression evaluation or token reparsing.
if ($RequestBase64) {
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
    foreach ($property in $request.PSObject.Properties) {
        if ($property.Name -notin @('Command', 'Target', 'Group', 'User', 'Days', 'All', 'Json', 'StorageSegment', 'Direct', 'ConfirmedTransaction', 'Plan', 'Digest', 'Expect', 'ConfirmCode')) {
            throw "无效的运维请求字段"
        }
        $script:OpsInputNames += $property.Name
        Set-Variable -Name $property.Name -Value $property.Value
    }
}
if ($StorageSegment -and $GroupId) { throw "群目录选择参数互斥" }

$OpsSource = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Project = if ($env:MIXIN_OPS_PROJECT) { [IO.Path]::GetFullPath($env:MIXIN_OPS_PROJECT) } else { $OpsSource }
# 与其他 Windows 脚本共用的纯辅助函数（可执行文件发现、交互提示）。
$CommonLib = Join-Path $PSScriptRoot "..\lib\common.ps1"
if (-not (Test-Path -LiteralPath $CommonLib -PathType Leaf)) {
    Write-Host "缺少 $CommonLib；请从仓库完整获取脚本目录后重试。" -ForegroundColor Red
    exit 1
}
. $CommonLib
$TaskName = "mixin-chatbot"
$DataDir = Join-Path $Project "data"
$ConfigDir = Join-Path $DataDir "config"
$StateDir = Join-Path $DataDir "state"
$RuntimeDir = Join-Path $DataDir "runtime"
$LogPath  = Join-Path $Project "logs\mixin-chatbot.log"
$ModelsFile = Join-Path $ConfigDir "models.json"
$AppBotFile = Join-Path $ConfigDir "app-bot.json"
$RelayConfigFile = Join-Path $ConfigDir "relay.json"
$WindowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) { $WindowsPowerShell = "powershell.exe" }

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[x] $m" -ForegroundColor Red; Write-OperationEvent 'error' $m }
function Find-VersionedApplication([string]$Name, [string]$Pattern, [string[]]$AdditionalPaths = @()) {
    $candidates = @(Get-ApplicationPaths $Name)
    foreach ($extra in $AdditionalPaths) {
        if ($extra -and (Test-Path -LiteralPath $extra -PathType Leaf) -and $candidates -notcontains $extra) {
            $candidates += $extra
        }
    }
    foreach ($candidate in $candidates) {
        try {
            $output = @(& $candidate --version 2>$null)
            $exitCode = $LASTEXITCODE
        } catch {
            continue
        }
        if ($exitCode -eq 0 -and (($output -join "`n") -match $Pattern)) { return $candidate }
    }
    return $null
}
function Get-TaskResultHex($Value) {
    $unsigned = [int64]$Value -band [int64]0xffffffff
    return "0x" + [Convert]::ToString($unsigned, 16).PadLeft(8, '0').ToUpperInvariant()
}
function Get-TaskLogonLabel($LogonType) {
    switch ([string]$LogonType) {
        "S4U" { return "S4U（无需登录）" }
        "InteractiveToken" { return "交互式登录" }
        "Interactive" { return "交互式登录" }
        default { return [string]$LogonType }
    }
}
function Get-TaskStateLabel($State) {
    switch ([string]$State) {
        "Running" { return "运行中" }
        "Ready" { return "就绪" }
        "Disabled" { return "已禁用" }
        "Queued" { return "排队中" }
        default { return [string]$State }
    }
}
$script:GitPath = $null
$script:GitPathResolved = $false
function Get-GitPath {
    if (-not $script:GitPathResolved) {
        $additional = @()
        foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
            if (-not $root) { continue }
            $additional += (Join-Path $root "Git\cmd\git.exe")
            $additional += (Join-Path $root "Git\bin\git.exe")
        }
        $script:GitPath = Find-VersionedApplication "git" '(?i)^git version\b' $additional
        $script:GitPathResolved = $true
    }
    return $script:GitPath
}
$script:BunPath = $null
$script:BunPathResolved = $false
function Get-BunPath {
    if (-not $script:BunPathResolved) {
        $additional = @()
        if ($env:USERPROFILE) { $additional += (Join-Path $env:USERPROFILE ".bun\bin\bun.exe") }
        if ($env:LOCALAPPDATA) { $additional += (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\bun.exe") }
        $script:BunPath = Find-VersionedApplication "bun" '^\d+(?:\.\d+)+' $additional
        $script:BunPathResolved = $true
    }
    return $script:BunPath
}

# 外链运维（列出、测试、清理）交给运维核心，这边只转交参数。对象签名和精确删除由 TypeScript 管理，shell 不接触凭据：
# 这些知识全在 src\integrations\relay.ts；在 PowerShell 里抄一遍等于把它维护成两份，而且凭据会出现在命令行参数里，
# 同机器上任何用户都能用 WMI 读到别人进程的完整命令行。
function Invoke-RelayAdmin([string[]]$RelayArgs) {
    $script:OpsCoreExitCode = 1
    if (@($script:OpsInputNames | Where-Object { $_ -cnotin @('Command','RequestBase64','Json','Target','All','Expect') }).Count) { Err '外链维护含有不适用的参数'; return $false }
    $action = if ($RelayArgs[0] -eq 'list') { 'relay-ls' } else { 'relay-' + $RelayArgs[0] }
    $coreArgs = @('maintenance', $action)
    if ($RelayArgs.Count -gt 1) { $coreArgs += $RelayArgs[1..($RelayArgs.Count-1)] }
    return (Invoke-CoreMaintenance $coreArgs)
}

# 结构化结果（W2 计划 §2 第 3 条），与 ops.sh 的 ops_result 相同：调用方设置 MIXIN_OPS_RESULT_FILE 时写一份 JSON（先写
# 临时文件再改名），人类可读的输出不变。写不进去时返回 $false。
function Write-OpsResult([string]$Outcome, [bool]$WasRunning, [string]$FinalState, [int]$ExitCode, [string]$Message) {
    $path = $env:MIXIN_OPS_RESULT_FILE
    if (-not $path) { return $true }
    $temporary = "$path.$PID.tmp"
    try {
        $json = [ordered]@{ protocol = 'mixin-ops'; version = 1; command = $Command; outcome = $Outcome; wasRunning = $WasRunning
            finalState = $FinalState; exitCode = $ExitCode; message = $Message } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($temporary, $json + "`n", [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $path -Force
        return $true
    } catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Err "无法写入结构化结果：$path"
        return $false
    }
}

# 机器人此刻是否在运行：计划任务正在运行，或有本项目的机器人进程（前台实例）时为 running，否则为 stopped。
function Get-FinalRunState {
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $running = [bool]($task -and $task.State -eq 'Running') -or @(Get-BotPids).Count -gt 0
    } catch { return 'unknown' }
    if ($running) { return 'running' }
    return 'stopped'
}

function Test-PendingTransaction {
    return [bool](@('deploy-transaction', 'upgrade-transaction') | Where-Object { Test-Path -LiteralPath (Join-Path $StateDir $_) })
}

# 启停、重启（与 ops.sh 的 service_command 相同）和 Windows 的修复都由运维核心执行，它写结构化结果。start、restart、repair
# 先做与停机维护相同的检查（部署锁、未完成的事务、维护状态 service）；repair 只在本机实例未就绪时重启（包括已停止的实例），
# 已就绪时不动。stop 只在部署、升级或维护正持锁时拒绝，不查事务：停止总是安全的，事务未完成时也要能停。
function Invoke-ServiceCommand([string]$Action) {
    $script:OpsCoreExitCode = 1
    $allowed = @('Command','RequestBase64','Json') + @(if ($Action -ceq 'repair') { 'Repair' })
    if ($Action -cnotin @('start','stop','restart','repair') -or @($script:OpsInputNames | Where-Object { $_ -cnotin $allowed }).Count) {
        Err '启停命令含有不适用的参数，未执行操作'; return $false
    }
    $bunPath = if ($env:MIXIN_OPS_BUN) { $env:MIXIN_OPS_BUN } else { Get-BunPath }
    if (-not $bunPath) { Err '找不到 Bun 1.4.4 或更高版本'; return $false }
    $arguments = @('--no-env-file', (Join-Path $OpsSource 'scripts/ops/core/cli.ts'), 'service', $Action, '--project', $Project)
    if ($Json) { $arguments += '--json' }
    try { $script:OpsCoreExitCode = Invoke-ConsoleProcess $bunPath $arguments; return ($script:OpsCoreExitCode -eq 0) }
    catch { Err $_.Exception.Message; return $false }
}

# 配置向导（模型、应用机器人凭据、外链）在服务继续运行时填写：用项目当前的依赖运行，只读取现有配置作为基准，回答写进私有
# 暂存目录（含凭据，结束时删除）。确认后交给共用核心，与网页配置相同：停机前预检，停机、写入，按原运行状态启动并核对就绪，
# 失败时恢复原配置。取消时向导不写暂存，配置和服务保持原状。
function Invoke-ConfigureWizard([string]$Wizard, [string]$Label, [string]$Kind) {
    $script:OpsCoreExitCode = 1
    $bunPath = Get-BunPath
    if (-not $bunPath) { Err "找不到可用的 bun；请安装 Bun：https://bun.sh"; return $false }
    if ([Console]::IsInputRedirected) { Err "$($Label)需要在终端里运行向导；配置和服务保持原状"; return $false }
    if ($pendingTransaction) {
        Err "有未完成的部署或升级；请先用 $(Get-OpsCommandHint 'resume') 继续，或 $(Get-OpsCommandHint 'rollback') 回滚"; return $false
    }
    $stage = Join-Path $Project ('tmp\configure-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
        Protect-ProjectSecretPath $stage
        $previous = $ErrorActionPreference
        Push-Location $Project
        try {
            $ErrorActionPreference = 'Continue'
            $global:LASTEXITCODE = 1
            # 直接继承终端，保留密码掩码和 Ctrl+C；不把凭据放进参数或输出管道。
            Invoke-WithUtf8Output { & $bunPath --no-env-file run (Join-Path $Project "scripts\config\$Wizard") --stage $stage }
            $code = $global:LASTEXITCODE
        } finally { $ErrorActionPreference = $previous; Pop-Location }
        $staged = Join-Path $stage "configuration-$Kind.json"
        if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) {
            if ($code -in @(0, 2)) { Warn "$($Label)已取消；配置和服务保持原状"; $script:OpsCoreExitCode = 0; return $true }
            Err "$($Label)未完成（原因见上方）；配置和服务保持原状"; return $false
        }
        return (Invoke-CoreMaintenance @('maintenance', 'configuration-apply', '--stage', $staged))
    } finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

# 应用控制台已确认的运行参数草稿，与 ops.sh 的 runtime_configure 相同：由运维核心持部署锁、拒绝未完成的事务，
# 维护状态不允许启动时不停机，发布失败时恢复原配置和运行状态，并写结构化结果。
function Invoke-RuntimeConfiguration([string]$DraftName) {
    $script:OpsCoreExitCode = 1
    if (@($script:OpsInputNames | Where-Object { $_ -cnotin @('Command','RequestBase64','Json','Target') }).Count) {
        Err '运行参数维护含有不适用的参数'; return $false
    }
    return (Invoke-CoreMaintenance @('maintenance','runtime-configure',$DraftName))
}

# 数据操作由 Bun 统一管理存储边界；外置共享资料目录保存在 data\config\runtime.json，工具与服务读同一份。
function Invoke-ConfigurationChange([string]$Mode, [string]$DraftId, [string]$DraftDigest, [string]$ExpectedState = '') {
    $script:OpsCoreExitCode = 1
    if ($Mode -cnotin @('apply','restore')) { Err '配置动作无效'; return $false }
    $allowed = @('Command','RequestBase64','Json','Target') + $(if ($Mode -ceq 'apply') { 'Digest' } else { 'Expect' })
    if (@($script:OpsInputNames | Where-Object { $_ -cnotin $allowed }).Count) { Err '配置维护含有不适用的参数'; return $false }
    $coreArgs = @('maintenance', ('configuration-' + $Mode), $DraftId)
    if ($Mode -ceq 'apply') { $coreArgs += @('--digest', $DraftDigest) }
    elseif ($ExpectedState) { $coreArgs += @('--expect', $ExpectedState) }
    return (Invoke-CoreMaintenance $coreArgs)
}

function Invoke-DataAdmin([string]$Script, [string[]]$TmpArgs) {
    $bunPath = Get-BunPath
    if (-not $bunPath) {
        Err "找不到可用的 bun；请安装 Bun：https://bun.sh"
        return $false
    }
    Push-Location $Project
    try {
        $previous = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            # 与 Invoke-RelayAdmin 同理：调用点用 if (-not (...)) 收返回值，bun 的输出必须
            # 走 Out-Host 才不会被一起吞掉；路径和文件名有中文，不切 UTF-8 就是一屏乱码。
            Invoke-WithUtf8Output {
                & $bunPath run $Script @TmpArgs 2>&1 | Out-Host
            }
            return ($LASTEXITCODE -eq 0)
        } finally {
            $ErrorActionPreference = $previous
        }
    } finally {
        Pop-Location
    }
}

function Invoke-TmpAdmin([string[]]$TmpArgs) {
    $script:OpsCoreExitCode = 1
    if (@($script:OpsInputNames | Where-Object { $_ -cnotin @('Command','RequestBase64','Json','Days','All','Plan','Digest','User','Group','StorageSegment','GroupId') }).Count) {
        Err '临时文件维护含有不适用的参数'; return $false
    }
    $action = if ($TmpArgs[0] -eq 'list') { 'tmp-ls' } else { 'tmp-' + $TmpArgs[0] }
    $coreArgs = @('maintenance', $action)
    if ($TmpArgs.Count -gt 1) { $coreArgs += $TmpArgs[1..($TmpArgs.Count - 1)] }
    return (Invoke-CoreMaintenance $coreArgs)
}

# 修订整理（revision-chain plan §4、§8）与会话库文件收缩（§4.6）：预览和状态只读，服务照常运行；删除收缩保留的原库也
# 不停机。整理、跳过、放弃、从备份恢复和收缩在停机时执行：停机之前先按维护状态判断这个动作现在能否执行（不能就不停机）；
# 结束后只按重读的维护状态决定是否启动（不看命令自己的结果），允许才启动，并等实例身份与就绪检查通过才说「运行中」，
# 没通过时只是「已请求启动」；不允许时保持停止。有未完成的部署或升级时只接受从备份恢复：自动回滚在恢复数据和代码之前
# 停止，当前检出就是事务的目标代码，用它恢复，事务和停机状态不变。
function Invoke-RevisionCleanupAdmin([string]$Action) {
    $script:OpsCoreExitCode = 1
    if (@($script:OpsInputNames | Where-Object { $_ -cnotin @('Command','RequestBase64','Json','Target','Space','Yes') }).Count) {
        Err '修订维护含有不适用的参数'; return $false
    }
    $script = "scripts\runtime\revision-cleanup.ts"
    $readOnly = @('preview', 'status', 'shrink-preview', 'shrink-status', 'shrink-remove-old')
    $actions = @('preview', 'status', 'apply', 'skip', 'abandon', 'restore', 'shrink-preview', 'shrink', 'shrink-status', 'shrink-remove-old')
    if ($Action -cnotin $actions) {
        Err "用法：ops.ps1 revision-cleanup <$($actions -join '|')> [-Space <空间>] [-Yes]"
        return $false
    }
    $cleanupArgs = @($Action, '--project', $Project)
    $spaces = @("$Space" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($spaces.Count -and $Action -cnotin @('shrink-preview', 'shrink', 'restore')) { Err "-Space 只用于 revision-cleanup shrink-preview、shrink 和 restore"; return $false }
    if ($Action -ceq 'restore' -and $spaces.Count -ne 1) { Err "revision-cleanup restore 需要 -Space <空间>，一次一个（见 revision-cleanup status）"; return $false }
    foreach ($name in $spaces) { $cleanupArgs += @('--space', $name) }
    if ($Yes) {
        if ($Action -cne 'shrink-remove-old') { Err "-Yes 只用于 revision-cleanup shrink-remove-old"; return $false }
        $cleanupArgs += '--yes'
    }
    if ($Action -cin $readOnly) {
        if ($Json) { $cleanupArgs += '--json' }
        return (Invoke-DataAdmin $script $cleanupArgs)
    }
    # 共用核心在部署锁内核对事务：有未完成的部署或升级时，从备份恢复由事务记录的版本执行（事务和停机状态不变），其余动作拒绝。
    return (Invoke-CoreMaintenance (@('revision-cleanup', $Action) + @($cleanupArgs | Select-Object -Skip 3)))
}

# stat-import 不带路径时弹出系统“打开文件”对话框选择旧统计账本；没有桌面会话或取消时返回空。
# 对话框要求 STA 线程（pwsh 默认 MTA），所以放进单独的 STA runspace；起始目录是项目的上一级（旧部署通常在旁边）。
function Select-LegacyStatsFile {
    if (-not [Environment]::UserInteractive) { return $null }
    $runspace = [runspacefactory]::CreateRunspace()
    $runspace.ApartmentState = 'STA'
    $runspace.Open()
    try {
        $shell = [powershell]::Create()
        $shell.Runspace = $runspace
        [void]$shell.AddScript({
            param($Start)
            Add-Type -AssemblyName System.Windows.Forms
            $dialog = New-Object System.Windows.Forms.OpenFileDialog
            $dialog.Title = '选择旧版统计账本（旧部署的 data\groups\stats.sqlite）'
            $dialog.Filter = 'SQLite 数据库 (*.sqlite;*.sqlite3;*.db)|*.sqlite;*.sqlite3;*.db|所有文件 (*.*)|*.*'
            $dialog.CheckFileExists = $true
            if ($Start -and (Test-Path -LiteralPath $Start -PathType Container)) { $dialog.InitialDirectory = $Start }
            # 置顶的隐形父窗口让对话框出现在终端前面，而不是藏在后面。
            $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
            try { if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.FileName } }
            finally { $owner.Dispose(); $dialog.Dispose() }
        }).AddArgument((Split-Path -Parent $Project))
        return @($shell.Invoke()) | Select-Object -First 1
    } finally { $runspace.Dispose() }
}

# 维护动作交给共用核心（scripts/ops/core/cli.ts）：部署锁、未完成事务的检查、停机窗口、维护状态和结构化结果都在核心里，
# 这里只负责找到 Bun 并把退出码带回。
function Invoke-CoreMaintenance([string[]]$CoreArguments) {
    $script:OpsCoreExitCode = 1
    $bunPath = if ($env:MIXIN_OPS_BUN) { $env:MIXIN_OPS_BUN } else { Get-BunPath }
    if (-not $bunPath) { Err '找不到 Bun 1.4.4 或更高版本'; return $false }
    $arguments = @('--no-env-file', (Join-Path $OpsSource 'scripts/ops/core/cli.ts')) + $CoreArguments + @('--project', $Project)
    if ($Json) { $arguments += '--json' }
    try { $script:OpsCoreExitCode = Invoke-ConsoleProcess $bunPath $arguments; return ($script:OpsCoreExitCode -eq 0) }
    catch { Err $_.Exception.Message; return $false }
}

function Clear-SpaceHistory([string]$SpaceValue, [string]$Operation = "clear") {
    $script:OpsCoreExitCode = 1
    $allowed = @('Command','RequestBase64','Json','Target','Direct','StorageSegment','GroupId','Expect')
    if ($Operation -eq 'compact') { $allowed += 'User' } else { $allowed += 'All' }
    if (@($script:OpsInputNames | Where-Object { $_ -cnotin $allowed }).Count) { Err '会话维护含有不适用的参数'; return $false }
    if (-not $SpaceValue) { Err '会话维护需要明确指定空间'; return $false }
    if ($Operation -eq 'compact' -and -not $User) { Err '压缩需要成员号码'; return $false }
    $coreArgs = @('maintenance', "history-$Operation", $SpaceValue)
    if ($Operation -eq 'compact') { $coreArgs += $User }
    if ($StorageSegment) { $coreArgs += '--storage-segment' }
    elseif ($GroupId) { $coreArgs += '--group-id' }
    if ($Expect) { $coreArgs += @('--expect', $Expect) }
    return (Invoke-CoreMaintenance $coreArgs)
}

# git 的返回码才是判据，但 $ErrorActionPreference="Stop" 下原生命令写 stderr 会直接抛异常，
# 所以这里临时放宽再取真实退出码。GIT_TERMINAL_PROMPT=0 让缺凭证时立刻失败，而不是挂在
# 一个无人应答的交互提示上——这个脚本可能跑在计划任务或无人值守的会话里。
function Invoke-GitCapture([string[]]$GitArgs) {
    $gitPath = Get-GitPath
    $hadPromptEnv = Test-Path Env:GIT_TERMINAL_PROMPT
    $previousPromptEnv = $env:GIT_TERMINAL_PROMPT
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $env:GIT_TERMINAL_PROMPT = "0"
        $ErrorActionPreference = "Continue"
        $output = & $gitPath -C $Project @GitArgs 2>&1
        $exitCode = $LASTEXITCODE
        if ($env:BOT_OPERATION_LOG) { Write-OperationEvent 'info' ('git ' + $GitArgs[0] + '; exit=' + $exitCode + "`n" + (@($output) -join "`n")) }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($hadPromptEnv) { $env:GIT_TERMINAL_PROMPT = $previousPromptEnv }
        else { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        # 只去尾部空白：git status --porcelain 的首列状态位本身就是空格，整体 Trim 会把
        # 第一行的缩进吃掉，输出对不齐。需要比较的那几个命令（rev-parse 等）不带前导空白。
        Text     = (@($output | ForEach-Object { "$_" }) -join "`n").TrimEnd()
    }
}



# 这里只读检查 S3 必填项；完整格式由运行时校验，凭据不传入 curl 或命令行。
function Get-RelayDoctorRows {
    if (-not (Test-Path -LiteralPath $RelayConfigFile -PathType Leaf)) { return @() }
    try {
        $config = Get-Content -LiteralPath $RelayConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($config.provider -ne "s3") { throw "provider" }
        foreach ($field in @("endpoint", "region", "bucket", "accessKeyId", "secretAccessKey")) {
            if ($config.$field -isnot [string] -or -not $config.$field.Trim()) { throw "missing" }
        }
    } catch {
        return @(New-DoctorRow "data/config/relay.json" "fail" "S3 必填项不全" "请重新运行外链配置向导。")
    }
    return @(New-DoctorRow "S3 外链配置必填项" "pass" "必填项齐全；启动时执行完整格式校验" "此项不检测云端权限、私有访问和签名；云端设置变化后请用 relay-test 验收。")
}

function New-DoctorRow([string]$Name, [string]$Status, [string]$Detail, [string]$Fix = "") {
    return [pscustomobject]@{
        Name   = $Name
        Status = $Status
        Detail = $Detail
        Fix    = $Fix
    }
}

# 继续、回滚和有未完成事务的升级只把命令交给部署或升级脚本，由它们按事务记录执行：
# 这里不读取普通设置，设置损坏或为空都不能挡住恢复入口。
$pendingTransaction = (Test-Path -LiteralPath (Join-Path $StateDir 'deploy-transaction')) -or
    (Test-Path -LiteralPath (Join-Path $StateDir 'upgrade-transaction'))
$recovering = $Command -in @('resume', 'rollback', 'maintenance-recover') -or ($pendingTransaction -and $Command -in @('update', 'upgrade'))
$Port = '1011'; $DeployedWorkspaceRoot = ''
function Read-StateText([string]$Name) {
    $path = Join-Path $StateDir $Name
    if (Test-Path -LiteralPath $path -PathType Leaf) { return "$(Get-Content -LiteralPath $path -Raw)".Trim() }
    return $null
}
if (-not $recovering) {
    # 普通操作使用已保存设置（环境变量优先）；空文件与损坏的值一样报错；共享资料目录为空表示默认 data\workspace。
    $savedPort = Read-StateText 'bot-port'
    $Port = if ($env:BOT_PORT) { $env:BOT_PORT } elseif ($null -ne $savedPort) { $savedPort } else { '1011' }
    $DeployedWorkspaceRoot = Get-SavedWorkspaceRoot $Project
}
# 部署脚本自行校验并提供修正。
if (-not $recovering -and $Command -ne 'deploy') {
    $portNumber = 0
    if (-not [int]::TryParse($Port, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
        throw "BOT_PORT/data/state/bot-port 中的端口无效：$Port"
    }
    $Port = "$portNumber"
}

# 使用启动时间和本地实例记录识别相对路径启动的机器人。
function Get-BotPids { Get-ProjectBotPids $Project }
function Stop-Bot { return (Stop-ProjectBot $Project $TaskName) }

function Test-Local {
    $verification = $false
    if (Test-ProjectBotHealth $Project ([int]$Port) -VerificationOnly ([ref]$verification)) { return 200 }
    if ($verification) { return 503 }
    return 0
}

function Wait-Local {
    $lastStatus = $null
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        $lastStatus = Test-Local
        if ($lastStatus -eq 200) { return $lastStatus }
        if ($attempt -lt 10) { Start-Sleep -Seconds 1 }
    }
    return $lastStatus
}

function Show-Doctor {
    if (-not $Json) { Step "mixin-chatbot 健康检查（本机端口=$Port）" }
    $rows = @()

    # 外置资料目录缺失时服务拒绝启动（不会当成空资料目录）；默认目录由服务创建。
    if (-not $DeployedWorkspaceRoot) {
        $rows += New-DoctorRow "共享资料目录" "pass" "$(Join-Path $DataDir 'workspace')（默认）"
    } elseif (Test-Path -LiteralPath $DeployedWorkspaceRoot -PathType Container) {
        $rows += New-DoctorRow "共享资料目录" "pass" "$DeployedWorkspaceRoot（外置，只读）"
    } else {
        $rows += New-DoctorRow "共享资料目录" "fail" "外置目录不存在：$DeployedWorkspaceRoot" "恢复该目录或挂载；改用其他目录请设置 WORKSPACE_ROOT 后使用 $(Get-OpsCommandHint 'deploy')。"
    }

    $localStatus = Test-Local
    $botPids = @(Get-BotPids)
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    # 任务在、没有运行且本机没有应答：多半是有意停止（stop 之后任务保持就绪），也可能是意外退出，两种处理都要说清。
    $stoppedTask = $t -and $t.State -ne "Disabled" -and $t.State -ne "Running" -and $localStatus -ne 200 -and $localStatus -ne 503
    $stoppedHint = "有意停止的使用 $(Get-OpsCommandHint 'start') 启动；意外退出时先在 $(Get-OpsCommandHint 'logs') 查看日志，再使用 $(Get-OpsCommandHint 'doctor -Repair')。"
    if (-not $t) {
        if ($localStatus -eq 200 -and $botPids.Count -gt 0) {
            $rows += New-DoctorRow "计划任务" "warn" "未安装；机器人当前以前台方式运行" "如需开机自启，请以管理员身份使用 $(Get-OpsCommandHint 'deploy')。"
        } else {
            $rows += New-DoctorRow "计划任务" "fail" "缺少，且没有健康的前台机器人" "请以管理员身份使用 $(Get-OpsCommandHint 'deploy')。"
        }
    } else {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        $taskLogon = if ($t.Principal) { Get-TaskLogonLabel $t.Principal.LogonType } else { "未知登录方式" }
        $taskDetail = "$(Get-TaskStateLabel $t.State)，$taskLogon" + $(if ($taskInfo) { "，上次结果 $(Get-TaskResultHex $taskInfo.LastTaskResult)" } else { "" })
        if ($t.State -eq "Disabled") {
            $rows += New-DoctorRow "计划任务" "fail" $taskDetail "使用 $(Get-OpsCommandHint 'start')，会启用计划任务并启动机器人。"
        } elseif ($t.State -eq "Running") {
            $rows += New-DoctorRow "计划任务" "pass" $taskDetail
        } elseif ($localStatus -eq 200) {
            $rows += New-DoctorRow "计划任务" "warn" "$taskDetail；机器人可能在任务外运行" "先通过 $(Get-OpsCommandHint 'stop') 停止手动启动的机器人，再使用 $(Get-OpsCommandHint 'start')。"
        } else {
            $rows += New-DoctorRow "计划任务" "fail" "$taskDetail；机器人没有运行" $stoppedHint
        }
    }

    if ($listeners.Count -eq 0) {
        $rows += New-DoctorRow "机器人监听 :$Port" "fail" "没有监听" $(if ($stoppedTask) { $stoppedHint } else { "使用 $(Get-OpsCommandHint 'doctor -Repair')。" })
    } else {
        $ownerPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { [int]$_ })
        $botOwnerPid = @($ownerPids | Where-Object { $botPids -contains $_ } | Select-Object -First 1)
        if ($botOwnerPid.Count -gt 0) {
            $rows += New-DoctorRow "机器人监听 :$Port" "pass" "pid $($botOwnerPid[0])（mixin-chatbot）"
        } elseif ($localStatus -eq 200) {
            $ownerList = $ownerPids -join ", "
            $rows += New-DoctorRow "机器人监听 :$Port" "warn" "pid $ownerList；健康检查有响应但未识别进程身份" "在 Windows 任务管理器的「详细信息」中核对这些 PID 与命令行；$(Get-OpsCommandHint 'doctor') 可重新检查。"
        } else {
            $ownerList = $ownerPids -join ", "
            $rows += New-DoctorRow "机器人监听 :$Port" "fail" "pid $ownerList 不是健康的 mixin-chatbot" "在 Windows 任务管理器中核对占用端口的进程，或通过 $(Get-OpsCommandHint 'deploy') 选择其他端口。"
        }
    }

    $rows += New-DoctorRow "本地机器人健康" $(if ($localStatus -eq 200) { "pass" } else { "fail" }) $(if ($localStatus -eq 200) { "就绪且实例身份匹配" } elseif ($localStatus -eq 503) { "只验证实例，不处理消息" } else { "未就绪或实例身份不匹配" }) $(if ($localStatus -eq 200) { "" } elseif ($localStatus -eq 503) { "使用 $(Get-OpsCommandHint 'resume') 继续上次操作并完成提交。" } elseif ($stoppedTask) { $stoppedHint } else { "使用 $(Get-OpsCommandHint 'doctor -Repair')，再到 $(Get-OpsCommandHint 'logs') 查看日志。" })

    # Stream 与通讯录状态只读运行中服务的 /health，不另开 Stream 连接（同一应用只能有一条）。
    if ($localStatus -eq 200) {
        $streamRows = $null
        $previousErrorActionPreference = $ErrorActionPreference
        $bunPath = Get-BunPath
        if ($bunPath) {
            Push-Location $Project
            try {
                $ErrorActionPreference = "Continue"
                $streamRows = @(Invoke-WithUtf8Output { & $bunPath run "scripts\ops\directory-admin.ts" doctor 2>$null })
                if ($LASTEXITCODE -ne 0) { $streamRows = $null }
            } catch {
                $streamRows = $null
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
                Pop-Location
            }
        }
        if ($null -eq $streamRows) {
            $rows += New-DoctorRow "事件 Stream" "warn" "无法读取服务状态" "查看 $(Get-OpsCommandHint 'logs')。"
        } else {
            foreach ($line in $streamRows) {
                $parts = "$line" -split "`t", 3
                if ($parts.Count -lt 3 -or -not $parts[1]) { continue }
                $fix = switch ($parts[1]) {
                    "事件 Stream" { "检查出站访问 imtwo.zdxlz.com 的 443 端口和应用凭据（$(Get-OpsCommandHint 'configure-app-bot')），再查看 $(Get-OpsCommandHint 'logs')。" }
                    "通讯录同步" { "服务会自动重试和复核；用 $(Get-OpsCommandHint 'directory') 查看范围状态和原因，长时间没有恢复时查看 $(Get-OpsCommandHint 'logs')。" }
                    "运行状况" { "在 $(Get-OpsCommandHint 'logs') 中查看对应记录（Durable 报告、交付超时放弃、统计累计值回退等）；停住的任务由成员用 /status 查看、/stop 或 /clear 结束。" }
                    default { "" }
                }
                $status = if ($parts[0] -in @("pass", "warn")) { $parts[0] } else { "fail" }
                $rows += New-DoctorRow $parts[1] $status $parts[2] $(if ($status -eq "pass") { "" } else { $fix })
            }
        }
    }

    # 版本取自运行中服务的 /health；服务未运行时取部署记录。本地代码不同于运行版本时另起一行说明。
    $versionRows = $null
    $bunPath = Get-BunPath
    if ($bunPath) {
        $previousErrorActionPreference = $ErrorActionPreference
        Push-Location $Project
        try {
            $ErrorActionPreference = "Continue"
            $versionArgs = if ($localStatus -eq 200) { @("--port", "$Port") } else { @() }
            $versionRows = @(Invoke-WithUtf8Output { & $bunPath run "scripts\ops\version-info.ts" @versionArgs 2>$null })
            if ($LASTEXITCODE -ne 0) { $versionRows = $null }
        } catch {
            $versionRows = $null
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
            Pop-Location
        }
    }
    if ($null -eq $versionRows) {
        $rows += New-DoctorRow "应用机器人" "warn" "无法读取版本信息"
    } else {
        foreach ($line in $versionRows) {
            $parts = "$line" -split "`t", 2
            if ($parts.Count -lt 2 -or -not $parts[0]) { continue }
            if ($parts[1].StartsWith("未知：")) {
                $rows += New-DoctorRow $parts[0] "fail" $parts[1] "部署记录无法读取；不要在此目录覆盖部署，参见 docs\data-migrations.md。"
            } else {
                $rows += New-DoctorRow $parts[0] "pass" $parts[1]
            }
        }
    }

    if (Test-Path -LiteralPath $AppBotFile -PathType Leaf) {
        $rows += New-DoctorRow "data/config/app-bot.json" "pass" "已配置（不显示凭据）"
    } else {
        $rows += New-DoctorRow "data/config/app-bot.json" "fail" "缺少（服务拒绝启动）" "使用 $(Get-OpsCommandHint 'configure-app-bot') 填写 AppID 和 AppSecret。"
    }

    # 一次检查整套模型配置：models.json 的服务商与凭证，加上 Pi 设置里的选型。
    $modelsOk = Test-ModelConfiguration $Project
    $rows += New-DoctorRow "模型配置（models.json + Pi 设置）" $(if ($modelsOk) { "pass" } else { "fail" }) $(if ($modelsOk) { "有效" } else { "缺少或无效" }) $(if ($modelsOk) { "" } elseif (-not (Test-Path -LiteralPath $ModelsFile)) { "通过 $(Get-OpsCommandHint 'deploy') 完成首次模型配置。" } else { "先修正 data/config/models.json 与 data/runtime/pi/settings.json。" })

    $rows += Get-RelayDoctorRows

    # doctor -Json 让控制台复用这同一套体检，而不是自己再实现一遍计划任务/Stream/配置的判断。
    # stdout 必须只有 JSON，所以这里直接返回，不走下面的彩色输出。
    if ($Json) {
        $payload = [pscustomobject]@{
            pass   = @($rows | Where-Object { $_.Status -eq "pass" }).Count
            warn   = @($rows | Where-Object { $_.Status -eq "warn" }).Count
            fail   = @($rows | Where-Object { $_.Status -eq "fail" }).Count
            port   = [int]$Port
            # 单行输出：ConvertTo-Json 默认会把数组换行展开，Compress 后一行读完即可。
            checks = @($rows | ForEach-Object {
                [pscustomobject]@{ name = $_.Name; status = $_.Status; detail = $_.Detail; fix = $_.Fix }
            })
        }
        # 返回结构化结果；JSON 序列化与退出码由入口处理，不与布尔结果混进同一条管道。
        return $payload
    }

    foreach ($r in $rows) {
        $tag = switch ($r.Status) { "pass" { "[+]" }; "warn" { "[!]" }; default { "[x]" } }
        $color = switch ($r.Status) { "pass" { "Green" }; "warn" { "Yellow" }; default { "Red" } }
        Write-Host ("{0} {1,-26} {2}" -f $tag, $r.Name, $r.Detail) -ForegroundColor $color
    }

    $pass = @($rows | Where-Object { $_.Status -eq "pass" }).Count
    $warn = @($rows | Where-Object { $_.Status -eq "warn" }).Count
    $fail = @($rows | Where-Object { $_.Status -eq "fail" }).Count
    Write-Host ""
    Write-Host ("结果：{0} 项通过，{1} 项警告，{2} 项失败" -f $pass, $warn, $fail) -ForegroundColor White

    $actions = @($rows | Where-Object { $_.Status -ne "pass" -and $_.Fix } | Select-Object Name, Fix -Unique)
    if ($actions.Count -gt 0) {
        Write-Host ""
        Write-Host "建议操作：" -ForegroundColor Cyan
        foreach ($action in $actions) {
            Write-Host ("  - {0}: {1}" -f $action.Name, $action.Fix) -ForegroundColor Yellow
        }
    }

    if ($fail -gt 0) {
        Warn "可尝试修复：$(Get-OpsCommandHint 'doctor -Repair')"
        return $false
    } elseif ($warn -gt 0) {
        Warn "必需检查已通过，但仍有警告"
        return $true
    } else {
        Done "全部检查通过"
        return $true
    }
}

# 未完成的部署由运维核心继续或回滚：它取事务固定的运行包，只使用事务记录，不重新提问。
function Invoke-PendingDeployment([string]$Action, [string]$Confirmation = '') {
    $script:OpsCoreExitCode = 1
    $bunPath = if ($env:MIXIN_OPS_BUN) { $env:MIXIN_OPS_BUN } else { Get-BunPath }
    if (-not $bunPath) { Err '找不到 Bun 1.4.4 或更高版本'; return $false }
    $arguments = @('--no-env-file', (Join-Path $OpsSource 'scripts/ops/core/cli.ts'), 'deployment', 'deploy', '--project', $Project)
    if ($Action -eq 'rollback') { $arguments += '--rollback' }
    if ($Confirmation) { $arguments += @('--confirmation', $Confirmation) }
    $gitPath = Get-GitPath
    if ($gitPath) { $arguments += @('--git-path', $gitPath) }
    try { $script:OpsCoreExitCode = Invoke-ConsoleProcess $bunPath $arguments; return ($script:OpsCoreExitCode -eq 0) }
    catch { Err $_.Exception.Message; return $false }
}

# The fixed release's deploy entry asks before the stop and hands the live project to the shared core, which owns the lock,
# the transaction, its recovery and the result.
function Invoke-DeployCommand {
    $script:OpsCoreExitCode = 1
    $deployHost = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $source = if ($env:MIXIN_OPS_CONSOLE -ceq '1') { $OpsSource } else { $Project }
    $previousProject = $env:MIXIN_OPS_PROJECT
    try {
        if ($env:MIXIN_OPS_CONSOLE -ceq '1') { Assert-ConsoleLifecycle 'deploy' $Project; $env:MIXIN_OPS_PROJECT=$Project }
        $script:OpsCoreExitCode = Invoke-ConsoleProcess $deployHost @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $source 'scripts\deploy\deploy.ps1'))
        return ($script:OpsCoreExitCode -eq 0)
    } finally { $env:MIXIN_OPS_PROJECT=$previousProject }
}

# 控制台的部署与升级：核心写了结果文件时沿用，否则按观察到的最终状态补写。
# Lifecycle scripts alone own stop, commit and recovery. This wrapper reports the observed end state.
function Invoke-LifecycleOperation([scriptblock]$Action) {
    $script:OpsCoreExitCode = 1
    if (-not $env:MIXIN_OPS_RESULT_FILE) { return (& $Action) }
    $wasRunning = (Get-FinalRunState) -eq 'running'
    $code = 1; $outcome = 'failed'; $message = '操作未完成，请查看任务日志和恢复状态'; $state = 'unknown'
    try { if (& $Action) { $code = 0 } }
    catch { $message = $_.Exception.Message; Err $message; $script:OpsCoreExitCode = 1 }
    finally {
        # The shared core wrote the result (original state, final state and readiness): do not overwrite it. Each console task
        # has its own result path, so an existing file is this run's. Without it (a refusal before the hand-off, a core killed
        # before writing, or an old release's upgrader) the observed state below is reported.
        if (Test-Path -LiteralPath $env:MIXIN_OPS_RESULT_FILE -PathType Leaf) {
            $code = $script:OpsCoreExitCode
            $written = $true
        } else {
        $state = Get-FinalRunState
        if ($state -eq 'running') {
            try {
                $saved = Read-StateText 'bot-port'; $Port = if ($null -eq $saved) { '1011' } else { $saved }
                if ((Wait-Local) -ne 200) { $state = 'start-requested'; if ($code -eq 0) { $code = 1 } }
            } catch { $state = 'unknown'; if ($code -eq 0) { $code = 1 } }
        } elseif ($state -eq 'unknown' -and $code -eq 0) { $code = 1 }
        if (Test-PendingTransaction) {
            if ($code -eq 0) { $code = 1 }; $message = '事务尚未结束，请刷新维护页后继续或回滚'
        } elseif ($code -eq 0) { $outcome = 'success'; $message = '操作完成' }
        $written = Write-OpsResult $outcome $wasRunning $state $code $message
        $script:OpsCoreExitCode = if ($code -eq 0 -and -not $written) { 1 } else { $code }
        }
    }
    return ($code -eq 0 -and $written)
}

function Invoke-TransactionCommand([string]$Action, [string]$Confirmation = '') {
    if (Test-Path -LiteralPath (Join-Path $Project 'data\state\upgrade-transaction')) { return (Invoke-Update $Action '' $Confirmation) }
    if (Test-Path -LiteralPath (Join-Path $Project 'data\state\deploy-transaction')) {
        if (-not (Test-Administrator)) { Err "$Action 需要管理员 PowerShell"; return $false }
        return (Invoke-PendingDeployment $Action $Confirmation)
    }
    if ($Confirmation) { Err '确认后的事务已消失，请刷新预览'; return $false }
    Done '没有未完成的部署或升级'
    return $true
}

# 获取目标提交并交给目标版本升级器；停机、迁移、回滚由升级器负责。
# 有未完成的事务时先继续或回滚，使用记录的目标提交，不追随最新 main。
function Invoke-Update([string]$Action = '', [string]$ConfirmedTarget = '', [string]$Confirmation = '') {
    $script:OpsCoreExitCode = 1
    $operation = Start-OperationLog $Project 'upgrade'
    $operationExit = 1
    try {
    Set-OperationStage 'upgrade-preflight'
    if ($ConfirmedTarget -and $ConfirmedTarget -cnotmatch '^[0-9a-f]{40}$') { Err '已确认的升级目标必须是完整提交 SHA；请重新检查版本'; return $false }
    if (-not (Test-Administrator)) { Err 'update 需要管理员 PowerShell'; return $false }
    if (-not (Get-GitPath) -or -not (Get-BunPath)) { Err '需要 Git 和 Bun'; return $false }
    $pendingDeploy = Join-Path $Project 'data\state\deploy-transaction'
    $pendingUpgrade = Join-Path $Project 'data\state\upgrade-transaction'
    if ($ConfirmedTarget -and ((Test-Path -LiteralPath $pendingUpgrade) -or (Test-Path -LiteralPath $pendingDeploy))) {
        Err '预览后出现未完成的事务，请刷新后继续或回滚'; return $false
    }
    if (-not (Test-Path -LiteralPath $pendingUpgrade) -and (Test-Path -LiteralPath $pendingDeploy)) {
        if (-not $Action) {
            Warn '发现未完成的部署，需先继续或回滚，再升级。'
            $Action = Read-TransactionAction
            if (-not $Action) { Warn '未处理上次操作，服务保持当前状态。'; return $false }
        }
        $operationExit = if (Invoke-PendingDeployment $Action $Confirmation) { 0 } else { 1 }
        return ($operationExit -eq 0)
    }
    $dirty = Invoke-GitCapture @('status', '--porcelain', '--untracked-files=no')
    if ($dirty.ExitCode -ne 0 -or $dirty.Text) { Err '已跟踪文件有改动，请先处理'; return $false }
    $branch = (Invoke-GitCapture @('rev-parse', '--abbrev-ref', 'HEAD')).Text
    $original = (Invoke-GitCapture @('rev-parse', 'HEAD')).Text
    if (Test-Path -LiteralPath $pendingUpgrade) {
        $pendingName = "$(Get-Content -LiteralPath $pendingUpgrade -Raw)".Trim()
        if ($pendingName -cnotmatch '^deploy-[A-Za-z0-9]+$') { Err '升级事务名称无效'; return $false }
        # 目标提交只取事务记录：核心要求升级入口的目标与记录一致。
        try { $pendingRecord = Read-DeploymentTransaction (Join-Path $Project ('backup\snapshots\' + $pendingName)) }
        catch { Err "未完成事务的记录无法读取：$($_.Exception.Message)；保持现状，请人工检查 backup\snapshots"; return $false }
        $target = $pendingRecord.target_sha
        if ($pendingRecord.operation -cne 'upgrade' -or $target -cnotmatch '^[0-9a-f]{40}$') { Err '中断事务目标无效'; return $false }
        Warn (Format-DeploymentTransaction $pendingRecord)
        if (-not $Action) {
            $Action = Read-TransactionAction
            if (-not $Action) { Warn '未处理上次操作，服务保持当前状态。'; return $false }
        }
    } elseif ($Action) {
        if ($Confirmation) { Err '确认后的事务已消失，请刷新预览'; return $false }
        Done '没有未完成的部署或升级'
        $operationExit = 0
        return $true
    } elseif ($env:MIXIN_OPS_CONSOLE -ceq '1' -and -not $ConfirmedTarget) {
        Err '控制台升级缺少已确认目标，未拉取或停止服务'; return $false
    } elseif ($ConfirmedTarget) {
        $resolved = Invoke-GitCapture @('rev-parse', '--verify', ($ConfirmedTarget + '^{commit}'))
        if ($resolved.ExitCode -ne 0 -or $resolved.Text -cne $ConfirmedTarget) { Err '已确认的提交在本地不存在，请重新检查版本'; return $false }
        $target = $ConfirmedTarget
    } else {
        $fetch = Invoke-GitCapture @('fetch', 'origin', 'main:refs/remotes/origin/main')
        if ($fetch.ExitCode -ne 0) { Err $fetch.Text; return $false }
        $target = (Invoke-GitCapture @('rev-parse', 'origin/main')).Text
    }
    Write-OperationEvent 'info' ("original=$original target=$target action=$Action")
    if ($original -notmatch '^[0-9a-f]{40}$' -or $target -notmatch '^[0-9a-f]{40}$') { Err '无法识别提交'; return $false }
    # Export the target's preview before stopping or changing the live checkout.
    $stage = Join-Path $Project ('tmp\upgrade-' + [Guid]::NewGuid().ToString('N'))
    Set-OperationStage 'export-target-upgrader'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    try {
    $archive = Join-Path $stage 'target.zip'
    # The whole tree, not just the upgrader: it loads its own lib, and its data preview (data-current.ts) imports the
    # target's src to check the data before the live checkout changes.
    $export = Invoke-GitCapture @('archive', '--format=zip', ('--output=' + $archive), $target)
    if ($export.ExitCode -ne 0) { Err $export.Text; return $false }
    Expand-Archive -LiteralPath $archive -DestinationPath $stage
    # The parent may be pwsh 7; the supported child host is Windows PowerShell 5.1.
    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $stage 'scripts\deploy\upgrade.ps1'),
        '-Project', $Project, '-OriginalSha', $original, '-TargetSha', $target, '-OriginalBranch', $branch,
        '-BunPath', (Get-BunPath), '-GitPath', (Get-GitPath))
    if ($Action -eq 'rollback') { $arguments += '-Rollback' }
    if ($Confirmation) { $arguments += @('-ConfirmedTransaction', $Confirmation) }
    Set-OperationStage 'target-upgrader'
    # 升级器在停机前要提问（修订整理、通讯录同步范围），所以直接使用控制台，不经 Out-Host 管道。
    $operationExit = Invoke-ConsoleProcess $shell $arguments
    $script:OpsCoreExitCode = $operationExit
    if ($operationExit -ne 0 -and (Test-Path -LiteralPath $pendingUpgrade)) {
        Warn "升级未完成，事务已保留；处理上方原因后，可用 $(Get-OpsCommandHint 'resume') 继续，或 $(Get-OpsCommandHint 'rollback') 回滚（数据已提交时只能继续）。"
    }
    return ($operationExit -eq 0)
    } finally {
        try { Remove-UpgradeStage $Project $stage }
        catch { Warn ('升级导出目录清理失败，保留 ' + $stage + '：' + $_.Exception.Message) }
    }
    } catch { Write-OperationFailure $_; throw }
    finally { Stop-OperationLog $operation $operationExit }
}

function Show-Logs {
    Step "持续查看 $LogPath（Ctrl+C 退出）"
    # 日志是 UTF-8 且不带 BOM，而 Windows PowerShell 5.1 的 Get-Content 默认按系统 ANSI
    # 代码页解码，中文日志会整片变成乱码。显式指定就两个版本都对。
    Get-Content $LogPath -Tail 50 -Wait -Encoding UTF8
}

function Run-Foreground {
    $launcher = Join-Path $RuntimeDir "bot-launcher.ps1"
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        Err "找不到前台 launcher；请先使用 $(Get-OpsCommandHint 'deploy')"
        return $false
    }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Err "计划任务正在运行；请先使用 $(Get-OpsCommandHint 'stop')，再切换到前台模式"
        return $false
    }
    $running = @(Get-BotPids)
    if ($running.Count -gt 0) {
        Err "机器人已经在运行（pid $($running -join ', ')）；请先使用 $(Get-OpsCommandHint 'stop')"
        return $false
    }
    Step "以前台方式运行机器人（Ctrl+C 停止）..."
    $previousErrorActionPreference = $ErrorActionPreference
    $foregroundExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $launcher
        $foregroundExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    return $foregroundExitCode -eq 0
}

function Uninstall-Bot {
    Step "卸载 mixin-chatbot"
    if (-not (Test-Administrator)) { Warn "当前不是管理员，任务/服务删除可能失败；如失败请以管理员身份重跑。" }
    # 部署锁（FileShare.None）持有到归档 data/ 之前，与部署、升级和运维任务互斥；核心在锁内拒绝仍需要本部署的未完成事务、
    # 运维任务和配置提交。锁文件在 data\state 里，持有时无法移动 data/，所以归档前释放：这时若别的操作取得了锁，移动会因
    # 文件占用失败，不会误删。
    $lockPath = Join-Path $DataDir 'state\deploy.lock'
    New-Item -ItemType Directory -Force -Path (Split-Path $lockPath -Parent) | Out-Null
    try { $script:UninstallLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { Err '部署、升级或另一个维护操作正在进行；卸载未开始'; return $false }
    try {
        $env:BOT_DEPLOY_LOCK_HELD = $lockPath
        try { $checked = Invoke-CoreMaintenance @('uninstall-check') } finally { Remove-Item Env:BOT_DEPLOY_LOCK_HELD -ErrorAction SilentlyContinue }
        if (-not $checked) { Err '卸载未开始（原因见上方）'; return $false }
        return (Remove-BotInstallation)
    } finally { if ($script:UninstallLock) { $script:UninstallLock.Dispose(); $script:UninstallLock = $null } }
}

function Remove-BotInstallation {
    if (-not (Stop-Bot)) { Err '停止机器人失败，卸载已停止。'; return $false }
    $remainingBotPids = @(Get-BotPids)
    if ($remainingBotPids.Count -gt 0) {
        Err "机器人进程仍在运行（pid $($remainingBotPids -join ', ')）；为避免删除仍在使用的数据，卸载已停止。"
        return $false
    }
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t -and -not (Test-Administrator)) {
        Err "检测到计划任务，但当前权限无法可靠注销；为避免留下指向已删除文件的孤立任务，卸载已停止。"
        Warn "请以管理员身份使用 $(Get-OpsCommandHint 'uninstall')。"
        return $false
    }
    if ($t) {
        try {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Done "计划任务已注销"
        } catch {
            Err "注销计划任务失败：$($_.Exception.Message)"
            return $false
        }
    } else { Warn "没有可删除的计划任务" }
    $launcher = Join-Path $RuntimeDir "bot-launcher.ps1"
    if (Test-Path -LiteralPath $launcher -PathType Leaf) { Move-ToProjectArchive $launcher $Project; Done "机器人 launcher 已删除" }
    if ((Test-Path -LiteralPath $RuntimeDir -PathType Container) -and
        @(Get-ChildItem -LiteralPath $RuntimeDir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Move-ToProjectArchive $RuntimeDir $Project
        Done "空的 data\runtime 目录已删除"
    }
    if (Read-YesNo "是否删除 data/（配置、部署状态、runtime、默认共享资料、会话、临时文件和统计）和 logs/？[y/N]" $false) {
        $logsDir = Join-Path $Project "logs"
        $script:UninstallLock.Dispose(); $script:UninstallLock = $null
        try {
            if (Test-Path -LiteralPath $DataDir) {
                Move-ToProjectArchive $DataDir $Project
            }
            if (Test-Path -LiteralPath $logsDir) {
                Move-ToProjectArchive $logsDir $Project
            }
            if ((Test-Path -LiteralPath $DataDir) -or (Test-Path -LiteralPath $logsDir)) {
                throw "目录仍然存在"
            }
            Done "data/ 和 logs/ 已删除"
        } catch {
            Err "data/ 或 logs/ 删除不完整：$($_.Exception.Message)"
            return $false
        }
    } else {
        Done "已保留 data/ 和 logs/（配置、状态、资料、会话与统计保留）"
    }
    if ($DeployedWorkspaceRoot) {
        Warn "外置共享资料目录不属于本项目，未删除：$DeployedWorkspaceRoot"
    }
    Done "卸载流程完成；如上方有警告，请按提示补充清理。"
    return $true
}

if ($Json -and $Command -in @("doctor", "status")) {
    if ($Repair) { [Console]::Error.WriteLine("-Json 只用于诊断；修复请使用 $(Get-OpsCommandHint 'doctor -Repair')。"); exit 2 }
    $result = Show-Doctor
    Invoke-WithUtf8Output { [Console]::WriteLine(($result | ConvertTo-Json -Depth 4 -Compress)) }
    if ($result.fail -gt 0) { exit 1 }
    exit 0
}

switch ($Command) {
    "deploy" {
        if ($env:MIXIN_OPS_CONSOLE -ceq '1') { if (-not (Invoke-LifecycleOperation { Invoke-DeployCommand })) { exit 1 } }
        else {
            $deployHost = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
            Invoke-WithUtf8Output { & $deployHost -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Project 'scripts\deploy\deploy.ps1') }
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
    }
    "doctor"    {
        $healthy = Show-Doctor
        if ($Repair) {
            Write-Host ""
            $repairOk = Invoke-ServiceCommand 'repair'
            Write-Host ""
            $healthy = Show-Doctor
            if (-not $repairOk -or -not $healthy) { exit 1 }
        } elseif (-not $healthy) {
            exit 1
        }
    }
    "status"    { if (-not (Show-Doctor)) { exit 1 } }
    "update"    { if (-not (Invoke-LifecycleOperation { Invoke-Update -ConfirmedTarget $Target })) { exit $script:OpsCoreExitCode } }
    "upgrade"   { if (-not (Invoke-LifecycleOperation { Invoke-Update -ConfirmedTarget $Target })) { exit $script:OpsCoreExitCode } }
    "resume"    { if (-not (Invoke-LifecycleOperation { Invoke-TransactionCommand 'continue' $ConfirmedTransaction })) { exit $script:OpsCoreExitCode } }
    "rollback"  { if (-not (Invoke-LifecycleOperation { Invoke-TransactionCommand 'rollback' $ConfirmedTransaction })) { exit $script:OpsCoreExitCode } }
    "repair"    { if (-not (Invoke-ServiceCommand 'repair')) { exit $script:OpsCoreExitCode } }
    "restart"   { if (-not (Invoke-ServiceCommand 'restart')) { exit $script:OpsCoreExitCode } }
    "stop"      { if (-not (Invoke-ServiceCommand 'stop')) { exit $script:OpsCoreExitCode } }
    "foreground" { if (-not (Run-Foreground)) { exit 1 } }
    "run-foreground" { if (-not (Run-Foreground)) { exit 1 } }
    "start"     { if (-not (Invoke-ServiceCommand 'start')) { exit $script:OpsCoreExitCode } }
    "logs"      {
        if (-not (Test-Path $LogPath)) { Warn "找不到日志文件 $LogPath（机器人可能从未启动）"; exit 1 }
        Show-Logs
    }
    "relay-configure" { if (-not (Invoke-ConfigureWizard 'configure-relay.ts' '外链配置' 'relay')) { exit $script:OpsCoreExitCode } }
    "configuration-apply" { if (-not (Invoke-ConfigurationChange apply $Target $Digest)) { exit $script:OpsCoreExitCode } }
    "configuration-restore" { if (-not (Invoke-ConfigurationChange restore $Target '' $Expect)) { exit $script:OpsCoreExitCode } }
    "runtime-configure" { if (-not (Invoke-RuntimeConfiguration $Target)) { exit $script:OpsCoreExitCode } }
    "model-configure" { if (-not (Invoke-ConfigureWizard 'configure.ts' '模型配置' 'models')) { exit $script:OpsCoreExitCode } }
    "configure-app-bot" { if (-not (Invoke-ConfigureWizard 'configure-app-bot.ts' '应用机器人配置' 'app')) { exit $script:OpsCoreExitCode } }
    # 只经本机控制接口读写运行中的服务，不另开 Stream 连接。
    "directory" { if (-not (Invoke-DataAdmin "scripts\ops\directory-admin.ts" @("status"))) { exit 1 } }
    "directory-scope" { if (-not (Invoke-DataAdmin "scripts\ops\directory-admin.ts" @("scope", $Target))) { exit 1 } }
    { $_ -in @('relay-ls','relay-test','relay-purge') } {
        $relayAction = if ($Command -eq 'relay-ls') { 'list' } else { $Command.Substring(6) }
        $relayArgs = @($relayAction)
        if ($All) { $relayArgs += '--all' }
        if ($Target) { $relayArgs += @('--keyword', $Target) }
        if ($Expect) { $relayArgs += @('--expect', $Expect) }
        if (-not (Invoke-RelayAdmin $relayArgs)) { exit $script:OpsCoreExitCode }
    }
    "tmp-ls" {
        $tmpArgs = @("list")
        if ($User) { $tmpArgs += "--user=$User" }
        if ($Group) { $tmpArgs += "--group=$Group" }
        if ($StorageSegment) { $tmpArgs += "--storage-segment" }
        if ($GroupId) { $tmpArgs += "--group-id" }
        if (-not (Invoke-TmpAdmin $tmpArgs)) { exit $script:OpsCoreExitCode }
    }
    { $_ -in @("tmp-purge", "tmp-preview", "tmp-reclaim", "tmp-discard") } {
        $tmpArgs = @($Command.Substring(4))
        if ($All) { $tmpArgs += "--all" }
        if ($script:OpsInputNames -contains "Days") { $tmpArgs += @("--days", "$Days") }
        if ($Plan) { $tmpArgs += @("--plan", $Plan) }
        if ($Digest) { $tmpArgs += @("--digest", $Digest) }
        if ($User) { $tmpArgs += "--user=$User" }
        if ($Group) { $tmpArgs += "--group=$Group" }
        if ($StorageSegment) { $tmpArgs += "--storage-segment" }
        if ($GroupId) { $tmpArgs += "--group-id" }
        if (-not (Invoke-TmpAdmin $tmpArgs)) { exit $script:OpsCoreExitCode }
    }
    "stat" {
        $statArgs = @()
        if ($Since)  { $statArgs += @("--since", $Since) }
        if ($Until)  { $statArgs += @("--until", $Until) }
        if ($Period) { $statArgs += @("--period", $Period) }
        if ($StorageSegment) { $statArgs += "--storage-segment" }
        elseif ($GroupId) { $statArgs += "--group-id" }
        if ($Target) { $statArgs += @("--", $Target) }
        if (-not (Invoke-DataAdmin "scripts\ops\stats-admin.ts" $statArgs)) { exit 1 }
    }
    "stat-import" {
        # 文件选择留在原生入口；快照、停机、恢复与副本清理由共用核心负责。
        if (@($script:OpsInputNames | Where-Object { $_ -cnotin @('Command','RequestBase64','Json','Target','Expect') }).Count) { Err '统计导入含有不适用的参数'; exit 1 }
        if ($Json -and -not $Target) { Err 'JSON 调用需要明确指定统计文件路径'; exit 1 }
        $legacy = $Target
        if (-not $legacy) {
            Step "请在弹出的窗口中选择旧统计账本（旧部署的 data\groups\stats.sqlite）"
            $legacy = Select-LegacyStatsFile
            if (-not $legacy) { Err "未选择文件，未导入；也可直接给出路径：ops.ps1 stat-import <stats.sqlite>"; exit 2 }
        }
        if (-not (Test-Path -LiteralPath $legacy -PathType Leaf)) { Err "找不到旧统计账本：$legacy"; exit 1 }
        $legacy = (Resolve-Path -LiteralPath $legacy).Path
        $importArgs = @('maintenance', 'stat-import', $legacy); if ($Expect) { $importArgs += @('--expect', $Expect) }
        if (-not (Invoke-CoreMaintenance $importArgs)) { exit $script:OpsCoreExitCode }
    }
    "history-ls" {
        if (-not (Invoke-DataAdmin "scripts\ops\history-admin.ts" @("list"))) { exit 1 }
    }
    "history-clear" {
        # -All 清空所有会话空间（history-admin 的 clear --all）；-Direct 为单聊空间；与群号或群选择参数同用时拒绝，漏写群号只报错。
        if ($All) {
            if ($Target -or $Direct -or $StorageSegment -or $GroupId) { Err "history-clear -All 不能再指定群、-Direct 或群选择参数"; exit 2 }
            if (-not (Clear-SpaceHistory "--all")) { exit $script:OpsCoreExitCode }
        }
        elseif ($Direct) {
            if ($Target -or $StorageSegment -or $GroupId) { Err "history-clear -Direct 不能再指定群或群选择参数"; exit 2 }
            if (-not (Clear-SpaceHistory "--direct")) { exit $script:OpsCoreExitCode }
        }
        elseif (-not (Clear-SpaceHistory $Target)) { exit $script:OpsCoreExitCode }
    }
    "history-compact" {
        if (-not $User) { Err "history-compact 需要 -User <成员号码>"; exit 2 }
        if ($Direct -and ($Target -or $StorageSegment -or $GroupId)) { Err "history-compact -Direct 不能再指定群或群选择参数"; exit 2 }
        if (-not (Clear-SpaceHistory $(if ($Direct) { "--direct" } else { $Target }) "compact")) { exit $script:OpsCoreExitCode }
    }
    "maintenance-recover" {
        if (@($script:OpsInputNames | Where-Object { $_ -cnotin @('Command','RequestBase64','Json') }).Count) { Err '恢复命令不接受其他参数'; exit 1 }
        if (-not (Invoke-CoreMaintenance @('maintenance-recover'))) { exit $script:OpsCoreExitCode }
    }
    "revision-cleanup" {
        if (-not (Invoke-RevisionCleanupAdmin $Target)) { exit $script:OpsCoreExitCode }
    }
    # 历史归档清理：扫描只写清单；删除只按确认过的清单执行，工具逐条重新检查。
    { $_ -in @('backup-scan','backup-clean') } {
        if (@($script:OpsInputNames | Where-Object { $_ -cnotin @('Command','RequestBase64','Json','Target','ConfirmCode') }).Count) { Err '备份维护含有不适用的参数'; exit 1 }
        if ($Command -eq 'backup-clean' -and -not $Target) { Err 'backup-clean 需要报告名（tmp\backup-cleanup 下的目录名）'; exit 2 }
        $backupArgs = @('maintenance', $Command)
        if ($Target) { $backupArgs += $Target }
        if ($ConfirmCode) { $backupArgs += @('--confirm', $ConfirmCode) }
        if (-not (Invoke-CoreMaintenance $backupArgs)) { exit $script:OpsCoreExitCode }
    }
    "uninstall" { if (-not (Uninstall-Bot)) { exit 1 } }
    default {
        # 空参和显式 help 是「我要看帮助」，退 0；其余都是打错了的命令，必须退非零。
        $unknown = $Command -and $Command -ne "help"
        if ($unknown) { Err "无法识别的命令：$Command" }
        Write-Host "mixin-chatbot 运维工具（Windows Server）" -ForegroundColor Cyan
        Write-Host "用法：powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 <命令> [-Repair]"
        Write-Host "运维控制台：在项目根目录运行 bun run console，在浏览器中打开。"
        Write-Host ""
        Write-Host "  doctor          只读诊断（含共享资料目录与运行版本）；-Json 输出 JSON；-Repair 自动修复"
        Write-Host "  deploy          配置并部署当前代码；已有部署可重建，失败自动回滚"
        Write-Host "  update          同步 origin/main，停机前检查部署记录与配置，停机后切换并验证；提交前失败回滚"
        Write-Host "                  沿用现有端口、共享资料目录、应用凭据和 AI 配置；改配置请用 deploy"
        Write-Host "  resume          按事务记录继续中断的部署或升级（不重新提问）"
        Write-Host "  rollback        回滚中断的部署或升级；数据已提交时只能继续"
        Write-Host "  restart         停止并重新启动机器人"
        Write-Host "  stop            停止计划任务和 Bun 进程"
        Write-Host "  start           启动机器人计划任务"
        Write-Host "  foreground      以前台方式运行 launcher（Ctrl+C 停止）"
        Write-Host "  logs            持续查看 logs\mixin-chatbot.log"
        Write-Host "  relay-configure 交互配置可选的大文件外链；填写期间机器人照常运行，确认后短暂停机应用并恢复原运行状态"
        Write-Host "  model-configure 运行模型配置向导；填写期间机器人照常运行，确认后短暂停机应用并恢复原运行状态，失败时恢复原配置"
        Write-Host "  runtime-configure <草稿名> 应用控制台「设置」中已确认的高级运行参数"
        Write-Host "  configure-app-bot 填写应用机器人 AppID/AppSecret 并验证；之后与 model-configure 相同地应用"
        Write-Host "  directory       查看事件 Stream 与通讯录同步状态（同步范围及是否生效、映射数、最近同步、待复核的缺席）"
        Write-Host "  directory-scope all"
        Write-Host "                  把同步范围设为整个通讯录并应用；只同步部分部门请在控制台的「通讯录」中逐层勾选。"
        Write-Host "                  完整同步成功后一次切换，之前的名单在此前仍然生效"
        Write-Host "  relay-ls        列出已发出、仍在册的大文件外链"
        Write-Host "  relay-test      上传并删除一个随机测试文件，验收外链签名、私有访问和删除权限"
        Write-Host "  relay-purge <关键字>|-All"
        Write-Host "                  删除匹配的外链对象并清掉索引记录"
        Write-Host "  tmp-ls [-User <手机号>] [-Group <群号>|direct]"
        Write-Host "                  列出各用户临时目录的占用（缓存、中间产物、截断日志）；direct 为单聊空间"
        Write-Host "  tmp-preview -Days <天数> | -All  核对引用并保存清单（服务照常运行）"
        Write-Host "  tmp-purge -Plan <ID> -Digest <摘要>  停机执行或继续归档清单，再恢复原状态"
        Write-Host "  tmp-reclaim -Days <天数> | -All  预览物理回收，再用 -Plan/-Digest 确认"
        Write-Host "  tmp-discard     预览可永久删除的归档，再用 -Plan/-Digest 确认，释放磁盘空间"
        Write-Host "  tmp-purge -Days <天数> | -All [-User <手机号>] [-Group <群号>]"
        Write-Host "                  清理用户临时目录；-Days 只删这些天没改动过的条目"
        Write-Host "  stat [群号] [-Period today|yesterday|week|last-week|month|last-month|7d|30d|all]"
        Write-Host "              或 [-Since <日期>] [-Until <日期>]"
        Write-Host "                  使用统计：多少人用过、提问多少次、模型用了多少 token；日期格式 YYYY-MM-DD"
        Write-Host "  stat-import [旧账本]  一次性导入旧版统计（提问数与 token）；不给路径时弹出文件选择框；停机导入后恢复原运行状态"
        Write-Host "  history-ls      列出单聊空间和各群的会话历史（会话库的占用、最后活动）"
        Write-Host "  history-clear <群号>|-Direct  清空该群（或单聊空间）全部成员的上下文；自动停机、清理，再恢复原运行或停止状态"
        Write-Host "  history-compact <群号>|-Direct -User <成员号码>  停机登记压缩并恢复原运行状态（产生模型用量）"
        Write-Host "                  群选择可加 -GroupId（原始群号）或 -StorageSegment（目录段）"
        Write-Host "  history-clear -All  清空所有会话空间全部成员的上下文；一次停机完成，某个空间失败时其余照常清空"
        Write-Host "  maintenance-recover 回收中断的维护写入者，恢复原运行状态，不重复数据动作"
        Write-Host "  revision-cleanup preview|status  只读：会话库中待整理的旧修订链、预计用时与空间；上次整理的状态"
        Write-Host "  revision-cleanup apply|skip|abandon"
        Write-Host "                  停机整理旧修订链（先备份到 backup\revision-cleanup）、跳过或放弃剩余整理；维护状态允许时恢复原运行状态"
        Write-Host "  revision-cleanup restore -Space <空间>  整理发现基准与记录不同时，停机从备份恢复那个库（校验通过才执行）"
        Write-Host "  revision-cleanup shrink-preview|shrink-status  只读：可收缩的会话库、空闲页与所需空间；上次收缩的状态与保留的原库"
        Write-Host "  revision-cleanup shrink [-Space <空间>]  停机收缩会话库文件（原库保留为同目录的 .old），再恢复原运行状态"
        Write-Host "  revision-cleanup shrink-remove-old [-Yes]  列出收缩保留的原库；确认机器人运行正常后加 -Yes 删除"
        Write-Host "  backup-scan     只读扫描 backup\rm、snapshots 和 revision-cleanup，分类后在 tmp\backup-cleanup 生成清单，不删除"
        Write-Host "  backup-clean <报告名> [-ConfirmCode <确认码>]"
        Write-Host "                  不带确认码时预演并给出确认码；带确认码时按清单的精确路径删除，不可撤销"
        Write-Host "  uninstall       清理任务/进程/launcher，可选清理 data 和 logs"
        if ($unknown) { exit 1 }
    }
}
