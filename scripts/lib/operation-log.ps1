function Protect-OperationMessage([string]$Message) {
    $text = $Message -replace '\x1b\[[0-?]*[ -/]*[@-~]', ''
    $text = $text -replace '(?i)(Bearer\s+)[^\s"'',;]+', '$1[redacted]'
    $text = $text -replace '(?i)((?:api[_-]?key|token|secret|password|authorization)["'']?\s*[:=]\s*["'']?)[^\s"'',;&}]+', '$1[redacted]'
    $text = $text -replace '(?i)(https?://)[^\s/@]+:[^\s/@]+@', '$1[redacted]@'
    $text = $text -replace '(?i)([?&](?:key|token|secret|password)=)[^\s&#"'']+', '$1[redacted]'
    $text = $text -replace '(?i)/webhook/[a-f\d]{64}\b', '/webhook/[redacted]'
    return ($text -replace '\bsk-[\w-]{12,}\b', '[redacted]')
}

function Write-OperationEvent([string]$Level, [string]$Message) {
    if (-not $env:BOT_OPERATION_LOG -or -not $env:BOT_OPERATION_PROJECT) { return }
    try {
        $path = Join-Path $env:BOT_OPERATION_PROJECT ('logs\operations\' + $env:BOT_OPERATION_LOG)
        $size = (Get-Item -LiteralPath $path).Length
        if ($size -ge 2MB) { return }
        if ($Level -eq 'output' -and $size -ge 1MB) {
            if ($script:OperationOutputLimited -eq $path) { return }
            $script:OperationOutputLimited = $path
            $Level = 'warn'
            $Message = 'Command output limit reached; subsequent stages and errors are still recorded.'
        }
        $text = Protect-OperationMessage $Message
        if ($text.Length -gt 16384) { $text = $text.Substring(0,16384) }
        $text = $text.Replace("`r", '\r').Replace("`n", '\n') -replace '[\x00-\x1f\x7f]', ' '
        $line = '{0} [{1}] {2} {3}: {4}' -f [DateTime]::UtcNow.ToString('o'),$PID,$Level,$env:BOT_OPERATION_STAGE,$text
        [IO.File]::AppendAllText($path, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    } catch { Write-Warning ('运维日志写入失败：' + (Protect-OperationMessage $_.Exception.Message)) }
}

function Set-OperationStage([string]$Stage) {
    $env:BOT_OPERATION_STAGE = $Stage
    Write-OperationEvent 'info' 'begin'
}

function Write-OperationFailure($Failure) {
    Write-OperationEvent 'error' ($Failure.Exception.ToString() + "`n" + $Failure.InvocationInfo.PositionMessage + "`n" + $Failure.ScriptStackTrace)
}

function Start-OperationLog([string]$ProjectRoot, [string]$Kind) {
    $context = [pscustomobject]@{ Name=$env:BOT_OPERATION_LOG; Project=$env:BOT_OPERATION_PROJECT; Stage=$env:BOT_OPERATION_STAGE; Path=$null }
    try {
        $directory = Join-Path $ProjectRoot 'logs\operations'
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '日志目录不能是链接' }
        $pattern = '^(upgrade|deploy|migration|startup)-[0-9TZ]+-[a-zA-Z0-9_-]+\.log$'
        $name = if ($env:BOT_OPERATION_LOG -match $pattern) { $env:BOT_OPERATION_LOG } else { $Kind + '-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N') + '.log' }
        $path = Join-Path $directory $name
        if (Test-Path -LiteralPath $path) {
            $item = Get-Item -LiteralPath $path
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '日志文件不是普通文件' }
        } else { [IO.File]::WriteAllText($path, '', [Text.UTF8Encoding]::new($false)) }
        $context.Path = $path
        $env:BOT_OPERATION_PROJECT = [IO.Path]::GetFullPath($ProjectRoot)
        $env:BOT_OPERATION_LOG = $name
        $env:BOT_OPERATION_STAGE = $Kind
        Write-OperationEvent 'info' 'operation started'
        $old = @(Get-ChildItem -LiteralPath $directory -File | Where-Object { $_.Name -ne $name -and $_.Name -match $pattern -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 19)
        foreach ($file in $old) { Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop }
        Write-Host ('运维日志：' + $path)
    } catch { Write-Warning ('无法创建运维日志，继续使用终端输出：' + (Protect-OperationMessage $_.Exception.Message)) }
    return $context
}

function Stop-OperationLog($Context, [int]$ExitCode) {
    Write-OperationEvent $(if ($ExitCode) { 'error' } else { 'info' }) ('operation finished; exit=' + $ExitCode)
    if ($Context.Path) { Write-Host ('运维日志：' + $Context.Path) }
    $env:BOT_OPERATION_LOG = $Context.Name
    $env:BOT_OPERATION_PROJECT = $Context.Project
    $env:BOT_OPERATION_STAGE = $Context.Stage
}

# Only noninteractive commands use this pipe; prompts retain their original terminal.
function Invoke-OperationNative([string]$Executable, [string[]]$Arguments) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        # Native commands update the global automatic variable in Windows PowerShell 5.1.
        $global:LASTEXITCODE = 1
        & $Executable @Arguments 2>&1 | ForEach-Object { Write-Host $_; Write-OperationEvent 'output' ([string]$_) }
        $code = $LASTEXITCODE
        Write-OperationEvent 'info' ((Split-Path $Executable -Leaf) + '; exit=' + $code)
        return [int]$code
    } finally { $ErrorActionPreference = $previous }
}
