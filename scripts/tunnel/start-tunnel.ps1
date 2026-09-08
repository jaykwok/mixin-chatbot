# Windows Server 连接器：使用已安装的官方 cloudflared 注册 Windows 服务。
#   Cloudflare Tunnel  <==>  localhost:BOT_PORT（默认 1011）
#
# 前置条件：
#   1) 机器人已在 localhost:BOT_PORT 运行（scripts\deploy\deploy.ps1，Cloudflare 模式）
#   2) 隧道 token。来源优先级：
#        参数： .\scripts\tunnel\start-tunnel.ps1 <token文件>  # 相对或绝对路径
#        环境： $env:TUNNEL_TOKEN_FILE='<路径>'                  # token 文件路径
#        环境： $env:TUNNEL_TOKEN='<裸 token>'                  # 直接提供 token
#        默认： data\config\tunnel-token                         # 裸 token 或 .env 形式
#      token 文件可以是裸 token，也可以是复制来的 .env 文件。
#      任何包含 TUNNEL_TOKEN=<值> 的 .env 文件都可以直接使用。
#
# 请在管理员 PowerShell 中运行：
#   powershell -ExecutionPolicy Bypass -File scripts\tunnel\start-tunnel.ps1 [token文件]
$ErrorActionPreference = "Stop"
$Project = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
# 加载共享实例控制、部署事务和辅助函数。
$CommonLib = Join-Path $PSScriptRoot "..\lib\common.ps1"
if (-not (Test-Path -LiteralPath $CommonLib -PathType Leaf)) {
    Write-Host "缺少 $CommonLib；请从仓库完整获取脚本目录后重试。" -ForegroundColor Red
    exit 1
}
. $CommonLib
Set-Location $Project
$DataDir = Join-Path $Project "data"
$ConfigDir = Join-Path $DataDir "config"
$StateDir = Join-Path $DataDir "state"
$PersistedPortFile = Join-Path $StateDir "bot-port"
$DefaultTunnelTokenFile = Join-Path $ConfigDir "tunnel-token"
$TunnelManagedFile = Join-Path $StateDir "cloudflared-managed"


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


$BotPort = if ($env:BOT_PORT) {
    $env:BOT_PORT
} elseif (Test-Path -LiteralPath $PersistedPortFile) {
    (Get-Content -LiteralPath $PersistedPortFile -Raw).Trim()
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
        Invoke-WebRequest -Uri "http://localhost:$BotPort/health" -UseBasicParsing -TimeoutSec 3 | Out-Null
        Write-Host "正常：机器人已在 :$BotPort 在线。" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "警告：:$BotPort 无响应；请先通过 scripts\deploy\deploy.ps1 启动机器人（Cloudflare 模式）。" -ForegroundColor Yellow
        return $false
    }
}

# 从 token 里读出它属于哪条隧道，好让人在连上去之前看清目标。
#
# token 是 base64 过的 JSON：{"a":"<账号>","t":"<隧道 id>","s":"<密钥>"}。这里只取前两个
# 字段，secret 一个字符都不打印。解不开就返回 null——这只是给人看的信息，不该成为启动
# 的前提条件。
function Get-TunnelTokenIdentity([string]$Value) {
    try {
        $padded = $Value.Replace('-', '+').Replace('_', '/')
        switch ($padded.Length % 4) {
            2 { $padded += '==' }
            3 { $padded += '=' }
        }
        $doc = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($padded)) | ConvertFrom-Json
        if (-not $doc.t) { return $null }
        return @{ Account = [string]$doc.a; Tunnel = [string]$doc.t }
    } catch {
        return $null
    }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$existingService = if ($isAdmin) { Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue } else { $null }
if ($existingService -and $env:CLOUDFLARED_REINSTALL -ne "1") {
    # 这条分支不新增连接器，只是把已有服务拉起来，所以机器人不在线只提示、不拦。
    $null = Test-LocalBot
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
    if (-not (Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf)) {
        Write-Host "该服务没有本项目归属标记；切换回直连模式时部署脚本不会自动停止它。" -ForegroundColor Yellow
    }
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
    $file = $DefaultTunnelTokenFile
}
if ($file) {
    $r = Read-TokenFile $file
    if ($null -eq $r) {
        Write-Host "错误：找不到 tunnel token 文件：$file" -ForegroundColor Red
        Write-Host "  使用优先级：" -ForegroundColor Red
        Write-Host "    .\scripts\tunnel\start-tunnel.ps1 <token文件>   # 相对或绝对路径" -ForegroundColor Red
        Write-Host "    `$env:TUNNEL_TOKEN_FILE='<路径>'             # 指定 token 文件" -ForegroundColor Red
        Write-Host "    `$env:TUNNEL_TOKEN='<裸 token>'             # 直接提供 token 值" -ForegroundColor Red
        Write-Host "    默认：data\config\tunnel-token          # 裸 token 或 .env 文件" -ForegroundColor Red
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

# ---- 2. 查找官方安装的 cloudflared.exe ----
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
    throw '请先通过官方渠道安装 cloudflared：winget install --id Cloudflare.cloudflared；然后重新运行。'
}
Write-Host "[*] cloudflared 程序：$cfPath" -ForegroundColor Cyan

# ---- 3. 连接前的确认：连到哪条隧道、本机有没有东西可转发 ----
$identity = Get-TunnelTokenIdentity $token
if ($identity) {
    Write-Host "[*] 目标隧道：$($identity.Tunnel)" -ForegroundColor Cyan
    Write-Host "[*] 所属账号：$($identity.Account)" -ForegroundColor Cyan
}
$botOnline = Test-LocalBot

# 连接器注册后会参与分流；默认要求本地服务健康，避免向无服务实例导入生产流量。
if (-not $botOnline -and $env:TUNNEL_ALLOW_NO_BOT -ne "1") {
    Write-Host ""
    Write-Host "已中止：本机 :$BotPort 上没有机器人在监听，不能把这台机器接进隧道。" -ForegroundColor Red
    Write-Host "连上之后 Cloudflare 会把流量分给它，而它无处可转发，只会返回 502；" -ForegroundColor Red
    Write-Host "如果隧道里还有正常的连接器，表现就是时好时坏，非常难查。" -ForegroundColor Red
    Write-Host ""
    Write-Host "  · 要在这台机器上部署：先跑 scripts\deploy\deploy.ps1（Cloudflare 模式）再回来。" -ForegroundColor Yellow
    Write-Host "  · 只是想测试本脚本：别用生产 token，用 `$env:TUNNEL_TOKEN 指向一条测试隧道。" -ForegroundColor Yellow
    Write-Host "  · 确认就是要这么连：设置 `$env:TUNNEL_ALLOW_NO_BOT='1' 后重跑。" -ForegroundColor Yellow
    exit 1
}

# ---- 4. 启动隧道 ----
Write-Host "cloudflared 连接器：请在控制台将 Published application 服务地址设为 http://localhost:$BotPort"
if ($isAdmin) {
    if ($existingService -and -not (Test-Path -LiteralPath $TunnelManagedFile -PathType Leaf)) {
        throw '现有 Cloudflared 服务没有本项目归属记录；请通过其原管理方式维护，不能自动重装。'
    }
    $serviceHelp = @(& $cfPath service install --help) -join "`n"
    if ($serviceHelp -notmatch '--token-file') { throw '请更新官方 cloudflared，当前 service install 不支持 token 文件。' }
    $connectorSnapshot = New-CloudflaredSnapshot $Project
    $connectorCommitted = $false
    try {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    Set-Content -LiteralPath $TunnelManagedFile -Value "Cloudflared" -NoNewline -Encoding ASCII
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
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    Set-Content -LiteralPath $TunnelManagedFile -Value "Cloudflared" -NoNewline -Encoding ASCII
    Write-Host "完成。检查命令：Get-Service Cloudflared；日志：事件查看器（eventvwr）。" -ForegroundColor Green
    $connectorCommitted = $true
    } finally {
        try {
        if (-not $connectorCommitted) { Restore-CloudflaredSnapshot $connectorSnapshot }
        else {
            try { Remove-CompletedBackup $connectorSnapshot.Path $Project }
            catch { Write-Warning ('连接器已启动，但备份清理未完成，请检查 backup/tmp 和 backup/rm：' + $_.Exception.Message) }
        }
        } finally { $env:BOT_DEPLOY_BACKUP_ID = $connectorSnapshot.PreviousBackupId }
    }
} else {
    Write-Host "（当前不是管理员：以前台方式运行；请以管理员身份重跑以安装服务。）" -ForegroundColor Yellow
    $previousErrorActionPreference = $ErrorActionPreference
    $foregroundExitCode = 1
    try {
        $ErrorActionPreference = "Continue"
        $foregroundTokenFile = Join-Path $ConfigDir 'cloudflared-token'
        New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
        [IO.File]::WriteAllText($foregroundTokenFile, $token, (New-Object Text.UTF8Encoding($false)))
        Protect-ProjectSecretPath $foregroundTokenFile
        & $cfPath tunnel --no-autoupdate run --token-file $foregroundTokenFile
        $foregroundExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    exit $foregroundExitCode
}
