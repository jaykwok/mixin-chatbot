# Nonzero exits restart a fresh process after the old group leases can expire.
function Invoke-BotSupervision {
    param(
        [Parameter(Mandatory = $true)][string]$BunPath,
        [Parameter(Mandatory = $true)][string]$Entry,
        [ValidateRange(0, 86400)][int]$RestartDelaySeconds = 60,
        [ValidateRange(0, 999)][int]$RestartLimit = 999
    )
    $previousPreference = $ErrorActionPreference
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
