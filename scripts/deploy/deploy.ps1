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
$DefaultGroupDataRoot = Join-Path $DataDir "groups"
$ModelsFile = Join-Path $ConfigDir "models.json"
$WebhookSecretFile = Join-Path $ConfigDir "webhook-secret"
$PortFile = Join-Path $StateDir "bot-port"
$ModeFile = Join-Path $StateDir "deploy-mode"
$DomainFile = Join-Path $StateDir "bot-domain"
$GroupRootFile = Join-Path $StateDir "group-data-root"
$TunnelManagedFile = Join-Path $StateDir "cloudflared-managed"
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

$savedRuntime = @{}
$runtimeFile = Join-Path $ConfigDir 'runtime.json'
if (Test-Path -LiteralPath $runtimeFile) { $savedRuntime = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json }
$BotDebug = if ($env:BOT_DEBUG) { $env:BOT_DEBUG.Trim() } elseif ($savedRuntime.BOT_DEBUG) { [string]$savedRuntime.BOT_DEBUG } else { '0' }
if ($BotDebug -notin @("0", "1")) {
    Fail "BOT_DEBUG 只能是 0 或 1。"
    exit 1
}
$BotMaxActiveRequests = if ($env:BOT_MAX_ACTIVE_REQUESTS) { $env:BOT_MAX_ACTIVE_REQUESTS.Trim() }
    elseif ($savedRuntime.BOT_MAX_ACTIVE_REQUESTS) { [string]$savedRuntime.BOT_MAX_ACTIVE_REQUESTS } else { '32' }
$parsedMaxActiveRequests = 0
if (-not [int]::TryParse($BotMaxActiveRequests, [ref]$parsedMaxActiveRequests) -or
    $parsedMaxActiveRequests -lt 1 -or $parsedMaxActiveRequests -gt 1000) {
    Fail "BOT_MAX_ACTIVE_REQUESTS 必须是 1–1000 的整数。"
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

# 从此处开始才允许修改持久配置、依赖、服务和网络入口。
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "部署需要管理员权限；请在管理员终端中使用 $(Get-OpsCommandHint 'deploy')。" }
if ([Version]($bunVersion -replace '-.*$', '') -lt [Version]'1.4.2') { throw '需要 Bun 1.4.2 或更高版本（Windows FFI 进程监督）。' }
$UvPath = @(Get-ApplicationPaths 'uv.exe' | Where-Object { Test-VersionedApplication $_ '^uv ' } | Select-Object -First 1)
if ($UvPath.Count -ne 1) { throw '缺少原生 uv.exe，请先安装 uv 并加入 PATH。' }
$UvDir = Split-Path $UvPath[0] -Parent
$env:PATH = $UvDir + ';' + $BashDir + ';' + $env:PATH
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
    break
}
Done "群数据总根：$GroupDataRoot"

$migrationPlan = Join-Path $Project ('tmp\migration-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
$migrationRunner = Join-Path $Project 'scripts\migrations\run.ts'
$migrationPlanned = $false
$migrationAttempted = $false
$migrationGroups = $GroupDataRoot
if ((Test-Path -LiteralPath $ModelsFile) -and (Test-Path -LiteralPath (Join-Path $RuntimeDir 'pi\settings.json'))) {
    & $bunPath run $migrationRunner preview --decisions-only --interactive --project $Project --groups $migrationGroups --plan $migrationPlan
    if ($LASTEXITCODE -ne 0) { throw '迁移预览未完成；旧服务尚未停止' }
    $migrationPlanned = $true
}
# ---- 停机前的交互选择：只读取和校验，全部答完才停止机器人服务 ----
$reconfigureAi = $false
if (Test-Path -LiteralPath $ModelsFile -PathType Leaf) {
    Done "data\config\models.json 已存在"
    $reconfigureAi = Read-YesNo "是否重新配置 AI（provider/key/model）？[y/N]" $false
    if ($reconfigureAi) { Write-Host "  配置向导需要新安装的依赖，将在停止机器人服务并安装依赖后打开。" }
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
    Write-Host "Cloudflare 公网域名准备："
    Write-Host "  1) 将根域名（如 example.com）添加到 Cloudflare，按指引在域名注册商修改 NS，等待状态变为 Active（已激活）。域名无需转移注册商，但 DNS 需托管到 Cloudflare。"
    Write-Host "  2) 下面填写机器人使用的子域名，例如 bot.example.com。"
    Write-Host "  3) 在同一 Cloudflare 账户的 Networking → Tunnels 中创建或选择 Cloudflared 隧道；Published application 路由填相同子域名，服务地址设为 http://127.0.0.1:$Port。"
    Write-Host "DNS 接入和公开路由需在控制台完成；此处填写域名不会自动创建它们。可留空稍后配置，公网回调需配置完成后才能使用。"
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

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$platformIp = if ($env:PLATFORM_IP) { $env:PLATFORM_IP } else { "223.244.14.237" }
$allowUnmanagedFirewall = $env:ALLOW_UNMANAGED_FIREWALL -eq "1"
$cleanupFirewallAfterHealth = $false
$currentFirewallRuleName = $null
if ($mode -eq "direct") {
    $parsedIp = $null
    if (-not [System.Net.IPAddress]::TryParse($platformIp, [ref]$parsedIp)) {
        Fail "PLATFORM_IP 无效：$platformIp"
        exit 1
    }
}

# 外部连接器不能仅凭服务名认领；此时尚未停止服务，取消不会改动部署。
$unmanagedTunnelConfirmed = $false
$preflightTunnelService = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
$preflightTunnelManaged = Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf
if ($preflightTunnelService -and -not $preflightTunnelManaged) {
    Warn "系统存在没有本项目归属标记的 Cloudflared 服务，部署脚本不会自动修改它。"
    $tunnelQuestion = if ($mode -eq "cloudflare") {
        "确认该服务正在服务本项目，继续沿用？[y/N]"
    } else {
        "确认该服务与本项目无关或其入口仍受保护，继续直连部署？[y/N]"
    }
    if (-not (Read-YesNo $tunnelQuestion $false)) {
        Fail "未确认未托管 Cloudflared 的归属，部署已取消；机器人服务和配置均未改动。"
        exit 1
    }
    $unmanagedTunnelConfirmed = $true
}
# 缺少隧道服务时先收集 token（输入隐藏），部署实例就绪后再安装，避免停机期间等待输入。
$tunnelInputPrepared = $false
$preparedTunnelInput = $null
if ($mode -eq "cloudflare" -and -not $preflightTunnelService) {
    Step "未安装 Cloudflared 服务；请先提供隧道 token，部署实例就绪后自动安装"
    Show-TunnelTokenHelp
    while ($true) {
        $preparedTunnelInput = Read-TunnelTokenInput
        try { $null = Resolve-TunnelToken $Project $preparedTunnelInput; break }
        catch { Warn $_.Exception.Message }
    }
    $tunnelInputPrepared = $true
}

Set-OperationStage 'deployment-snapshot'
$snapshot = New-DeploymentSnapshot $Project $TaskName
Write-OperationEvent 'info' ('snapshot=' + $snapshot.Path)
$deploymentCommitted = $false
$deploymentMutated = $false
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
if ($migrationPlanned) {
    $migrationAttempted = $true
    & $bunPath run $migrationRunner apply --project $Project --groups $migrationGroups --plan $migrationPlan
    if ($LASTEXITCODE -ne 0) { throw '数据迁移失败' }
}

# ---- 3. 持久化目录 + AI 配置 ----
New-Item -ItemType Directory -Force -Path $ConfigDir, $StateDir, $RuntimeDir, (Join-Path $Project "logs") | Out-Null
Protect-ProjectSecretPath $ConfigDir
Protect-ProjectSecretPath $StateDir
if (-not (Test-Path -LiteralPath $ModelsFile -PathType Leaf)) {
    Step "首次配置 AI（provider/key/model）..."
    $previousErrorActionPreference = $ErrorActionPreference
    $configureExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        # 向导全程是中文提示，不切 UTF-8 就没法读，见 Invoke-WithUtf8Output。
        Invoke-WithUtf8Output { & $bunPath run configure }
        $configureExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($configureExitCode -ne 0) { Fail "AI 配置失败（退出码 $configureExitCode）。"; exit 1 }
    if (-not (Test-Path -LiteralPath $ModelsFile -PathType Leaf)) { Fail "未生成 data\config\models.json，部署中止。"; exit 1 }
} elseif ($reconfigureAi) {
    # 是否重配已在停机前确认；向导依赖刚安装的依赖，只能在这里运行。
    Step "重新配置 AI（provider/key/model）..."
    $previousErrorActionPreference = $ErrorActionPreference
    $configureExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        Invoke-WithUtf8Output { & $bunPath run configure }
        $configureExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($configureExitCode -ne 0) { Fail "AI 配置失败（退出码 $configureExitCode）。"; exit 1 }
}

if (-not (Test-ModelConfiguration $Project)) { throw '模型配置无效，正在恢复原部署。' }

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
        Fail "data\config\webhook-secret 格式无效（应为 64 位十六进制字符）。"
        Write-Host "停机并将该文件移入 backup\rm 后，重新部署可生成新密钥。" -ForegroundColor Red
        exit 1
    }
    Done "沿用已有 webhook-secret"
}

# 让直连模式防火墙规则始终跟随所选端口。Cloudflare 模式只监听 loopback，
# 并删除本脚本遗留的直连规则。
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
            Fail "Windows 防火墙安全基线无法生效，直连模式拒绝在 0.0.0.0 上启动：$($_.Exception.Message)"
            Write-Host "修复 Windows 防火墙，或确认已有等效云防火墙后显式设置 ALLOW_UNMANAGED_FIREWALL=1。" -ForegroundColor Red
            exit 1
        }
        Warn "ALLOW_UNMANAGED_FIREWALL=1：未使用 Windows 防火墙基线，依赖你已配置的外部防火墙。原因：$($_.Exception.Message)"
    }
} else {
    # 旧直连入口保留到新机器人和隧道健康，部署中途失败时仍可恢复旧服务。
    $cleanupFirewallAfterHealth = $true
}


# 旧服务已在依赖和配置变更之前停止，所有后续失败统一进入 finally 回滚。
function Sq($s) { return "'" + ($s -replace "'", "''") + "'" }
function Save-DeploymentState {
    Set-Content -LiteralPath $PortFile -Value $Port -NoNewline -Encoding ASCII
    Set-Content -LiteralPath $ModeFile -Value $mode -NoNewline -Encoding ASCII
    Set-Content -LiteralPath $GroupRootFile -Value $GroupDataRoot -NoNewline -Encoding UTF8
    if ($persistDomain) {
        Set-Content -LiteralPath $DomainFile -Value $publicDomain -NoNewline -Encoding ASCII
    } elseif ($clearPersistedDomain) {
        Move-ToProjectArchive $DomainFile $Project
    }
}
$env:GROUP_DATA_ROOT = $GroupDataRoot
$env:BOT_PORT = $Port
$env:BOT_HOST = $BotHost
$env:BOT_DEBUG = $BotDebug
$env:BOT_MAX_ACTIVE_REQUESTS = $BotMaxActiveRequests
if (-not $migrationPlanned) {
    & $bunPath run $migrationRunner preview --interactive --project $Project --groups $GroupDataRoot --plan $migrationPlan
    if ($LASTEXITCODE -ne 0) { throw '迁移预览失败' }
    $migrationAttempted = $true
    & $bunPath run $migrationRunner apply --project $Project --groups $GroupDataRoot --plan $migrationPlan
    if ($LASTEXITCODE -ne 0) { throw '数据迁移失败' }
}
Set-Content -LiteralPath (Join-Path $StateDir 'verify-only') -Value 'verify' -Encoding ASCII
Invoke-WithUtf8Output { & $bunPath run scripts/config/runtime-settings.ts }
if ($LASTEXITCODE -ne 0) { throw '运行配置持久化失败' }
$launcherBody = @"
`$ErrorActionPreference = 'Stop'
`$env:PATH = $(Sq ($UvDir + ";" + $BashDir + ";")) + `$env:PATH
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
    Warn "密钥仅显示一次；轮换时停机并将 data\config\webhook-secret 移入 backup\rm，再重新部署。"
} else {
    Write-Host "  $url" -ForegroundColor White
    Write-Host "  密钥未变化；查看：Get-Content data\config\webhook-secret"
}

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
                Fail "无法停止或禁用本项目 Cloudflared 服务：$($_.Exception.Message)"
                exit 1
            }
        } elseif (-not $unmanagedTunnelConfirmed) {
            # 停机期间不再询问；停机前没有这项服务，说明它是部署期间出现的，回滚后重新部署时再确认。
            Fail "部署期间出现未标记为本项目所有的 Cloudflared 服务，无法确认遗留隧道的安全边界；部署将回滚。确认其归属后重新部署。"
            throw '部署期间出现未确认的 Cloudflared 服务'
        }
    }
}
# 登录时启动意味着无人值守重启后不会自动运行，需要提醒；正常的开机任务只做说明。
if ($taskUsesS4U) { Done "任务启动方式：$taskStartDescription。" } else { Warn "任务启动方式：$taskStartDescription。" }

# ---- 7b. Cloudflare 模式：确保隧道在线（已有服务则启动，否则调用安装脚本）----
if ($mode -eq "cloudflare") {
    Step "Cloudflare 模式：确保 cloudflared 隧道在线..."
    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        $managedTunnelService = Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf
        if (-not $managedTunnelService) {
            if (-not $unmanagedTunnelConfirmed) {
                Fail "部署期间出现没有本项目归属标记的 Cloudflared 服务，无法确认它连接的是当前隧道；部署将回滚。确认其归属后重新部署。"
                throw '部署期间出现未确认的 Cloudflared 服务'
            }
        } else {
            Set-Service -Name "Cloudflared" -StartupType Automatic -ErrorAction Stop
        }
        if ($svc.Status -ne "Running") {
            try { Start-Service "Cloudflared"; Done "Cloudflared 服务已启动（原状态：$(Get-ServiceStateLabel $svc.Status)）。" }
            catch { Warn "启动 Cloudflared 服务失败：$($_.Exception.Message)。请使用 $(Get-OpsCommandHint 'doctor -Repair')，并查看 Windows 事件查看器。" }
        } else {
            Done "Cloudflared 服务已经在运行。"
        }
        Done "继续沿用现有隧道连接；更新 data\config\cloudflared-token 后，请使用 $(Get-OpsCommandHint 'repair-tunnel') 使新 token 生效。"
    } else {
        Step "安装 Cloudflared 隧道服务（使用停机前提供的 token）..."
        $stPath = Join-Path $Project "scripts\tunnel\start-tunnel.ps1"
        $env:BOT_PORT = $Port
        # 停机前已校验 token 来源；服务在停机前后才消失时没有预先输入，由安装器读取默认来源。
        $tokIn = if ($tunnelInputPrepared) { $preparedTunnelInput } else { '' }
        $preparedTunnelInput = $null
        $previousTokenInput = $env:MIXIN_TUNNEL_TOKEN_INPUT
        $previousAllowVerification = $env:MIXIN_TUNNEL_ALLOW_VERIFICATION
        $previousErrorActionPreference = $ErrorActionPreference
        $tunnelExitCode = 1
        try {
            # Windows PowerShell 5.1 会把原生命令的 stderr 包装为 ErrorRecord；
            # 此处让子脚本直接输出，再按真实退出码判断，避免错误提示中断退出码采集。
            $ErrorActionPreference = "Continue"
            $env:MIXIN_TUNNEL_TOKEN_INPUT = $tokIn
            # 提交前运行的是验证实例；安装器需要明确放行它，否则会判定为本机没有机器人。
            $env:MIXIN_TUNNEL_ALLOW_VERIFICATION = '1'
            & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $stPath
            $tunnelExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
            $env:MIXIN_TUNNEL_TOKEN_INPUT = $previousTokenInput
            $env:MIXIN_TUNNEL_ALLOW_VERIFICATION = $previousAllowVerification
            $tokIn = $null
        }
        $installedTunnelService = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        if ($tunnelExitCode -ne 0 -or -not $installedTunnelService -or $installedTunnelService.Status -ne "Running") {
            # 停机期间不再重新询问 token；回滚恢复原服务后，重新部署会在停机前再次收集。
            Fail "Cloudflared 隧道未能安装或启动（见上方提示）；部署将回滚。确认 token 后重新部署。"
            throw 'Cloudflared 隧道安装失败'
        }
    }
    $finalTunnelService = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if (-not $finalTunnelService -or $finalTunnelService.Status -ne "Running") {
        Fail "Cloudflare 模式部署未完成：Cloudflared 服务没有运行。请使用 $(Get-OpsCommandHint 'doctor -Repair')。"
        exit 1
    }
}

if ($cleanupFirewallAfterHealth) {
    # 只在确实删除了旧规则时提示；没有遗留规则的常规重部署不输出。
    $staleFirewallRules = @(Get-NetFirewallRule -Group "mixin-chatbot" -ErrorAction SilentlyContinue |
        Where-Object { $mode -ne "direct" -or $_.Name -ne $currentFirewallRuleName })
    if ($staleFirewallRules.Count -gt 0) {
        $staleFirewallRules | Remove-NetFirewallRule -ErrorAction Stop
        if ($mode -eq "direct") { Done "已删除 $($staleFirewallRules.Count) 条本项目旧防火墙规则，Windows 防火墙只保留当前机器人入口" }
        else { Done "Cloudflare 模式已删除 $($staleFirewallRules.Count) 条本项目旧直连防火墙规则" }
    }
}
# 部署预检通过且隧道/直连切换成功后再提交，避免 doctor 读取半完成配置。
Step "提交部署..."
Save-DeploymentState
Done "部署状态已写入 data\state。"
if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '验证实例未停止' }
& $bunPath run $migrationRunner commit --project $Project --groups $GroupDataRoot
if ($LASTEXITCODE -ne 0) { throw '迁移提交失败' }
$deploymentCommitted = $true
Remove-Item -LiteralPath (Join-Path $StateDir 'verify-only') -Force
Step "启动机器人并等待健康检查..."
Enable-ScheduledTask -TaskName $TaskName | Out-Null
Start-ScheduledTask -TaskName $TaskName
if (-not (Wait-BotHealth $Port)) { throw '数据已提交，但业务实例未就绪；保留新版本，请检查日志后启动' }
Done "机器人已启动（群数据总根=$GroupDataRoot）。停止请用 $(Get-OpsCommandHint 'stop')；日志：$(Get-OpsCommandHint 'logs')"
Done "可选大文件外链：运行 bun run tui，进入「系统 → 设置 → 外链配置」按需启用。"

} catch { Write-OperationFailure $_; throw } finally {
    if (-not $deploymentCommitted -and $deploymentMutated) {
        Set-OperationStage 'rollback'
        try {
            if ($migrationAttempted) {
                if (-not (Stop-ProjectBot $Project $TaskName -KeepDisabled)) { throw '验证实例未停止，拒绝恢复数据' }
                $rollbackGroups = if ($migrationPlanned) { $migrationGroups } else { $GroupDataRoot }
                & $bunPath run $migrationRunner rollback --project $Project --groups $rollbackGroups --deployment (Split-Path $snapshot.Path -Leaf)
                if ($LASTEXITCODE -ne 0) { throw '数据已提交或恢复失败；保持停机，保留备份' }
            }
            Remove-Item -LiteralPath (Join-Path $StateDir 'verify-only') -Force -ErrorAction SilentlyContinue
            Restore-DeploymentSnapshot $snapshot
            Write-OperationEvent 'info' ('data and deployment restored; snapshot=' + $snapshot.Path)
            $serviceState = if ($snapshot.WasRunning) { '机器人服务已重新启动' } else { '机器人服务保持停止' }
            Write-Host ('部署已回滚：配置、依赖、计划任务和网络入口已恢复到部署前；' + $serviceState + '。') -ForegroundColor Yellow
        }
        catch { Write-OperationFailure $_; Write-Host ("自动回滚未完成，保留快照 " + $snapshot.Path + "：" + $_.Exception.Message) -ForegroundColor Red }
    } elseif ($deploymentCommitted) {
        try { Remove-CompletedBackup $snapshot.Path $Project }
        catch { Warn ('部署已完成，但备份清理未完成，请检查 backup/snapshots 和 backup/rm：' + $_.Exception.Message) }
    }
    $snapshot.Lock.Dispose()
    $env:BOT_DEPLOY_BACKUP_ID = $snapshot.PreviousBackupId
}
$operationExit = 0
} catch { Write-OperationFailure $_; throw }
finally { Stop-OperationLog $operation $operationExit }
