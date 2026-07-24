# mixin-chatbot - Windows Server deploy (native Bun, NO Docker).
# Agent's bash tool needs bash.exe -> install "Git for Windows" (also gives `git` to clone).
# Runtime: Bun (https://bun.sh).
# Persistence: Windows Scheduled Task (auto-start at logon, restart on failure).
#
# Run in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1
$ErrorActionPreference = "Stop"
$Project  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Project
$Entry    = Join-Path $Project "src\server\index.ts"
$TaskName = "mixin-chatbot"

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
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

# ---- 1. prerequisites ----
Step "Checking prerequisites..."
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if (-not $gitCommand) {
    Write-Host "MISSING: git. Install Git for Windows (also provides bash.exe for the agent bash tool):" -ForegroundColor Red
    Write-Host "  https://git-scm.com/download/win"
    exit 1
}
$gitRoot = Split-Path (Split-Path $gitCommand.Source -Parent) -Parent
$BashPath = @(
    (Join-Path $gitRoot "bin\bash.exe"),
    (Join-Path $gitRoot "usr\bin\bash.exe")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $BashPath) {
    # Never accept Windows' WSL launcher (C:\Windows\System32\bash.exe) as the
    # agent shell. A non-Git bash is only accepted after a GNU Bash probe.
    $bashCommand = Get-Command bash -CommandType Application -ErrorAction SilentlyContinue
    if ($bashCommand -and $bashCommand.Source -notmatch '(?i)(\\Windows\\System32\\bash\.exe$|\\WindowsApps\\bash\.exe$)') {
        $BashPath = $bashCommand.Source
    }
}
if (-not $BashPath) {
    Write-Host "MISSING: bash.exe. Install Git for Windows with Git Bash enabled; the agent bash tool requires it." -ForegroundColor Red
    exit 1
}
$bashVersion = & $BashPath --version 2>$null | Select-Object -First 1
if ($LASTEXITCODE -ne 0 -or $bashVersion -notmatch "GNU bash") {
    Write-Host "INVALID: $BashPath is not a working GNU bash.exe." -ForegroundColor Red
    exit 1
}
$BashDir = Split-Path $BashPath -Parent
Done "git and GNU bash present ($BashPath)"
$bunCommand = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
if (-not $bunCommand) {
    Write-Host "MISSING: bun. Install one of:" -ForegroundColor Red
    Write-Host "  powershell -c ""irm bun.sh/install.ps1 | iex"""
    Write-Host "  winget install Oven-sh.Bun"
    exit 1
}
$bunPath = $bunCommand.Source
$bunVersion = & $bunPath --version
if ($LASTEXITCODE -ne 0) { Write-Host "bun --version failed" -ForegroundColor Red; exit 1 }
Done "bun $bunVersion"

# ---- 2. dependencies ----
Step "Installing dependencies (bun install --frozen-lockfile)..."
& $bunPath install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { Write-Host "bun install failed" -ForegroundColor Red; exit 1 }

# ---- 3. AI config (models.json) ----
New-Item -ItemType Directory -Force -Path "data", "data\runtime", "logs" | Out-Null
if (-not (Test-Path "data/models.json")) {
    Step "First-time AI config (provider/key/model)..."
    & $bunPath run configure
    if ($LASTEXITCODE -ne 0) { Write-Host "AI configuration failed" -ForegroundColor Red; exit 1 }
    if (-not (Test-Path "data/models.json")) { Write-Host "models.json not generated; abort" -ForegroundColor Red; exit 1 }
} else {
    Done "data/models.json exists"
    $ans = Read-Host "Reconfigure AI (provider/key/model)? [y/N]"
    if ($ans -match "^[yY]$") {
        & $bunPath run configure
        if ($LASTEXITCODE -ne 0) { Write-Host "AI configuration failed" -ForegroundColor Red; exit 1 }
    }
}

# ---- 4. webhook secret ----
$showSecret = $false
if (-not (Test-Path "data/webhook-secret")) {
    Step "Generating webhook secret..."
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    Set-Content -Path "data\webhook-secret" -Value $secret -NoNewline -Encoding ASCII
    $showSecret = $true
    Done "webhook secret generated"
} else {
    $secret = (Get-Content "data\webhook-secret" -Raw).Trim()
    if ($secret -notmatch "^[0-9a-fA-F]{32,64}$") {
        Write-Host "data\webhook-secret is invalid (expected 32-64 hexadecimal characters)." -ForegroundColor Red
        Write-Host "Delete it and re-run scripts\deploy\deploy.ps1 to generate a new secret." -ForegroundColor Red
        exit 1
    }
    Done "existing webhook-secret reused"
}

$domainFile = Join-Path $Project "data\bot-domain"
$persistDomain = $false
if (-not [string]::IsNullOrWhiteSpace($env:BOT_DOMAIN)) {
    $publicDomain = $env:BOT_DOMAIN.Trim()
    $persistDomain = $true
} elseif (Test-Path -LiteralPath $domainFile) {
    $publicDomain = (Get-Content -LiteralPath $domainFile -Raw).Trim()
} else {
    $publicDomain = ""
}
if ($publicDomain -and -not (Test-Hostname $publicDomain)) {
    Write-Host "BOT_DOMAIN/data\bot-domain must be a hostname without scheme, port, or path: $publicDomain" -ForegroundColor Red
    exit 1
}

# ---- 4b. Pi group data root (<group>/workspace + <group>/<phone>/{tmp,sessions}) ----
Step "Pi group data root"
$agentRootDefault = if ([string]::IsNullOrWhiteSpace($env:AGENT_DATA_ROOT)) { "data" } else { $env:AGENT_DATA_ROOT.Trim() }
Write-Host "  Default 'data' = .\data inside the repo; AGENT_DATA_ROOT overrides the prompt default."
Write-Host "  Pick another root folder if needed (relative to repo, or absolute)."
Write-Host "  Each group gets <folder>\<group>\workspace; each caller gets <group>\<phone>\tmp and sessions."
$wdIn = Read-Host "Group data root [default: $agentRootDefault]"
$AgentDataRoot = if ($wdIn) { $wdIn.Trim() } else { $agentRootDefault }
if (Test-Path -LiteralPath $AgentDataRoot) {
    if (-not (Test-Path -LiteralPath $AgentDataRoot -PathType Container)) {
        Write-Host "Group data root is not a directory: $AgentDataRoot" -ForegroundColor Red
        exit 1
    }
} else {
    New-Item -ItemType Directory -Force -Path $AgentDataRoot | Out-Null
}
$AgentDataRoot = (Resolve-Path -LiteralPath $AgentDataRoot).Path
$volumeRoot = [System.IO.Path]::GetPathRoot($AgentDataRoot).TrimEnd('\')
if ($AgentDataRoot.TrimEnd('\') -eq $volumeRoot -or $AgentDataRoot.TrimEnd('\') -eq $Project.TrimEnd('\')) {
    Write-Host "Group data root cannot be a filesystem root or the project root: $AgentDataRoot" -ForegroundColor Red
    exit 1
}
Done "group data root: $AgentDataRoot"

# ---- 4c. listen port (explicit env > persisted value > 1011) ----
$portFile = Join-Path $Project "data\bot-port"
$portDefault = if ($env:BOT_PORT) {
    $env:BOT_PORT
} elseif (Test-Path $portFile) {
    (Get-Content $portFile -Raw).Trim()
} else {
    "1011"
}
while ($true) {
    $portIn = Read-Host "Bot listen port [default: $portDefault]"
    $Port = if ($portIn) { $portIn.Trim() } else { $portDefault }
    $portNumber = 0
    if ([int]::TryParse($Port, [ref]$portNumber) -and $portNumber -ge 1 -and $portNumber -le 65535) {
        $Port = "$portNumber"
        break
    }
    Warn "port must be an integer from 1 to 65535"
}
Done "listen port: $Port"

# ---- 5. deploy mode ----
Step "Deploy mode:"
Write-Host "  1) Direct      - server has a public IP; open port $Port in Windows Firewall"
Write-Host "  2) Cloudflare  - cloud PC; cloudflared tunnel started automatically after deploy"
$modeIn = Read-Host "Choose 1 or 2 [default 1]"
$mode = if ($modeIn -eq "2") { "cloudflare" } else { "direct" }
$BotHost = if ($mode -eq "cloudflare") { "127.0.0.1" } else { "0.0.0.0" }
Done "mode: $mode"
if ($mode -eq "cloudflare") {
    Warn "set the Cloudflare Tunnel Published application service URL to http://localhost:$Port"
}

# Keep the direct-mode firewall rule aligned with the selected port. Cloudflare mode
# listens on loopback only and removes this script's obsolete direct-mode rules.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$platformIp = if ($env:PLATFORM_IP) { $env:PLATFORM_IP } else { "223.244.14.237" }
if ($mode -eq "direct") {
    $parsedIp = $null
    if (-not [System.Net.IPAddress]::TryParse($platformIp, [ref]$parsedIp)) {
        Write-Host "PLATFORM_IP is invalid: $platformIp" -ForegroundColor Red
        exit 1
    }
}
if ($isAdmin) {
    if ($mode -eq "direct") {
        # Create the new allow rule before removing stale rules, so a failed update
        # does not take the currently deployed webhook offline.
        $currentFirewallRule = New-NetFirewallRule -DisplayName "mixin-chatbot TCP $Port" -Group "mixin-chatbot" `
            -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
            -RemoteAddress $platformIp
        Get-NetFirewallRule -Group "mixin-chatbot" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne $currentFirewallRule.Name } |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
        Done "Windows Firewall allows TCP $Port only from $platformIp"
    } else {
        Get-NetFirewallRule -Group "mixin-chatbot" -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule -ErrorAction SilentlyContinue
    }
} elseif ($mode -eq "direct") {
    Warn "not admin: Windows Firewall was not changed; allow TCP $Port only from the platform IP before using direct mode"
}

# ---- 6. stop stale bot (avoid port conflict on re-deploy) ----
$escapedEntry = [WildcardPattern]::Escape($Entry)
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$escapedEntry*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ---- 7. launcher (bakes deployment settings into the command; scheduled tasks do not re-read this shell) + run ----

# single-quote-escape for embedding paths into the generated launcher
function Sq($s) { return "'" + ($s -replace "'", "''") + "'" }
$launcher = Join-Path $Project "data\runtime\bot-launcher.ps1"
$launcherBody = @"
`$ErrorActionPreference = 'Stop'
`$env:AGENT_DATA_ROOT = $(Sq $AgentDataRoot)
`$env:BOT_PORT = $(Sq $Port)
`$env:BOT_HOST = $(Sq $BotHost)
`$env:PATH = $(Sq ($BashDir + ";")) + `$env:PATH
Set-Location $(Sq $Project)
& $(Sq $bunPath) run $(Sq $Entry)
exit `$LASTEXITCODE
"@
Set-Content -Path $launcher -Value $launcherBody -Encoding UTF8

$publicDomainDisplay = if ($publicDomain) { $publicDomain } else { "<your-domain>" }
$url = if ($mode -eq "cloudflare") {
    "https://$publicDomainDisplay/webhook/<SECRET>"
} else {
    "http://<server-ip>:$Port/webhook/<SECRET>"
}
Write-Host ""
Write-Host "==== Webhook URL (fill into IM platform) ====" -ForegroundColor Cyan
if ($showSecret) {
    Write-Host ("  " + ($url -replace "<SECRET>", $secret)) -ForegroundColor White
    Warn "secret shown once; rotate: delete data\webhook-secret and re-run."
} else {
    Write-Host "  $url" -ForegroundColor White
    Warn "secret unchanged; view: Get-Content data\webhook-secret"
}

if ($isAdmin) {
    Step "Installing as Windows Scheduled Task '$TaskName' (start at user logon, restart on failure)..."
    $fileArg = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
    $action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $fileArg -WorkingDirectory $Project
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    # RunLevel Limited：bot 只需监听所选端口 + 写 data/logs，无需管理员；
    # 降权可缩小 agent bash 工具（非 cwd 沙箱）的爆炸半径。
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Step "Waiting for the bot health endpoint..."
    $healthy = $false
    for ($attempt = 1; $attempt -le 18; $attempt++) {
        try {
            $status = (Invoke-WebRequest -Uri "http://localhost:$Port/favicon.svg" -UseBasicParsing -TimeoutSec 2).StatusCode
            if ($status -eq 200) { $healthy = $true; break }
        } catch {}
        if ($attempt -lt 18) { Start-Sleep -Seconds 3 }
    }
    if (-not $healthy) {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        $lastResult = if ($taskInfo) { $taskInfo.LastTaskResult } else { "unknown" }
        Write-Host "Bot did not become healthy within 90 seconds (task result: $lastResult). Check logs\mixin-chatbot.log." -ForegroundColor Red
        exit 1
    }
    Set-Content -LiteralPath $portFile -Value $Port -NoNewline -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $Project "data\deploy-mode") -Value $mode -NoNewline -Encoding ASCII
    if ($persistDomain) {
        Set-Content -LiteralPath $domainFile -Value $publicDomain -NoNewline -Encoding ASCII
    }
    Done "bot healthy (group data root=$AgentDataRoot). Manage: Get-ScheduledTask $TaskName | Stop-ScheduledTask ; logs: logs\mixin-chatbot.log"
    Warn "task runs at logon as $env:USERNAME (needs the user logged on; enable auto-logon for always-on)."
} else {
    Warn "non-admin: running in foreground (Ctrl+C to stop). Re-run as admin to install as a service."
    if ($mode -eq "cloudflare") {
        Warn "start scripts\tunnel\start-tunnel.ps1 in a second PowerShell window; this foreground bot process occupies the current window."
    }
    Set-Content -LiteralPath $portFile -Value $Port -NoNewline -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $Project "data\deploy-mode") -Value $mode -NoNewline -Encoding ASCII
    if ($persistDomain) {
        Set-Content -LiteralPath $domainFile -Value $publicDomain -NoNewline -Encoding ASCII
    }
    $env:AGENT_DATA_ROOT = $AgentDataRoot
    $env:BOT_PORT = $Port
    $env:BOT_HOST = $BotHost
    Set-Location $Project
    & $bunPath run $Entry
    exit $LASTEXITCODE
}

# ---- 7b. Cloudflare mode: ensure the tunnel is up (service running, or install via tunnel/start-tunnel.ps1) ----
if ($mode -eq "cloudflare") {
    Step "Cloudflare mode: ensuring cloudflared tunnel is up..."
    $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.Status -ne "Running") {
            try { Start-Service "Cloudflared"; Done "Cloudflared service started (was $($svc.Status))." }
            catch { Warn "Start-Service failed: $($_.Exception.Message). Check Event Viewer (eventvwr)." }
        } else {
            Done "Cloudflared service already running."
        }
    } else {
        Warn "Cloudflared service not installed. Installing via scripts\tunnel\start-tunnel.ps1..."
        $tokIn = Read-Host "Tunnel token file [default: data\tunnel-token]"
        $tokArg = if ($tokIn) { $tokIn.Trim() } else { "data\tunnel-token" }
        $stPath = Join-Path $Project "scripts\tunnel\start-tunnel.ps1"
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stPath $tokArg
        if ($LASTEXITCODE -ne 0) { Warn "start-tunnel.ps1 exited $LASTEXITCODE - tunnel may not be up; run it manually as admin." }
    }
}
