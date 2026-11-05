. (Join-Path $PSScriptRoot 'operation-log.ps1')
. (Join-Path $PSScriptRoot 'file-replace.ps1')

function Save-DeploymentSnapshot($Snapshot) {
    $saved = $Snapshot | Select-Object * -ExcludeProperty Lock, Record
    Save-FileAtomically (Join-Path $Snapshot.Path 'deployment.xml') { param($temporary) $saved | Export-Clixml -LiteralPath $temporary }.GetNewClosure()
}

# 部署/升级事务记录：快照目录中的 transaction 文件，与 Linux 同一格式（每行 key=value）。
# 记录停机前确认的全部选择；续做和回滚只使用记录值，不重新读取默认值。凭据永不写入。
function Get-TransactionKeys {
    return @('format', 'operation', 'snapshot', 'target_sha', 'original_sha', 'original_branch', 'original_workspace_root',
        'target_workspace_root', 'was_running', 'bot_port', 'reconfigure_ai')
}

function Test-TransactionValue([string]$Key, [string]$Value) {
    if ($Value -match '[\x00-\x1f\x7f]') { return $false }
    switch -CaseSensitive ($Key) {
        'format' { return $Value -ceq '2' }
        'operation' { return $Value -cin @('deploy', 'upgrade') }
        'snapshot' { return $Value -cmatch '^deploy-[A-Za-z0-9]+$' }
        'target_sha' { return $Value -cmatch '^([0-9a-f]{40}|[0-9a-f]{64})?$' }
        'original_sha' { return $Value -cmatch '^([0-9a-f]{40}|[0-9a-f]{64})?$' }
        'original_branch' { return $Value -cmatch '^[^\s~^:?*\[\\]*$' }
        'original_workspace_root' { return -not $Value -or [IO.Path]::IsPathRooted($Value) }
        'target_workspace_root' { return -not $Value -or [IO.Path]::IsPathRooted($Value) }
        'was_running' { return $Value -cin @('0', '1') }
        'reconfigure_ai' { return $Value -cin @('0', '1') }
        'bot_port' { $number = 0; return ($Value -cmatch '^[1-9][0-9]{0,4}$') -and [int]::TryParse($Value, [ref]$number) -and $number -le 65535 }
    }
    return $false
}

# 当前发布必须有完整记录；其他格式的记录（旧版发布）不被识别。
function Read-DeploymentTransaction([string]$Directory) {
    $path = Join-Path $Directory 'transaction'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '事务格式不匹配：缺少当前发布记录' }
    $record = @{}
    foreach ($line in [IO.File]::ReadAllLines($path, [Text.UTF8Encoding]::new($false))) {
        $index = $line.IndexOf('=')
        if ($index -lt 1) { throw '事务记录无效' }
        $key = $line.Substring(0, $index)
        $value = $line.Substring($index + 1)
        if ($record.ContainsKey($key) -or -not (Test-TransactionValue $key $value)) { throw "事务记录无效：$key" }
        $record[$key] = $value
    }
    foreach ($key in (Get-TransactionKeys)) { if (-not $record.ContainsKey($key)) { throw "事务记录缺少：$key" } }
    return $record
}

# 已提交部署保存的外置共享资料目录（绝对路径）；为空表示默认的 data\workspace。
function Get-SavedWorkspaceRoot([string]$ProjectRoot) {
    $file = Join-Path $ProjectRoot 'data\state\workspace-root'
    if (Test-Path -LiteralPath $file -PathType Leaf) { return "$(Get-Content -LiteralPath $file -Raw)".Trim() }
    return ''
}

function Format-DeploymentTransaction($Record) {
    $kind = if ($Record.operation -eq 'upgrade') { '升级' } else { '部署' }
    $state = if ($Record.was_running -eq '1') { '运行' } else { '停止' }
    $sha = if ($Record.target_sha) { $Record.target_sha.Substring(0, 7) } else { '（非 git 部署）' }
    return "未完成的$($kind)：目标提交 $($sha)；共享资料目录 $(if ($Record.target_workspace_root) { $Record.target_workspace_root } else { 'data\workspace' })（原 $(if ($Record.original_workspace_root) { $Record.original_workspace_root } else { 'data\workspace' })）；本机端口 $($Record.bot_port)；原运行状态：$($state)"
}

function Remove-UpgradeStage([string]$ProjectRoot, [string]$Stage) {
    $temporaryRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'tmp')).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($Stage).TrimEnd('\')
    if ((Split-Path $target -Parent) -ne $temporaryRoot -or (Split-Path $target -Leaf) -notmatch '^upgrade-[0-9a-f]{32}$') { throw '升级临时目录越界' }
    if (-not (Test-Path -LiteralPath $target)) { return }
    if ((Get-Item -LiteralPath $temporaryRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '升级临时目录经过链接' }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($target)
    while ($pending.Count) {
        $directory = $pending.Pop()
        $item = Get-Item -LiteralPath $directory -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '升级临时目录含链接' }
        foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '升级临时目录含链接' }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
}

function Save-DeploymentDependencies($Snapshot) {
    $root = [IO.Path]::GetFullPath($Snapshot.Project).TrimEnd('\')
    $source = [IO.Path]::GetFullPath((Join-Path $root 'node_modules'))
    $target = [IO.Path]::GetFullPath((Join-Path $Snapshot.Path 'node_modules'))
    if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '依赖快照目录越界' }
    # A resumed transaction already recorded that there were no original
    # dependencies; the node_modules present now came from the interrupted install.
    if ($Snapshot.DependenciesAttempted -and -not $Snapshot.DependenciesMoved) { return }
    if (Test-Path -LiteralPath $target) {
        $Snapshot.DependenciesMoved = $true
        $Snapshot.DependenciesAttempted = $true
        Save-DeploymentSnapshot $Snapshot
        return
    }
    # Write intent before the atomic same-volume move. Recovery distinguishes a
    # completed move by the backup directory, so interruption cannot overwrite it.
    $Snapshot.DependenciesMoved = Test-Path -LiteralPath $source
    $Snapshot.DependenciesAttempted = $true
    Save-DeploymentSnapshot $Snapshot
    if ($Snapshot.DependenciesMoved) {
        Move-Item -LiteralPath $source -Destination $target -ErrorAction Stop
    }
}

# ---- 部署入口：工具与配置向导 ----
function Test-VersionedApplication([string]$Path, [string]$RequiredPattern = '') {
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

function Test-Administrator {
    return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 部署在停机前找到计划任务要运行的工具（git、GNU bash、Bun ≥ 1.4.4、原生 uv.exe），绝对路径记入暂存，之后不再从 PATH
# 查找。缺少时抛出带安装提示的说明（服务尚未停止）。
function Find-DeployTools {
    $gitPaths = @(Get-ApplicationPaths "git")
    $knownGitRoots = @()
    if ($env:ProgramFiles) { $knownGitRoots += (Join-Path $env:ProgramFiles "Git") }
    if (${env:ProgramFiles(x86)}) { $knownGitRoots += (Join-Path ${env:ProgramFiles(x86)} "Git") }
    if ($env:LOCALAPPDATA) { $knownGitRoots += (Join-Path $env:LOCALAPPDATA "Programs\Git") }
    foreach ($candidateRoot in $knownGitRoots) {
        foreach ($candidateGit in @((Join-Path $candidateRoot "cmd\git.exe"), (Join-Path $candidateRoot "bin\git.exe"))) {
            if ((Test-Path -LiteralPath $candidateGit -PathType Leaf) -and $gitPaths -notcontains $candidateGit) { $gitPaths += $candidateGit }
        }
    }
    $workingGitPaths = @($gitPaths | Where-Object { Test-VersionedApplication $_ '(?i)^git version\b' })
    if ($workingGitPaths.Count -eq 0) { throw "缺少 git。请安装 Git for Windows（同时提供 agent bash 工具所需的 bash.exe）：`n  https://git-scm.com/download/win" }
    $bashCandidates = @()
    foreach ($candidateRoot in @($workingGitPaths | ForEach-Object { Split-Path (Split-Path $_ -Parent) -Parent }) + $knownGitRoots) {
        if (-not $candidateRoot) { continue }
        foreach ($candidateBash in @((Join-Path $candidateRoot "bin\bash.exe"), (Join-Path $candidateRoot "usr\bin\bash.exe"))) {
            if ((Test-Path -LiteralPath $candidateBash -PathType Leaf) -and $bashCandidates -notcontains $candidateBash) { $bashCandidates += $candidateBash }
        }
    }
    foreach ($candidateBash in @(Get-ApplicationPaths "bash")) {
        # 排除 Windows 自带的 WSL 启动器；它不是 agent bash 工具需要的 GNU bash.exe。
        if ($candidateBash -match '(?i)(\\Windows\\System32\\bash\.exe$|\\WindowsApps\\bash\.exe$)') { continue }
        if ($bashCandidates -notcontains $candidateBash) { $bashCandidates += $candidateBash }
    }
    $bashPath = @($bashCandidates | Where-Object { Test-VersionedApplication $_ '(?i)GNU bash' } | Select-Object -First 1)
    if ($bashPath.Count -ne 1) { throw '缺少 bash.exe。请安装并启用 Git Bash；agent bash 工具需要它。' }
    # npm 风格的 Bun 安装可能同时暴露 bun.cmd 和 bun；逐个探测具体路径，避免 PowerShell 将多个匹配项拼成一个命令字符串。
    $bunPaths = @(Get-ApplicationPaths "bun")
    foreach ($knownBunPath in @($(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE ".bun\bin\bun.exe" }), $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\bun.exe" }))) {
        if ($knownBunPath -and (Test-Path -LiteralPath $knownBunPath -PathType Leaf) -and $bunPaths -notcontains $knownBunPath) { $bunPaths += $knownBunPath }
    }
    if ($bunPaths.Count -eq 0) {
        throw "缺少 bun。请选择一种方式安装：`n  powershell -c ""irm bun.sh/install.ps1 | iex""`n  winget install Oven-sh.Bun`n安装后请重新打开管理员 PowerShell，再运行部署脚本。"
    }
    $bun = $null
    foreach ($bunPathCandidate in $bunPaths) {
        $bun = Test-VersionedApplication $bunPathCandidate '^\d+(?:\.\d+)+'
        if ($bun) { break }
    }
    if (-not $bun) { throw 'bun --version 执行失败；找到的 bun 命令都不可用。' }
    if ([Version]($bun.Version -replace '-.*$', '') -lt [Version]'1.4.4') { throw "需要 Bun 1.4.4 或更高版本（当前 $($bun.Version)）。" }
    $uvPath = @(Get-ApplicationPaths 'uv.exe' | Where-Object { Test-VersionedApplication $_ '^uv ' } | Select-Object -First 1)
    if ($uvPath.Count -ne 1) { throw '缺少原生 uv.exe，请先安装 uv 并加入 PATH。' }
    return [pscustomobject]@{ Git = $workingGitPaths[0]; Bash = $bashPath[0]; Bun = $bun.Path; BunVersion = $bun.Version; Uv = $uvPath[0] }
}

# 配置向导直接使用终端：作为语句调用，输出不经管道（见下方 Invoke-DirectoryScopeTool）。回答只写进部署暂存；取消时向导
# 不写暂存文件。
function Invoke-StagedWizard([string]$Bun, [string]$ProjectRoot, [string]$Stage, [string]$Label, [string]$Wizard, [string]$Staged) {
    if ([Console]::IsInputRedirected) { throw "$($Label)需要在终端里运行向导；服务尚未停止，未做任何改动" }
    Write-Host "[*] $Label（回答先暂存，停止服务后写入）..." -ForegroundColor Cyan
    Set-OperationStage $Label
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 1
        Invoke-WithUtf8Output { & $Bun --no-env-file run (Join-Path $ProjectRoot "scripts\config\$Wizard") --stage $Stage }
        $code = $global:LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $Stage $Staged) -PathType Leaf)) { throw '配置未完成（取消或失败，原因见上方）；服务尚未停止，未做任何改动' }
}

# ---- 通讯录同步范围（data\config\directory.json）----
# 与 deploy.sh、upgrade.sh 相同：范围必须明确选择，没有默认值。已有应用机器人凭据而没有范围时（含从 1.0.1 及更早版本
# 部署或升级）在停机前选择（scripts\config\directory-scope.ts choose --plan：设置了 BOT_DIRECTORY_SCOPE 时不交互，否则
# 在终端里运行向导，没有终端就失败），计划随事务快照保存，停机后写入；续做沿用这份计划，不再选择。
# 脚本的退出码留在 $LASTEXITCODE：0 已写入，1 失败，2 取消。向导直接使用终端：只能作为语句调用，输出不经管道也不被
# 收集（收集输出会重定向标准输出，向导就没有终端，返回值也会混进输出），标准错误也不转成 PowerShell 错误。
# 从 1.0.1 及更早版本升级时，由旧版 ops.ps1 经 `| Out-Host` 启动本升级器，标准输出已经是管道（标准输入仍是控制台）：
# 要运行向导时（choose，没有设置 BOT_DIRECTORY_SCOPE）把工具直接接到控制台上，否则向导认为没有终端，
# 只能选整个通讯录。
function Invoke-DirectoryScopeTool([string]$Bun, [string]$Script, [string[]]$Arguments) {
    if ($Arguments[0] -eq 'choose' -and -not "$env:BOT_DIRECTORY_SCOPE".Trim() -and
        (Test-ConsoleOutputPiped)) {
        $global:LASTEXITCODE = Invoke-ConsoleProcess $Bun (@('--no-env-file', 'run', $Script) + $Arguments) -Screen
        return
    }
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 1
        Invoke-WithUtf8Output { & $Bun --no-env-file run $Script @Arguments }
    } finally { $ErrorActionPreference = $previous }
}

# 停机前：选定的范围写入计划文件；取消或失败时抛出（服务尚未停止）。作为语句调用（见上）。首次部署的应用凭据还在部署暂存
# 里：-App 指向暂存的 configuration-app.json，向平台核对部门时用它。
function Select-DirectoryScope([string]$Bun, [string]$Script, [string]$ProjectRoot, [string]$Plan, [string]$App = '') {
    Remove-Item -LiteralPath $Plan -Force -ErrorAction SilentlyContinue
    Invoke-DirectoryScopeTool $Bun $Script (@('choose', '--plan', $Plan, '--project', $ProjectRoot) + $(if ($App) { @('--app', $App) } else { @() }))
    $code = $global:LASTEXITCODE
    if ($code -eq 2) { throw '已取消选择通讯录同步范围；服务尚未停止，未做任何改动' }
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $Plan -PathType Leaf)) { throw '没有选定通讯录同步范围（原因见上方）；服务尚未停止，未做任何改动' }
}

# ---- 修订链首次整理（revision-chain plan §4、§8）----
# 与 scripts/lib/deployment.sh 的同名一段相同：停机前用目标版本的代码只读预览（revision-cleanup.ts preview --json），
# 决定停机后整理（先备份）或跳过（BOT_REVISION_CLEANUP=apply|skip；不设置时终端交互询问，默认整理，非交互也整理）。
# 空间不足时停机前拒绝，由用户释放空间或显式选择跳过，不自动改变整理方式。选择写入事务快照的 revision-cleanup，续做
# 沿用。整理在停机后、数据准备之后、验证实例之前运行；回滚先结束它（在途文档收尾），维护状态不允许启动时回滚在恢复
# 数据之前停止、保持停机。

# 维护命令的结构化结果（scripts/lib/maintenance-protocol.ts 的 --json）：标准输出只有一行协议。返回
# @{ Outcome; Code; Result; Message }；输出不是一行 JSON、协议或版本不符、命令不符或 outcome 未知时 Outcome 为 incomplete。
function ConvertFrom-MaintenanceResult([string[]]$Lines, [string]$Command, [int]$Code) {
    $incomplete = @{ Outcome = 'incomplete'; Code = $Code; Result = $null; Message = '' }
    $text = @($Lines | Where-Object { "$_".Trim() })
    if ($text.Count -ne 1) { return $incomplete }
    try { $value = ConvertFrom-Json -InputObject $text[0] -ErrorAction Stop } catch { return $incomplete }
    if ($value -isnot [Management.Automation.PSCustomObject]) { return $incomplete }
    if ($value.protocol -isnot [string] -or $value.protocol -cne 'mixin-maintenance') { return $incomplete }
    if (-not ($value.version -is [int] -or $value.version -is [long]) -or $value.version -ne 1) { return $incomplete }
    if ($value.command -isnot [string] -or $value.command -cne $Command) { return $incomplete }
    if ($value.outcome -isnot [string] -or $value.outcome -cnotin @('success', 'refused', 'stopped', 'not-enough-space', 'failed')) { return $incomplete }
    return @{ Outcome = $value.outcome; Code = $Code; Result = $value.result; Message = $(if ($value.message -is [string]) { $value.message } else { '' }) }
}

# 运行维护工具（revision-cleanup.ts、maintenance.ts）的一个命令并读取它的 --json 结果。标准输出和标准错误分开读：
# 说明和进度在标准错误，按 UTF-8 解码后写向终端和运维日志；标准输出只交给协议解析，不会混进调用函数的返回值。
# 结果不完整时把捕获的标准输出也显示出来，原因不会被吞掉。
function Invoke-MaintenanceTool([string]$Bun, [string]$Script, [string]$Command, [string[]]$Arguments) {
    $lines = [Collections.Generic.List[string]]::new()
    $previous = $ErrorActionPreference
    $encoding = $null
    try { $encoding = [Console]::OutputEncoding; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { $encoding = $null }
    try {
        # 原生命令写标准错误时，Windows PowerShell 5.1 在 Stop 下会把它当成终止错误。
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = 1
        & $Bun --no-env-file run $Script $Command @Arguments --json 2>&1 | ForEach-Object {
            if ($_ -is [Management.Automation.ErrorRecord]) {
                $line = $_.Exception.Message
                Write-Host $line
                Write-OperationEvent 'output' $line
            } else { $lines.Add([string]$_) }
        }
        $code = [int]$LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
        if ($null -ne $encoding) { try { [Console]::OutputEncoding = $encoding } catch { } }
    }
    Write-OperationEvent 'info' ((Split-Path $Script -Leaf) + " $Command; exit=$code")
    $result = ConvertFrom-MaintenanceResult $lines.ToArray() $Command $code
    if ($result.Outcome -ceq 'incomplete') {
        foreach ($line in $lines) { Write-Host $line }
        Write-Warning "$Command 的结果不完整或无法识别（退出码 $code），按失败处理"
    }
    return $result
}

# 只有退出码 0、结果完整且 outcome 为 success 才算成功。
function Test-MaintenanceSuccess($Result) { return ($Result.Code -eq 0 -and $Result.Outcome -ceq 'success') }

# 跳过修订整理的办法：控制台任务不能设置环境变量，要在升级或重新部署的表单里重新预览并选择跳过。
function Get-RevisionCleanupSkipHint {
    if ($env:MIXIN_OPS_CONSOLE -ceq '1') { return '重新预览并选择“跳过整理”' }
    return '设置 BOT_REVISION_CLEANUP=skip 跳过整理'
}

# 停机前决定本次的整理方式（apply 或 skip），并确认这个选择需要的空间；在停止服务之前调用。<Script> 是目标版本的
# revision-cleanup.ts。还没有会话库时不预览。维护状态不允许结束整理（要求从备份恢复、收缩未完成、日志格式不受支持）
# 时预览答 refused，在这里拒绝。预览没能给出结果（例如升级导出沿用的旧依赖无法加载它）时按环境变量或默认值处理：
# 整理在停机后自己检查维护状态和空间，不满足时不开始，部署随之回滚。
function Select-RevisionCleanup([string]$Bun, [string]$Script, [string]$ProjectRoot) {
    $choice = "$env:BOT_REVISION_CLEANUP".Trim()
    if ($choice -and $choice -cnotin @('apply', 'skip')) { throw 'BOT_REVISION_CLEANUP 只能是 apply（默认）或 skip；服务尚未停止' }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'data\conversations') -PathType Container) -and
        -not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'data\state\revision-cleanup.json'))) {
        return $(if ($choice) { $choice } else { 'apply' })
    }
    $result = Invoke-MaintenanceTool $Bun $Script 'preview' @('--project', $ProjectRoot)
    if ($result.Outcome -ceq 'refused') { throw '修订整理预览被拒绝（原因见上方）；服务尚未停止' }
    if (-not (Test-MaintenanceSuccess $result) -or $null -eq $result.Result) {
        if ($env:MIXIN_OPS_CONSOLE -ceq '1') { throw '停机前无法预览修订整理，控制台操作已拒绝；服务尚未停止' }
        $fallback = if ($choice) { $choice } else { 'apply' }
        Write-Warning "停机前无法预览会话库的旧修订链（原因见上方）；按 $fallback 处理，整理在停机后自己检查维护状态和空间，不满足时不开始，部署随之回滚"
        return $fallback
    }
    $preview = $result.Result
    $runState = if ($null -ne $preview.run) { [string]$preview.run.state } else { 'none' }
    if ($runState -ceq 'stopped' -and $choice -cne 'skip') {
        throw "上次修订整理已停止，只能跳过剩余整理或回滚，不能续做；请先用 $(Get-OpsCommandHint 'revision-cleanup skip') 结束它，或$(Get-RevisionCleanupSkipHint)；服务尚未停止"
    }
    if ([long]$preview.documents -eq 0 -and $runState -ceq 'none') { return $(if ($choice) { $choice } else { 'apply' }) }
    $minutes = [Math]::Max([long]1, [long][Math]::Ceiling([long]$preview.seconds / 60))
    if (-not $choice) {
        $choice = 'apply'
        if (-not [Console]::IsInputRedirected -and -not (Read-YesNo "停机后整理这些文档的旧修订链？停机约延长 $minutes 分钟，跳过请输入 n [Y/n]" $true)) { $choice = 'skip' }
    }
    if ($choice -ceq 'skip') {
        Write-Warning ("跳过修订整理：其中 $($preview.legacy) 份超过上限的旧长链在服务运行中保持现状（读入较慢，链继续变长），其余的由服务在下次变更时整理；" +
            "之后可停机用 $(Get-OpsCommandHint 'revision-cleanup apply') 整理")
        return $choice
    }
    # 续做的整理沿用已验证的备份（预览已按它计算）。
    $backupBytes = [long]$preview.backupBytes
    $space = Invoke-MaintenanceTool $Bun $Script 'space' @('--project', $ProjectRoot, '--backup-bytes', "$backupBytes", '--wal-bytes', "$([long]$preview.walBytes)")
    if ($space.Outcome -ceq 'not-enough-space') { throw "剩余空间不够修订整理（见上方）；可以释放空间后重试，或$(Get-RevisionCleanupSkipHint)（不会自动省略备份）；服务尚未停止" }
    if (-not (Test-MaintenanceSuccess $space)) { throw '修订整理的空间检查失败（原因见上方）；服务尚未停止' }
    if ($backupBytes) {
        Write-Host "停机后整理旧修订链，约 $minutes 分钟；先备份要修改的会话库（$([Math]::Round($backupBytes / 1MB, 1)) MB，备份留在 backup\revision-cleanup，确认后再删除）"
    } else { Write-Host "停机后续做上次的修订整理，约 $minutes 分钟" }
    return $choice
}
