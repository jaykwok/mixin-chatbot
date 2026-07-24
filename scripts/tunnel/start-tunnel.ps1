# 云电脑（Windows Server）连接器：安装 cloudflared 并注册为 Windows 服务。
#   Cloudflare Tunnel  <==>  localhost:BOT_PORT（默认 1011）
#
# 前置条件：
#   1) 机器人已在 localhost:BOT_PORT 运行（scripts\deploy\deploy.ps1，Cloudflare 模式）
#   2) 隧道 token。来源优先级：
#        参数： .\scripts\tunnel\start-tunnel.ps1 <token文件>  # 相对或绝对路径
#        环境： $env:TUNNEL_TOKEN_FILE='<路径>'                  # token 文件路径
#        环境： $env:TUNNEL_TOKEN='<裸 token>'                  # 直接提供 token
#        默认： data\tunnel-token                                # 裸 token 或 .env 形式
#      token 文件可以是裸 token，也可以是复制来的 .env 文件。
#      任何包含 TUNNEL_TOKEN=<值> 的 .env 文件都可以直接使用。
#
# 请在管理员 PowerShell 中运行：
#   powershell -ExecutionPolicy Bypass -File scripts\tunnel\start-tunnel.ps1 [token文件]
$ErrorActionPreference = "Stop"
$Project = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Project

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

function Test-CloudflaredApplication([string]$Path) {
    try {
        $output = @(& $Path --version 2>$null)
        $exitCode = $LASTEXITCODE
    } catch {
        return $false
    }
    return $exitCode -eq 0 -and (($output -join "`n") -match '(?i)cloudflared\s+version')
}

function Resolve-ProjectPath([string]$Value) {
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $Project $Value))
}

function Test-TunnelTokenValue([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return (($Value -replace '[^A-Za-z0-9+/=_-]', '').Length -ge 20)
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

$persistedPort = Join-Path $Project "data\bot-port"
$BotPort = if ($env:BOT_PORT) {
    $env:BOT_PORT
} elseif (Test-Path $persistedPort) {
    (Get-Content $persistedPort -Raw).Trim()
} else {
    "1011"
}
$portNumber = 0
if (-not [int]::TryParse($BotPort, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
    Write-Host "错误：BOT_PORT 必须是 1–65535 的整数。" -ForegroundColor Red
    exit 1
}
$BotPort = "$portNumber"

function Test-LocalBot {
    try {
        Invoke-WebRequest -Uri "http://localhost:$BotPort/favicon.svg" -UseBasicParsing -TimeoutSec 3 | Out-Null
        Write-Host "正常：机器人已在 :$BotPort 在线。" -ForegroundColor Green
    } catch {
        Write-Host "警告：:$BotPort 无响应；请先通过 scripts\deploy\deploy.ps1 启动机器人（Cloudflare 模式）。" -ForegroundColor Yellow
    }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$existingService = if ($isAdmin) { Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue } else { $null }
if ($existingService -and $env:CLOUDFLARED_REINSTALL -ne "1") {
    Test-LocalBot
    Write-Host "Cloudflared 服务已存在（状态：$(Get-ServiceStateLabel $existingService.Status)）。" -ForegroundColor Yellow
    if ($existingService.Status -ne "Running") {
        try { Start-Service "Cloudflared" }
        catch {
            Write-Host "错误：Cloudflared 服务启动失败：$($_.Exception.Message)" -ForegroundColor Red
            Write-Host "请运行：powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 doctor" -ForegroundColor Yellow
            exit 1
        }
    }
    Write-Host "现有服务会继续使用已安装的 token；如需替换，请设置 CLOUDFLARED_REINSTALL=1。" -ForegroundColor Yellow
    Write-Host "也可以运行：powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 repair-tunnel" -ForegroundColor Yellow
    Write-Host "完成。检查命令：Get-Service Cloudflared；日志：事件查看器（eventvwr）。" -ForegroundColor Green
    exit 0
}

# ---- 1. 读取 token ----
function Read-TokenFile($path) {
    $abs = Resolve-ProjectPath $path
    if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { return $null }
    $content = Get-Content -LiteralPath $abs -Raw -ErrorAction SilentlyContinue
    if ($null -eq $content) { return $null }
    $m = [regex]::Match($content, '(?m)^[ \t]*TUNNEL_TOKEN[ \t]*=(.+?)[ \t\r]*$')
    if ($m.Success) {
        $val = $m.Groups[1].Value.Trim().Trim('"').Trim("'")
        return @{ token = $val; from = $abs }
    }
    if ($content -match '(?m)^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=') {
        return @{ token = ""; from = $abs }
    }
    return @{ token = $content; from = $abs }
}

$token = $null
$source = $null
if ($args.Count -ge 1 -and $args[0]) {
    $file = $args[0]
} elseif ($env:TUNNEL_TOKEN_FILE) {
    $file = $env:TUNNEL_TOKEN_FILE
} elseif ($env:TUNNEL_TOKEN) {
    $file = $null
    $token = $env:TUNNEL_TOKEN
    $source = "env:TUNNEL_TOKEN"
} else {
    $file = "data\tunnel-token"
}
if ($file) {
    $r = Read-TokenFile $file
    if ($null -eq $r) {
        Write-Host "错误：找不到 tunnel token 文件：$file" -ForegroundColor Red
        Write-Host "  使用优先级：" -ForegroundColor Red
        Write-Host "    .\scripts\tunnel\start-tunnel.ps1 <token文件>   # 相对或绝对路径" -ForegroundColor Red
        Write-Host "    `$env:TUNNEL_TOKEN_FILE='<路径>'             # 指定 token 文件" -ForegroundColor Red
        Write-Host "    `$env:TUNNEL_TOKEN='<裸 token>'             # 直接提供 token 值" -ForegroundColor Red
        Write-Host "    默认：data\tunnel-token                 # 裸 token 或 .env 文件" -ForegroundColor Red
        Write-Host "  （包含 TUNNEL_TOKEN=<值> 的 .env 文件可直接使用）" -ForegroundColor Red
        exit 1
    }
    $token = $r.token
    $source = $r.from
}
# 清洗：只保留 base64 字符（去除空白、引号、BOM、CRLF）
$token = $token -replace '[^A-Za-z0-9+/=_-]', ''
if (-not (Test-TunnelTokenValue $token)) {
    Write-Host "错误：token 为空或格式明显无效（清洗后长度不足 20）。" -ForegroundColor Red
    exit 1
}
Write-Host "[*] token 来源：$source" -ForegroundColor Cyan

# ---- 2. 查找或下载 cloudflared.exe ----
$exe = Join-Path $Project "cloudflared.exe"
$cfCandidates = @(Get-ApplicationPaths "cloudflared")
$knownCloudflaredPaths = @()
if ($env:LOCALAPPDATA) { $knownCloudflaredPaths += (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\cloudflared.exe") }
if ($env:ProgramFiles) { $knownCloudflaredPaths += (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe") }
foreach ($knownCloudflaredPath in $knownCloudflaredPaths) {
    if ((Test-Path -LiteralPath $knownCloudflaredPath -PathType Leaf) -and $cfCandidates -notcontains $knownCloudflaredPath) {
        $cfCandidates += $knownCloudflaredPath
    }
}
if ((Test-Path -LiteralPath $exe -PathType Leaf) -and $cfCandidates -notcontains $exe) { $cfCandidates += $exe }
$cfPath = $null
foreach ($candidate in $cfCandidates) {
    if (Test-CloudflaredApplication $candidate) {
        $cfPath = $candidate
        break
    }
}
if (-not $cfPath) {
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        Write-Host "警告：项目内的 cloudflared.exe 不可用，将下载最新版替换。" -ForegroundColor Yellow
    } else {
        Write-Host "未找到可用的 cloudflared，正在下载最新版..."
    }
    $asset = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
        "X64"   { "cloudflared-windows-amd64.exe" }
        "Arm64" { "cloudflared-windows-arm64.exe" }
        default { throw "不支持的 Windows 架构：$($_)" }
    }
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
    $download = "$exe.download-$PID.exe"
    try {
        try {
            Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
        } catch {
            throw "下载 cloudflared 失败：$($_.Exception.Message)"
        }
        if (-not (Test-CloudflaredApplication $download)) { throw "下载的 cloudflared 版本探测失败" }
        Move-Item -LiteralPath $download -Destination $exe -Force
    } finally {
        Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
    }
    $cfPath = $exe
}
Write-Host "[*] cloudflared 程序：$cfPath" -ForegroundColor Cyan

# ---- 3. 探测本地机器人 ----
Test-LocalBot

# ---- 4. 启动隧道 ----
Write-Host "cloudflared 连接器：请在控制台将 Published application 服务地址设为 http://localhost:$BotPort"
if ($isAdmin) {
    $svc = $existingService
    if ($svc) {
        Write-Host "Cloudflared 服务已存在（状态：$(Get-ServiceStateLabel $svc.Status)）。" -ForegroundColor Yellow
        if ($env:CLOUDFLARED_REINSTALL -eq "1") {
            Stop-Service "Cloudflared" -ErrorAction SilentlyContinue
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & $cfPath service uninstall
                $serviceUninstallExitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            if ($serviceUninstallExitCode -ne 0) { throw "Cloudflared 服务卸载失败（退出码 $serviceUninstallExitCode）" }
            $previousErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                & $cfPath service install $token
                $serviceInstallExitCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            if ($serviceInstallExitCode -ne 0) { throw "Cloudflared 服务安装失败（退出码 $serviceInstallExitCode）" }
            Write-Host "Cloudflared 服务已使用指定 token 重新安装。" -ForegroundColor Green
        } else {
            if ($svc.Status -ne "Running") { Start-Service "Cloudflared" }
            Write-Host "现有服务会继续使用已安装的 token；如需替换，请设置 CLOUDFLARED_REINSTALL=1。" -ForegroundColor Yellow
        }
    } else {
        Write-Host "正在安装 Windows 服务（开机自启）..."
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            & $cfPath service install $token
            $serviceInstallExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($serviceInstallExitCode -ne 0) { throw "Cloudflared 服务安装失败（退出码 $serviceInstallExitCode）" }
    }
    $installedService = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if (-not $installedService) { throw "Cloudflared 服务安装命令已完成，但系统中仍找不到该服务" }
    if ($installedService.Status -ne "Running") {
        Start-Service "Cloudflared"
        $installedService = Get-Service -Name "Cloudflared"
    }
    if ($installedService.Status -ne "Running") { throw "Cloudflared 服务已安装，但未能进入运行状态" }
    Write-Host "完成。检查命令：Get-Service Cloudflared；日志：事件查看器（eventvwr）。" -ForegroundColor Green
} else {
    Write-Host "（当前不是管理员：以前台方式运行；请以管理员身份重跑以安装服务。）" -ForegroundColor Yellow
    $previousErrorActionPreference = $ErrorActionPreference
    $foregroundExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        & $cfPath tunnel --no-autoupdate run --token $token
        $foregroundExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    exit $foregroundExitCode
}
