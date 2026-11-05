# Native filesystem and scheduler effects. The shared TS executor owns ordering, commit boundaries and startup.
# An upgrade binds every effect to the task identity it confirmed; a deployment replaces the task, so it only requires the
# task to be absent or this project's.
param([Parameter(Mandatory=$true)][string]$RequestBase64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot '../../lib/common.ps1')
. (Join-Path $PSScriptRoot 'windows-service-functions.ps1')

function Assert-OrdinaryTree([string]$Path) {
    try { $attributes = [IO.File]::GetAttributes($Path) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return }
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Snapshot source or destination contains a link' }
    if ($attributes -band [IO.FileAttributes]::Directory) {
        foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($Path)) { Assert-OrdinaryTree $child }
    }
}
function Assert-SnapshotParent([string]$Path, [string]$Project) {
    for ($at = $Path; $at -ne $Project; $at = Split-Path $at -Parent) {
        if (-not $at -or -not $at.StartsWith($Project + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Snapshot path escapes project' }
        try { $attributes = [IO.File]::GetAttributes($at) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { continue }
        if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Snapshot parent contains a link' }
    }
}
function Read-NativeSnapshot([string]$Path, [string]$Project, [string[]]$Paths, [string]$Operation) {
    Assert-SnapshotParent $Path $Project
    $file = Join-Path $Path 'deployment.xml'
    if ([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) { throw 'Snapshot metadata is a link' }
    $state = Import-Clixml -LiteralPath $file
    if ($state.Project -cne $Project -or $state.Path -cne $Path -or $state.TaskName -cne 'mixin-chatbot' -or
        $state.CoreFormat -ne 1 -or $state.Operation -cne $Operation -or $state.ServiceIdentity -cnotmatch '^[a-f0-9]{64}$' -or
        $state.WasRunning -isnot [bool] -or $state.DependenciesAttempted -isnot [bool] -or $state.DependenciesMoved -isnot [bool] -or
        ($Operation -ceq 'upgrade' -and -not $state.TaskXml) -or
        (@($state.Paths) -join "`n") -cne ($Paths -join "`n")) { throw 'Snapshot belongs to another project or unsupported format' }
    return $state
}
function Write-Notice([string]$Text) { [Console]::Error.WriteLine($Text) }
function Sq([string]$Text) { return "'" + ($Text -replace "'", "''") + "'" }
# RunLevel Limited: the bot only listens on its loopback port and writes data/ and logs/; less privilege also narrows what
# the agent's bash tool (not a cwd sandbox) can reach.
function Register-BotTask($Action, $Settings, [bool]$UseS4U) {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($UseS4U) {
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
    } else {
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    }
    Register-ScheduledTask -TaskName 'mixin-chatbot' -Action $Action -Trigger $trigger -Settings $Settings -Principal $principal -Force -ErrorAction Stop | Out-Null
}
# Some security policies refuse S4U: keep the task's current (enabled) action and settings, start at the operator's logon instead.
function Register-InteractiveBotTask([string]$Reason) {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $Task = Get-NativeTask 'mixin-chatbot'
    Write-Notice "$Reason；自动回退为 $user 登录时启动。如需无人值守，请授予该账户“作为批处理作业登录”权限后重新部署。"
    Register-BotTask $Task.Actions $Task.Settings $false
    Enable-ScheduledTask -TaskName 'mixin-chatbot' -ErrorAction Stop | Out-Null
}

try {
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
    $actions = @('capture','read','stop','restore-configuration','save-dependencies','restore-dependencies','restore-task','cleanup',
        'prepare-directories','install-task','start-task')
    $deploying = $request.operation -ceq 'deploy'
    if (@($request.PSObject.Properties.Name | Where-Object { $_ -cnotin @('action','operation','project','snapshot','expected','original','target','branch','tools','fallback') }).Count -gt 0 -or
        $request.action -cnotin $actions -or $request.operation -cnotin @('upgrade','deploy') -or $request.project -isnot [string] -or
        $request.snapshot -cnotmatch '^deploy-[A-Za-z0-9]+$' -or
        ($(if ($deploying) { $null -ne $request.expected } else { $request.expected -cnotmatch '^[a-f0-9]{64}$' -or $request.action -cin @('prepare-directories','install-task','start-task') })) -or
        (($null -ne $request.tools) -ne ($request.action -ceq 'install-task')) -or (($null -ne $request.fallback) -ne ($request.action -ceq 'start-task')) -or
        ($request.action -ceq 'start-task' -and $request.fallback -isnot [bool])) { throw 'Invalid deployment effect request' }
    $tools = $null
    if ($request.action -ceq 'install-task') {
        # The launcher and the task's command line name these paths; quotes or control characters cannot be expressed there.
        if (@($request.tools.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'bash,bun,git,uv') { throw 'Invalid deployment effect request' }
        foreach ($name in @('bun','git','uv','bash')) {
            $path = $request.tools.$name
            if ($path -isnot [string] -or $path -cnotmatch '^(?:[A-Za-z]:\\|\\\\)[^\x00-\x1f\x7f"]+$') { throw 'Invalid deployment effect request' }
        }
        $tools = $request.tools
    }
    $project = [IO.Path]::GetFullPath($request.project).TrimEnd('\')
    $snapshotPath = Join-Path $project ('backup\snapshots\' + $request.snapshot)
    Assert-SnapshotParent $snapshotPath $project
    $env:BOT_DEPLOY_BACKUP_ID = $request.snapshot
    $paths = @('data\config','data\runtime\pi\settings.json','data\runtime\models-store.json','data\runtime\bot-launcher.ps1','data\state\bot-port','data\state\workspace-root')
    $task = Get-NativeTask 'mixin-chatbot'
    $identity = Get-NativeIdentity $task $project
    $ours = ($task -and $task.TaskPath -ceq '\' -and @($task.Actions).Count -eq 1 -and $task.Actions[0].WorkingDirectory -and
        [IO.Path]::GetFullPath($task.Actions[0].WorkingDirectory) -eq $project)
    if ($deploying) { if ($task -and -not $ours) { throw 'Service task belongs to another project' } }
    elseif (-not $ours -or $identity -cne $request.expected) { throw 'Service definition changed or belongs to another project' }
    $value = $null
    if ($request.action -ceq 'capture') {
        $sha = '^[a-f0-9]{40}([a-f0-9]{24})?$'
        $checkout = if ($deploying) { $request.original -ceq '' -and $request.branch -ceq '' -and $request.target -is [string] -and ($request.target -ceq '' -or $request.target -cmatch $sha) }
            else { $request.original -cmatch $sha -and $request.target -cmatch $sha -and $request.branch -is [string] -and $request.branch }
        if ([IO.Directory]::Exists($snapshotPath) -or [IO.File]::Exists($snapshotPath) -or -not $checkout) { throw 'Invalid new snapshot or checkout identity' }
        # A bot this project runs in the foreground has no task to stop or restore.
        if (@(Get-NativeBotPids $project).Count -gt 0 -and -not ($task -and $task.State -eq 'Running')) { throw 'A foreground bot of this project is running; no snapshot taken' }
        foreach ($relative in $paths) { Assert-SnapshotParent (Join-Path $project $relative) $project; Assert-OrdinaryTree (Join-Path $project $relative) }
        $savedPaths = Save-DeploymentFiles $project $snapshotPath
        $state = [pscustomobject]@{ CoreFormat=1; Operation=$request.operation; Project=$project; Path=$snapshotPath; Paths=$savedPaths; TaskName='mixin-chatbot';
            TaskXml=$(if ($task) { Export-ScheduledTask -TaskName 'mixin-chatbot' -ErrorAction Stop } else { $null }); ServiceIdentity=$identity;
            WasRunning=[bool]($task -and $task.State -eq 'Running'); DependenciesMoved=$false; DependenciesAttempted=$false;
            UpgradeOriginal=$request.original; UpgradeTarget=$request.target; UpgradeBranch=$request.branch; PreviousBackupId=$null }
        Save-DeploymentSnapshot $state
        $value = [ordered]@{ identity=$identity; wasRunning=$state.WasRunning; hasTask=[bool]$state.TaskXml; dependenciesAttempted=$false; dependenciesMoved=$false }
    } elseif ($request.action -ceq 'stop') {
        $results = @(Stop-ProjectBot $project 'mixin-chatbot' -KeepDisabled 3>&1 | ForEach-Object {
            if ($_ -is [Management.Automation.WarningRecord]) { [Console]::Error.WriteLine($_.Message) }
            elseif ($_ -is [bool]) { $_ } else { throw 'Unexpected stop result' }
        })
        if ($results.Count -ne 1 -or $results[0] -ne $true) { throw 'Service did not stop' }
    } else {
        $state = Read-NativeSnapshot $snapshotPath $project $paths $request.operation
        if (-not $deploying -and $state.ServiceIdentity -cne $request.expected) { throw 'Snapshot service identity changed' }
        if ($request.action -ceq 'read') {
            $value = [ordered]@{ identity=$state.ServiceIdentity; wasRunning=$state.WasRunning; hasTask=[bool]$state.TaskXml;
                dependenciesAttempted=$state.DependenciesAttempted; dependenciesMoved=$state.DependenciesMoved }
        } elseif ($request.action -ceq 'cleanup') {
            Remove-CompletedBackup $snapshotPath $project
        } elseif ($request.action -ceq 'start-task') {
            # The core asks only for the instance it has just installed, verified or restored; the task is this project's.
            if (-not $task) { throw 'Service task is absent; nothing to start' }
            $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            $s4u = [string]$task.Principal.LogonType -ceq 'S4U'
            if ($task.State -eq 'Disabled') { Enable-ScheduledTask -TaskName 'mixin-chatbot' -ErrorAction Stop | Out-Null }
            try { Start-ScheduledTask -TaskName 'mixin-chatbot' -ErrorAction Stop | Out-Null }
            catch {
                if (-not ($request.fallback -and $s4u)) { throw }
                Register-InteractiveBotTask "无需登录的开机任务无法启动：$($_.Exception.Message)"
                $s4u = $false
                Start-ScheduledTask -TaskName 'mixin-chatbot' -ErrorAction Stop | Out-Null
            }
            if ($request.fallback -and $s4u) {
                # The scheduler accepts the start and only then fails the S4U logon: look once, shortly after.
                Start-Sleep -Seconds 2
                $result = (Get-ScheduledTaskInfo -TaskName 'mixin-chatbot' -ErrorAction Stop).LastTaskResult
                if (Test-S4ULogonFailure $result) {
                    Register-InteractiveBotTask "系统拒绝 S4U 任务登录（$(Get-ResultCodeHex $result)）"
                    $s4u = $false
                    Start-ScheduledTask -TaskName 'mixin-chatbot' -ErrorAction Stop | Out-Null
                }
            }
            if ($request.fallback) { Write-Notice $(if ($s4u) { '任务启动方式：开机启动（无需用户登录）。' } else { "任务启动方式：$user 登录时启动（无人值守重启后不会自动运行）。" }) }
        } else {
            if ($task.State -eq 'Running' -or @(Get-NativeBotPids $project).Count -gt 0) { throw 'Service still running; no files or task definition changed' }
            switch -CaseSensitive ($request.action) {
                'save-dependencies' { Save-DeploymentDependencies $state }
                'restore-dependencies' {
                    if ($state.DependenciesAttempted) {
                        $current = Join-Path $project 'node_modules'; $saved = Join-Path $snapshotPath 'node_modules'
                        Assert-SnapshotParent $saved $project; Assert-SnapshotParent $current $project
                        if ($state.DependenciesMoved) {
                            if (Test-Path -LiteralPath $saved) { Move-ToProjectArchive $current $project; Move-Item -LiteralPath $saved -Destination $current -ErrorAction Stop }
                            elseif (-not (Test-Path -LiteralPath $current)) { throw 'Original dependencies and backup are both missing' }
                        } else { Move-ToProjectArchive $current $project }
                    }
                }
                'restore-configuration' {
                    foreach ($relative in $paths) {
                        Assert-SnapshotParent (Join-Path $project $relative) $project
                        Assert-OrdinaryTree (Join-Path $snapshotPath $relative)
                    }
                    Restore-DeploymentFiles $project $snapshotPath $paths
                }
                'restore-task' {
                    # A first deployment had no task: the one it registered goes away with the rest of the deployment.
                    if ($state.TaskXml) { Register-ScheduledTask -TaskName 'mixin-chatbot' -Xml $state.TaskXml -Force -ErrorAction Stop | Out-Null }
                    elseif ($task) { Unregister-ScheduledTask -TaskName 'mixin-chatbot' -Confirm:$false -ErrorAction Stop }
                }
                'prepare-directories' {
                    foreach ($relative in @('data\config','data\state','data\runtime','logs')) {
                        Assert-SnapshotParent (Join-Path $project $relative) $project
                        New-Item -ItemType Directory -Force -Path (Join-Path $project $relative) | Out-Null
                    }
                    Protect-ProjectSecretPath (Join-Path $project 'data\config')
                    Protect-ProjectSecretPath (Join-Path $project 'data\state')
                }
                'install-task' {
                    $launcher = Join-Path $project 'data\runtime\bot-launcher.ps1'
                    Assert-SnapshotParent $launcher $project
                    $body = @(
                        "`$ErrorActionPreference = 'Stop'",
                        "`$env:PATH = $(Sq ((Split-Path $tools.uv -Parent) + ';' + (Split-Path $tools.bash -Parent) + ';')) + `$env:PATH",
                        "Set-Location $(Sq $project)",
                        ". $(Sq (Join-Path $project 'scripts\lib\bot-supervisor.ps1'))",
                        "`$botExitCode = Invoke-BotSupervision -BunPath $(Sq $tools.bun) -Entry $(Sq (Join-Path $project 'src\server\index.ts')) -GitPath $(Sq $tools.git)",
                        "exit `$botExitCode") -join "`r`n"
                    [IO.File]::WriteAllText($launcher, $body + "`r`n", [Text.UTF8Encoding]::new($true))
                    $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
                    if (-not (Test-Path -LiteralPath $shell -PathType Leaf)) { $shell = 'powershell.exe' }
                    $action = New-ScheduledTaskAction -Execute $shell -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"') -WorkingDirectory $project
                    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
                    try { Register-BotTask $action $settings $true }
                    catch {
                        Write-Notice "无法注册无需登录的开机任务：$($_.Exception.Message)；回退为 $([Security.Principal.WindowsIdentity]::GetCurrent().Name) 登录时启动。"
                        Register-BotTask $action $settings $false
                    }
                    # Registered, not started: the core starts the verification instance once the other steps agree.
                    Disable-ScheduledTask -TaskName 'mixin-chatbot' -ErrorAction Stop | Out-Null
                    $credentials = Join-Path $project 'data\config\app-bot.json'
                    if (Test-Path -LiteralPath $credentials -PathType Leaf) { Protect-ProjectSecretPath $credentials }
                }
            }
        }
    }
    [Console]::Out.WriteLine((([ordered]@{ protocol='mixin-platform'; version=1; action=$request.action; ok=$true; value=$value }) | ConvertTo-Json -Depth 8 -Compress))
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
