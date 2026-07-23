# Cloud PC (Windows Server) connector: install cloudflared and run it as a Windows service.
#   im-bot.jaykwok.net  <==>  localhost:1011
#
# Prereqs:
#   1) Bot running on localhost:1011 (./deploy.sh, Cloudflare mode)
#   2) Tunnel token in data\tunnel-token (copied from server /root/.cpa-bot-tunnel-token.env)
#      or  $env:TUNNEL_TOKEN='<...>'
#
# Run in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1
$ErrorActionPreference = "Stop"

$BotPort   = if ($env:BOT_PORT) { $env:BOT_PORT } else { "1011" }
$TokenFile = "data\tunnel-token"

# ---- 1. token (normalize: keep only base64 chars, strips BOM/CRLF/junk) ----
$token = $env:TUNNEL_TOKEN
if (-not $token) {
    if (Test-Path $TokenFile) { $token = Get-Content $TokenFile -Raw }
    else {
        Write-Host "ERROR: tunnel token not found." -ForegroundColor Red
        Write-Host "  Put the TUNNEL_TOKEN (from server /root/.cpa-bot-tunnel-token.env) into $TokenFile,"
        Write-Host "  or:  `$env:TUNNEL_TOKEN='<...>'"
        exit 1
    }
}
$token = $token -replace '[^A-Za-z0-9+/=_-]', ''
if (-not $token) {
    Write-Host "ERROR: tunnel token is empty after cleanup." -ForegroundColor Red
    exit 1
}

# ---- 2. cloudflared.exe ----
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cf) { $cfPath = $cf.Source }
else {
    $exe = Join-Path $PWD "cloudflared.exe"
    if (-not (Test-Path $exe)) {
        Write-Host "Downloading cloudflared.exe ..."
        $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    }
    $cfPath = $exe
}

# ---- 3. probe local bot ----
try {
    Invoke-WebRequest -Uri "http://localhost:$BotPort/favicon.svg" -UseBasicParsing -TimeoutSec 3 | Out-Null
    Write-Host "OK: bot online on :$BotPort" -ForegroundColor Green
} catch {
    Write-Host "WARN: no response on :$BotPort - start the bot first via ./deploy.sh (Cloudflare mode)" -ForegroundColor Yellow
}

# ---- 4. run tunnel ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "cloudflared: im-bot.jaykwok.net  <==>  localhost:$BotPort"
if ($isAdmin) {
    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Host "Service 'Cloudflared' exists (status: $($svc.Status))" -ForegroundColor Yellow
        if ($svc.Status -ne "Running") { Start-Service "Cloudflared" }
    } else {
        Write-Host "Installing as Windows service (autostart)..."
        & $cfPath service install $token
    }
    Write-Host "Done. Check: Get-Service Cloudflared ; logs: Event Viewer (eventvwr)" -ForegroundColor Green
} else {
    Write-Host "(non-admin: running in foreground; re-run as admin to install as service)" -ForegroundColor Yellow
    & $cfPath tunnel --no-autoupdate run --token $token
}
