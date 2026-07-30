# mixin-chatbot - Windows Server 部署（原生 Bun，无需 Docker）。
# agent 的 bash 工具需要 bash.exe；请安装 Git for Windows（同时提供 git）。
# 运行时：Bun（https://bun.sh）。
# 持久化：Windows 计划任务（优先开机启动、无需用户登录；失败自动重试）。
#
# 请在管理员 PowerShell 中运行：
#   powershell -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1
$ErrorActionPreference = "Stop"
$Project  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Project
$Entry    = Join-Path $Project "src\server\index.ts"
$TaskName = "mixin-chatbot"
$DataDir = Join-Path $Project "data"
$ConfigDir = Join-Path $DataDir "config"
$StateDir = Join-Path $DataDir "state"
$RuntimeDir = Join-Path $DataDir "runtime"
$DefaultGroupDataRoot = Join-Path $DataDir "groups"
$ModelsFile = Join-Path $ConfigDir "models.json"
$WebhookSecretFile = Join-Path $ConfigDir "webhook-secret"
$TunnelTokenFile = Join-Path $ConfigDir "tunnel-token"
$PortFile = Join-Path $StateDir "bot-port"
$ModeFile = Join-Path $StateDir "deploy-mode"
$DomainFile = Join-Path $StateDir "bot-domain"
$GroupRootFile = Join-Path $StateDir "group-data-root"
$TunnelManagedFile = Join-Path $StateDir "cloudflared-managed"
$LauncherFile = Join-Path $RuntimeDir "bot-launcher.ps1"
$WindowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) { $WindowsPowerShell = "powershell.exe" }

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Read-YesNo([string]$Prompt, [bool]$Default = $false) {
    while ($true) {
        $rawAnswer = Read-Host $Prompt
        $answer = if ($null -eq $rawAnswer) { "" } else { $rawAnswer.Trim().ToLowerInvariant() }
        if (-not $answer) { return $Default }
        if ($answer -in @("y", "yes", "是")) { return $true }
        if ($answer -in @("n", "no", "否")) { return $false }
        Warn "请输入 y 或 n（也可直接回车采用默认值）"
    }
}
function Get-ApplicationPaths([string]$Name) {
    $paths = @()
    foreach ($command in @(Get-Command $Name -All -CommandType Application -ErrorAction SilentlyContinue)) {
        foreach ($rawCandidate in @($command.Path)) {
            $candidate = [string]$rawCandidate
            if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            if ($paths -notcontains $candidate) { $paths += $candidate }
        }
    }
    return $paths
}
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
function Wait-BotHealth([string]$ListenPort, [int]$Attempts = 18) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $status = (Invoke-WebRequest -Uri "http://localhost:$ListenPort/favicon.svg" -UseBasicParsing -TimeoutSec 2).StatusCode
            if ($status -eq 200) { return $true }
        } catch {}
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
function Get-ServiceStateLabel($State) {
    switch ([string]$State) {
        "Running" { return "运行中" }
        "Stopped" { return "已停止" }
        "StartPending" { return "正在启动" }
        "StopPending" { return "正在停止" }
        default { return [string]$State }
    }
}

$BotDebug = if ([string]::IsNullOrWhiteSpace($env:BOT_DEBUG)) { "0" } else { $env:BOT_DEBUG.Trim() }
if ($BotDebug -notin @("0", "1")) {
    Write-Host "BOT_DEBUG 只能是 0 或 1。" -ForegroundColor Red
    exit 1
}
$BotMaxActiveRequests = if ([string]::IsNullOrWhiteSpace($env:BOT_MAX_ACTIVE_REQUESTS)) { "32" } else { $env:BOT_MAX_ACTIVE_REQUESTS.Trim() }
$parsedMaxActiveRequests = 0
if (-not [int]::TryParse($BotMaxActiveRequests, [ref]$parsedMaxActiveRequests) -or
    $parsedMaxActiveRequests -lt 1 -or $parsedMaxActiveRequests -gt 1000) {
    Write-Host "BOT_MAX_ACTIVE_REQUESTS 必须是 1–1000 的整数。" -ForegroundColor Red
    exit 1
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
function Test-Hostname([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 253) { return $false }
    foreach ($label in $Value.Split('.')) {
        if ($label.Length -lt 1 -or $label.Length -gt 63 -or
            $label -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$') {
            return $false
        }
    }
    return $true
}
function ConvertTo-Hostname([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $candidate = $Value.Trim()
    if (Test-Hostname $candidate) { return $candidate.ToLowerInvariant() }

    $uri = $null
    if ([Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) -and
        $uri.Scheme -in @("http", "https") -and
        $uri.IsDefaultPort -and
        [string]::IsNullOrEmpty($uri.UserInfo) -and
        $uri.AbsolutePath -eq "/" -and
        [string]::IsNullOrEmpty($uri.Query) -and
        [string]::IsNullOrEmpty($uri.Fragment) -and
        (Test-Hostname $uri.DnsSafeHost)) {
        return $uri.DnsSafeHost.ToLowerInvariant()
    }
    return $null
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
    Write-Host "缺少 git。请安装 Git for Windows（同时提供 agent bash 工具所需的 bash.exe）：" -ForegroundColor Red
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
    Write-Host "缺少 bash.exe。请安装并启用 Git Bash；agent bash 工具需要它。" -ForegroundColor Red
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
    Write-Host "缺少 bun。请选择一种方式安装：" -ForegroundColor Red
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
if (-not $bunPath) { Write-Host "bun --version 执行失败；找到的 bun 命令都不可用。" -ForegroundColor Red; exit 1 }
Done "bun 版本：$bunVersion"

# ---- 2. 依赖 ----
Step "安装依赖（bun install --frozen-lockfile）..."
$previousErrorActionPreference = $ErrorActionPreference
$bunInstallExitCode = 1
try {
    $ErrorActionPreference = "Continue"
    & $bunPath install --frozen-lockfile
    $bunInstallExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
if ($bunInstallExitCode -ne 0) { Write-Host "bun install 执行失败（退出码 $bunInstallExitCode）。" -ForegroundColor Red; exit 1 }

# ---- 3. 持久化目录 + AI 配置 ----
New-Item -ItemType Directory -Force -Path $ConfigDir, $StateDir, $RuntimeDir, (Join-Path $Project "logs") | Out-Null
if (-not (Test-Path -LiteralPath $ModelsFile -PathType Leaf)) {
    Step "首次配置 AI（provider/key/model）..."
    $previousErrorActionPreference = $ErrorActionPreference
    $configureExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        & $bunPath run configure
        $configureExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($configureExitCode -ne 0) { Write-Host "AI 配置失败（退出码 $configureExitCode）。" -ForegroundColor Red; exit 1 }
    if (-not (Test-Path -LiteralPath $ModelsFile -PathType Leaf)) { Write-Host "未生成 data\config\models.json，部署中止。" -ForegroundColor Red; exit 1 }
} else {
    Done "data\config\models.json 已存在"
    if (Read-YesNo "是否重新配置 AI（provider/key/model）？[y/N]" $false) {
        $previousErrorActionPreference = $ErrorActionPreference
        $configureExitCode = 1
        try {
            $ErrorActionPreference = "Continue"
            & $bunPath run configure
            $configureExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($configureExitCode -ne 0) { Write-Host "AI 配置失败（退出码 $configureExitCode）。" -ForegroundColor Red; exit 1 }
    }
}

# ---- 4. webhook 密钥 ----
$showSecret = $false
if (-not (Test-Path -LiteralPath $WebhookSecretFile -PathType Leaf)) {
    Step "生成 webhook 随机密钥..."
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    Set-Content -LiteralPath $WebhookSecretFile -Value $secret -NoNewline -Encoding ASCII
    $showSecret = $true
    Done "webhook 密钥已生成"
} else {
    $secret = (Get-Content -LiteralPath $WebhookSecretFile -Raw).Trim()
    if ($secret -notmatch "^[0-9a-fA-F]{64}$") {
        Write-Host "data\config\webhook-secret 格式无效（应为 64 位十六进制字符）。" -ForegroundColor Red
        Write-Host "删除该文件后重新运行 scripts\deploy\deploy.ps1 可生成新密钥。" -ForegroundColor Red
        exit 1
    }
    Done "沿用已有 webhook-secret"
}

$persistDomain = $false
$clearPersistedDomain = $false
$invalidConfiguredDomain = ""
if (-not [string]::IsNullOrWhiteSpace($env:BOT_DOMAIN)) {
    $rawPublicDomain = $env:BOT_DOMAIN.Trim()
    $domainSource = "BOT_DOMAIN"
} elseif (Test-Path -LiteralPath $DomainFile) {
    $rawPublicDomain = (Get-Content -LiteralPath $DomainFile -Raw).Trim()
    $domainSource = "data\state\bot-domain"
} else {
    $rawPublicDomain = ""
    $domainSource = ""
}
$publicDomain = ConvertTo-Hostname $rawPublicDomain
if ($rawPublicDomain -and -not $publicDomain) {
    $invalidConfiguredDomain = $rawPublicDomain
    $clearPersistedDomain = $domainSource -eq "data\state\bot-domain"
} elseif ($publicDomain -and ($domainSource -eq "BOT_DOMAIN" -or $publicDomain -cne $rawPublicDomain)) {
    $persistDomain = $true
}

# ---- 4b. Pi 群数据总根（<group>/workspace + <group>/users/<phone>/{tmp,session.jsonl}）----
Step "配置 Pi 群数据总根"
$savedGroupRoot = if (Test-Path -LiteralPath $GroupRootFile -PathType Leaf) {
    (Get-Content -LiteralPath $GroupRootFile -Raw).Trim()
} else {
    ""
}
$groupRootDefault = if (-not [string]::IsNullOrWhiteSpace($env:GROUP_DATA_ROOT)) {
    $env:GROUP_DATA_ROOT.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($savedGroupRoot)) {
    $savedGroupRoot
} else {
    "data\groups"
}
Write-Host "  默认 data\groups；GROUP_DATA_ROOT 可覆盖到其他磁盘。"
Write-Host "  部署成功后会记入 data\state\group-data-root，下次自动沿用。"
Write-Host "  如需调整，可输入相对仓库路径或绝对路径。"
Write-Host "  每个群使用 <root>\<group>\workspace；每个调用用户使用 <group>\users\<phone>\tmp 和 session.jsonl。"
while ($true) {
    $wdIn = Read-Host "群数据总根 [默认：$groupRootDefault]"
    $groupRootCandidate = if ($wdIn) { $wdIn.Trim() } else { $groupRootDefault }
    try {
        $GroupDataRoot = if ([System.IO.Path]::IsPathRooted($groupRootCandidate)) {
            [System.IO.Path]::GetFullPath($groupRootCandidate)
        } else {
            [System.IO.Path]::GetFullPath((Join-Path $Project $groupRootCandidate))
        }
    } catch {
        Warn "群数据总根路径无效：$groupRootCandidate"
        continue
    }
    $volumeRoot = [System.IO.Path]::GetPathRoot($GroupDataRoot).TrimEnd('\')
    if ($GroupDataRoot.TrimEnd('\') -eq $volumeRoot -or $GroupDataRoot.TrimEnd('\') -eq $Project.TrimEnd('\')) {
        Warn "群数据总根不能是文件系统根目录或项目根目录：$GroupDataRoot"
        continue
    }
    $projectChildPrefix = $Project.TrimEnd('\') + '\'
    if ($GroupDataRoot.StartsWith($projectChildPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        $GroupDataRoot.TrimEnd('\') -ne $DefaultGroupDataRoot.TrimEnd('\')) {
        Warn "项目内群数据目录固定为 data\groups；如需自定义，请选择项目外的路径：$GroupDataRoot"
        continue
    }
    if (Test-Path -LiteralPath $GroupDataRoot) {
        if (-not (Test-Path -LiteralPath $GroupDataRoot -PathType Container)) {
            Warn "群数据总根不是目录：$GroupDataRoot"
            continue
        }
    } else {
        try {
            New-Item -ItemType Directory -Force -Path $GroupDataRoot | Out-Null
        } catch {
            Warn "无法创建群数据总根：$GroupDataRoot（$($_.Exception.Message)）"
            continue
        }
    }
    $GroupDataRoot = (Resolve-Path -LiteralPath $GroupDataRoot).Path
    $writeProbe = Join-Path $GroupDataRoot (".mixin-chatbot-write-test-" + [Guid]::NewGuid().ToString("N"))
    try {
        [System.IO.File]::WriteAllText($writeProbe, "")
    } catch {
        Warn "群数据总根不可写：$GroupDataRoot（$($_.Exception.Message)）"
        continue
    } finally {
        Remove-Item -LiteralPath $writeProbe -Force -ErrorAction SilentlyContinue
    }
    break
}
Done "群数据总根：$GroupDataRoot"

# ---- 4c. 监听端口（显式环境变量 > 已保存值 > 1011）----
$portDefaultSource = ""
$rawPortDefault = if (-not [string]::IsNullOrWhiteSpace($env:BOT_PORT)) {
    $portDefaultSource = "BOT_PORT"
    $env:BOT_PORT.Trim()
} elseif (Test-Path -LiteralPath $PortFile) {
    $portDefaultSource = "data\state\bot-port"
    (Get-Content -LiteralPath $PortFile -Raw).Trim()
} else {
    "1011"
}
$defaultPortNumber = 0
if ([int]::TryParse($rawPortDefault, [ref]$defaultPortNumber) -and
    $defaultPortNumber -ge 1 -and $defaultPortNumber -le 65535) {
    $portDefault = "$defaultPortNumber"
} else {
    Warn "$portDefaultSource 中的端口无效，已改用安全默认值 1011：$rawPortDefault"
    $portDefault = "1011"
}
while ($true) {
    $portIn = Read-Host "机器人监听端口 [默认：$portDefault]"
    $Port = if ($portIn) { $portIn.Trim() } else { $portDefault }
    $portNumber = 0
    if ([int]::TryParse($Port, [ref]$portNumber) -and $portNumber -ge 1 -and $portNumber -le 65535) {
        $Port = "$portNumber"
        break
    }
    Warn "端口必须是 1–65535 的整数"
}
Done "监听端口：$Port"

# ---- 5. 部署模式 ----
$modeDefaultSource = ""
$rawModeDefault = if (-not [string]::IsNullOrWhiteSpace($env:DEPLOY_MODE)) {
    $modeDefaultSource = "DEPLOY_MODE"
    $env:DEPLOY_MODE.Trim().ToLowerInvariant()
} elseif (Test-Path -LiteralPath $ModeFile -PathType Leaf) {
    $modeDefaultSource = "data\state\deploy-mode"
    (Get-Content -LiteralPath $ModeFile -Raw).Trim().ToLowerInvariant()
} else {
    "direct"
}
if ($rawModeDefault -in @("direct", "cloudflare")) {
    $modeDefault = $rawModeDefault
} else {
    Warn "$modeDefaultSource 中的部署模式无效，已改用安全默认值 direct：$rawModeDefault"
    $modeDefault = "direct"
}
$modeDefaultChoice = if ($modeDefault -eq "cloudflare") { "2" } else { "1" }
$modeDefaultLabel = if ($modeDefault -eq "cloudflare") { "Cloudflare" } else { "直连" }
Step "选择部署模式："
Write-Host "  1) 直连模式       - 服务器有公网 IP；在 Windows 防火墙放行端口 $Port"
Write-Host "  2) Cloudflare 模式 - 云电脑；部署后自动启动 cloudflared 隧道"
while ($true) {
    $modeIn = Read-Host "输入 1 或 2 [默认：$modeDefaultChoice / $modeDefaultLabel]"
    $modeChoice = if ([string]::IsNullOrWhiteSpace($modeIn)) { $modeDefaultChoice } else { $modeIn.Trim() }
    if ($modeChoice -eq "1") {
        $mode = "direct"
        break
    }
    if ($modeChoice -eq "2") {
        $mode = "cloudflare"
        break
    }
    Warn "请输入 1 或 2"
}
$modeLabel = if ($mode -eq "cloudflare") { "Cloudflare" } else { "直连" }
$BotHost = if ($mode -eq "cloudflare") { "127.0.0.1" } else { "0.0.0.0" }
Done "部署模式：$modeLabel"
if ($invalidConfiguredDomain) {
    Warn "$domainSource 中的域名无效，已忽略：$invalidConfiguredDomain"
}
if ($mode -eq "cloudflare") {
    Warn "请在 Cloudflare Tunnel 控制台将 Published application 的服务地址设为 http://localhost:$Port"
    $domainDefault = $publicDomain
    while ($true) {
        $domainPrompt = if ($domainDefault) {
            "Cloudflare 公网域名 [默认：$domainDefault；支持完整根 URL]"
        } else {
            "Cloudflare 公网域名（可留空；支持 im-bot.example.com 或 https://im-bot.example.com）"
        }
        $domainIn = Read-Host $domainPrompt
        if ([string]::IsNullOrWhiteSpace($domainIn)) {
            $publicDomain = $domainDefault
            break
        }
        $normalizedDomain = ConvertTo-Hostname $domainIn
        if ($normalizedDomain) {
            $publicDomain = $normalizedDomain
            $persistDomain = $true
            if ($publicDomain -cne $domainIn.Trim()) {
                Done "已规范化公网域名：$publicDomain"
            }
            break
        }
        Warn "域名格式无效；请输入纯 hostname，或只含 hostname 的 http(s) URL（不能带端口、路径、查询参数）"
    }
}

# 让直连模式防火墙规则始终跟随所选端口。Cloudflare 模式只监听 loopback，
# 并删除本脚本遗留的直连规则。
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$currentIdentity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$currentUser = $currentIdentity.Name
$platformIp = if ($env:PLATFORM_IP) { $env:PLATFORM_IP } else { "223.244.14.237" }
$allowUnmanagedFirewall = $env:ALLOW_UNMANAGED_FIREWALL -eq "1"
$cleanupFirewallAfterHealth = $false
$currentFirewallRuleName = $null
if ($mode -eq "direct") {
    $parsedIp = $null
    if (-not [System.Net.IPAddress]::TryParse($platformIp, [ref]$parsedIp)) {
        Write-Host "PLATFORM_IP 无效：$platformIp" -ForegroundColor Red
        exit 1
    }
}
if ($isAdmin) {
    if ($mode -eq "direct") {
        try {
            $firewallProfiles = @(Get-NetFirewallProfile -ErrorAction Stop)
            if ($firewallProfiles.Count -eq 0) { throw "未找到 Windows 防火墙配置文件" }
            $disabledProfiles = @($firewallProfiles | Where-Object { -not $_.Enabled })
            if ($disabledProfiles.Count -gt 0) {
                throw "Windows 防火墙配置文件未全部启用：$($disabledProfiles.Name -join ', ')"
            }
            # 先写入新规则，再删除旧规则；这样更新失败时不会让当前 webhook 入口中断。
            $currentFirewallRule = New-NetFirewallRule -DisplayName "mixin-chatbot TCP $Port" -Group "mixin-chatbot" `
                -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
                -RemoteAddress $platformIp -ErrorAction Stop
            $currentFirewallRuleName = $currentFirewallRule.Name
            $cleanupFirewallAfterHealth = $true
            Done "Windows 防火墙已写入限定回调来源的 TCP $Port 规则"
        } catch {
            if (-not $allowUnmanagedFirewall) {
                Write-Host "Windows 防火墙安全基线无法生效，直连模式拒绝在 0.0.0.0 上启动：$($_.Exception.Message)" -ForegroundColor Red
                Write-Host "修复 Windows 防火墙，或确认已有等效云防火墙后显式设置 ALLOW_UNMANAGED_FIREWALL=1。" -ForegroundColor Red
                exit 1
            }
            Warn "ALLOW_UNMANAGED_FIREWALL=1：未使用 Windows 防火墙基线，依赖你已配置的外部防火墙。原因：$($_.Exception.Message)"
        }
    } else {
        # 旧直连入口保留到新机器人和隧道健康，部署中途失败时仍可恢复旧服务。
        $cleanupFirewallAfterHealth = $true
    }
} elseif ($mode -eq "direct") {
    if (-not $allowUnmanagedFirewall) {
        Write-Host "当前不是管理员，无法设置 Windows 防火墙；直连模式拒绝在 0.0.0.0 上启动。" -ForegroundColor Red
        Write-Host "请用管理员 PowerShell 重跑，或确认已有等效云防火墙后显式设置 ALLOW_UNMANAGED_FIREWALL=1。" -ForegroundColor Red
        exit 1
    }
    Warn "ALLOW_UNMANAGED_FIREWALL=1：当前不是管理员，依赖你已配置的外部防火墙。"
}

# 在停止现有机器人前确认未托管 Cloudflared 服务的归属，取消部署时不产生停机。
$unmanagedTunnelConfirmed = $false
$preflightTunnelService = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
$preflightTunnelManaged = Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf
if ($preflightTunnelService -and $preflightTunnelManaged -and $mode -eq "direct" -and -not $isAdmin) {
    Write-Host "直连模式需要停止并禁用本项目 Cloudflared 服务；请使用管理员 PowerShell 重跑。" -ForegroundColor Red
    exit 1
}
if ($preflightTunnelService -and -not $preflightTunnelManaged) {
    Warn "系统存在没有本项目归属标记的 Cloudflared 服务，部署脚本不会自动修改它。"
    $tunnelQuestion = if ($mode -eq "cloudflare") {
        "确认该服务正在服务本项目，继续沿用？[y/N]"
    } else {
        "确认该服务与本项目无关或其入口仍受保护，继续直连部署？[y/N]"
    }
    if (-not (Read-YesNo $tunnelQuestion $false)) {
        Write-Host "未确认未托管 Cloudflared 的安全边界；尚未停止现有机器人。" -ForegroundColor Red
        exit 1
    }
    $unmanagedTunnelConfirmed = $true
}

# ---- 6. 停止旧机器人（避免重新部署时端口冲突）----
if ($isAdmin) {
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask -and $existingTask.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    }
}
$escapedEntry = [WildcardPattern]::Escape($Entry)
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$escapedEntry*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ---- 7. launcher（把部署设置写入命令；计划任务不会重新读取当前 shell）+ 启动 ----

# 为写入生成的 launcher，对路径执行单引号转义
function Sq($s) { return "'" + ($s -replace "'", "''") + "'" }
function Save-DeploymentState {
    Set-Content -LiteralPath $PortFile -Value $Port -NoNewline -Encoding ASCII
    Set-Content -LiteralPath $ModeFile -Value $mode -NoNewline -Encoding ASCII
    Set-Content -LiteralPath $GroupRootFile -Value $GroupDataRoot -NoNewline -Encoding UTF8
    if ($persistDomain) {
        Set-Content -LiteralPath $DomainFile -Value $publicDomain -NoNewline -Encoding ASCII
    } elseif ($clearPersistedDomain) {
        Remove-Item -LiteralPath $DomainFile -Force -ErrorAction SilentlyContinue
    }
}
$launcherBody = @"
`$ErrorActionPreference = 'Stop'
`$env:GROUP_DATA_ROOT = $(Sq $GroupDataRoot)
`$env:BOT_PORT = $(Sq $Port)
`$env:BOT_HOST = $(Sq $BotHost)
`$env:BOT_DEBUG = $(Sq $BotDebug)
`$env:BOT_MAX_ACTIVE_REQUESTS = $(Sq $BotMaxActiveRequests)
`$env:PATH = $(Sq ($BashDir + ";")) + `$env:PATH
Set-Location $(Sq $Project)
`$ErrorActionPreference = 'Continue'
& $(Sq $bunPath) run $(Sq $Entry)
`$botExitCode = `$LASTEXITCODE
exit `$botExitCode
"@
$utf8WithBom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($LauncherFile, $launcherBody, $utf8WithBom)

$publicDomainDisplay = if ($publicDomain) { $publicDomain } else { "<你的域名>" }
$url = if ($mode -eq "cloudflare") {
    "https://$publicDomainDisplay/webhook/<SECRET>"
} else {
    "http://<服务器IP>:$Port/webhook/<SECRET>"
}
Write-Host ""
Write-Host "==== 回调 URL（填入 IM 平台）====" -ForegroundColor Cyan
if ($showSecret) {
    Write-Host ("  " + ($url -replace "<SECRET>", $secret)) -ForegroundColor White
    Warn "密钥仅显示一次；如需轮换，删除 data\config\webhook-secret 后重新运行部署。"
} else {
    Write-Host "  $url" -ForegroundColor White
    Warn "密钥未变化；查看命令：Get-Content data\config\webhook-secret"
}

if ($isAdmin) {
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
    Step "等待机器人健康检查通过..."
    $healthy = Wait-BotHealth $Port
    if (-not $healthy) {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        $lastResult = if ($taskInfo) { "$(Get-ResultCodeHex $taskInfo.LastTaskResult) / $($taskInfo.LastTaskResult)" } else { "未知" }
        Write-Host "机器人在 90 秒内未通过健康检查（任务结果：$lastResult）。请查看 logs\mixin-chatbot.log，并运行 scripts\ops\ops.ps1 doctor。" -ForegroundColor Red
        exit 1
    }
    if ($mode -eq "direct") {
        $existingTunnelService = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        if ($existingTunnelService) {
            if (Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf) {
                Step "直连模式：停止并禁用本项目管理的 Cloudflared 服务..."
                try {
                    if ($existingTunnelService.Status -ne "Stopped") {
                        Stop-Service -Name "Cloudflared" -Force -ErrorAction Stop
                    }
                    Set-Service -Name "Cloudflared" -StartupType Disabled -ErrorAction Stop
                    Done "本项目 Cloudflared 已停止并禁用，重启后也不会恢复旧隧道入口"
                } catch {
                    Write-Host "无法停止或禁用本项目 Cloudflared 服务：$($_.Exception.Message)" -ForegroundColor Red
                    exit 1
                }
            } else {
                if (-not $unmanagedTunnelConfirmed) {
                    Warn "部署期间出现未标记为本项目所有的 Cloudflared 服务；不会自动修改。"
                }
                if (-not $unmanagedTunnelConfirmed -and -not (Read-YesNo "确认该服务与本项目无关或其入口仍受保护，继续直连部署？[y/N]" $false)) {
                    Write-Host "未确认遗留隧道的安全边界；直连模式部署已停止。" -ForegroundColor Red
                    exit 1
                }
            }
        }
    }
    Done "机器人健康（群数据总根=$GroupDataRoot）。管理：Get-ScheduledTask $TaskName | Stop-ScheduledTask；日志：logs\mixin-chatbot.log"
    Warn "任务启动方式：$taskStartDescription。"
} else {
    Warn "当前不是管理员，将以前台方式运行（Ctrl+C 停止）；请以管理员身份重跑以安装计划任务。"
    if ($mode -eq "cloudflare") {
        Warn "请在另一个 PowerShell 窗口运行 scripts\tunnel\start-tunnel.ps1；当前窗口将被前台机器人占用。"
    }
    Save-DeploymentState
    $env:GROUP_DATA_ROOT = $GroupDataRoot
    $env:BOT_PORT = $Port
    $env:BOT_HOST = $BotHost
    $env:BOT_DEBUG = $BotDebug
    $env:BOT_MAX_ACTIVE_REQUESTS = $BotMaxActiveRequests
    # 非管理员前台模式也必须继承已探测到的 Git Bash，避免 bash 不在系统 PATH 时工具启动失败。
    $env:PATH = $BashDir + ";" + $env:PATH
    Set-Location $Project
    $previousErrorActionPreference = $ErrorActionPreference
    $foregroundExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        & $bunPath run $Entry
        $foregroundExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    exit $foregroundExitCode
}

# ---- 7b. Cloudflare 模式：确保隧道在线（已有服务则启动，否则调用安装脚本）----
if ($mode -eq "cloudflare") {
    Step "Cloudflare 模式：确保 cloudflared 隧道在线..."
    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        $managedTunnelService = Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf
        if (-not $managedTunnelService) {
            if (-not $unmanagedTunnelConfirmed) {
                Warn "部署期间出现没有本项目归属标记的 Cloudflared 服务，无法自动确认它连接的是当前隧道。"
            }
            if (-not $unmanagedTunnelConfirmed -and -not (Read-YesNo "确认该服务正在服务本项目，继续沿用？[y/N]" $false)) {
                Write-Host "未确认未托管的 Cloudflared 服务归属；Cloudflare 模式部署已停止。" -ForegroundColor Red
                exit 1
            }
        } else {
            Set-Service -Name "Cloudflared" -StartupType Automatic -ErrorAction Stop
        }
        if ($svc.Status -ne "Running") {
            try { Start-Service "Cloudflared"; Done "Cloudflared 服务已启动（原状态：$(Get-ServiceStateLabel $svc.Status)）。" }
            catch { Warn "启动 Cloudflared 服务失败：$($_.Exception.Message)。请运行 scripts\ops\ops.ps1 doctor -Repair，并查看事件查看器（eventvwr）。" }
        } else {
            Done "Cloudflared 服务已经在运行。"
        }
        if (Test-Path -LiteralPath $TunnelTokenFile -PathType Leaf) {
            Warn "检测到 data\config\tunnel-token；现有服务可能仍使用旧 token。token 更新后请执行 scripts\ops\ops.ps1 repair-tunnel。"
        }
    } else {
        Warn "未安装 Cloudflared 服务，将通过 scripts\tunnel\start-tunnel.ps1 安装..."
        $stPath = Join-Path $Project "scripts\tunnel\start-tunnel.ps1"
        $env:BOT_PORT = $Port
        while ($true) {
            $tokIn = Read-Host "隧道 token 文件 [直接回车按 TUNNEL_TOKEN_FILE / TUNNEL_TOKEN / data\config\tunnel-token 的顺序查找]"
            $previousErrorActionPreference = $ErrorActionPreference
            $tunnelExitCode = 1
            try {
                # Windows PowerShell 5.1 会把原生命令的 stderr 包装为 ErrorRecord；
                # 此处让子脚本直接输出，再按真实退出码判断，避免错误提示中断退出码采集。
                $ErrorActionPreference = "Continue"
                if ([string]::IsNullOrWhiteSpace($tokIn)) {
                    & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $stPath
                } else {
                    & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $stPath $tokIn.Trim()
                }
                $tunnelExitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            $installedTunnelService = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
            if ($tunnelExitCode -eq 0 -and $installedTunnelService -and $installedTunnelService.Status -eq "Running") {
                break
            }
            Warn "Cloudflared 未安装成功或尚未运行，请检查上方提示后重新输入 token 来源。按 Ctrl+C 可取消部署。"
        }
    }
    if ($isAdmin) {
        $finalTunnelService = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        if (-not $finalTunnelService -or $finalTunnelService.Status -ne "Running") {
            Write-Host "Cloudflare 模式部署未完成：Cloudflared 服务没有运行。请执行 scripts\ops\ops.ps1 doctor -Repair。" -ForegroundColor Red
            exit 1
        }
        Done "Cloudflared 隧道服务正在运行。"
    }
}

if ($isAdmin) {
    if ($cleanupFirewallAfterHealth) {
        if ($mode -eq "direct") {
            Get-NetFirewallRule -Group "mixin-chatbot" -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ne $currentFirewallRuleName } |
                Remove-NetFirewallRule -ErrorAction Stop
            Done "Windows 防火墙已只保留当前机器人入口"
        } else {
            Get-NetFirewallRule -Group "mixin-chatbot" -ErrorAction SilentlyContinue |
                Remove-NetFirewallRule -ErrorAction Stop
            Done "Cloudflare 模式已清理本项目旧直连防火墙规则"
        }
    }
    # 机器人健康且隧道/直连切换成功后再提交，避免 doctor 读取半完成配置。
    Save-DeploymentState
    Done "部署状态已写入 data\state。"
}
