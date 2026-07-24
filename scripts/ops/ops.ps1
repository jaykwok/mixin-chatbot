# mixin-chatbot 运维工具（Windows Server）。
# 一站式运维：诊断/修复、服务安装与卸载、前台运行、日志和完整清理。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 <命令>
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 doctor -Repair
#   命令：doctor、repair-tunnel、uninstall-tunnel、restart、stop、start、foreground、logs、uninstall（无参数显示菜单）
#
# repair-tunnel/uninstall-tunnel/restart/stop/start/uninstall 可能需要管理员权限。
param(
    [Parameter(Position = 0)]
    [string]$Command = "",
    [switch]$Repair
)

$ErrorActionPreference = "Stop"

$Project  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$TaskName = "mixin-chatbot"
$portFile = Join-Path $Project "data\bot-port"
$Port     = if ($env:BOT_PORT) { $env:BOT_PORT } elseif (Test-Path $portFile) { (Get-Content $portFile -Raw).Trim() } else { "1011" }
$modeFile = Join-Path $Project "data\deploy-mode"
$DeployMode = if (Test-Path $modeFile) { (Get-Content $modeFile -Raw).Trim() } else { "direct" }
$domainFile = Join-Path $Project "data\bot-domain"
$Domain   = if ($env:BOT_DOMAIN) { $env:BOT_DOMAIN.Trim() } elseif (Test-Path $domainFile) { (Get-Content $domainFile -Raw).Trim() } else { "" }
$LogPath  = Join-Path $Project "logs\mixin-chatbot.log"
$TunnelScript = Join-Path $Project "scripts\tunnel\start-tunnel.ps1"
$DefaultTunnelTokenFile = Join-Path $Project "data\tunnel-token"
$LocalCloudflared = Join-Path $Project "cloudflared.exe"
$WindowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $WindowsPowerShell -PathType Leaf)) { $WindowsPowerShell = "powershell.exe" }

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[x] $m" -ForegroundColor Red }
function IsAdmin  { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
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
    return Get-TunnelTokenFileInfo $DefaultTunnelTokenFile "data\tunnel-token"
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
    throw "BOT_PORT/data/bot-port 中的端口无效：$Port"
}
$Port = "$portNumber"
if ($DeployMode -notin @("direct", "cloudflare")) {
    throw "data/deploy-mode 中的部署模式无效：$DeployMode"
}
if ($Domain -and -not (Test-Hostname $Domain)) {
    throw "BOT_DOMAIN/data/bot-domain 中的 hostname 无效：$Domain"
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

function Stop-Bot {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { try { Stop-ScheduledTask -TaskName $TaskName } catch {} }
    foreach ($p in Get-BotPids) { try { Stop-Process -Id $p -Force } catch {} }
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
    try { return (Invoke-WebRequest -Uri "http://localhost:$Port/favicon.svg" -UseBasicParsing -TimeoutSec 2).StatusCode }
    catch {
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
        Err "repair-tunnel 只适用于 data\deploy-mode 为 cloudflare 的部署"
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
        Warn "请将裸 token（或 TUNNEL_TOKEN=...）放入 data\tunnel-token 后重试"
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

    Warn "缺少 data\bot-domain；连接器已修复，但无法验证公网健康状态"
    return $true
}

function Show-Doctor {
    Step "mixin-chatbot 健康检查（模式=$(Get-DeployModeLabel $DeployMode)，端口=$Port）"
    $rows = @()

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
        $rows += New-DoctorRow "隧道 token 来源" $(if ($tokenSource.Available) { "pass" } else { "warn" }) $tokenDetail $(if ($tokenSource.Available) { "" } else { "将 token（裸值或 TUNNEL_TOKEN=...）放入 data\tunnel-token，然后执行 ops.ps1 repair-tunnel。" })

        $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        if (-not $svc) {
            $rows += New-DoctorRow "Cloudflared 服务" "fail" "未安装" "请在管理员 PowerShell 中执行 ops.ps1 repair-tunnel。"
        } elseif ($svc.Status -eq "Running") {
            $rows += New-DoctorRow "Cloudflared 服务" "pass" "运行中"
        } else {
            $rows += New-DoctorRow "Cloudflared 服务" "fail" (Get-ServiceStateLabel $svc.Status) "执行 ops.ps1 doctor -Repair；如果 token 已变化，再执行 ops.ps1 repair-tunnel。"
        }

        if ($Domain) {
            $rows += New-DoctorRow "data/bot-domain" "pass" $Domain
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
            $rows += New-DoctorRow "data/bot-domain" "warn" "缺少；跳过公网健康检查" "运行：Set-Content -LiteralPath .\data\bot-domain -Value 'bot.example.com' -NoNewline"
            $rows += New-DoctorRow "公网 CF→隧道→机器人" "warn" "没有 data/bot-domain，未测试" "设置 data\bot-domain 后重新执行 ops.ps1 doctor。"
        }
    }

    $mj = Join-Path $Project "data\models.json"
    $modelsOk = $false
    if (Test-Path $mj) {
        try {
            $modelsDoc = Get-Content $mj -Raw | ConvertFrom-Json
            $modelsOk = $null -ne $modelsDoc.providers -and @($modelsDoc.providers.PSObject.Properties).Count -gt 0
        } catch {}
    }
    $rows += New-DoctorRow "data/models.json" $(if ($modelsOk) { "pass" } else { "fail" }) $(if ($modelsOk) { "有效" } else { "缺少或无效" }) $(if ($modelsOk) { "" } else { "执行 bun run configure。" })

    $ws = Join-Path $Project "data\webhook-secret"
    $secretOk = (Test-Path $ws) -and ((Get-Content $ws -Raw).Trim() -match "^[0-9a-fA-F]{32,64}$")
    $rows += New-DoctorRow "data/webhook-secret" $(if ($secretOk) { "pass" } else { "fail" }) $(if ($secretOk) { "有效" } else { "缺少或无效（生产服务拒绝启动）" }) $(if ($secretOk) { "" } else { "执行 scripts\deploy\deploy.ps1；密钥变化后还必须更新 IM webhook URL。" })

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
            } elseif ($svc -and (IsAdmin)) {
                try {
                    if ($svc.Status -eq "Running") { Restart-Service Cloudflared } else { Start-Service Cloudflared }
                    Done "Cloudflared 服务已用当前已安装的 token 重启"
                } catch {
                    Err "重启 Cloudflared 失败：$($_.Exception.Message)"
                    $ok = $false
                }
            } else {
                Err "Cloudflared 需要修复，但没有可用的 token 来源"
                Warn "请将 token 放入 data\tunnel-token，然后以管理员身份执行 ops.ps1 repair-tunnel"
                $ok = $false
            }
        }
    }

    if (-not $changed) { Done "没有发现可自动修复的失败项" }
    return $ok
}

function Restart-Bot {
    Step "重新启动机器人..."
    Stop-Bot
    Start-Sleep -Seconds 1
    if (-not (Start-Bot)) { return $false }
    $lc = Wait-Local
    if ($lc -eq 200) { Done "机器人已恢复（:$Port 返回 HTTP 200）"; return $true }
    Warn "机器人仍未响应（HTTP $lc）；请检查 scripts\ops\ops.ps1 logs。"
    return $false
}

function Show-Logs {
    Step "持续查看 $LogPath（Ctrl+C 退出）"
    Get-Content $LogPath -Tail 50 -Wait
}

function Run-Foreground {
    $launcher = Join-Path $Project "data\runtime\bot-launcher.ps1"
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
        $confirm = Read-Host "确认停止并删除 Cloudflared 系统服务？[y/N]"
        if ($confirm -notmatch "^[yY]$") {
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
    Done "Cloudflared 服务已清理"

    if (Test-Path -LiteralPath $LocalCloudflared -PathType Leaf) {
        $removeExe = Read-Host "是否删除项目内下载的 cloudflared.exe？[y/N]"
        if ($removeExe -match "^[yY]$") {
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
    if (-not (IsAdmin)) { Warn "当前不是管理员，任务/服务删除可能失败；如失败请以管理员身份重跑。" }
    Stop-Bot
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
    $runtimeDir = Join-Path $Project "data\runtime"
    $launcher = Join-Path $runtimeDir "bot-launcher.ps1"
    if (Test-Path -LiteralPath $launcher -PathType Leaf) { Remove-Item -LiteralPath $launcher -Force; Done "机器人 launcher 已删除" }
    if ((Test-Path -LiteralPath $runtimeDir -PathType Container) -and
        @(Get-ChildItem -LiteralPath $runtimeDir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
        Remove-Item -LiteralPath $runtimeDir -Force
        Done "空的 data\runtime 目录已删除"
    }
    [void](Remove-ManagedFirewallRules)

    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        $a = Read-Host "是否同时停止并卸载 Cloudflared 隧道服务？[y/N]"
        if ($a -match "^[yY]$") {
            [void](Uninstall-TunnelService -Confirmed)
        }
    } elseif (Test-Path -LiteralPath $LocalCloudflared -PathType Leaf) {
        $a = Read-Host "Cloudflared 服务不存在；是否清理项目内 cloudflared.exe？[y/N]"
        if ($a -match "^[yY]$") {
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

    $d = Read-Host "是否删除 data/（models.json、webhook-secret、默认群数据）和 logs/？[y/N]"
    if ($d -match "^[yY]$") {
        Remove-Item (Join-Path $Project "data") -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $Project "logs") -Recurse -Force -ErrorAction SilentlyContinue
        Done "data/ 和 logs/ 已删除"
    } else {
        Done "已保留 data/ 和 logs/（配置与默认群数据保留）"
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
    "repair-tunnel" {
        if (-not (Invoke-TunnelRepair)) { exit 1 }
        Write-Host ""
        if (-not (Show-Doctor)) { exit 1 }
    }
    "uninstall-tunnel" { if (-not (Uninstall-TunnelService)) { exit 1 } }
    "restart"   { if (-not (Restart-Bot)) { exit 1 } }
    "stop"      { Step "停止机器人..."; Stop-Bot; Done "机器人已停止" }
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
        Write-Host "用法：powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 <命令> [-Repair]"
        Write-Host ""
        Write-Host "  doctor          只读诊断；加 -Repair 自动修复可安全判断的问题"
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
