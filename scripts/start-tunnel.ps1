# Cloud PC (Windows Server) connector: install cloudflared and run it as a Windows service.
#   im-bot.jaykwok.net  <==>  localhost:1011
#
# Prereqs:
#   1) Bot running on localhost:1011 (deploy.ps1, Cloudflare mode)
#   2) Tunnel token. Sources, in priority order:
#        arg:    .\start-tunnel.ps1 <token-file>     # path, relative or absolute
#        env:    $env:TUNNEL_TOKEN_FILE='<path>'      # path
#        env:    $env:TUNNEL_TOKEN='<raw-token>'      # raw value
#        default:data\tunnel-token                    # raw token OR .env form
#      The token file may be the raw token, OR a copied .env file
#      (e.g. server's .cpa-bot-tunnel-token.env) containing TUNNEL_TOKEN=<value>.
#
# Run in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\start-tunnel.ps1 [token-file]
$ErrorActionPreference = "Stop"

$BotPort = if ($env:BOT_PORT) { $env:BOT_PORT } else { "1011" }

# ---- 1. token ----
function Read-TokenFile($path) {
    $abs = if ([System.IO.Path]::IsPathRooted($path)) { $path } else { Join-Path (Get-Location).Path $path }
    if (-not (Test-Path $abs)) { return $null }
    $content = Get-Content $abs -Raw -ErrorAction SilentlyContinue
    if ($null -eq $content) { return $null }
    $m = [regex]::Match($content, '(?m)^[ \t]*TUNNEL_TOKEN[ \t]*=(.+?)[ \t\r]*$')
    if ($m.Success) {
        $val = $m.Groups[1].Value.Trim().Trim('"').Trim("'")
        return @{ token = $val; from = $abs }
    }
    return @{ token = $content; from = $abs }
}

$token = $env:TUNNEL_TOKEN
$source = "env:TUNNEL_TOKEN"
if (-not $token) {
    if ($args.Count -ge 1 -and $args[0]) { $file = $args[0] }
    elseif ($env:TUNNEL_TOKEN_FILE) { $file = $env:TUNNEL_TOKEN_FILE }
    else { $file = "data\tunnel-token" }
    $r = Read-TokenFile $file
    if ($null -eq $r) {
        Write-Host "ERROR: tunnel token file not found: $file" -ForegroundColor Red
        Write-Host "  Usage (priority order):" -ForegroundColor Red
        Write-Host "    .\start-tunnel.ps1 <token-file>          # relative or absolute path" -ForegroundColor Red
        Write-Host "    `$env:TUNNEL_TOKEN_FILE='<path>'           # or specify the file" -ForegroundColor Red
        Write-Host "    `$env:TUNNEL_TOKEN='<raw-token>'           # or give the value directly" -ForegroundColor Red
        Write-Host "    default: data\tunnel-token                 # raw value or .env form" -ForegroundColor Red
        Write-Host "  (token copied from server /root/.cpa-bot-tunnel-token.env; you may use that .env file directly)" -ForegroundColor Red
        exit 1
    }
    $token = $r.token
    $source = $r.from
}
# cleanup: keep only base64 chars (strips whitespace/quotes/BOM/CRLF)
$token = $token -replace '[^A-Za-z0-9+/=_-]', ''
if (-not $token) {
    Write-Host "ERROR: tunnel token is empty after cleanup." -ForegroundColor Red
    exit 1
}
Write-Host "[*] token from: $source" -ForegroundColor Cyan

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
    Write-Host "WARN: no response on :$BotPort - start the bot first via deploy.ps1 (Cloudflare mode)" -ForegroundColor Yellow
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
