# mixin-chatbot ops tool (Windows Server).
# One-stop: doctor / restart / stop / start / logs / uninstall.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\ops.ps1 <command>
#   commands: doctor, restart, stop, start, logs, uninstall   (no arg -> menu)
#
# Run from the repo root. restart/stop/start/uninstall may need admin
# (scheduled task + Cloudflared service control).
$ErrorActionPreference = "Stop"

$Project  = (Get-Location).Path
$TaskName = "mixin-chatbot"
$Port     = if ($env:BOT_PORT) { $env:BOT_PORT } else { "1011" }
$Domain   = if ($env:BOT_DOMAIN) { $env:BOT_DOMAIN } else { "im-bot.jaykwok.net" }
$LogPath  = Join-Path $Project "logs\mixin-chatbot.log"
$Command  = "$args"

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[x] $m" -ForegroundColor Red }
function IsAdmin  { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

# bot bun.exe processes running src/server/index.ts
function Get-BotPids {
    Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*server\index.ts*" -or $_.CommandLine -like "*server/index.ts*" } |
        Select-Object -ExpandProperty ProcessId
}

function Stop-Bot {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { try { Stop-ScheduledTask -TaskName $TaskName } catch {} }
    foreach ($p in Get-BotPids) { try { Stop-Process -Id $p -Force } catch {} }
}

function Start-Bot {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { Err "scheduled task '$TaskName' not found; run deploy.ps1 first"; return $false }
    Start-ScheduledTask -TaskName $TaskName
    return $true
}

function Test-Local {
    try { return (Invoke-WebRequest -Uri "http://localhost:$Port/favicon.svg" -UseBasicParsing -TimeoutSec 6).StatusCode }
    catch { return $null }
}

function Test-Public {
    # curl.exe handles TLS cleanly (incl. --ssl-no-revoke); returns HTTP code or $null
    $code = & curl.exe --ssl-no-revoke -m 10 -s -o NUL -w "%{http_code}" "https://$Domain/favicon.svg" 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return "$code".Trim()
}

function Show-Doctor {
    Step "mixin-chatbot health check (domain=$Domain, port=$Port)"
    $rows = @()

    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $rows += [pscustomobject]@{ Name = "scheduled task";        OK = ($null -ne $t); Detail = $(if ($t) { $t.State } else { "missing" }) }

    $listen = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $owner  = if ($listen.Count -gt 0) { "pid " + $listen[0].OwningProcess } else { "no" }
    $rows  += [pscustomobject]@{ Name = "bot listening :$Port"; OK = ($listen.Count -gt 0); Detail = $owner }

    $lc = Test-Local
    $rows += [pscustomobject]@{ Name = "local bot health";      OK = ($lc -eq 200); Detail = $(if ($lc) { "HTTP $lc" } else { "no response" }) }

    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    $rows += [pscustomobject]@{ Name = "cloudflared service";   OK = ($null -ne $svc); Detail = $(if ($svc) { $svc.Status } else { "not installed" }) }

    $pc = Test-Public
    $rows += [pscustomobject]@{ Name = "public CF->tunnel->bot"; OK = ($pc -eq 200); Detail = $(if ($pc) { "HTTP $pc" } else { "fail (tunnel/bot down?)" }) }

    $mj = Join-Path $Project "data\models.json"
    $rows += [pscustomobject]@{ Name = "data/models.json";      OK = (Test-Path $mj); Detail = $(if (Test-Path $mj) { "present" } else { "MISSING" }) }

    $ws = Join-Path $Project "data\webhook-secret"
    $rows += [pscustomobject]@{ Name = "data/webhook-secret";   OK = (Test-Path $ws); Detail = $(if (Test-Path $ws) { "present" } else { "MISSING (open /webhook)" }) }

    foreach ($r in $rows) {
        $tag = $(if ($r.OK) { "[+]" } else { "[x]" })
        $color = $(if ($r.OK) { "Green" } else { "Red" })
        Write-Host ("{0} {1,-26} {2}" -f $tag, $r.Name, $r.Detail) -ForegroundColor $color
    }

    $pass = @($rows | Where-Object { $_.OK }).Count
    $fail = @($rows | Where-Object { -not $_.OK }).Count
    Write-Host ""
    Write-Host ("result: {0} pass, {1} fail" -f $pass, $fail) -ForegroundColor White
    if ($fail -gt 0) {
        Warn "hints: public 530/1033 -> tunnel down (Start-Service Cloudflared or run start-tunnel.ps1);"
        Warn "       public 502 -> tunnel up but bot down (ops.ps1 restart); local fail -> bot down; secret MISSING -> re-run deploy.ps1."
    } else {
        Done "all checks passed"
    }
}

function Restart-Bot {
    Step "restarting bot..."
    Stop-Bot
    Start-Sleep -Seconds 1
    if (-not (Start-Bot)) { return }
    Start-Sleep -Seconds 2
    $lc = Test-Local
    if ($lc -eq 200) { Done "bot back up (HTTP 200 on :$Port)" }
    else { Warn "bot not responding yet (HTTP $lc); check 'ops.ps1 logs'." }
}

function Show-Logs {
    if (-not (Test-Path $LogPath)) { Warn "no log file at $LogPath (bot may never have started)"; return }
    Step "tailing $LogPath  (Ctrl+C to exit)"
    Get-Content $LogPath -Tail 50 -Wait
}

function Uninstall-Bot {
    Step "uninstall mixin-chatbot"
    if (-not (IsAdmin)) { Warn "not admin; task/service removal may fail. Re-run as admin if so." }
    Stop-Bot
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; Done "scheduled task removed" }
    else { Warn "no scheduled task to remove" }
    $launcher = Join-Path $Project "scripts\.bot-launcher.ps1"
    if (Test-Path $launcher) { Remove-Item $launcher -Force; Done "launcher removed" }

    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        $a = Read-Host "Also STOP + UNINSTALL the Cloudflared tunnel service? [y/N]"
        if ($a -match "^[yY]$") {
            if (IsAdmin) {
                Stop-Service Cloudflared -ErrorAction SilentlyContinue
                $cf = Get-Command cloudflared -ErrorAction SilentlyContinue
                if ($cf) { & $cf.Source service uninstall } else { Warn "cloudflared not on PATH; stop manually: Stop-Service Cloudflared" }
                Done "cloudflared service uninstalled"
            } else { Warn "need admin to uninstall cloudflared service" }
        }
    }

    $d = Read-Host "Delete data/ (models.json, sessions, webhook-secret) and logs/? [y/N]"
    if ($d -match "^[yY]$") {
        Remove-Item (Join-Path $Project "data") -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $Project "logs") -Recurse -Force -ErrorAction SilentlyContinue
        Done "data/ and logs/ removed"
    } else {
        Done "data/ and logs/ kept (models.json + sessions preserved)"
    }
    Done "uninstall complete."
}

switch ($Command) {
    "doctor"    { Show-Doctor }
    "status"    { Show-Doctor }
    "restart"   { Restart-Bot }
    "stop"      { Step "stopping bot..."; Stop-Bot; Done "bot stopped" }
    "start"     { Start-Bot | Out-Null }
    "logs"      { Show-Logs }
    "uninstall" { Uninstall-Bot }
    default {
        Write-Host "mixin-chatbot ops tool" -ForegroundColor Cyan
        Write-Host "usage: powershell -ExecutionPolicy Bypass -File scripts\ops.ps1 <command>"
        Write-Host ""
        Write-Host "  doctor     health check: task, :$Port listen, local+public reachability, cloudflared, config files"
        Write-Host "  restart    stop + start the bot"
        Write-Host "  stop       stop the bot (task + bun)"
        Write-Host "  start      start the bot (scheduled task)"
        Write-Host "  logs       tail logs\mixin-chatbot.log (-Wait)"
        Write-Host "  uninstall  remove task/processes (+optional cloudflared service, data/, logs/)"
    }
}
