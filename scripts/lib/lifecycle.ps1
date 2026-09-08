# Shared local process identity and recoverable filesystem operations. No side effects on import.
function Move-ToProjectArchive([string]$Path, [string]$ProjectRoot, [string]$AllowedRoot = "") {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $source = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetFullPath($(if ($AllowedRoot) { $AllowedRoot } else { $ProjectRoot })).TrimEnd('\', '/')
    if ($source -ne $root -and -not $source.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "归档路径不在指定目录内：$source"
    }
    $archive = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'backup\rm'))
    if ($env:BOT_DEPLOY_BACKUP_ID -match '^(deploy|tunnel)-[a-zA-Z0-9-]+$') { $archive = Join-Path $archive $env:BOT_DEPLOY_BACKUP_ID }
    if ($source -eq $archive -or $archive.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "不能将项目根目录或回收区移入其自身"
    }
    New-Item -ItemType Directory -Force -Path $archive | Out-Null
    $destination = Join-Path $archive (([Guid]::NewGuid().ToString('N')) + '-' + (Split-Path $source -Leaf))
    Move-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
}

# A successful deployment discards its snapshot and empties the entire recycle area.
function Remove-CompletedBackup([string]$SnapshotPath, [string]$ProjectRoot) {
    $root = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
    $backup = Join-Path $root 'backup'
    $snapshot = [IO.Path]::GetFullPath($SnapshotPath)
    $name = Split-Path $snapshot -Leaf
    if ((Split-Path $snapshot -Parent) -ne (Join-Path $backup 'tmp') -or $name -notmatch '^(deploy|tunnel)-[a-zA-Z0-9-]+$') {
        throw '备份清理路径无效'
    }
    $targets = @($snapshot, (Join-Path $backup 'rm'))
    foreach ($target in $targets) {
        # Reject redirected ancestors before recursive removal; never follow a junction out of backup.
        for ($ancestor = $target; $ancestor -ne $root; $ancestor = Split-Path $ancestor -Parent) {
            if (Test-Path -LiteralPath $ancestor) {
                if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '备份清理路径包含链接' }
            }
        }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop }
    }
    foreach ($directory in @((Join-Path $backup 'tmp'), (Join-Path $backup 'rm'), $backup)) {
        if ((Test-Path -LiteralPath $directory -PathType Container) -and @(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) {
            [IO.Directory]::Delete($directory) # Keep other snapshots still present under tmp.
        }
    }
}

function Get-ProjectBotInstance([string]$ProjectRoot) {
    try {
        $identity = Get-Content -LiteralPath (Join-Path $ProjectRoot 'data\state\instance.json') -Raw -ErrorAction Stop | ConvertFrom-Json
        if ([IO.Path]::GetFullPath([string]$identity.cwd) -ne [IO.Path]::GetFullPath($ProjectRoot)) { return $null }
        if ([int]$identity.pid -le 0 -or [int]$identity.port -lt 1 -or [int]$identity.port -gt 65535 -or $identity.token -notmatch '^[0-9a-f]{64}$') { return $null }
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$identity.pid)" -ErrorAction Stop
        if (-not $processInfo -or $processInfo.Name -ne 'bun.exe') { return $null }
        $created = ([DateTimeOffset]$processInfo.CreationDate).ToUnixTimeMilliseconds()
        if ([Math]::Abs($created - [double]$identity.startedAt) -gt 5000) { return $null }
        return $identity
    } catch { return $null }
}

function Get-ProjectBotPids([string]$ProjectRoot) {
    $identity = Get-ProjectBotInstance $ProjectRoot
    if ($identity) { [int]$identity.pid }
    # Migration fallback for old launchers, which used an absolute entry path.
    $entry = [Regex]::Escape((Join-Path $ProjectRoot 'src\server\index.ts')).Replace('\\', '[\\/]')
    Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match ('(?:^|["\s])' + $entry + '(?:["\s]|$)') -and (!$identity -or $_.ProcessId -ne $identity.pid) } |
        Select-Object -ExpandProperty ProcessId
}

function Stop-ProjectBot([string]$ProjectRoot, [string]$TaskName = 'mixin-chatbot', [switch]$KeepDisabled) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $wasEnabled = $task -and $task.State -ne 'Disabled'
    $stopped = $false
    try {
        if ($wasEnabled) { Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null }
        $identity = Get-ProjectBotInstance $ProjectRoot
        if ($identity) {
            try {
                # The port is authenticated by a random per-instance token; credentials never enter argv.
                $localHost = if ($identity.host -eq '::' -or $identity.host -eq '::1') { '[::1]' }
                    elseif ($identity.host -and $identity.host -notin @('0.0.0.0', 'localhost')) { [string]$identity.host }
                    else { '127.0.0.1' }
                $address = $null
                if (-not [Net.IPAddress]::TryParse($localHost.Trim('[', ']'), [ref]$address)) { throw '实例监听地址无效' }
                if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { $localHost = '[' + $address + ']' }
                $request = [Net.HttpWebRequest]::Create("http://${localHost}:$($identity.port)/_admin/shutdown")
                $request.Proxy = $null
                $request.Method = 'POST'
                $request.Headers['Authorization'] = 'Bearer ' + $identity.token
                $request.ContentLength = 0
                $request.Timeout = 3000
                $response = $request.GetResponse()
                $response.Close()
            } catch { Write-Warning "本地关闭请求未确认，将等待后重新核对进程身份。" }
            for ($attempt = 0; $attempt -lt 60 -and (Get-ProjectBotInstance $ProjectRoot); $attempt++) {
                Start-Sleep -Milliseconds 500
            }
        }
        foreach ($ownedPid in @(Get-ProjectBotPids $ProjectRoot)) {
            # Re-read identity immediately before the irreversible fallback; never kill all Bun processes.
            if (@(Get-ProjectBotPids $ProjectRoot) -contains $ownedPid) {
                & "$env:SystemRoot\System32\taskkill.exe" /PID "$ownedPid" /T /F | Out-Null
                if ($LASTEXITCODE -ne 0 -and @(Get-ProjectBotPids $ProjectRoot) -contains $ownedPid) { throw "无法结束本项目进程树 $ownedPid" }
            }
        }
        if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            if (@(Get-ProjectBotPids $ProjectRoot).Count -eq 0 -and (!$current -or $current.State -ne 'Running')) { $stopped = $true; return $true }
            Start-Sleep -Milliseconds 500
        }
        return $false
    } catch { Write-Warning "停止机器人失败：$($_.Exception.Message)"; return $false }
    finally {
        if ($wasEnabled -and (-not $KeepDisabled -or -not $stopped)) { Enable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null }
    }
}

function Save-DeploymentFiles([string]$ProjectRoot, [string]$Snapshot) {
    New-Item -ItemType Directory -Force -Path $Snapshot | Out-Null
    Protect-ProjectSecretPath $Snapshot
    $paths = @('data\config', 'data\runtime\bot-launcher.ps1', 'data\state\bot-port', 'data\state\deploy-mode',
        'data\state\bot-domain', 'data\state\group-data-root', 'data\state\cloudflared-managed')
    foreach ($relative in $paths) {
        $source = Join-Path $ProjectRoot $relative
        if (Test-Path -LiteralPath $source) {
            $target = Join-Path $Snapshot $relative
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            Copy-Item -LiteralPath $source -Destination $target -Recurse -ErrorAction Stop
        }
    }
    return ,$paths
}

function Protect-ProjectSecretPath([string]$Path) {
    # A PowerShell 7 caller can pass its module path to Windows PowerShell 5.1.
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    $isDirectory = $item.PSIsContainer
    $security = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $security.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($security.Access)) { $security.RemoveAccessRuleSpecific($existing) }
    $identities = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
    foreach ($id in $identities) {
        $sid = New-Object Security.Principal.SecurityIdentifier($id)
        $inheritance = if ($isDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inheritance, 'None', 'Allow')
        $security.AddAccessRule($rule)
    }
    Set-ProjectAcl $Path $security
}

function Set-ProjectAcl([string]$Path, $Security) {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    # Persist only the modified DACL; Set-Acl can request SACL privileges unnecessarily.
    if ($PSVersionTable.PSVersion.Major -le 5) {
        if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($item.FullName, $Security) }
        else { [IO.File]::SetAccessControl($item.FullName, $Security) }
    } else { [IO.FileSystemAclExtensions]::SetAccessControl($item, $Security) }
}

function Restore-DeploymentFiles([string]$ProjectRoot, [string]$Snapshot, [string[]]$Paths) {
    foreach ($relative in $Paths) {
        $target = Join-Path $ProjectRoot $relative
        Move-ToProjectArchive $target $ProjectRoot
        $source = Join-Path $Snapshot $relative
        if (Test-Path -LiteralPath $source) {
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            Copy-Item -LiteralPath $source -Destination $target -Recurse -ErrorAction Stop
        }
    }
}
