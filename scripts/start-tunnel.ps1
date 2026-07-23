# 云电脑 (Windows Server) 本地对接：装 cloudflared 并作为 Windows 服务连接隧道。
#   im-bot.jaykwok.net  <==>  localhost:1011
#
# 前置：
#   1) 机器人已在本机 :1011 跑起来 (./deploy.sh 选 Cloudflare 模式)
#   2) 隧道 token 放到 data\tunnel-token (从服务器 /root/.cpa-bot-tunnel-token.env 拷)
#      或  $env:TUNNEL_TOKEN='<...>'
#
# 用法 (管理员 PowerShell)：
#   powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1
$ErrorActionPreference = "Stop"

$BotPort   = if ($env:BOT_PORT) { $env:BOT_PORT } else { "1011" }
$TokenFile = "data\tunnel-token"

# ---- 1. 取 token ----
$token = $env:TUNNEL_TOKEN
if (-not $token) {
    if (Test-Path $TokenFile) { $token = (Get-Content $TokenFile -Raw).Trim() }
    else {
        Write-Host "✗ 未找到隧道 token。" -ForegroundColor Red
        Write-Host "  把服务器 /root/.cpa-bot-tunnel-token.env 里的 TUNNEL_TOKEN 写入 $TokenFile，"
        Write-Host "  或： `$env:TUNNEL_TOKEN='<...>'"
        exit 1
    }
}

# ---- 2. 确保 cloudflared.exe ----
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cf) { $cfPath = $cf.Source }
else {
    $exe = Join-Path $PWD "cloudflared.exe"
    if (-not (Test-Path $exe)) {
        Write-Host "下载 cloudflared.exe ..."
        Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" `
                          -OutFile $exe -UseBasicParsing
    }
    $cfPath = $exe
}

# ---- 3. 探测本机机器人 ----
try {
    Invoke-WebRequest -Uri "http://localhost:$BotPort/favicon.svg" -UseBasicParsing -TimeoutSec 3 | Out-Null
    Write-Host "✓ 本机 :$BotPort 机器人在线" -ForegroundColor Green
} catch {
    Write-Host "⚠ 本机 :$BotPort 无响应——先 ./deploy.sh 把机器人起来（Cloudflare 模式）" -ForegroundColor Yellow
}

# ---- 4. 起隧道 ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "▶ cloudflared：im-bot.jaykwok.net  <==>  localhost:$BotPort"
if ($isAdmin) {
    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Host "服务 'Cloudflared' 已存在（状态：$($svc.Status)）" -ForegroundColor Yellow
        if ($svc.Status -ne "Running") { Start-Service "Cloudflared" }
    } else {
        Write-Host "以 Windows 服务方式安装（开机自启）..."
        & $cfPath service install $token
    }
    Write-Host "✓ 完成。查看：Get-Service Cloudflared ；日志：事件查看器 (eventvwr)" -ForegroundColor Green
} else {
    Write-Host "（非管理员，前台运行；要常驻请用管理员 PowerShell 重跑本脚本）" -ForegroundColor Yellow
    & $cfPath tunnel --no-autoupdate run --token $token
}
