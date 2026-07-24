# mixin-chatbot - Windows Server deploy (native Bun, NO Docker).
# Agent's bash tool needs bash.exe -> install "Git for Windows" (also gives `git` to clone).
# Runtime: Bun (https://bun.sh).
# Persistence: Windows Scheduled Task (auto-start at logon, restart on failure).
#
# Run in an ADMIN PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
$ErrorActionPreference = "Stop"
$Port     = if ($env:BOT_PORT) { $env:BOT_PORT } else { "1011" }
$Project  = (Get-Location).Path
$Entry    = Join-Path $Project "src\server\index.ts"
$TaskName = "mixin-chatbot"

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }

# ---- 1. prerequisites ----
Step "Checking prerequisites..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "MISSING: git. Install Git for Windows (also provides bash.exe for the agent bash tool):" -ForegroundColor Red
    Write-Host "  https://git-scm.com/download/win"
    exit 1
}
Done "git present (bash.exe available -> agent bash tool works)"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "MISSING: bun. Install one of:" -ForegroundColor Red
    Write-Host "  powershell -c ""irm bun.sh/install.ps1 | iex"""
    Write-Host "  winget install Oven-sh.Bun"
    exit 1
}
Done ("bun " + (bun --version))

# ---- 2. dependencies ----
Step "Installing dependencies (bun install)..."
bun install
if ($LASTEXITCODE -ne 0) { Write-Host "bun install failed" -ForegroundColor Red; exit 1 }

# ---- 3. AI config (models.json) ----
New-Item -ItemType Directory -Force -Path "data", "logs" | Out-Null
if (-not (Test-Path "data/models.json")) {
    Step "First-time AI config (provider/key/model)..."
    bun run scripts/configure.ts
    if (-not (Test-Path "data/models.json")) { Write-Host "models.json not generated; abort" -ForegroundColor Red; exit 1 }
} else {
    Done "data/models.json exists"
    $ans = Read-Host "Reconfigure AI (provider/key/model)? [y/N]"
    if ($ans -match "^[yY]$") { bun run scripts/configure.ts }
}

# ---- 4. webhook secret ----
$showSecret = $false
if (-not (Test-Path "data/webhook-secret")) {
    Step "Generating webhook secret..."
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    Set-Content -Path "data\webhook-secret" -Value $secret -NoNewline
    $showSecret = $true
    Done "webhook secret generated"
} else {
    $secret = (Get-Content "data\webhook-secret" -Raw).Trim()
    Done "existing webhook-secret reused"
}

# ---- 4b. Pi agent working directory (where read/bash/edit/write operate) ----
Step "Pi agent working directory"
Write-Host "  Default 'data' = .\data inside the repo (isolated scratch + tool workspace)."
Write-Host "  Pick another folder to let the agent work elsewhere (relative to repo, or absolute)."
Write-Host "  Sessions stay in data\sessions regardless of this choice."
$wdIn = Read-Host "Agent working dir [default: data]"
$AgentCwd = if ($wdIn) { $wdIn.Trim() } else { "data" }
if (-not (Test-Path $AgentCwd)) { New-Item -ItemType Directory -Force -Path $AgentCwd | Out-Null }
Done "agent cwd: $AgentCwd"

# ---- 5. deploy mode ----
Step "Deploy mode:"
Write-Host "  1) Direct      - server has a public IP; open port $Port in Windows Firewall"
Write-Host "  2) Cloudflare  - cloud PC; run scripts/start-tunnel.ps1 after this"
$modeIn = Read-Host "Choose 1 or 2 [default 1]"
$mode = if ($modeIn -eq "2") { "cloudflare" } else { "direct" }
Done "mode: $mode"
if ($mode -eq "cloudflare") { Warn "next step: scripts/start-tunnel.ps1 (as admin) brings up the tunnel." }

# ---- 6. stop stale bot (avoid port conflict on re-deploy) ----
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*index.ts*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ---- 7. launcher (bakes AGENT_CWD into the launch cmd; scheduled tasks don't re-read User env) + run ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$bunPath = (Get-Command bun).Source

# single-quote-escape for embedding paths into the generated launcher
function Sq($s) { return "'" + ($s -replace "'", "''") + "'" }
$launcher = Join-Path $Project "scripts\.bot-launcher.ps1"
$launcherBody = @"
`$ErrorActionPreference = 'Stop'
`$env:AGENT_CWD = $(Sq $AgentCwd)
Set-Location $(Sq $Project)
& $(Sq $bunPath) run $(Sq $Entry)
"@
Set-Content -Path $launcher -Value $launcherBody -Encoding UTF8

if ($isAdmin) {
    Step "Installing as Windows Scheduled Task '$TaskName' (auto-start, restart on failure)..."
    $fileArg = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
    $action    = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $fileArg -WorkingDirectory $Project
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    $settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Done "bot started (agent cwd=$AgentCwd). Manage: Get-ScheduledTask $TaskName | Stop-ScheduledTask ; logs: logs\mixin-chatbot.log"
    Warn "task runs at startup/logon as $env:USERNAME (needs the user logged on; enable auto-logon for always-on)."
} else {
    Warn "non-admin: running in foreground (Ctrl+C to stop). Re-run as admin to install as a service."
    $env:AGENT_CWD = $AgentCwd
    Set-Location $Project
    & $bunPath run $Entry
}

# ---- 8. webhook URL ----
if ($mode -eq "cloudflare") { $url = "https://im-bot.jaykwok.net/webhook/<SECRET>" }
else { $url = "http://<server-ip>:$Port/webhook/<SECRET>" }
Write-Host ""
Write-Host "==== Webhook URL (fill into IM platform) ====" -ForegroundColor Cyan
if ($showSecret) {
    Write-Host ("  " + ($url -replace "<SECRET>", $secret)) -ForegroundColor White
    Warn "secret shown once; rotate: delete data\webhook-secret and re-run."
} else {
    Write-Host "  $url" -ForegroundColor White
    Warn "secret unchanged; view: Get-Content data\webhook-secret"
}
