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
$WindowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) { $WindowsPowerShell = "powershell.exe" }

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
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

# ---- 3. AI 配置（models.json）----
New-Item -ItemType Directory -Force -Path "data", "data\runtime", "logs" | Out-Null
if (-not (Test-Path "data/models.json")) {
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
    if (-not (Test-Path "data/models.json")) { Write-Host "未生成 models.json，部署中止。" -ForegroundColor Red; exit 1 }
} else {
    Done "data/models.json 已存在"
    $ans = Read-Host "是否重新配置 AI（provider/key/model）？[y/N]"
    if ($ans -match "^[yY]$") {
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
if (-not (Test-Path "data/webhook-secret")) {
    Step "生成 webhook 随机密钥..."
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    Set-Content -Path "data\webhook-secret" -Value $secret -NoNewline -Encoding ASCII
    $showSecret = $true
    Done "webhook 密钥已生成"
} else {
    $secret = (Get-Content "data\webhook-secret" -Raw).Trim()
    if ($secret -notmatch "^[0-9a-fA-F]{32,64}$") {
        Write-Host "data\webhook-secret 格式无效（应为 32–64 位十六进制字符）。" -ForegroundColor Red
        Write-Host "删除该文件后重新运行 scripts\deploy\deploy.ps1 可生成新密钥。" -ForegroundColor Red
        exit 1
    }
    Done "沿用已有 webhook-secret"
}

$domainFile = Join-Path $Project "data\bot-domain"
$persistDomain = $false
if (-not [string]::IsNullOrWhiteSpace($env:BOT_DOMAIN)) {
    $publicDomain = $env:BOT_DOMAIN.Trim()
    $persistDomain = $true
} elseif (Test-Path -LiteralPath $domainFile) {
    $publicDomain = (Get-Content -LiteralPath $domainFile -Raw).Trim()
} else {
    $publicDomain = ""
}
if ($publicDomain -and -not (Test-Hostname $publicDomain)) {
    Write-Host "BOT_DOMAIN/data\bot-domain 必须是纯 hostname（不能包含协议、端口或路径）：$publicDomain" -ForegroundColor Red
    exit 1
}

# ---- 4b. Pi 群数据总根（<group>/workspace + <group>/<phone>/{tmp,sessions}）----
Step "配置 Pi 群数据总根"
$agentRootDefault = if ([string]::IsNullOrWhiteSpace($env:AGENT_DATA_ROOT)) { "data" } else { $env:AGENT_DATA_ROOT.Trim() }
Write-Host "  默认 data = 仓库内的 .\data；AGENT_DATA_ROOT 可覆盖此默认值。"
Write-Host "  如需调整，可输入相对仓库路径或绝对路径。"
Write-Host "  每个群使用 <folder>\<group>\workspace；每个调用用户使用 <group>\<phone>\tmp 和 sessions。"
$wdIn = Read-Host "群数据总根 [默认：$agentRootDefault]"
$AgentDataRoot = if ($wdIn) { $wdIn.Trim() } else { $agentRootDefault }
if (Test-Path -LiteralPath $AgentDataRoot) {
    if (-not (Test-Path -LiteralPath $AgentDataRoot -PathType Container)) {
        Write-Host "群数据总根不是目录：$AgentDataRoot" -ForegroundColor Red
        exit 1
    }
} else {
    New-Item -ItemType Directory -Force -Path $AgentDataRoot | Out-Null
}
$AgentDataRoot = (Resolve-Path -LiteralPath $AgentDataRoot).Path
$volumeRoot = [System.IO.Path]::GetPathRoot($AgentDataRoot).TrimEnd('\')
if ($AgentDataRoot.TrimEnd('\') -eq $volumeRoot -or $AgentDataRoot.TrimEnd('\') -eq $Project.TrimEnd('\')) {
    Write-Host "群数据总根不能是文件系统根目录或项目根目录：$AgentDataRoot" -ForegroundColor Red
    exit 1
}
Done "群数据总根：$AgentDataRoot"

# ---- 4c. 监听端口（显式环境变量 > 已保存值 > 1011）----
$portFile = Join-Path $Project "data\bot-port"
$portDefault = if ($env:BOT_PORT) {
    $env:BOT_PORT
} elseif (Test-Path $portFile) {
    (Get-Content $portFile -Raw).Trim()
} else {
    "1011"
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
Step "选择部署模式："
Write-Host "  1) 直连模式       - 服务器有公网 IP；在 Windows 防火墙放行端口 $Port"
Write-Host "  2) Cloudflare 模式 - 云电脑；部署后自动启动 cloudflared 隧道"
$modeIn = Read-Host "输入 1 或 2 [默认：1]"
$mode = if ($modeIn -eq "2") { "cloudflare" } else { "direct" }
$modeLabel = if ($mode -eq "cloudflare") { "Cloudflare" } else { "直连" }
$BotHost = if ($mode -eq "cloudflare") { "127.0.0.1" } else { "0.0.0.0" }
Done "部署模式：$modeLabel"
if ($mode -eq "cloudflare") {
    Warn "请在 Cloudflare Tunnel 控制台将 Published application 的服务地址设为 http://localhost:$Port"
    if ([string]::IsNullOrWhiteSpace($publicDomain)) {
        $domainIn = Read-Host "Cloudflare 公网域名（可留空；留空会跳过公网健康检查）"
        if ($domainIn) {
            $publicDomain = $domainIn.Trim()
            if (-not (Test-Hostname $publicDomain)) {
                Write-Host "域名必须是纯 hostname（不能包含协议、端口或路径）：$publicDomain" -ForegroundColor Red
                exit 1
            }
            $persistDomain = $true
        }
    }
}

# 让直连模式防火墙规则始终跟随所选端口。Cloudflare 模式只监听 loopback，
# 并删除本脚本遗留的直连规则。
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$currentIdentity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$currentUser = $currentIdentity.Name
$platformIp = if ($env:PLATFORM_IP) { $env:PLATFORM_IP } else { "223.244.14.237" }
if ($mode -eq "direct") {
    $parsedIp = $null
    if (-not [System.Net.IPAddress]::TryParse($platformIp, [ref]$parsedIp)) {
        Write-Host "PLATFORM_IP 无效：$platformIp" -ForegroundColor Red
        exit 1
    }
}
if ($isAdmin) {
    if ($mode -eq "direct") {
        # 先写入新规则，再删除旧规则；这样更新失败时不会让当前 webhook 入口中断。
        $currentFirewallRule = New-NetFirewallRule -DisplayName "mixin-chatbot TCP $Port" -Group "mixin-chatbot" `
            -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
            -RemoteAddress $platformIp
        Get-NetFirewallRule -Group "mixin-chatbot" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne $currentFirewallRule.Name } |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
        Done "Windows 防火墙已设置为仅允许 $platformIp 访问 TCP $Port"
    } else {
        Get-NetFirewallRule -Group "mixin-chatbot" -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
} elseif ($mode -eq "direct") {
    Warn "当前不是管理员，未修改 Windows 防火墙；直连模式前请只允许平台 IP 访问 TCP $Port"
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
$launcher = Join-Path $Project "data\runtime\bot-launcher.ps1"
$launcherBody = @"
`$ErrorActionPreference = 'Stop'
`$env:AGENT_DATA_ROOT = $(Sq $AgentDataRoot)
`$env:BOT_PORT = $(Sq $Port)
`$env:BOT_HOST = $(Sq $BotHost)
`$env:PATH = $(Sq ($BashDir + ";")) + `$env:PATH
Set-Location $(Sq $Project)
`$ErrorActionPreference = 'Continue'
& $(Sq $bunPath) run $(Sq $Entry)
`$botExitCode = `$LASTEXITCODE
exit `$botExitCode
"@
$utf8WithBom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($launcher, $launcherBody, $utf8WithBom)

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
    Warn "密钥仅显示一次；如需轮换，删除 data\webhook-secret 后重新运行部署。"
} else {
    Write-Host "  $url" -ForegroundColor White
    Warn "密钥未变化；查看命令：Get-Content data\webhook-secret"
}

if ($isAdmin) {
    Step "安装 Windows 计划任务 '$TaskName'（优先开机启动，失败自动重试）..."
    $fileArg = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
    $action    = New-ScheduledTaskAction -Execute $WindowsPowerShell -Argument $fileArg -WorkingDirectory $Project
    $settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    # RunLevel Limited：bot 只需监听所选端口并写入 data/logs，无需管理员；
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
    Set-Content -LiteralPath $portFile -Value $Port -NoNewline -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $Project "data\deploy-mode") -Value $mode -NoNewline -Encoding ASCII
    if ($persistDomain) {
        Set-Content -LiteralPath $domainFile -Value $publicDomain -NoNewline -Encoding ASCII
    }
    Done "机器人健康（群数据总根=$AgentDataRoot）。管理：Get-ScheduledTask $TaskName | Stop-ScheduledTask；日志：logs\mixin-chatbot.log"
    Warn "任务启动方式：$taskStartDescription。"
} else {
    Warn "当前不是管理员，将以前台方式运行（Ctrl+C 停止）；请以管理员身份重跑以安装计划任务。"
    if ($mode -eq "cloudflare") {
        Warn "请在另一个 PowerShell 窗口运行 scripts\tunnel\start-tunnel.ps1；当前窗口将被前台机器人占用。"
    }
    Set-Content -LiteralPath $portFile -Value $Port -NoNewline -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $Project "data\deploy-mode") -Value $mode -NoNewline -Encoding ASCII
    if ($persistDomain) {
        Set-Content -LiteralPath $domainFile -Value $publicDomain -NoNewline -Encoding ASCII
    }
    $env:AGENT_DATA_ROOT = $AgentDataRoot
    $env:BOT_PORT = $Port
    $env:BOT_HOST = $BotHost
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
        if ($svc.Status -ne "Running") {
            try { Start-Service "Cloudflared"; Done "Cloudflared 服务已启动（原状态：$(Get-ServiceStateLabel $svc.Status)）。" }
            catch { Warn "启动 Cloudflared 服务失败：$($_.Exception.Message)。请运行 scripts\ops\ops.ps1 doctor -Repair，并查看事件查看器（eventvwr）。" }
        } else {
            Done "Cloudflared 服务已经在运行。"
        }
        if (Test-Path -LiteralPath (Join-Path $Project "data\tunnel-token") -PathType Leaf) {
            Warn "检测到 data\tunnel-token；现有服务可能仍使用旧 token。token 更新后请执行 scripts\ops\ops.ps1 repair-tunnel。"
        }
    } else {
        Warn "未安装 Cloudflared 服务，将通过 scripts\tunnel\start-tunnel.ps1 安装..."
        $tokIn = Read-Host "隧道 token 文件 [默认：data\tunnel-token]"
        $tokArg = if ($tokIn) { $tokIn.Trim() } else { "data\tunnel-token" }
        $stPath = Join-Path $Project "scripts\tunnel\start-tunnel.ps1"
        $previousErrorActionPreference = $ErrorActionPreference
        $tunnelExitCode = 1
        try {
            # Windows PowerShell 5.1 会把原生命令的 stderr 包装为 ErrorRecord；
            # 此处让子脚本直接输出，再按真实退出码判断，避免错误提示中断退出码采集。
            $ErrorActionPreference = "Continue"
            & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $stPath $tokArg
            $tunnelExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($tunnelExitCode -ne 0) { Warn "start-tunnel.ps1 返回退出码 $tunnelExitCode，隧道可能未上线；请运行 scripts\ops\ops.ps1 doctor 查看修复建议。" }
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
