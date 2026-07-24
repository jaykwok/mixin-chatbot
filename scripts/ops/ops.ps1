# mixin-chatbot ops tool (Windows Server).
# One-stop: doctor / restart / stop / start / logs / uninstall.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 <command>
#   commands: doctor, restart, stop, start, logs, uninstall   (no arg -> menu)
#
# restart/stop/start/uninstall may need admin (scheduled task + Cloudflared service control).
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
$Command  = "$args"

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "[x] $m" -ForegroundColor Red }
function IsAdmin  { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
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

$portNumber = 0
if (-not [int]::TryParse($Port, [ref]$portNumber) -or $portNumber -lt 1 -or $portNumber -gt 65535) {
    throw "Invalid bot port in BOT_PORT/data/bot-port: $Port"
}
$Port = "$portNumber"
if ($DeployMode -notin @("direct", "cloudflare")) {
    throw "Invalid deployment mode in data/deploy-mode: $DeployMode"
}
if ($Domain -and -not (Test-Hostname $Domain)) {
    throw "Invalid hostname in BOT_DOMAIN/data/bot-domain: $Domain"
}

# bot bun.exe processes running src/server/index.ts
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
    if (-not $t) { Err "scheduled task '$TaskName' not found; run scripts\deploy\deploy.ps1 first"; return $false }
    Start-ScheduledTask -TaskName $TaskName | Out-Null
    return $true
}

function Test-Local {
    try { return (Invoke-WebRequest -Uri "http://localhost:$Port/favicon.svg" -UseBasicParsing -TimeoutSec 2).StatusCode }
    catch { return $null }
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
    # Prefer curl.exe for consistent TLS behavior, with an IWR fallback on older hosts.
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($curl) {
        $code = & $curl.Source --ssl-no-revoke -m 10 -s -o NUL -w "%{http_code}" "https://$Domain/favicon.svg" 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return "$code".Trim()
    }
    try {
        return "" + (Invoke-WebRequest -Uri "https://$Domain/favicon.svg" -UseBasicParsing -TimeoutSec 10).StatusCode
    } catch {
        return $null
    }
}

function Show-Doctor {
    Step "mixin-chatbot health check (mode=$DeployMode, port=$Port)"
    $rows = @()

    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $rows += [pscustomobject]@{ Name = "scheduled task";        OK = ($null -ne $t); Detail = $(if ($t) { $t.State } else { "missing" }) }

    $listen = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    $owner  = if ($listen.Count -gt 0) { "pid " + $listen[0].OwningProcess } else { "no" }
    $rows  += [pscustomobject]@{ Name = "bot listening :$Port"; OK = ($listen.Count -gt 0); Detail = $owner }

    $lc = Test-Local
    $rows += [pscustomobject]@{ Name = "local bot health";      OK = ($lc -eq 200); Detail = $(if ($lc) { "HTTP $lc" } else { "no response" }) }

    if ($DeployMode -eq "cloudflare") {
        $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
        $rows += [pscustomobject]@{ Name = "cloudflared service"; OK = ($null -ne $svc -and $svc.Status -eq "Running"); Detail = $(if ($svc) { $svc.Status } else { "not installed" }) }

        if ($Domain) {
            $pc = Test-Public
            $rows += [pscustomobject]@{ Name = "public CF->tunnel->bot"; OK = ($pc -eq 200); Detail = $(if ($pc) { "HTTP $pc" } else { "fail (tunnel/bot down?)" }) }
        } else {
            Warn "BOT_DOMAIN/data/bot-domain is not set; skipping public health check"
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
    $rows += [pscustomobject]@{ Name = "data/models.json"; OK = $modelsOk; Detail = $(if ($modelsOk) { "valid" } else { "MISSING/INVALID" }) }

    $ws = Join-Path $Project "data\webhook-secret"
    $secretOk = (Test-Path $ws) -and ((Get-Content $ws -Raw).Trim() -match "^[0-9a-fA-F]{32,64}$")
    $rows += [pscustomobject]@{ Name = "data/webhook-secret"; OK = $secretOk; Detail = $(if ($secretOk) { "valid" } else { "MISSING/INVALID (service refuses to start)" }) }

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
        if ($DeployMode -eq "cloudflare") {
            Warn "hints: public 530/1033 -> tunnel down; public 502 -> tunnel up but bot down;"
        }
        Warn "       local fail -> bot down; secret MISSING -> re-run scripts\deploy\deploy.ps1."
        return $false
    } else {
        Done "all checks passed"
        return $true
    }
}

function Restart-Bot {
    Step "restarting bot..."
    Stop-Bot
    Start-Sleep -Seconds 1
    if (-not (Start-Bot)) { return $false }
    $lc = Wait-Local
    if ($lc -eq 200) { Done "bot back up (HTTP 200 on :$Port)"; return $true }
    Warn "bot not responding yet (HTTP $lc); check 'scripts\ops\ops.ps1 logs'."
    return $false
}

function Show-Logs {
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
    $launcher = Join-Path $Project "data\runtime\bot-launcher.ps1"
    if (Test-Path $launcher) { Remove-Item $launcher -Force; Done "launcher removed" }

    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        $a = Read-Host "Also STOP + UNINSTALL the Cloudflared tunnel service? [y/N]"
        if ($a -match "^[yY]$") {
            if (IsAdmin) {
                Stop-Service Cloudflared -ErrorAction SilentlyContinue
                $cf = Get-Command cloudflared -CommandType Application -ErrorAction SilentlyContinue
                $localCf = Join-Path $Project "cloudflared.exe"
                $cfPath = if ($cf) { $cf.Source } elseif (Test-Path -LiteralPath $localCf) { $localCf } else { $null }
                if ($cfPath) {
                    & $cfPath service uninstall
                    if ($LASTEXITCODE -eq 0) { Done "cloudflared service uninstalled" }
                    else { Warn "cloudflared service uninstall returned $LASTEXITCODE" }
                } else { Warn "cloudflared executable not found; service was stopped but not uninstalled" }
            } else { Warn "need admin to uninstall cloudflared service" }
        }
    }

    $d = Read-Host "Delete data/ (models.json, webhook-secret, default group data) and logs/? [y/N]"
    if ($d -match "^[yY]$") {
        Remove-Item (Join-Path $Project "data") -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $Project "logs") -Recurse -Force -ErrorAction SilentlyContinue
        Done "data/ and logs/ removed"
    } else {
        Done "data/ and logs/ kept (config + default group data preserved)"
    }
    Done "uninstall complete."
}

switch ($Command) {
    "doctor"    { if (-not (Show-Doctor)) { exit 1 } }
    "status"    { if (-not (Show-Doctor)) { exit 1 } }
    "restart"   { if (-not (Restart-Bot)) { exit 1 } }
    "stop"      { Step "stopping bot..."; Stop-Bot; Done "bot stopped" }
    "start"     {
        if (-not (Start-Bot)) { exit 1 }
        $lc = Wait-Local
        if ($lc -eq 200) { Done "bot started (HTTP 200 on :$Port)" }
        else { Warn "bot did not become healthy (HTTP $lc); check 'scripts\ops\ops.ps1 logs'."; exit 1 }
    }
    "logs"      {
        if (-not (Test-Path $LogPath)) { Warn "no log file at $LogPath (bot may never have started)"; exit 1 }
        Show-Logs
    }
    "uninstall" { Uninstall-Bot }
    default {
        Write-Host "mixin-chatbot ops tool" -ForegroundColor Cyan
        Write-Host "usage: powershell -ExecutionPolicy Bypass -File scripts\ops\ops.ps1 <command>"
        Write-Host ""
        Write-Host "  doctor     health check: task, :$Port, config; Cloudflare checks only in tunnel mode"
        Write-Host "  restart    stop + start the bot"
        Write-Host "  stop       stop the bot (task + bun)"
        Write-Host "  start      start the bot (scheduled task)"
        Write-Host "  logs       tail logs\mixin-chatbot.log (-Wait)"
        Write-Host "  uninstall  remove task/processes (+optional cloudflared service, data/, logs/)"
    }
}
