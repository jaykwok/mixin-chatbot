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

# 当前发布必须有完整记录；其他格式的记录不被识别。
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
        Invoke-WithUtf8Output { & $Bun --no-env-file run (Join-Path $ProjectRoot "ops\config\$Wizard") --stage $Stage }
        $code = $global:LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $Stage $Staged) -PathType Leaf)) { throw '配置未完成（取消或失败，原因见上方）；服务尚未停止，未做任何改动' }
}

# ---- 通讯录同步范围（data\config\directory.json）----
# 与 deploy.sh、upgrade.sh 相同：范围必须明确选择，没有默认值。已有应用机器人凭据而没有范围时在停机前选择
# （ops\config\directory-scope.ts choose --plan：设置了 BOT_DIRECTORY_SCOPE 时不交互，否则
# 在终端里运行向导，没有终端就失败），计划随事务快照保存，停机后写入；续做沿用这份计划，不再选择。
# 脚本的退出码留在 $LASTEXITCODE：0 已写入，1 失败，2 取消。向导直接使用终端：只能作为语句调用，输出不经管道也不被
# 收集（收集输出会重定向标准输出，向导就没有终端，返回值也会混进输出），标准错误也不转成 PowerShell 错误。
function Invoke-DirectoryScopeTool([string]$Bun, [string]$Script, [string[]]$Arguments) {
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
