# Cloud PC (Windows Server) connector: install cloudflared and run it as a Windows service.
#   Cloudflare Tunnel  <==>  localhost:BOT_PORT (default 1011)
#
# Prereqs:
#   1) Bot running on localhost:BOT_PORT (scripts\deploy\deploy.ps1, Cloudflare mode)
#   2) Tunnel token. Sources, in priority order:
#        arg:    .\scripts\tunnel\start-tunnel.ps1 <token-file>  # path, relative or absolute
#        env:    $env:TUNNEL_TOKEN_FILE='<path>'      # path
#        env:    $env:TUNNEL_TOKEN='<raw-token>'      # raw value
#        default:data\tunnel-token                    # raw token OR .env form
#      The token file may be the raw token, OR a copied .env file
#      Any .env file containing TUNNEL_TOKEN=<value> can be used directly.
#
# Run in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\tunnel\start-tunnel.ps1 [token-file]
$ErrorActionPreference = "Stop"
$Project = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Project

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
    Write-Host "ERROR: BOT_PORT must be an integer from 1 to 65535." -ForegroundColor Red
    exit 1
}
$BotPort = "$portNumber"

function Test-LocalBot {
    try {
        Invoke-WebRequest -Uri "http://localhost:$BotPort/favicon.svg" -UseBasicParsing -TimeoutSec 3 | Out-Null
        Write-Host "OK: bot online on :$BotPort" -ForegroundColor Green
    } catch {
        Write-Host "WARN: no response on :$BotPort - start the bot first via scripts\deploy\deploy.ps1 (Cloudflare mode)" -ForegroundColor Yellow
    }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$existingService = if ($isAdmin) { Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue } else { $null }
if ($existingService -and $env:CLOUDFLARED_REINSTALL -ne "1") {
    Test-LocalBot
    Write-Host "Service 'Cloudflared' exists (status: $($existingService.Status))" -ForegroundColor Yellow
    if ($existingService.Status -ne "Running") { Start-Service "Cloudflared" }
    Write-Host "Existing service keeps its installed token. Set CLOUDFLARED_REINSTALL=1 to replace it." -ForegroundColor Yellow
    Write-Host "Done. Check: Get-Service Cloudflared ; logs: Event Viewer (eventvwr)" -ForegroundColor Green
    exit 0
}

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
        Write-Host "ERROR: tunnel token file not found: $file" -ForegroundColor Red
        Write-Host "  Usage (priority order):" -ForegroundColor Red
        Write-Host "    .\scripts\tunnel\start-tunnel.ps1 <token-file>  # relative or absolute path" -ForegroundColor Red
        Write-Host "    `$env:TUNNEL_TOKEN_FILE='<path>'           # or specify the file" -ForegroundColor Red
        Write-Host "    `$env:TUNNEL_TOKEN='<raw-token>'           # or give the value directly" -ForegroundColor Red
        Write-Host "    default: data\tunnel-token                 # raw value or .env form" -ForegroundColor Red
        Write-Host "  (.env files containing TUNNEL_TOKEN=<value> can be used directly)" -ForegroundColor Red
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
$cf = Get-Command cloudflared -CommandType Application -ErrorAction SilentlyContinue
if ($cf) { $cfPath = $cf.Source }
else {
    $exe = Join-Path $PWD "cloudflared.exe"
    if (-not (Test-Path $exe)) {
        Write-Host "Downloading cloudflared.exe ..."
        $asset = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
            "X64"   { "cloudflared-windows-amd64.exe" }
            "Arm64" { "cloudflared-windows-arm64.exe" }
            default { throw "Unsupported Windows architecture: $($_)" }
        }
        $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
        $download = "$exe.download-$PID"
        try {
            Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
            & $download --version | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "downloaded cloudflared failed its version probe" }
            Move-Item -LiteralPath $download -Destination $exe
        } finally {
            Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
        }
    }
    $cfPath = $exe
}
& $cfPath --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "cloudflared executable is not usable: $cfPath" }

# ---- 3. probe local bot ----
Test-LocalBot

# ---- 4. run tunnel ----
Write-Host "cloudflared connector: set the dashboard Published application service URL to http://localhost:$BotPort"
if ($isAdmin) {
    $svc = $existingService
    if ($svc) {
        Write-Host "Service 'Cloudflared' exists (status: $($svc.Status))" -ForegroundColor Yellow
        if ($env:CLOUDFLARED_REINSTALL -eq "1") {
            Stop-Service "Cloudflared" -ErrorAction SilentlyContinue
            & $cfPath service uninstall
            if ($LASTEXITCODE -ne 0) { throw "cloudflared service uninstall failed" }
            & $cfPath service install $token
            if ($LASTEXITCODE -ne 0) { throw "cloudflared service install failed" }
            Write-Host "Cloudflared service reinstalled with the supplied token." -ForegroundColor Green
        } else {
            if ($svc.Status -ne "Running") { Start-Service "Cloudflared" }
            Write-Host "Existing service keeps its installed token. Set CLOUDFLARED_REINSTALL=1 to replace it." -ForegroundColor Yellow
        }
    } else {
        Write-Host "Installing as Windows service (autostart)..."
        & $cfPath service install $token
        if ($LASTEXITCODE -ne 0) { throw "cloudflared service install failed" }
    }
    Write-Host "Done. Check: Get-Service Cloudflared ; logs: Event Viewer (eventvwr)" -ForegroundColor Green
} else {
    Write-Host "(non-admin: running in foreground; re-run as admin to install as service)" -ForegroundColor Yellow
    & $cfPath tunnel --no-autoupdate run --token $token
    exit $LASTEXITCODE
}
