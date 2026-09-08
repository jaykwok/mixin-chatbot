# A deployment snapshot excludes live SQLite databases and conversation data.
function New-DeploymentSnapshot([string]$ProjectRoot, [string]$TaskName) {
    $temporaryRoot = Join-Path $ProjectRoot 'agents\temp'
    New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
    $deploymentLock = [IO.File]::Open((Join-Path $temporaryRoot 'deploy.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
    $snapshot = Join-Path $ProjectRoot ('agents\temp\deploy-' + [Guid]::NewGuid().ToString('N'))
    $paths = Save-DeploymentFiles $ProjectRoot $snapshot
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task -and @(Get-ProjectBotPids $ProjectRoot).Count -gt 0) {
        throw '检测到前台机器人实例。请先停止前台实例，再用部署脚本创建计划任务。'
    }
    $taskXml = if ($task) { Export-ScheduledTask -TaskName $TaskName -ErrorAction Stop } else { $null }
    $firewall = @()
    foreach ($rule in @(Get-NetFirewallRule -Group 'mixin-chatbot' -ErrorAction SilentlyContinue)) {
        $port = $rule | Get-NetFirewallPortFilter -ErrorAction Stop
        $address = $rule | Get-NetFirewallAddressFilter -ErrorAction Stop
        $firewall += @{
            Name = $rule.Name; DisplayName = $rule.DisplayName; Group = $rule.Group;
            Direction = [string]$rule.Direction; Action = [string]$rule.Action; Enabled = [string]$rule.Enabled;
            Profile = [string]$rule.Profile; Protocol = $port.Protocol; LocalPort = $port.LocalPort;
            RemotePort = $port.RemotePort; LocalAddress = $address.LocalAddress; RemoteAddress = $address.RemoteAddress
        }
    }
    $connector = New-CloudflaredSnapshot $ProjectRoot $snapshot
    $tunnel = $connector.Tunnel
    $cloudConfigPath = $connector.CloudConfigPath
    $state = [pscustomobject]@{
        Project = $ProjectRoot; Path = $snapshot; Paths = $paths; TaskName = $TaskName; TaskXml = $taskXml;
        WasRunning = [bool]($task -and $task.State -eq 'Running');
        Firewall = $firewall; Tunnel = $tunnel;
        TunnelManaged = (Test-Path -LiteralPath (Join-Path $ProjectRoot 'data\state\cloudflared-managed'));
        DependenciesMoved = $false; DependenciesAttempted = $false;
        Lock = $deploymentLock; CloudConfigPath = $cloudConfigPath
    }
    Save-DeploymentSnapshot $state
    return $state
    } catch { $deploymentLock.Dispose(); throw }
}

function Save-DeploymentSnapshot($Snapshot) {
    $Snapshot | Select-Object * -ExcludeProperty Lock | Export-Clixml -LiteralPath (Join-Path $Snapshot.Path 'deployment.xml')
}

function Save-DeploymentDependencies($Snapshot) {
    $root = [IO.Path]::GetFullPath($Snapshot.Project).TrimEnd('\')
    $source = [IO.Path]::GetFullPath((Join-Path $root 'node_modules'))
    $target = [IO.Path]::GetFullPath((Join-Path $Snapshot.Path 'node_modules'))
    if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '依赖快照目录越界' }
    if (Test-Path -LiteralPath $source) {
        Move-Item -LiteralPath $source -Destination $target -ErrorAction Stop
        $Snapshot.DependenciesMoved = $true
    }
    # Do not mark installation attempted before the original dependency directory has moved.
    $Snapshot.DependenciesAttempted = $true
    Save-DeploymentSnapshot $Snapshot
}

function Restore-DeploymentSnapshot($Snapshot) {
    $root = $Snapshot.Project
    if (-not (Stop-ProjectBot $root $Snapshot.TaskName -KeepDisabled)) { throw '新进程尚未停止，拒绝覆盖运行中的配置或依赖' }
    Restore-CloudflaredSnapshot $Snapshot -DeferStart
    Restore-DeploymentFiles $root $Snapshot.Path $Snapshot.Paths
    if ($Snapshot.DependenciesAttempted) {
        Move-ToProjectArchive (Join-Path $root 'node_modules') $root
        if ($Snapshot.DependenciesMoved) {
            $saved = [IO.Path]::GetFullPath((Join-Path $Snapshot.Path 'node_modules'))
            if (-not $saved.StartsWith([IO.Path]::GetFullPath($root).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '依赖快照路径无效' }
            Move-Item -LiteralPath $saved -Destination (Join-Path $root 'node_modules') -ErrorAction Stop
        }
    }
    foreach ($rule in @(Get-NetFirewallRule -Group 'mixin-chatbot' -ErrorAction SilentlyContinue)) {
        if ($Snapshot.Firewall.Name -notcontains $rule.Name) { $rule | Remove-NetFirewallRule -ErrorAction Stop }
    }
    foreach ($parameters in $Snapshot.Firewall) {
        if (-not (Get-NetFirewallRule -Name $parameters.Name -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule @parameters -ErrorAction Stop | Out-Null
        }
    }
    if ($Snapshot.TaskXml) {
        Register-ScheduledTask -TaskName $Snapshot.TaskName -Xml $Snapshot.TaskXml -Force -ErrorAction Stop | Out-Null
    } elseif (Get-ScheduledTask -TaskName $Snapshot.TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Snapshot.TaskName -Confirm:$false -ErrorAction Stop
    }
    if ($Snapshot.Tunnel -and $Snapshot.Tunnel.Started) { Start-Service Cloudflared -ErrorAction Stop }
    if ($Snapshot.WasRunning) { Start-ScheduledTask -TaskName $Snapshot.TaskName -ErrorAction Stop }
    Write-Warning '已恢复配置、启动定义、依赖、网络入口和原运行状态；回滚快照保留在 agents/temp。'
}

# The official Windows installer stores its token under ProgramData. Snapshot that directory too.
function New-CloudflaredSnapshot([string]$ProjectRoot, [string]$Directory = '') {
    if (-not $Directory) { $Directory = Join-Path $ProjectRoot ('agents\temp\tunnel-' + [Guid]::NewGuid().ToString('N')) }
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    Protect-ProjectSecretPath $Directory
    $tunnel = Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" -ErrorAction SilentlyContinue
    $marker = Join-Path $ProjectRoot 'data\state\cloudflared-managed'
    $managed = Test-Path -LiteralPath $marker
    $configPath = Join-Path $env:ProgramData 'cloudflared'
    if ($managed) { Copy-Item -LiteralPath $marker -Destination (Join-Path $Directory 'cloudflared-managed') -ErrorAction Stop }
    if (($managed -or -not $tunnel) -and (Test-Path -LiteralPath $configPath)) {
        Copy-Item -LiteralPath $configPath -Destination (Join-Path $Directory 'cloudflared-config') -Recurse -ErrorAction Stop
        Get-Acl -LiteralPath $configPath | Export-Clixml -LiteralPath (Join-Path $Directory 'cloudflared-acl.xml')
    }
    $state = [pscustomobject]@{ Project = $ProjectRoot; Path = $Directory; Tunnel = $tunnel; TunnelManaged = $managed; CloudConfigPath = $configPath }
    $state | Export-Clixml -LiteralPath (Join-Path $Directory 'tunnel.xml')
    return $state
}

function Restore-CloudflaredSnapshot($Snapshot, [switch]$DeferStart) {
    $root = $Snapshot.Project
    # Revert connector state before restoring its ownership marker.
    $currentTunnel = Get-Service -Name Cloudflared -ErrorAction SilentlyContinue
    if ($Snapshot.TunnelManaged -and $Snapshot.Tunnel) {
        if ($currentTunnel -and $currentTunnel.Status -ne 'Stopped') { Stop-Service Cloudflared -ErrorAction Stop }
        $startup = switch ($Snapshot.Tunnel.StartMode) { 'Auto' { 'Automatic' } 'Disabled' { 'Disabled' } default { 'Manual' } }
        if ($currentTunnel) {
            Set-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared' -Name ImagePath -Value $Snapshot.Tunnel.PathName
            Set-Service Cloudflared -StartupType $startup -ErrorAction Stop
        } else {
            New-Service -Name Cloudflared -BinaryPathName $Snapshot.Tunnel.PathName -StartupType $startup -ErrorAction Stop | Out-Null
        }
    } elseif (-not $Snapshot.Tunnel -and $currentTunnel -and (Test-Path -LiteralPath (Join-Path $root 'data\state\cloudflared-managed'))) {
        Stop-Service Cloudflared -ErrorAction Stop
        & "$env:SystemRoot\System32\sc.exe" delete Cloudflared | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '清理本次新装的 Cloudflared 服务失败' }
    } elseif ($Snapshot.Tunnel -and $currentTunnel -and -not $Snapshot.Tunnel.Started -and $currentTunnel.Status -ne 'Stopped') {
        Stop-Service Cloudflared -ErrorAction Stop
    }
    if ($Snapshot.TunnelManaged -or -not $Snapshot.Tunnel) {
        Move-ToProjectArchive $Snapshot.CloudConfigPath $root $Snapshot.CloudConfigPath
        $savedCloudConfig = Join-Path $Snapshot.Path 'cloudflared-config'
        if (Test-Path -LiteralPath $savedCloudConfig) {
            Copy-Item -LiteralPath $savedCloudConfig -Destination $Snapshot.CloudConfigPath -Recurse -ErrorAction Stop
            if (Test-Path -LiteralPath (Join-Path $Snapshot.Path 'cloudflared-acl.xml')) {
                $acl = Import-Clixml -LiteralPath (Join-Path $Snapshot.Path 'cloudflared-acl.xml')
                $security = Get-Acl -LiteralPath $Snapshot.CloudConfigPath
                $security.SetSecurityDescriptorSddlForm($acl.Sddl, [Security.AccessControl.AccessControlSections]::Access)
                Set-ProjectAcl $Snapshot.CloudConfigPath $security
                Get-ChildItem -LiteralPath $Snapshot.CloudConfigPath -File -Recurse | ForEach-Object { Protect-ProjectSecretPath $_.FullName }
            }
        }
    }

    $marker = Join-Path $root 'data\state\cloudflared-managed'
    Move-ToProjectArchive $marker $root
    if ($Snapshot.TunnelManaged) {
        New-Item -ItemType Directory -Force -Path (Split-Path $marker -Parent) | Out-Null
        Copy-Item -LiteralPath (Join-Path $Snapshot.Path 'cloudflared-managed') -Destination $marker -ErrorAction Stop
    }
    if (-not $DeferStart -and $Snapshot.Tunnel -and $Snapshot.Tunnel.Started) { Start-Service Cloudflared -ErrorAction Stop }
}
