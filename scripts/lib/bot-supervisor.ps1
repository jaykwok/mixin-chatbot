# Nonzero exits restart a fresh process after the old group leases can expire.
function Invoke-BotSupervision {
    param(
        [Parameter(Mandatory = $true)][string]$BunPath,
        [Parameter(Mandatory = $true)][string]$Entry,
        [ValidateRange(0, 86400)][int]$RestartDelaySeconds = 60,
        [ValidateRange(0, 999)][int]$RestartLimit = 999
    )
    $previousPreference = $ErrorActionPreference
    # Security software (Huorong) checks each process creation in proportion to the creator's RWX reservation,
    # ~3 ms/MB; Bun's default 1 GB JIT region cost ~3 s per tool command. 128 MB leaves the bot ample JIT space.
    # An explicit value in the task's environment wins.
    if (-not $env:BUN_JSC_jitMemoryReservationSize) { $env:BUN_JSC_jitMemoryReservationSize = '134217728' }
    try {
        $ErrorActionPreference = 'Continue'
        for ($attempt = 0; ; $attempt++) {
            $global:LASTEXITCODE = 1
            try { & $BunPath run $Entry | Out-Host; $exitCode = $global:LASTEXITCODE }
            catch { Write-Warning $_.Exception.Message; $exitCode = 1 }
            if ($exitCode -eq 0 -or $attempt -ge $RestartLimit) { return [int]$exitCode }
            Write-Warning "Bot exited with code $exitCode; restarting in $RestartDelaySeconds seconds (retry $($attempt + 1)/$RestartLimit)."
            Start-Sleep -Seconds $RestartDelaySeconds
        }
    } finally { $ErrorActionPreference = $previousPreference }
}
