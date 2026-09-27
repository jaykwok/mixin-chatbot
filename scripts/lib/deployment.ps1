. (Join-Path $PSScriptRoot 'operation-log.ps1')

# A deployment snapshot excludes live SQLite databases and conversation data.
function New-DeploymentSnapshot([string]$ProjectRoot, [string]$TaskName) {
    $previousBackupId = $env:BOT_DEPLOY_BACKUP_ID
    $temporaryRoot = Join-Path $ProjectRoot 'backup\snapshots'
    New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
    $lockRoot = Join-Path $ProjectRoot 'data\state'
    New-Item -ItemType Directory -Force -Path $lockRoot | Out-Null
    $deploymentLock = [IO.File]::Open((Join-Path $lockRoot 'deploy.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
    $snapshot = Join-Path $ProjectRoot ('backup\snapshots\deploy-' + [Guid]::NewGuid().ToString('N'))
    $env:BOT_DEPLOY_BACKUP_ID = Split-Path $snapshot -Leaf
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
        Lock = $deploymentLock; CloudConfigPath = $cloudConfigPath; PreviousBackupId = $previousBackupId
    }
    Save-DeploymentSnapshot $state
    return $state
    } catch { $env:BOT_DEPLOY_BACKUP_ID = $previousBackupId; $deploymentLock.Dispose(); throw }
}

function Save-DeploymentSnapshot($Snapshot) {
    $path = Join-Path $Snapshot.Path 'deployment.xml'
    $temporary = $path + '.tmp'
    $Snapshot | Select-Object * -ExcludeProperty Lock, Record | Export-Clixml -LiteralPath $temporary
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    try { $stream.Flush($true) } finally { $stream.Dispose() }
    # Windows PowerShell 5.1 binds $null to an empty string for .NET string arguments.
    if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $path) }
}

# 部署/升级事务记录：快照目录中的 transaction 文件，与 Linux 同一格式（每行 key=value）。
# 记录停机前确认的全部选择；续做和回滚只使用记录值，不重新读取默认值。隧道 token 永不写入。
function Get-TransactionKeys {
    return @('format', 'operation', 'snapshot', 'target_sha', 'original_sha', 'original_branch', 'original_group_root',
        'target_group_root', 'was_running', 'bot_port', 'deploy_mode', 'bot_domain', 'domain_action', 'unmanaged_tunnel', 'platform_ip', 'reconfigure_ai')
}

function Test-TransactionValue([string]$Key, [string]$Value) {
    if ($Value -match '[\x00-\x1f\x7f]') { return $false }
    switch -CaseSensitive ($Key) {
        'format' { return $Value -ceq '1' }
        'operation' { return $Value -cin @('deploy', 'upgrade') }
        'snapshot' { return $Value -cmatch '^deploy-[A-Za-z0-9]+$' }
        'target_sha' { return $Value -cmatch '^([0-9a-f]{40}|[0-9a-f]{64})?$' }
        'original_sha' { return $Value -cmatch '^([0-9a-f]{40}|[0-9a-f]{64})?$' }
        'original_branch' { return $Value -cmatch '^[^\s~^:?*\[\\]*$' }
        'original_group_root' { return [IO.Path]::IsPathRooted($Value) }
        'target_group_root' { return [IO.Path]::IsPathRooted($Value) }
        'was_running' { return $Value -cin @('0', '1') }
        'reconfigure_ai' { return $Value -cin @('0', '1') }
        'bot_port' { $number = 0; return ($Value -cmatch '^[1-9][0-9]{0,4}$') -and [int]::TryParse($Value, [ref]$number) -and $number -le 65535 }
        'deploy_mode' { return $Value -cin @('direct', 'cloudflare') }
        'bot_domain' { return (-not $Value) -or ((ConvertTo-Hostname $Value) -ceq $Value) }
        'domain_action' { return $Value -cin @('keep', 'persist', 'clear') }
        'unmanaged_tunnel' { return $Value -cin @('', 'direct', 'cloudflare') }
        # 直连防火墙放行的来源：IPv4 或 IPv6，可带前缀长度。
        'platform_ip' { return $Value.Length -le 64 -and $Value -cmatch '^(([0-9]{1,3}\.){3}[0-9]{1,3}|[0-9A-Fa-f]*:[0-9A-Fa-f:.]*)(/[0-9]{1,3})?$' }
    }
    return $false
}

# 逐项校验后先写临时文件再改名，读者不会看到半份记录。
function Write-DeploymentTransaction([string]$Directory, [hashtable]$Record) {
    $lines = foreach ($key in (Get-TransactionKeys)) {
        $value = [string]$Record[$key]
        if (-not (Test-TransactionValue $key $value)) { throw "事务记录值无效：$key=$value" }
        "$key=$value"
    }
    $path = Join-Path $Directory 'transaction'
    [IO.File]::WriteAllText($path + '.tmp', (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath ($path + '.tmp') -Destination $path -Force
}

# 旧版快照没有记录时返回 $null；存在但无效时拒绝。
function Read-DeploymentTransaction([string]$Directory) {
    $path = Join-Path $Directory 'transaction'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $record = @{}
    foreach ($line in [IO.File]::ReadAllLines($path, [Text.UTF8Encoding]::new($false))) {
        $index = $line.IndexOf('=')
        if ($index -lt 1) { throw '事务记录无效' }
        $key = $line.Substring(0, $index)
        $value = $line.Substring($index + 1)
        if ($record.ContainsKey($key) -or -not (Test-TransactionValue $key $value)) { throw "事务记录无效：$key" }
        $record[$key] = $value
    }
    foreach ($key in (Get-TransactionKeys)) { if (-not $record.ContainsKey($key)) { throw "事务记录缺少：$key" } }
    return $record
}

# 已提交部署保存的群根；未保存时为默认 data\groups。
function Get-SavedGroupDataRoot([string]$ProjectRoot) {
    $file = Join-Path $ProjectRoot 'data\state\group-data-root'
    $root = if (Test-Path -LiteralPath $file -PathType Leaf) { "$(Get-Content -LiteralPath $file -Raw)".Trim() } else { '' }
    if (-not $root) { $root = 'data\groups' }
    return [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($root)) { $root } else { Join-Path $ProjectRoot $root }))
}

function Format-DeploymentTransaction($Record) {
    $kind = if ($Record.operation -eq 'upgrade') { '升级' } else { '部署' }
    $state = if ($Record.was_running -eq '1') { '运行' } else { '停止' }
    $sha = if ($Record.target_sha) { $Record.target_sha.Substring(0, 7) } else { '（非 git 部署）' }
    $entry = if ($Record.deploy_mode -eq 'direct') { "direct（来源 $($Record.platform_ip)）" } else { $Record.deploy_mode }
    return "未完成的$($kind)：目标提交 $($sha)；群数据总根 $($Record.target_group_root)（原 $($Record.original_group_root)）；端口 $($Record.bot_port)；入口 $($entry)；原运行状态：$($state)"
}

# Reopen an interrupted deployment with its original snapshot, lock and recorded choices.
function Open-DeploymentTransaction([string]$ProjectRoot) {
    try {
        $deploymentLock = [IO.File]::Open((Join-Path $ProjectRoot 'data\state\deploy.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] { throw '另一个部署或升级正在进行' }
    try {
        $name = "$(Get-Content -LiteralPath (Join-Path $ProjectRoot 'data\state\deploy-transaction') -Raw)".Trim()
        if ($name -notmatch '^deploy-[0-9a-f]{32}$') { throw '部署事务快照名称无效' }
        $path = Join-Path $ProjectRoot ('backup\snapshots\' + $name)
        $state = Import-Clixml -LiteralPath (Join-Path $path 'deployment.xml')
        if ($state.Project -ne $ProjectRoot -or $state.Path -ne $path) { throw '部署事务快照与当前项目不一致' }
        $record = Read-DeploymentTransaction $path
        if (-not $record -or $record.snapshot -ne $name) { throw '部署事务记录缺失或与快照不一致' }
        $state | Add-Member -NotePropertyName Lock -NotePropertyValue $deploymentLock
        $state | Add-Member -NotePropertyName Record -NotePropertyValue $record
        $env:BOT_DEPLOY_BACKUP_ID = $name
        return $state
    } catch { $deploymentLock.Dispose(); throw }
}

# The pointer is published only after the confirmed choices are recorded; resume and rollback read only that record.
function Publish-DeploymentTransaction($Snapshot, [hashtable]$Record, [string]$Pointer, [string]$MigrationPlan = '') {
    Write-DeploymentTransaction $Snapshot.Path $Record
    if ($MigrationPlan) { Copy-Item -LiteralPath $MigrationPlan -Destination (Join-Path $Snapshot.Path 'migration-plan.json') -ErrorAction Stop }
    [IO.File]::WriteAllText($Pointer + '.tmp', (Split-Path $Snapshot.Path -Leaf))
    Move-Item -LiteralPath ($Pointer + '.tmp') -Destination $Pointer -Force
}

# An interrupted upgrade reuses its original snapshot and original running state.
function Open-UpgradeSnapshot([string]$ProjectRoot, [string]$TaskName, [string]$OriginalSha, [string]$OriginalBranch, [string]$TargetSha, [hashtable]$Record = $null, [string]$MigrationPlan = '') {
    $pointer = Join-Path $ProjectRoot 'data\state\upgrade-transaction'
    if (Test-Path -LiteralPath $pointer) {
        $name = "$(Get-Content -LiteralPath $pointer -Raw)".Trim()
        if ($name -notmatch '^deploy-[0-9a-f]{32}$') { throw '升级事务快照名称无效' }
        $path = Join-Path $ProjectRoot ('backup\snapshots\' + $name)
        $deploymentLock = [IO.File]::Open((Join-Path $ProjectRoot 'data\state\deploy.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            $state = Import-Clixml -LiteralPath (Join-Path $path 'deployment.xml')
            if ($state.Project -ne $ProjectRoot -or $state.Path -ne $path -or $state.UpgradeTarget -ne $TargetSha) { throw '中断升级必须使用原项目与原目标提交继续' }
            $state | Add-Member -NotePropertyName Lock -NotePropertyValue $deploymentLock
            $state | Add-Member -NotePropertyName Record -NotePropertyValue (Read-DeploymentTransaction $path)
            $env:BOT_DEPLOY_BACKUP_ID = $name
            return $state
        } catch { $deploymentLock.Dispose(); throw }
    }
    $state = New-DeploymentSnapshot $ProjectRoot $TaskName
    try {
        $state | Add-Member -NotePropertyName UpgradeOriginal -NotePropertyValue $OriginalSha
        $state | Add-Member -NotePropertyName UpgradeBranch -NotePropertyValue $OriginalBranch
        $state | Add-Member -NotePropertyName UpgradeTarget -NotePropertyValue $TargetSha
        Save-DeploymentSnapshot $state
        if ($Record) {
            $Record.snapshot = Split-Path $state.Path -Leaf
            $Record.was_running = if ($state.WasRunning) { '1' } else { '0' }
            Write-DeploymentTransaction $state.Path $Record
        }
        if ($MigrationPlan -and (Test-Path -LiteralPath $MigrationPlan -PathType Leaf)) {
            Copy-Item -LiteralPath $MigrationPlan -Destination (Join-Path $state.Path 'migration-plan.json') -ErrorAction Stop
        }
        [IO.File]::WriteAllText($pointer + '.tmp', (Split-Path $state.Path -Leaf))
        [IO.File]::Move($pointer + '.tmp', $pointer)
        return $state
    } catch { $state.Lock.Dispose(); $env:BOT_DEPLOY_BACKUP_ID = $state.PreviousBackupId; throw }
}

function Remove-UpgradeStage([string]$ProjectRoot, [string]$Stage) {
    $temporaryRoot = [IO.Path]::GetFullPath((Join-Path $ProjectRoot 'tmp')).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($Stage).TrimEnd('\')
    if ((Split-Path $target -Parent) -ne $temporaryRoot -or (Split-Path $target -Leaf) -notmatch '^upgrade-[0-9a-f]{32}$') { throw '升级临时目录越界' }
    if (-not (Test-Path -LiteralPath $target)) { return }
    if ((Get-Item -LiteralPath $temporaryRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '升级临时目录经过链接' }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($target)
    while ($pending.Count) {
        $directory = $pending.Pop()
        $item = Get-Item -LiteralPath $directory -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '升级临时目录含链接' }
        foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '升级临时目录含链接' }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
}

# 恢复升级前的代码会丢弃工作区内容（reset --hard / checkout --force）：列出升级后的人工改动，调用方保留事务并停止。
# 规则与 scripts/lib/common.sh 的 code_restore_safe 相同：当前提交和要重置的原分支只能停在升级前或目标提交；
# 已跟踪文件不能有改动；升级前有、当前提交没有的路径由恢复重建，路径本身和各级父路径都不能被未跟踪或忽略的文件、
# 目录或链接（含目录联接）占用。
function Get-CodeRestoreConflicts([string]$GitPath, [string]$ProjectRoot, [string]$Branch, [string]$OriginalSha, [string]$TargetSha) {
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $short = { param([string]$Sha) if ($Sha.Length -gt 7) { $Sha.Substring(0, 7) } else { $Sha } }
        $conflicts = @()
        $head = "$(& $GitPath -C $ProjectRoot rev-parse --verify --quiet 'HEAD^{commit}')".Trim()
        if ($head -ne $OriginalSha -and $head -ne $TargetSha) {
            $conflicts += "当前提交 $(& $short $head) 既不是升级前的 $(& $short $OriginalSha)，也不是目标 $(& $short $TargetSha)：升级后有新的提交或切换"
        }
        if ($Branch -and $Branch -ne 'HEAD') {
            $ref = "$(& $GitPath -C $ProjectRoot rev-parse --verify --quiet "refs/heads/$Branch^{commit}")".Trim()
            if ($ref -ne $OriginalSha -and $ref -ne $TargetSha) {
                $conflicts += "分支 $Branch 指向 $(& $short $ref)，不是升级前或目标提交：回滚会把它重置到 $(& $short $OriginalSha)"
            }
        }
        foreach ($line in @(& $GitPath -C $ProjectRoot status --porcelain --untracked-files=no)) {
            if ("$line") { $conflicts += "未提交的改动：$line" }
        }
        if ($head) {
            # 属性不跟随链接；取不到（不存在，或父路径不是目录）时为 $null。
            $attributesOf = { param([string]$Path) try { [IO.File]::GetAttributes((Join-Path $ProjectRoot $Path)) } catch { $null } }
            $realDirectory = { param($Attributes) $Attributes.HasFlag([IO.FileAttributes]::Directory) -and -not $Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) }
            $trackedType = { param([string]$Path) "$(& $GitPath -C $ProjectRoot cat-file -t "${head}:$Path" 2>$null)".Trim() }
            $checked = New-Object 'System.Collections.Generic.HashSet[string]'
            foreach ($path in @(& $GitPath -C $ProjectRoot -c core.quotepath=off diff --name-only --no-renames --diff-filter=D $OriginalSha $head)) {
                if (-not "$path") { continue }
                $attributes = & $attributesOf $path
                if ($null -ne $attributes) {
                    if ((& $realDirectory $attributes) -and (& $trackedType $path) -eq 'tree') {
                        foreach ($other in @(& $GitPath -C $ProjectRoot -c core.quotepath=off --literal-pathspecs ls-files --others -- $path)) {
                            if ("$other") { $conflicts += "未跟踪的文件会随目录删除（升级前的版本在 $path 是文件）：$other" }
                        }
                    } else { $conflicts += "未跟踪的文件会被升级前的版本覆盖：$path" }
                }
                $parent = "$path"
                while ($parent.Contains('/')) {
                    $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
                    if (-not $checked.Add($parent)) { break }
                    $attributes = & $attributesOf $parent
                    if ($null -ne $attributes -and -not (& $realDirectory $attributes) -and (& $trackedType $parent) -ne 'blob') {
                        $conflicts += "未跟踪的文件或链接占着升级前版本的目录位置：$parent"
                    }
                }
            }
        }
        return $conflicts
    } finally { $ErrorActionPreference = $previous }
}

function Test-DeploymentDependenciesReusable([string]$ProjectRoot, [string]$GitPath, [string]$OldRevision, [string]$NewRevision) {
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules') -PathType Container)) { return $false }
        $manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        # Compare lockfiles and install inputs as well as versions: a patch or transitive
        # dependency change also requires installation. Unknown layouts fail closed.
        $inputs = @('package.json', 'bun.lock', 'bun.lockb', 'bunfig.toml', '.npmrc', 'scripts/patches', 'patches')
        foreach ($patch in @($manifest.patchedDependencies.PSObject.Properties)) {
            if ($patch) { $inputs += [string]$patch.Value }
        }
        & $GitPath -C $ProjectRoot diff --quiet $OldRevision $NewRevision -- @inputs
        if ($LASTEXITCODE -ne 0 -or $manifest.workspaces) { return $false }
        foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies')) {
            foreach ($entry in @($manifest.$section.PSObject.Properties)) {
                if (-not $entry) { continue }
                # This project pins exact versions; ranges/aliases need Bun's resolver.
                if ([string]$entry.Value -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { return $false }
                $installedPath = Join-Path $ProjectRoot ('node_modules/' + $entry.Name + '/package.json')
                if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) { return $false }
                $installed = Get-Content -LiteralPath $installedPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($installed.name -cne $entry.Name -or $installed.version -cne [string]$entry.Value) { return $false }
                foreach ($bin in @($installed.bin.PSObject.Properties)) {
                    if ($installed.bin -is [string]) { $binPath = $installed.bin }
                    elseif ($bin) { $binPath = [string]$bin.Value }
                    else { continue }
                    if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $installedPath -Parent) $binPath) -PathType Leaf)) { return $false }
                }
            }
        }
        return $true
    } catch { return $false }
}

function Save-DeploymentDependencies($Snapshot) {
    $root = [IO.Path]::GetFullPath($Snapshot.Project).TrimEnd('\')
    $source = [IO.Path]::GetFullPath((Join-Path $root 'node_modules'))
    $target = [IO.Path]::GetFullPath((Join-Path $Snapshot.Path 'node_modules'))
    if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '依赖快照目录越界' }
    # A resumed transaction already recorded that there were no original
    # dependencies; the node_modules present now came from the interrupted install.
    if ($Snapshot.DependenciesAttempted -and -not $Snapshot.DependenciesMoved) { return }
    if (Test-Path -LiteralPath $target) {
        $Snapshot.DependenciesMoved = $true
        $Snapshot.DependenciesAttempted = $true
        Save-DeploymentSnapshot $Snapshot
        return
    }
    # Write intent before the atomic same-volume move. Recovery distinguishes a
    # completed move by the backup directory, so interruption cannot overwrite it.
    $Snapshot.DependenciesMoved = Test-Path -LiteralPath $source
    $Snapshot.DependenciesAttempted = $true
    Save-DeploymentSnapshot $Snapshot
    if ($Snapshot.DependenciesMoved) {
        Move-Item -LiteralPath $source -Destination $target -ErrorAction Stop
    }
}

function Restore-DeploymentSnapshot($Snapshot) {
    $root = $Snapshot.Project
    if (-not (Stop-ProjectBot $root $Snapshot.TaskName -KeepDisabled)) { throw '新进程尚未停止，拒绝覆盖运行中的配置或依赖' }
    Restore-CloudflaredSnapshot $Snapshot -DeferStart
    Restore-DeploymentFiles $root $Snapshot.Path $Snapshot.Paths
    if ($Snapshot.DependenciesAttempted) {
        if ($Snapshot.DependenciesMoved) {
            $saved = [IO.Path]::GetFullPath((Join-Path $Snapshot.Path 'node_modules'))
            if (-not $saved.StartsWith([IO.Path]::GetFullPath($root).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '依赖快照路径无效' }
            if (Test-Path -LiteralPath $saved) {
                Move-ToProjectArchive (Join-Path $root 'node_modules') $root
                Move-Item -LiteralPath $saved -Destination (Join-Path $root 'node_modules') -ErrorAction Stop
            } elseif (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules'))) { throw '原依赖及其备份都缺失' }
        } else { Move-ToProjectArchive (Join-Path $root 'node_modules') $root }
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
    Write-Warning '已恢复配置、启动定义、依赖、网络入口和原运行状态；回滚快照保留在 backup/snapshots。'
}

# Snapshot the service, project token and any ProgramData configuration for rollback.
function New-CloudflaredSnapshot([string]$ProjectRoot, [string]$Directory = '') {
    $previousBackupId = $env:BOT_DEPLOY_BACKUP_ID
    try {
    if (-not $Directory) {
        $Directory = Join-Path $ProjectRoot ('backup\snapshots\tunnel-' + [Guid]::NewGuid().ToString('N'))
        $env:BOT_DEPLOY_BACKUP_ID = Split-Path $Directory -Leaf
    }
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    Protect-ProjectSecretPath $Directory
    $tunnel = Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" -ErrorAction SilentlyContinue
    $marker = Join-Path $ProjectRoot 'data\state\cloudflared-managed'
    $managed = Test-Path -LiteralPath $marker
    $configPath = Join-Path $env:ProgramData 'cloudflared'
    $projectToken = Join-Path $ProjectRoot 'data\config\cloudflared-token'
    if (Test-Path -LiteralPath $projectToken -PathType Leaf) {
        Copy-Item -LiteralPath $projectToken -Destination (Join-Path $Directory 'project-cloudflared-token') -ErrorAction Stop
    }
    if ($managed) { Copy-Item -LiteralPath $marker -Destination (Join-Path $Directory 'cloudflared-managed') -ErrorAction Stop }
    if (($managed -or -not $tunnel) -and (Test-Path -LiteralPath $configPath)) {
        Copy-Item -LiteralPath $configPath -Destination (Join-Path $Directory 'cloudflared-config') -Recurse -ErrorAction Stop
        Get-Acl -LiteralPath $configPath | Export-Clixml -LiteralPath (Join-Path $Directory 'cloudflared-acl.xml')
    }
    $state = [pscustomobject]@{ Project = $ProjectRoot; Path = $Directory; Tunnel = $tunnel; TunnelManaged = $managed; CloudConfigPath = $configPath; PreviousBackupId = $previousBackupId }
    $state | Export-Clixml -LiteralPath (Join-Path $Directory 'tunnel.xml')
    return $state
    } catch { $env:BOT_DEPLOY_BACKUP_ID = $previousBackupId; throw }
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
        $projectToken = Join-Path $root 'data\config\cloudflared-token'
        Move-ToProjectArchive $projectToken $root
        $savedProjectToken = Join-Path $Snapshot.Path 'project-cloudflared-token'
        if (Test-Path -LiteralPath $savedProjectToken -PathType Leaf) {
            New-Item -ItemType Directory -Force -Path (Split-Path $projectToken -Parent) | Out-Null
            Copy-Item -LiteralPath $savedProjectToken -Destination $projectToken -ErrorAction Stop
            Protect-ProjectSecretPath $projectToken
        }
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
