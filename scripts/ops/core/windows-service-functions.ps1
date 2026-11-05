# Native task identity and process inventory; shared by service and deployment effects.
function Get-NativeTask([string]$Name) {
    # An unreadable task inventory must not be reported as an absent service.
    $matches = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -ceq $Name })
    if ($matches.Count -gt 1) { throw 'Multiple matching service tasks' }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}

function Get-NativeIdentity($Task, [string]$Project) {
    $shape = if ($Task) {
        [ordered]@{ name = $Task.TaskName; path = $Task.TaskPath; principal = [ordered]@{
            user = $Task.Principal.UserId; group = $Task.Principal.GroupId; logon = [string]$Task.Principal.LogonType; run = [string]$Task.Principal.RunLevel
        }; actions = @($Task.Actions | ForEach-Object { [ordered]@{ execute = $_.Execute; arguments = $_.Arguments; directory = $_.WorkingDirectory } }) }
    } else { [ordered]@{ absent = $true; project = $Project } }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($shape | ConvertTo-Json -Depth 8 -Compress))))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Get-ResultCodeHex($Value) {
    # Not 0xffffffff: PowerShell reads that literal as the Int32 -1, which masks nothing.
    $unsigned = [int64]$Value -band [int64]4294967295
    return '0x' + [Convert]::ToString($unsigned, 16).PadLeft(8, '0').ToUpperInvariant()
}
# ERROR_LOGON_FAILURE / ERROR_LOGON_TYPE_NOT_GRANTED: the scheduler accepted an S4U task but may not log it on.
function Test-S4ULogonFailure($Value) { return (Get-ResultCodeHex $Value) -in @('0x8007052E', '0x80070569') }

function Get-NativeBotPids([string]$Project) {
    # Unlike the legacy best-effort hint, a failed inventory is not evidence that no writer exists.
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction Stop)
    $identityPath = Join-Path $Project 'data/state/instance.json'
    $instanceText = $null
    try { $instanceText = [IO.File]::ReadAllText($identityPath, [Text.UTF8Encoding]::new($false, $true)) }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { }
    if ($null -ne $instanceText) {
        try { $instance = $instanceText | ConvertFrom-Json } catch { throw 'Invalid instance record JSON' }
        # startedAt is milliseconds; releases up to 1.0.1 wrote it fractional (Date.now() - process.uptime() * 1000),
        # which Windows PowerShell reads as [decimal] and PowerShell 7 as [double].
        $startedAtIsNumber = $instance.startedAt -is [int] -or $instance.startedAt -is [long] -or
            $instance.startedAt -is [double] -or $instance.startedAt -is [decimal]
        if (($instance.pid -isnot [long] -and $instance.pid -isnot [int]) -or $instance.pid -le 0 -or
            $instance.cwd -isnot [string] -or -not $instance.cwd -or -not $startedAtIsNumber -or $instance.startedAt -le 0) { throw 'Invalid instance record' }
        if ([IO.Path]::GetFullPath([string]$instance.cwd) -ne $Project) { throw 'Instance record belongs to another project' }
        foreach ($item in $processes) {
            if ($item.ProcessId -ne $instance.pid) { continue }
            $lag = [double]$instance.startedAt - ([DateTimeOffset]$item.CreationDate).ToUnixTimeMilliseconds()
            if ($lag -ge -5000 -and $lag -le 300000) { [int]$item.ProcessId }
        }
    }
    $entry = [Regex]::Escape((Join-Path $Project 'src/server/index.ts')).Replace('\\', '[\\/]')
    $processes | Where-Object { $_.CommandLine -match ('(?:^|["\s])' + $entry + '(?:["\s]|$)') } | Select-Object -ExpandProperty ProcessId
}

