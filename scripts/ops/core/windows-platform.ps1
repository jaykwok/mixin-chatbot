# Native effects only. Ordering, locking, recovery and final success belong to the TypeScript core.
param([Parameter(Mandatory=$true)][string]$RequestBase64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot '../../lib/common.ps1')

. (Join-Path $PSScriptRoot 'windows-service-functions.ps1')

try {
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
    if (@($request.PSObject.Properties.Name | Where-Object { $_ -cnotin @('action','project','task','expected') }).Count -gt 0 -or
        $request.action -cnotin @('inspect','stop','start','last-result') -or $request.project -isnot [string] -or
        $request.task -isnot [string] -or $request.task -cne 'mixin-chatbot') { throw 'Invalid platform request' }
    $project = [IO.Path]::GetFullPath($request.project)
    $task = Get-NativeTask $request.task
    $identity = Get-NativeIdentity $task $project
    $owned = (-not $task -or ($task.TaskPath -ceq '\' -and @($task.Actions).Count -eq 1 -and $task.Actions[0].WorkingDirectory -and
        [IO.Path]::GetFullPath($task.Actions[0].WorkingDirectory) -eq $project))
    $running = [bool]($task -and $task.State -eq 'Running')
    $foreground = (@(Get-NativeBotPids $project).Count -gt 0 -and -not $running)
    $state = if ($foreground -or ($task -and $task.State -notin @('Running','Ready','Disabled'))) { 'unsupported' }
        elseif ($running) { 'running' } elseif ($task) { 'stopped' } else { 'absent' }
    if ($request.action -ceq 'inspect') {
        $value = [ordered]@{ identity = $identity; owned = [bool]$owned; state = $state; rawState = $(if ($task) { [string]$task.State } else { 'absent' }) }
    } elseif ($request.action -ceq 'last-result') {
        # Diagnostics only, after a readiness wait timed out: the scheduler's code for the last run.
        $value = $null
        if ($task -and $owned) { $result = (Get-ScheduledTaskInfo -TaskName $request.task -ErrorAction Stop).LastTaskResult; $value = "$(Get-ResultCodeHex $result) / $result" }
    } else {
        if (-not $owned -or ($state -ceq 'unsupported' -and $request.action -cne 'stop') -or $request.expected -isnot [string] -or $request.expected -cne $identity) { throw 'Deployment identity changed or unsupported; no action performed' }
        if ($request.action -ceq 'stop') {
            $stopResults = @(Stop-ProjectBot $project $request.task 3>&1 | ForEach-Object {
                if ($_ -is [System.Management.Automation.WarningRecord]) { [Console]::Error.WriteLine($_.Message) }
                elseif ($_ -is [bool]) { $_ }
                else { throw 'Unexpected output from stop effect' }
            })
            if ($stopResults.Count -ne 1 -or $stopResults[0] -ne $true) { throw 'Service did not stop' }
        } else {
            if (-not $task) { throw 'Service task is absent; deploy first' }
            if ($task.State -eq 'Disabled') { Enable-ScheduledTask -TaskName $request.task -ErrorAction Stop | Out-Null }
            Start-ScheduledTask -TaskName $request.task -ErrorAction Stop | Out-Null
        }
        $value = $null
    }
    [Console]::Out.WriteLine((([ordered]@{ protocol = 'mixin-platform'; version = 1; action = $request.action; ok = $true; value = $value }) | ConvertTo-Json -Depth 8 -Compress))
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
