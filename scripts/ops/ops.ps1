# mixin-chatbot 运维工具（Windows Server）。
# 一站式运维：诊断/修复、服务安装与卸载、前台运行、日志和完整清理。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 <命令>
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 doctor -Repair
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 update
#   命令：doctor、update、repair-tunnel、uninstall-tunnel、restart、stop、start、foreground、logs、uninstall（无参数显示菜单）
#
# repair-tunnel/uninstall-tunnel/restart/stop/start/uninstall 可能需要管理员权限。
param(
    [Parameter(Position = 0)]
    [string]$Command = "",
    [switch]$Repair,
    [switch]$RestartTunnel
)

$ErrorActionPreference = "Stop"

$Project  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TaskName = "mixin-chatbot"
$DataDir = Join-Path $Project "data"
$ConfigDir = Join-Path $DataDir "config"
$StateDir = Join-Path $DataDir "state"
$RuntimeDir = Join-Path $DataDir "runtime"
$DefaultGroupDataRoot = Join-Path $DataDir "groups"
$portFile = Join-Path $StateDir "bot-port"
$Port     = if ($env:BOT_PORT) { $env:BOT_PORT } elseif (Test-Path $portFile) { (Get-Content $portFile -Raw).Trim() } else { "1011" }
$modeFile = Join-Path $StateDir "deploy-mode"
$DeployMode = if (Test-Path $modeFile) { (Get-Content $modeFile -Raw).Trim() } else { "direct" }
$domainFile = Join-Path $StateDir "bot-domain"
$Domain   = if ($env:BOT_DOMAIN) { $env:BOT_DOMAIN.Trim() } elseif (Test-Path $domainFile) { (Get-Content $domainFile -Raw).Trim() } else { "" }
$groupRootFile = Join-Path $StateDir "group-data-root"
$DeployedGroupDataRoot = if (Test-Path -LiteralPath $groupRootFile -PathType Leaf) {
    (Get-Content -LiteralPath $groupRootFile -Raw).Trim()
} else {
    $DefaultGroupDataRoot
}
$LogPath  = Join-Path $Project "logs\mixin-chatbot.log"
$TunnelScript = Join-Path $Project "scripts\tunnel\start-tunnel.ps1"
$ModelsFile = Join-Path $ConfigDir "models.json"
$WebhookSecretFile = Join-Path $ConfigDir "webhook-secret"
$RelayConfigFile = Join-Path $ConfigDir "relay.json"
$DefaultTunnelTokenFile = Join-Path $ConfigDir "tunnel-token"
$LocalCloudflared = Join-Path $Project "cloudflared.exe"
$TunnelManagedFile = Join-Path $StateDir "cloudflared-managed"
$WindowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) { $WindowsPowerShell = "powershell.exe" }

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[x] $m" -ForegroundColor Red }
function IsAdmin  { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
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
function Get-DeployModeLabel([string]$Mode) {
    if ($Mode -eq "cloudflare") { return "Cloudflare" }
    return "直连"
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
function Wait-ServiceGone([string]$Name, [int]$Attempts = 10) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return $true }
        if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds 500 }
    }
    return $false
}
function Remove-ManagedFirewallRules {
    if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) { return $true }
    $rules = @(Get-NetFirewallRule -Group "mixin-chatbot" -ErrorAction SilentlyContinue)
    if ($rules.Count -eq 0) { return $true }
    if (-not (IsAdmin)) {
        Warn "发现 $($rules.Count) 条 mixin-chatbot 防火墙规则，但清理需要管理员权限"
        return $false
    }
    try {
        $rules | Remove-NetFirewallRule -ErrorAction Stop
        Done "已清理 mixin-chatbot Windows 防火墙规则"
        return $true
    } catch {
        Warn "清理 Windows 防火墙规则失败：$($_.Exception.Message)"
        return $false
    }
}
$script:CurlPath = $null
$script:CurlPathResolved = $false
function Get-CurlPath {
    if (-not $script:CurlPathResolved) {
        $script:CurlPath = Find-VersionedApplication "curl.exe" '(?i)(^|\s)curl\s+'
        $script:CurlPathResolved = $true
    }
    return $script:CurlPath
}
function Get-CloudflaredPath {
    $additional = @($LocalCloudflared)
    if ($env:LOCALAPPDATA) { $additional += (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\cloudflared.exe") }
    if ($env:ProgramFiles) { $additional += (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe") }
    return Find-VersionedApplication "cloudflared" '(?i)cloudflared\s+version' $additional
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

function Invoke-BunInstall {
    $bunPath = Get-BunPath
    Step "安装依赖（bun install --frozen-lockfile）..."
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $bunPath install --frozen-lockfile
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($exitCode -ne 0) {
        Err "bun install 失败（退出码 $exitCode）"
        return $false
    }
    Done "依赖已就绪"
    return $true
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

function Resolve-ProjectPath([string]$Value) {
    if ([System.IO.Path]::IsPathRooted($Value)) {
        return [System.IO.Path]::GetFullPath($Value)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $Project $Value))
}

function Test-TunnelTokenValue([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    $clean = $Value -replace '[^A-Za-z0-9+/=_-]', ''
    return $clean.Length -ge 20
}

function Get-TunnelTokenFileInfo([string]$Path, [string]$Display) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{
            Available = $false
            Kind      = "file"
            Path      = $Path
            Display   = $Display
            Detail    = "缺少：$Display"
        }
    }

    try {
        $content = Get-Content -LiteralPath $Path -Raw
        $match = [regex]::Match($content, '(?m)^[ \t]*TUNNEL_TOKEN[ \t]*=(.+?)[ \t\r]*$')
        if ($match.Success) {
            $value = $match.Groups[1].Value.Trim().Trim('"').Trim("'")
        } elseif ($content -match '(?m)^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=') {
            $value = ""
        } else {
            $value = $content.Trim().Trim('"').Trim("'")
        }
        $valid = Test-TunnelTokenValue $value
    } catch {
        $valid = $false
    }

    return [pscustomobject]@{
        Available = $valid
        Kind      = "file"
        Path      = $Path
        Display   = $Display
        Detail    = $(if ($valid) { "$Display（值已隐藏）" } else { "为空或无效：$Display" })
    }
}

function Get-TunnelTokenSource {
    if (-not [string]::IsNullOrWhiteSpace($env:TUNNEL_TOKEN_FILE)) {
        $path = Resolve-ProjectPath $env:TUNNEL_TOKEN_FILE.Trim()
        return Get-TunnelTokenFileInfo $path "env:TUNNEL_TOKEN_FILE -> $path"
    }
    if (-not [string]::IsNullOrWhiteSpace($env:TUNNEL_TOKEN)) {
        $valid = Test-TunnelTokenValue $env:TUNNEL_TOKEN
        return [pscustomobject]@{
            Available = $valid
            Kind      = "env"
            Path      = $null
            Display   = "env:TUNNEL_TOKEN"
            Detail    = $(if ($valid) { "env:TUNNEL_TOKEN（值已隐藏）" } else { "env:TUNNEL_TOKEN 为空或无效" })
        }
    }
    return Get-TunnelTokenFileInfo $DefaultTunnelTokenFile "data\config\tunnel-token"
}

# 通用 HTTP 探测，返回状态码；连不上返回 $null。
#
# 用 HttpWebRequest 而不是 Invoke-WebRequest 或 curl，三个理由：
#   - Invoke-WebRequest 会套用系统代理设置，在云桌面上访问本机会一路挂到超时
#     （Test-Local 就栽在这上面）；这里 Proxy = $null 从根上绕开。
#   - curl 8.21 拒绝 -K/--config 从文件或 stdin 读配置（"unsupported trailing garbage"），
#     只剩把凭证写进命令行一条路；而 Windows 上任何用户都能用 WMI 读到别人进程的完整
#     命令行，WebDAV 密码不该出现在那里。走 .NET 则凭证既不进 argv 也不落盘。
#   - HttpWebRequest 在 Windows PowerShell 5.1 和 PowerShell 7 上都内置，无需额外依赖。
function Invoke-HttpProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [string]$Method = "HEAD",
        [int]$TimeoutSec = 8,
        [string]$Username,
        [string]$Password,
        [hashtable]$Headers
    )
    try {
        $request = [System.Net.HttpWebRequest]::Create($Url)
        $request.Method = $Method
        $request.Proxy = $null
        $request.Timeout = $TimeoutSec * 1000
        $request.ReadWriteTimeout = $TimeoutSec * 1000
        $request.AllowAutoRedirect = $false
        # 必须先判空：$null.Keys 会得到 $null，@($null) 是含一个 $null 元素的数组，
        # 于是 Headers.Add($null, ...) 抛异常，被下面的 catch 吞成「连不上」——
        # 不带自定义头的探测会因此永远误报失败。
        if ($Headers) {
            foreach ($name in @($Headers.Keys)) { $request.Headers.Add($name, $Headers[$name]) }
        }
        if ($Username) {
            $raw = "{0}:{1}" -f $Username, $Password
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($raw))
            $request.Headers.Add("Authorization", "Basic $encoded")
        }
        $response = $request.GetResponse()
        $status = [int]$response.StatusCode
        $response.Close()
        return $status
    } catch [System.Net.WebException] {
        # 4xx/5xx 也走这里，但带着 Response；没有 Response 才是真的没连上。
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return $null
    } catch {
        return $null
    }
}

# 大文件外链分发的体检。relay.json 不存在时该特性关闭，一行都不占——它是可选的，
# 没配置不是问题。配置了就要验到底：写错会让服务拒绝启动，后端不通会让大文件发送失败，
# 公开基址不通会让群成员拿到死链，三种都不该等到有人真发了个大文件才发现。
function Get-RelayDoctorRows {
    if (-not (Test-Path -LiteralPath $RelayConfigFile -PathType Leaf)) { return @() }

    $config = $null
    try {
        $config = Get-Content -LiteralPath $RelayConfigFile -Raw | ConvertFrom-Json
    } catch {
        return @(New-DoctorRow "data/config/relay.json" "fail" "不是有效 JSON（服务拒绝启动）" `
            "修正 JSON 语法，或删除该文件以关闭大文件外链分发。")
    }

    $webdavUrl = "$($config.webdavUrl)".Trim()
    $publicBaseUrl = "$($config.publicBaseUrl)".Trim()
    if (-not $webdavUrl -or -not $publicBaseUrl) {
        return @(New-DoctorRow "data/config/relay.json" "fail" "缺少 webdavUrl 或 publicBaseUrl（服务拒绝启动）" `
            "补齐这两个字段，或删除该文件以关闭大文件外链分发。")
    }

    $rows = @(New-DoctorRow "data/config/relay.json" "pass" "已启用 -> $publicBaseUrl")

    $davCode = Invoke-HttpProbe -Url $webdavUrl -Method "PROPFIND" -TimeoutSec 8 `
        -Username $config.username -Password $config.password `
        -Headers @{ "Depth" = "0" }

    if ($null -eq $davCode) {
        $rows += New-DoctorRow "外链 WebDAV 上传端点" "fail" "无法连接 $webdavUrl" `
            "确认后端服务正在运行且监听该地址；回环地址要求它与机器人在同一台机器。"
    } elseif ($davCode -in @(200, 204, 207)) {
        $rows += New-DoctorRow "外链 WebDAV 上传端点" "pass" "HTTP $davCode（可达且凭证有效）"
    } elseif ($davCode -in @(401, 403)) {
        $rows += New-DoctorRow "外链 WebDAV 上传端点" "fail" "HTTP $davCode（认证失败）" `
            "核对 relay.json 的 username/password，以及该账号对目标目录的写权限。"
    } elseif ($davCode -eq 404) {
        $rows += New-DoctorRow "外链 WebDAV 上传端点" "fail" "HTTP 404（目录不存在）" `
            "在后端创建 webdavUrl 指向的目录，或修正 relay.json 里的路径。"
    } else {
        $rows += New-DoctorRow "外链 WebDAV 上传端点" "warn" "HTTP $davCode（未预期的状态）" `
            "手动执行一次 PROPFIND 确认后端行为。"
    }

    # 公开基址只判断「服务是否在应答」。这类文件服务惯于用 HTTP 200 + JSON 业务码表达
    # 错误，对目录请求返回 200 属于正常行为，所以除了连不上，任何状态码都算通。
    $publicCode = Invoke-HttpProbe -Url $publicBaseUrl -Method "HEAD" -TimeoutSec 10
    if ($null -eq $publicCode) {
        $rows += New-DoctorRow "外链公开下载基址" "fail" "无法连接 $publicBaseUrl" `
            "检查该域名的 DNS、隧道与 WAF；群成员拿到的下载链接都指向这个基址。"
    } else {
        $rows += New-DoctorRow "外链公开下载基址" "pass" "HTTP $publicCode（服务有应答）"
    }

    return $rows
}

function New-DoctorRow([string]$Name, [string]$Status, [string]$Detail, [string]$Fix = "") {
    return [pscustomobject]@{
        Name   = $Name
        Status = $Status
        Detail = $Detail
        Fix    = $Fix
    }
}

$portNumber = 0
if (-not [int]::TryParse($Port, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
    throw "BOT_PORT/data/state/bot-port 中的端口无效：$Port"
}
$Port = "$portNumber"
if ($DeployMode -notin @("direct", "cloudflare")) {
    throw "data/state/deploy-mode 中的部署模式无效：$DeployMode"
}
if ($Domain) {
    $normalizedDomain = ConvertTo-Hostname $Domain
    if (-not $normalizedDomain) {
        throw "BOT_DOMAIN/data/state/bot-domain 中的域名无效：$Domain"
    }
    $Domain = $normalizedDomain
}

# 识别正在运行 src/server/index.ts 的 bun.exe 进程
function Get-BotPids {
    $escapedProject = [WildcardPattern]::Escape($Project)
    Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -like "*$escapedProject*" -and
            ($_.CommandLine -like "*server\index.ts*" -or $_.CommandLine -like "*server/index.ts*")
        } |
        Select-Object -ExpandProperty ProcessId
}

# 返回机器人是否真的停下来了。以前这里把所有失败都静默吞掉，于是「计划任务以
# Administrator 运行、当前窗口没有管理员权限」时停不掉进程也照样返回，Restart-Bot 会
# 当成已经重启继续往下走，最后只表现为一句莫名其妙的健康检查失败。
function Stop-Bot {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        try {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        } catch {
            Warn "停止计划任务失败：$($_.Exception.Message)"
        }
    }
    foreach ($p in Get-BotPids) {
        try {
            Stop-Process -Id $p -Force -ErrorAction Stop
        } catch {
            Warn "结束进程 $p 失败：$($_.Exception.Message)"
        }
    }
    # 进程和任务状态都要落地。Start-ScheduledTask 对仍处于 Running 的任务是静默空操作，
    # 只等进程消失就放行的话，随后的启动可能什么都没做，却一路显示成功。
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $taskBusy = $current -and $current.State -eq "Running"
        if (@(Get-BotPids).Count -eq 0 -and -not $taskBusy) { return $true }
        Start-Sleep -Milliseconds 500
    }

    $remaining = @(Get-BotPids)
    if ($remaining.Count -gt 0) {
        Err "机器人进程仍在运行（pid $($remaining -join ', ')）"
    } else {
        Err "计划任务 '$TaskName' 仍处于运行状态，无法重新启动它"
    }
    if (-not (IsAdmin)) {
        Warn "当前不是管理员；计划任务以其他账户运行时，需要管理员 PowerShell 才能停止它"
    }
    return $false
}

function Start-Bot {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Err "找不到计划任务 '$TaskName'；请先运行 scripts\deploy\deploy.ps1"; return $false }
    try {
        if ($t.State -eq "Disabled") { Enable-ScheduledTask -TaskName $TaskName | Out-Null }
        Start-ScheduledTask -TaskName $TaskName | Out-Null
        return $true
    } catch {
        Err "启动计划任务 '$TaskName' 失败：$($_.Exception.Message)"
        return $false
    }
}

function Test-Local {
    # 与 Test-Public 一致优先用 curl.exe。Invoke-WebRequest 走 .NET HttpClient，会套用系统
    # 代理设置，实测在云桌面上访问本机会一路挂到超时（TaskCanceledException），把健康的
    # 机器人误判成没响应；curl 同一地址立刻返回 200。
    # 地址固定 127.0.0.1 而不是 localhost：Cloudflare 模式下机器人只绑 IPv4 回环，
    # localhost 在 Windows 上可能先解析到 ::1。
    $curlPath = Get-CurlPath
    if ($curlPath) {
        $code = & $curlPath --noproxy "*" -s -o NUL -m 3 -w "%{http_code}" "http://127.0.0.1:$Port/favicon.svg" 2>$null
        $parsed = 0
        if ([int]::TryParse("$code".Trim(), [ref]$parsed) -and $parsed -gt 0) { return $parsed }
        return $null
    }
    try {
        return (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/favicon.svg" -UseBasicParsing -TimeoutSec 3).StatusCode
    } catch {
        $response = $_.Exception.Response
        if ($response -and $response.StatusCode) { return [int]$response.StatusCode }
        return $null
    }
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

function Test-Public {
    # 优先使用 curl.exe 保持 TLS 行为一致；旧系统回退到 Invoke-WebRequest。
    $curlPath = Get-CurlPath
    if ($curlPath) {
        $code = & $curlPath --ssl-no-revoke -m 10 -s -o NUL -w "%{http_code}" "https://$Domain/favicon.svg" 2>$null
        if ($LASTEXITCODE -eq 0) { return "$code".Trim() }
    }
    try {
        return "" + (Invoke-WebRequest -Uri "https://$Domain/favicon.svg" -UseBasicParsing -TimeoutSec 10).StatusCode
    } catch {
        $response = $_.Exception.Response
        if ($response -and $response.StatusCode) { return "" + [int]$response.StatusCode }
        return $null
    }
}

function Wait-Public {
    if (-not $Domain) { return $null }
    $lastStatus = $null
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        $lastStatus = Test-Public
        if ($lastStatus -eq "200") { return $lastStatus }
        if ($attempt -lt 8) { Start-Sleep -Seconds 2 }
    }
    return $lastStatus
}

function Invoke-TunnelRepair {
    if ($DeployMode -ne "cloudflare") {
        Err "repair-tunnel 只适用于 data\state\deploy-mode 为 cloudflare 的部署"
        return $false
    }
    if (-not (IsAdmin)) {
        Err "repair-tunnel 需要管理员 PowerShell"
        Warn "请在提升权限的 PowerShell 窗口中重新运行此命令"
        return $false
    }
    if (-not (Test-Path -LiteralPath $TunnelScript -PathType Leaf)) {
        Err "找不到隧道安装脚本：$TunnelScript"
        return $false
    }

    $tokenSource = Get-TunnelTokenSource
    if (-not $tokenSource.Available) {
        Err "没有可用的 Cloudflare 隧道 token 来源：$($tokenSource.Detail)"
        Warn "请将裸 token（或 TUNNEL_TOKEN=...）放入 data\config\tunnel-token 后重试"
        return $false
    }

    Step "使用 $($tokenSource.Display) 重新安装 Cloudflared 服务（token 已隐藏）..."
    $hadReinstallEnv = Test-Path Env:CLOUDFLARED_REINSTALL
    $previousReinstallEnv = $env:CLOUDFLARED_REINSTALL
    $previousErrorActionPreference = $ErrorActionPreference
    $tunnelExitCode = 1
    $invokeError = $null
    try {
        $env:CLOUDFLARED_REINSTALL = "1"
        # 子脚本直接继承当前控制台输出；临时放宽原生 stderr 处理，确保仍能读取真实退出码。
        $ErrorActionPreference = "Continue"
        try {
            if ($tokenSource.Kind -eq "file") {
                & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $TunnelScript $tokenSource.Path
            } else {
                & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $TunnelScript
            }
            $tunnelExitCode = $LASTEXITCODE
        } catch {
            $invokeError = $_.Exception.Message
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
        if ($hadReinstallEnv) {
            $env:CLOUDFLARED_REINSTALL = $previousReinstallEnv
        } else {
            Remove-Item Env:CLOUDFLARED_REINSTALL -ErrorAction SilentlyContinue
        }
    }

    if ($invokeError) {
        Err "执行 start-tunnel.ps1 失败：$invokeError"
        return $false
    }
    if ($tunnelExitCode -ne 0) {
        Err "start-tunnel.ps1 返回退出码 $tunnelExitCode"
        return $false
    }

    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if (-not $svc -or $svc.Status -ne "Running") {
        Err "重装后 Cloudflared 服务仍未运行"
        return $false
    }
    Done "Cloudflared 服务已重装并运行"

    if ($Domain) {
        Step "等待 https://$Domain/favicon.svg 恢复..."
        $publicStatus = Wait-Public
        if ($publicStatus -eq "200") {
            Done "公网隧道健康检查返回 HTTP 200"
            return $true
        }
        Warn "连接器正在运行，但公网健康检查为 $(if ($publicStatus) { "HTTP $publicStatus" } else { "无法连接" })"
        Warn "请检查 Cloudflare DNS/WAF，以及 Published application → http://localhost:$Port"
        return $false
    }

    Warn "缺少 data\state\bot-domain；连接器已修复，但无法验证公网健康状态"
    return $true
}

function Show-Doctor {
    Step "mixin-chatbot 健康检查（模式=$(Get-DeployModeLabel $DeployMode)，端口=$Port）"
    $rows = @()

    try {
        $resolvedGroupDataRoot = Resolve-ProjectPath $DeployedGroupDataRoot
        if (Test-Path -LiteralPath $resolvedGroupDataRoot -PathType Container) {
            $rows += New-DoctorRow "群数据总根" "pass" $resolvedGroupDataRoot
        } else {
            $rows += New-DoctorRow "群数据总根" "fail" "目录不存在：$resolvedGroupDataRoot" "重新运行 scripts\deploy\deploy.ps1 并确认群数据总根。"
        }
    } catch {
        $rows += New-DoctorRow "群数据总根" "fail" "路径无效：$DeployedGroupDataRoot" "重新运行 scripts\deploy\deploy.ps1 并选择有效目录。"
    }

    $localStatus = Test-Local
    $botPids = @(Get-BotPids)
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) {
        if ($localStatus -eq 200 -and $botPids.Count -gt 0) {
            $rows += New-DoctorRow "计划任务" "warn" "未安装；机器人当前以前台方式运行" "如需开机自启，请在管理员 PowerShell 中运行 scripts\deploy\deploy.ps1。"
        } else {
            $rows += New-DoctorRow "计划任务" "fail" "缺少，且没有健康的前台机器人" "请先运行 ops.ps1 foreground，或在管理员 PowerShell 中运行 scripts\deploy\deploy.ps1。"
        }
    } else {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        $taskLogon = if ($t.Principal) { Get-TaskLogonLabel $t.Principal.LogonType } else { "未知登录方式" }
        $taskDetail = "$(Get-TaskStateLabel $t.State)，$taskLogon" + $(if ($taskInfo) { "，上次结果 $(Get-TaskResultHex $taskInfo.LastTaskResult)" } else { "" })
        if ($t.State -eq "Disabled") {
            $rows += New-DoctorRow "计划任务" "fail" $taskDetail "运行：Enable-ScheduledTask -TaskName $TaskName；然后执行 ops.ps1 start。"
        } elseif ($t.State -eq "Running") {
            $rows += New-DoctorRow "计划任务" "pass" $taskDetail
        } elseif ($localStatus -eq 200) {
            $rows += New-DoctorRow "计划任务" "warn" "$taskDetail；机器人可能在任务外运行" "停止手动启动的机器人，然后执行 ops.ps1 start。"
        } else {
            $rows += New-DoctorRow "计划任务" "fail" $taskDetail "执行 ops.ps1 doctor -Repair，或用 ops.ps1 logs 查看日志。"
        }
    }

    if ($listeners.Count -eq 0) {
        $rows += New-DoctorRow "机器人监听 :$Port" "fail" "没有监听" "执行 ops.ps1 doctor -Repair。"
    } else {
        $ownerPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { [int]$_ })
        $botOwnerPid = @($ownerPids | Where-Object { $botPids -contains $_ } | Select-Object -First 1)
        if ($botOwnerPid.Count -gt 0) {
            $rows += New-DoctorRow "机器人监听 :$Port" "pass" "pid $($botOwnerPid[0])（mixin-chatbot）"
        } elseif ($localStatus -eq 200) {
            $ownerList = $ownerPids -join ", "
            $rows += New-DoctorRow "机器人监听 :$Port" "warn" "pid $ownerList；健康检查有响应但未识别进程身份" "检查：Get-CimInstance Win32_Process，并核对这些 pid。"
        } else {
            $ownerList = $ownerPids -join ", "
            $rows += New-DoctorRow "机器人监听 :$Port" "fail" "pid $ownerList 不是健康的 mixin-chatbot" "检查或停止这些 pid，或使用其他 BOT_PORT 重新部署。"
        }
    }

    $rows += New-DoctorRow "本地机器人健康" $(if ($localStatus -eq 200) { "pass" } else { "fail" }) $(if ($localStatus) { "HTTP $localStatus" } else { "无响应" }) $(if ($localStatus -eq 200) { "" } else { "执行 ops.ps1 doctor -Repair，然后用 ops.ps1 logs 查看日志。" })

    if ($DeployMode -eq "cloudflare") {
        $tokenSource = Get-TunnelTokenSource
        $tokenDetail = if ($tokenSource.Available) { "$($tokenSource.Detail)；仅表示可用于修复，无法证明服务已安装同一 token" } else { $tokenSource.Detail }
        $rows += New-DoctorRow "隧道 token 来源" $(if ($tokenSource.Available) { "pass" } else { "warn" }) $tokenDetail $(if ($tokenSource.Available) { "" } else { "将 token（裸值或 TUNNEL_TOKEN=...）放入 data\config\tunnel-token，然后执行 ops.ps1 repair-tunnel。" })

        $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        $managedTunnel = Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf
        if (-not $svc) {
            $rows += New-DoctorRow "Cloudflared 服务" "fail" "未安装" "请在管理员 PowerShell 中执行 ops.ps1 repair-tunnel。"
        } elseif ($svc.Status -eq "Running") {
            if ($managedTunnel) {
                $rows += New-DoctorRow "Cloudflared 服务" "pass" "运行中（本项目管理）"
            } else {
                $rows += New-DoctorRow "Cloudflared 服务" "warn" "运行中，但没有本项目归属标记" "确认该服务连接的是当前隧道；需纳入本项目管理时执行 ops.ps1 repair-tunnel。"
            }
        } else {
            $ownership = if ($managedTunnel) { "本项目管理" } else { "未记录归属" }
            $rows += New-DoctorRow "Cloudflared 服务" "fail" "$(Get-ServiceStateLabel $svc.Status)（$ownership）" "执行 ops.ps1 doctor -Repair；如果 token 已变化或服务未记录归属，再执行 ops.ps1 repair-tunnel。"
        }

        if ($Domain) {
            $rows += New-DoctorRow "data/state/bot-domain" "pass" $Domain
            $publicStatus = Test-Public
            if ($publicStatus -eq "200") {
                $rows += New-DoctorRow "公网 CF→隧道→机器人" "pass" "HTTP 200"
            } elseif ($publicStatus -eq "502") {
                $rows += New-DoctorRow "公网 CF→隧道→机器人" "fail" "HTTP 502（隧道已到达，但源站不可用）" "检查本地健康状态，以及 Cloudflare Published application → http://localhost:$Port。"
            } elseif ($publicStatus -eq "403") {
                $rows += New-DoctorRow "公网 CF→隧道→机器人" "fail" "HTTP 403（可能是 WAF 策略）" "允许 /favicon.svg 健康检查；按文档只限制 /webhook/ 路径。"
            } elseif ($publicStatus -eq "530" -or $publicStatus -eq "1033") {
                $rows += New-DoctorRow "公网 CF→隧道→机器人" "fail" "HTTP $publicStatus（连接器不可用）" "执行 ops.ps1 repair-tunnel，然后检查 Cloudflare Tunnel hostname/DNS。"
            } else {
                $rows += New-DoctorRow "公网 CF→隧道→机器人" "fail" $(if ($publicStatus) { "HTTP $publicStatus" } else { "DNS/TLS/连接失败" }) "执行 ops.ps1 repair-tunnel，然后检查 Cloudflare DNS、WAF 和 Published application。"
            }
        } else {
            $rows += New-DoctorRow "data/state/bot-domain" "warn" "缺少；跳过公网健康检查" "运行：Set-Content -LiteralPath .\data\state\bot-domain -Value 'bot.example.com' -NoNewline"
            $rows += New-DoctorRow "公网 CF→隧道→机器人" "warn" "没有 data/state/bot-domain，未测试" "设置 data\state\bot-domain 后重新执行 ops.ps1 doctor。"
        }
    }

    $modelsOk = $false
    if (Test-Path -LiteralPath $ModelsFile) {
        try {
            $modelsDoc = Get-Content -LiteralPath $ModelsFile -Raw | ConvertFrom-Json
            $modelsOk = $null -ne $modelsDoc.providers -and @($modelsDoc.providers.PSObject.Properties).Count -gt 0
        } catch {}
    }
    $rows += New-DoctorRow "data/config/models.json" $(if ($modelsOk) { "pass" } else { "fail" }) $(if ($modelsOk) { "有效" } else { "缺少或无效" }) $(if ($modelsOk) { "" } else { "执行 bun run configure。" })

    $secretOk = (Test-Path -LiteralPath $WebhookSecretFile) -and ((Get-Content -LiteralPath $WebhookSecretFile -Raw).Trim() -match "^[0-9a-fA-F]{64}$")
    $rows += New-DoctorRow "data/config/webhook-secret" $(if ($secretOk) { "pass" } else { "fail" }) $(if ($secretOk) { "有效" } else { "缺少或无效（生产服务拒绝启动）" }) $(if ($secretOk) { "" } else { "执行 scripts\deploy\deploy.ps1；密钥变化后还必须更新 IM webhook URL。" })

    $rows += Get-RelayDoctorRows

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
        Warn "可尝试安全自动修复：powershell -ExecutionPolicy Bypass -File .\scripts\ops\ops.ps1 doctor -Repair"
        return $false
    } elseif ($warn -gt 0) {
        Warn "必需检查已通过，但仍有警告"
        return $true
    } else {
        Done "全部检查通过"
        return $true
    }
}

function Invoke-DoctorRepair {
    Step "修复失败的本地组件..."
    $changed = $false
    $ok = $true

    if ((Test-Local) -ne 200) {
        $changed = $true
        if (-not (Restart-Bot)) { $ok = $false }
    }

    if ($DeployMode -eq "cloudflare") {
        $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        $publicStatus = if ($Domain) { Test-Public } else { $null }
        $connectorFailure = $Domain -and ($publicStatus -eq $null -or $publicStatus -eq "530" -or $publicStatus -eq "1033")

        if (-not $svc -or $svc.Status -ne "Running" -or $connectorFailure) {
            $changed = $true
            $tokenSource = Get-TunnelTokenSource
            if ($tokenSource.Available) {
                if (-not (Invoke-TunnelRepair)) { $ok = $false }
            } elseif ($svc -and (IsAdmin) -and (Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf)) {
                try {
                    Set-Service -Name "Cloudflared" -StartupType Automatic -ErrorAction Stop
                    if ($svc.Status -eq "Running") {
                        Restart-Service Cloudflared -ErrorAction Stop
                    } else {
                        Start-Service Cloudflared -ErrorAction Stop
                    }
                    Done "Cloudflared 服务已用当前已安装的 token 重启"
                } catch {
                    Err "重启 Cloudflared 失败：$($_.Exception.Message)"
                    $ok = $false
                }
            } elseif ($svc -and -not (Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf)) {
                Err "Cloudflared 服务没有本项目归属标记，doctor 不会自动重启它"
                Warn "确认 token 后以管理员身份执行 ops.ps1 repair-tunnel，将服务重新安装并纳入本项目管理"
                $ok = $false
            } else {
                Err "Cloudflared 需要修复，但没有可用的 token 来源"
                Warn "请将 token 放入 data\config\tunnel-token，然后以管理员身份执行 ops.ps1 repair-tunnel"
                $ok = $false
            }
        }
    }

    if (-not $changed) { Done "没有发现可自动修复的失败项" }
    return $ok
}

function Restart-Bot {
    Step "重新启动机器人..."
    # 没停下来就别假装重启了：旧进程还占着端口，新实例起不来，健康检查却会因为旧进程
    # 仍在应答而显示正常，得到一个「看起来成功、其实没换版本」的结果。
    if (-not (Stop-Bot)) {
        Err "机器人未能停止，已放弃重启"
        return $false
    }
    Start-Sleep -Seconds 1
    if (-not (Start-Bot)) { return $false }
    $lc = Wait-Local
    if ($lc -eq 200) { Done "机器人已恢复（:$Port 返回 HTTP 200）"; return $true }
    Warn "机器人仍未响应（HTTP $lc）；请检查 scripts\ops\ops.ps1 logs。"
    return $false
}

function Restart-TunnelService {
    # 只重启，不重装。隧道服务与仓库代码无关（它只是把公网流量转发到 localhost:$Port），
    # 例行升级没有理由重装它；token 变化这类需要重装的场景交给 repair-tunnel。
    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if (-not $svc) {
        Err "Cloudflared 服务未安装"
        Warn "请在管理员 PowerShell 中执行 ops.ps1 repair-tunnel"
        return $false
    }
    if (-not (Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf)) {
        Err "Cloudflared 服务没有本项目归属标记，update 不会自动重启它"
        Warn "确认该服务属于本项目后，以管理员身份执行 ops.ps1 repair-tunnel"
        return $false
    }
    if (-not (IsAdmin)) {
        Err "重启 Cloudflared 服务需要管理员 PowerShell"
        Warn "请在提升权限的窗口中执行 ops.ps1 update 或 ops.ps1 repair-tunnel"
        return $false
    }
    Step "重启 Cloudflared 服务..."
    try {
        if ($svc.Status -eq "Running") { Restart-Service Cloudflared -ErrorAction Stop }
        else { Start-Service Cloudflared -ErrorAction Stop }
    } catch {
        Err "重启 Cloudflared 失败：$($_.Exception.Message)"
        return $false
    }
    Done "Cloudflared 服务已重启"
    return $true
}

function Restore-Checkout([string]$Branch, [string]$Sha) {
    if ($Branch -and $Branch -ne "HEAD") {
        $checkout = Invoke-GitCapture @("checkout", $Branch)
        if ($checkout.ExitCode -ne 0) {
            Err "切回分支 $Branch 失败：$($checkout.Text)"
            return $false
        }
    }
    $reset = Invoke-GitCapture @("reset", "--hard", $Sha)
    if ($reset.ExitCode -ne 0) {
        Err "回滚到 $Sha 失败：$($reset.Text)"
        return $false
    }
    return $true
}

# 升级失败后把代码退回升级前那次提交并重新拉起。进入升级前已确认工作区干净，
# 所以 reset --hard 不会毁掉任何本地内容。
function Invoke-UpdateRollback([string]$Branch, [string]$Sha) {
    Write-Host ""
    Warn "升级后机器人未能恢复，正在回滚到 $($Sha.Substring(0, [Math]::Min(7, $Sha.Length)))..."
    if (-not (Restore-Checkout $Branch $Sha)) {
        Err "自动回滚失败；请手动执行：git checkout $Branch; git reset --hard $Sha"
        return $false
    }
    Done "代码已回滚"
    if (-not (Invoke-BunInstall)) {
        Err "回滚后依赖安装失败；机器人可能仍处于停止状态"
        return $false
    }
    if (-not (Restart-Bot)) {
        Err "回滚后机器人仍未恢复；请执行 ops.ps1 logs 查看日志"
        return $false
    }
    Warn "已回滚到升级前的版本，机器人恢复运行。请排查新版本的问题后再重试 update。"
    return $true
}

function Invoke-Update {
    Step "同步到 origin/main 并重启"

    if (-not (Get-GitPath)) {
        Err "找不到可用的 git；请安装 Git for Windows：https://git-scm.com/download/win"
        return $false
    }
    if (-not (Get-BunPath)) {
        Err "找不到可用的 bun；请先安装：powershell -c ""irm bun.sh/install.ps1 | iex"""
        return $false
    }

    $insideRepo = Invoke-GitCapture @("rev-parse", "--is-inside-work-tree")
    if ($insideRepo.ExitCode -ne 0 -or $insideRepo.Text -ne "true") {
        Err "$Project 不是 git 仓库，无法自动更新"
        Warn "这份部署可能是解压缩得到的；请改用 git clone 重新部署后再使用 update"
        return $false
    }

    # 已跟踪文件的改动会被后面的 checkout/reset 冲掉，必须先拦下来。
    # 只看已跟踪文件：未跟踪文件（部署机上常有的安装包、临时产物）不会被这些操作动到，
    # 拿它们挡住升级只会让这条命令永远跑不起来。真撞上同名新文件时，下面的
    # merge --ff-only 会自己带着明确原因失败。
    # data/ 和 logs/ 都在 .gitignore 里，配置与群数据本来就不算改动。
    $dirty = Invoke-GitCapture @("status", "--porcelain", "--untracked-files=no")
    if ($dirty.ExitCode -ne 0) {
        Err "读取 git 状态失败：$($dirty.Text)"
        return $false
    }
    if ($dirty.Text) {
        Err "已跟踪文件有未提交的改动，已停止升级："
        foreach ($line in ($dirty.Text -split "`n")) { Write-Host "      $line" -ForegroundColor Yellow }
        Warn "请先提交、撤销（git restore <文件>）或备份这些改动，然后重试"
        return $false
    }

    $originalBranch = (Invoke-GitCapture @("rev-parse", "--abbrev-ref", "HEAD")).Text
    $originalSha = (Invoke-GitCapture @("rev-parse", "HEAD")).Text
    if (-not $originalSha) {
        Err "无法读取当前提交"
        return $false
    }

    Step "拉取 origin/main..."
    $fetch = Invoke-GitCapture @("fetch", "--prune", "origin", "main")
    if ($fetch.ExitCode -ne 0) {
        Err "git fetch 失败：$($fetch.Text)"
        return $false
    }

    if ($originalBranch -ne "main") {
        Warn "当前在分支 $originalBranch，不是 main"
        if (-not (Read-YesNo "切换到 main 并继续升级？[y/N]" $false)) {
            Warn "已取消升级"
            return $false
        }
        $checkout = Invoke-GitCapture @("checkout", "main")
        if ($checkout.ExitCode -ne 0) {
            Err "切换到 main 失败：$($checkout.Text)"
            return $false
        }
        Done "已切换到 main"
    }

    $currentSha = (Invoke-GitCapture @("rev-parse", "HEAD")).Text
    $targetSha = (Invoke-GitCapture @("rev-parse", "origin/main")).Text
    if (-not $targetSha) {
        Err "无法解析 origin/main；请确认远端存在 main 分支"
        return $false
    }

    if ($currentSha -eq $targetSha) {
        Done "已经是 origin/main 最新版本（$($targetSha.Substring(0, 7))）"
        if (-not (Read-YesNo "代码没有变化；仍然重启机器人？[y/N]" $false)) {
            Write-Host ""
            return (Show-Doctor)
        }
        if (-not (Restart-Bot)) { return $false }
        Write-Host ""
        return (Show-Doctor)
    }

    # 只接受快进。本地有未推送的提交时停下来，而不是替用户决定怎么合并。
    $ancestor = Invoke-GitCapture @("merge-base", "--is-ancestor", "HEAD", "origin/main")
    if ($ancestor.ExitCode -ne 0) {
        Err "本地 main 与 origin/main 已分叉，无法快进升级"
        $ahead = Invoke-GitCapture @("log", "--oneline", "origin/main..HEAD")
        if ($ahead.Text) {
            Warn "本地独有的提交："
            foreach ($line in ($ahead.Text -split "`n")) { Write-Host "      $line" -ForegroundColor Yellow }
        }
        Warn "请先推送或丢弃这些提交后重试"
        return $false
    }

    $incoming = Invoke-GitCapture @("log", "--oneline", "HEAD..origin/main")
    $incomingCount = if ($incoming.Text) { @($incoming.Text -split "`n").Count } else { 0 }
    Write-Host ""
    Write-Host "将要应用 $incomingCount 个提交：" -ForegroundColor Cyan
    foreach ($line in ($incoming.Text -split "`n")) { Write-Host "      $line" -ForegroundColor Gray }
    Write-Host ""

    # 先停再改：bun install 会动 node_modules，让它在机器人跑着的时候换依赖不是好主意。
    # 停不下来就在动 git 之前退出，磁盘上的东西一点没变，重试成本为零。
    Step "停止机器人后更新代码..."
    if (-not (Stop-Bot)) {
        Err "机器人未能停止，已放弃升级（代码未改变）"
        return $false
    }
    Start-Sleep -Seconds 1

    $merge = Invoke-GitCapture @("merge", "--ff-only", "origin/main")
    if ($merge.ExitCode -ne 0) {
        Err "git merge --ff-only 失败：$($merge.Text)"
        Warn "代码未改变，正在重新启动机器人..."
        [void](Restart-Bot)
        return $false
    }
    Done "代码已更新到 $($targetSha.Substring(0, 7))"

    if (-not (Invoke-BunInstall)) {
        [void](Invoke-UpdateRollback $originalBranch $originalSha)
        return $false
    }

    if (-not (Restart-Bot)) {
        [void](Invoke-UpdateRollback $originalBranch $originalSha)
        return $false
    }

    $ok = $true
    if ($DeployMode -eq "cloudflare") {
        $needsTunnelRestart = [bool]$RestartTunnel
        if ($needsTunnelRestart) {
            Warn "已指定 -RestartTunnel，强制重启隧道"
        } elseif ($Domain) {
            Step "检查公网链路 https://$Domain ..."
            $publicStatus = Wait-Public
            if ($publicStatus -eq "200") {
                Done "公网链路正常（HTTP 200），隧道无需重启"
            } else {
                Warn "公网返回 $(if ($publicStatus) { "HTTP $publicStatus" } else { "无法连接" })，尝试重启隧道"
                $needsTunnelRestart = $true
            }
        } else {
            Warn "缺少 data\state\bot-domain，跳过公网检查；如需强制重启隧道请加 -RestartTunnel"
        }

        if ($needsTunnelRestart) {
            if (Restart-TunnelService) {
                if ($Domain) {
                    Step "等待公网链路恢复..."
                    $publicStatus = Wait-Public
                    if ($publicStatus -eq "200") {
                        Done "公网链路已恢复（HTTP 200）"
                    } else {
                        Warn "隧道已重启，但公网仍为 $(if ($publicStatus) { "HTTP $publicStatus" } else { "无法连接" })"
                        Warn "请以管理员身份执行 ops.ps1 repair-tunnel，并检查 Cloudflare DNS/WAF"
                        $ok = $false
                    }
                }
            } else {
                $ok = $false
            }
        }
    }

    Write-Host ""
    Done "升级完成：$($originalSha.Substring(0, 7)) -> $($targetSha.Substring(0, 7))"
    Write-Host ""
    $healthy = Show-Doctor
    return ($ok -and $healthy)
}

function Show-Logs {
    Step "持续查看 $LogPath（Ctrl+C 退出）"
    Get-Content $LogPath -Tail 50 -Wait
}

function Run-Foreground {
    $launcher = Join-Path $RuntimeDir "bot-launcher.ps1"
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
        Err "找不到前台 launcher；请先运行 scripts\deploy\deploy.ps1"
        return $false
    }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq "Running") {
        Err "计划任务正在运行；请先执行 ops.ps1 stop，再切换到前台模式"
        return $false
    }
    $running = @(Get-BotPids)
    if ($running.Count -gt 0) {
        Err "机器人已经在运行（pid $($running -join ', ')）；请先执行 ops.ps1 stop"
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

function Uninstall-TunnelService([switch]$Confirmed) {
    Step "停止并卸载 Cloudflared 服务..."
    Warn "此操作会删除系统中名为 Cloudflared 的服务；请确认它属于本项目。"
    if (-not (IsAdmin)) {
        Err "卸载 Cloudflared 服务需要管理员 PowerShell"
        return $false
    }

    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc -and -not $Confirmed) {
        if (-not (Read-YesNo "确认停止并删除 Cloudflared 系统服务？[y/N]" $false)) {
            Warn "已取消 Cloudflared 服务卸载"
            return $true
        }
    }
    if ($svc) {
        try {
            if ($svc.Status -ne "Stopped") { Stop-Service -Name "Cloudflared" -Force -ErrorAction Stop }
        } catch {
            Warn "停止 Cloudflared 服务失败：$($_.Exception.Message)"
        }

        $cfPath = Get-CloudflaredPath
        if ($cfPath) {
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & $cfPath service uninstall
                $uninstallExitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            if ($uninstallExitCode -ne 0) {
                Warn "cloudflared service uninstall 返回退出码 $uninstallExitCode，将尝试系统级删除服务。"
            }
        } else {
            Warn "找不到可用的 cloudflared 程序，将尝试系统级删除服务。"
        }

        $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        if ($svc) {
            $scPath = Join-Path $env:SystemRoot "System32\sc.exe"
            if (-not (Test-Path -LiteralPath $scPath -PathType Leaf)) {
                Err "找不到系统 sc.exe，无法删除残留的 Cloudflared 服务"
                return $false
            }
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & $scPath delete Cloudflared | Out-Null
                $scExitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            $serviceGone = Wait-ServiceGone "Cloudflared"
            if ($scExitCode -ne 0 -and -not $serviceGone) {
                Err "系统删除 Cloudflared 服务失败（退出码 $scExitCode）"
                return $false
            }
        }
    }

    if (Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue) {
        Err "Cloudflared 服务仍然存在；可能正在等待系统完成删除，请稍后重试"
        return $false
    }
    Remove-Item -LiteralPath $TunnelManagedFile -Force -ErrorAction SilentlyContinue
    Done "Cloudflared 服务已清理"

    if (Test-Path -LiteralPath $LocalCloudflared -PathType Leaf) {
        if (Read-YesNo "是否删除项目内下载的 cloudflared.exe？[y/N]" $false) {
            try {
                Remove-Item -LiteralPath $LocalCloudflared -Force
                Done "项目内 cloudflared.exe 已删除"
            } catch {
                Warn "删除 cloudflared.exe 失败：$($_.Exception.Message)"
                return $false
            }
        } else {
            Done "已保留项目内 cloudflared.exe"
        }
    }
    Get-ChildItem -LiteralPath $Project -Filter "cloudflared.exe.download-*" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    return $true
}

function Uninstall-Bot {
    Step "卸载 mixin-chatbot"
    $resolvedGroupDataRoot = try { Resolve-ProjectPath $DeployedGroupDataRoot } catch { $null }
    if (-not (IsAdmin)) { Warn "当前不是管理员，任务/服务删除可能失败；如失败请以管理员身份重跑。" }
    # 返回值丢弃：下面按实际残留进程判断，比信任停止操作的返回值更严格。
    [void](Stop-Bot)
    $remainingBotPids = @(Get-BotPids)
    if ($remainingBotPids.Count -gt 0) {
        Err "机器人进程仍在运行（pid $($remainingBotPids -join ', ')）；为避免删除仍在使用的数据，卸载已停止。"
        return $false
    }
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t -and -not (IsAdmin)) {
        Err "检测到计划任务，但当前权限无法可靠注销；为避免留下指向已删除文件的孤立任务，卸载已停止。"
        Warn "请以管理员 PowerShell 重新运行 ops.ps1 uninstall。"
        return $false
    }
    if ($t) {
        if (IsAdmin) {
            try {
                Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
                Done "计划任务已注销"
            } catch {
                Err "注销计划任务失败：$($_.Exception.Message)"
                return $false
            }
        } else {
            Warn "未注销计划任务；请以管理员身份重新运行 uninstall"
        }
    } else { Warn "没有可删除的计划任务" }
    $launcher = Join-Path $RuntimeDir "bot-launcher.ps1"
    if (Test-Path -LiteralPath $launcher -PathType Leaf) { Remove-Item -LiteralPath $launcher -Force; Done "机器人 launcher 已删除" }
    if ((Test-Path -LiteralPath $RuntimeDir -PathType Container) -and
        @(Get-ChildItem -LiteralPath $RuntimeDir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $RuntimeDir -Force
        Done "空的 data\runtime 目录已删除"
    }
    [void](Remove-ManagedFirewallRules)

    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        if (Read-YesNo "是否同时停止并卸载 Cloudflared 隧道服务？[y/N]" $false) {
            if (-not (Uninstall-TunnelService -Confirmed)) {
                Err "Cloudflared 服务未能完整卸载；已停止后续数据清理。"
                return $false
            }
        }
    } elseif (Test-Path -LiteralPath $LocalCloudflared -PathType Leaf) {
        if (Read-YesNo "Cloudflared 服务不存在；是否清理项目内 cloudflared.exe？[y/N]" $false) {
            try {
                Remove-Item -LiteralPath $LocalCloudflared -Force
                Done "项目内 cloudflared.exe 已删除"
            } catch {
                Warn "删除 cloudflared.exe 失败：$($_.Exception.Message)"
            }
        }
    }
    Get-ChildItem -LiteralPath $Project -Filter "cloudflared.exe.download-*" -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue

    if (Read-YesNo "是否删除 data/（配置、部署状态、runtime、默认群数据）和 logs/？[y/N]" $false) {
        $remainingTunnel = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        if ($remainingTunnel -and (Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf)) {
            Err "本项目管理的 Cloudflared 服务仍然存在；为避免删除其归属/token 状态，已保留 data/ 和 logs/。"
            return $false
        }
        $logsDir = Join-Path $Project "logs"
        try {
            if (Test-Path -LiteralPath $DataDir) {
                Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction Stop
            }
            if (Test-Path -LiteralPath $logsDir) {
                Remove-Item -LiteralPath $logsDir -Recurse -Force -ErrorAction Stop
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
        Done "已保留 data/ 和 logs/（配置、状态与默认群数据保留）"
    }
    if ($resolvedGroupDataRoot -and
        $resolvedGroupDataRoot.TrimEnd('\') -ne $DefaultGroupDataRoot.TrimEnd('\')) {
        Warn "自定义群数据根未删除：$resolvedGroupDataRoot"
    }
    Done "卸载流程完成；如上方有警告，请按提示补充清理。"
    return $true
}

switch ($Command) {
    "doctor"    {
        $healthy = Show-Doctor
        if ($Repair) {
            Write-Host ""
            $repairOk = Invoke-DoctorRepair
            Write-Host ""
            $healthy = Show-Doctor
            if (-not $repairOk -or -not $healthy) { exit 1 }
        } elseif (-not $healthy) {
            exit 1
        }
    }
    "status"    { if (-not (Show-Doctor)) { exit 1 } }
    "update"    { if (-not (Invoke-Update)) { exit 1 } }
    "upgrade"   { if (-not (Invoke-Update)) { exit 1 } }
    "repair-tunnel" {
        if (-not (Invoke-TunnelRepair)) { exit 1 }
        Write-Host ""
        if (-not (Show-Doctor)) { exit 1 }
    }
    "uninstall-tunnel" { if (-not (Uninstall-TunnelService)) { exit 1 } }
    "restart"   { if (-not (Restart-Bot)) { exit 1 } }
    "stop"      {
        Step "停止机器人..."
        if (-not (Stop-Bot)) { exit 1 }
        Done "机器人已停止"
    }
    "foreground" { if (-not (Run-Foreground)) { exit 1 } }
    "run-foreground" { if (-not (Run-Foreground)) { exit 1 } }
    "start"     {
        if (-not (Start-Bot)) { exit 1 }
        $lc = Wait-Local
        if ($lc -eq 200) { Done "机器人已启动（:$Port 返回 HTTP 200）" }
        else { Warn "机器人未通过健康检查（HTTP $lc）；请检查 scripts\ops\ops.ps1 logs。"; exit 1 }
    }
    "logs"      {
        if (-not (Test-Path $LogPath)) { Warn "找不到日志文件 $LogPath（机器人可能从未启动）"; exit 1 }
        Show-Logs
    }
    "uninstall" { if (-not (Uninstall-Bot)) { exit 1 } }
    default {
        Write-Host "mixin-chatbot 运维工具（Windows Server）" -ForegroundColor Cyan
        Write-Host "用法：powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 <命令> [-Repair] [-RestartTunnel]"
        Write-Host ""
        Write-Host "  doctor          只读诊断；加 -Repair 自动修复可安全判断的问题"
        Write-Host "  update          同步 origin/main、装依赖、重启并体检；失败自动回滚"
        Write-Host "                  隧道默认只在公网检查失败时重启，加 -RestartTunnel 可强制"
        Write-Host "  repair-tunnel   按当前 token 来源强制重装 Cloudflared 服务"
        Write-Host "  uninstall-tunnel 停止并卸载 Cloudflared 服务，可选删除本地程序"
        Write-Host "  restart         停止并重新启动机器人"
        Write-Host "  stop            停止计划任务和 Bun 进程"
        Write-Host "  start           启动机器人计划任务"
        Write-Host "  foreground      以前台方式运行 launcher（Ctrl+C 停止）"
        Write-Host "  logs            持续查看 logs\mixin-chatbot.log"
        Write-Host "  uninstall       清理任务/进程/防火墙/launcher，可选清理隧道、data 和 logs"
    }
}
