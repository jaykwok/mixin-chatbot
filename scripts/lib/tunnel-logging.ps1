# Optional connector diagnostics. Missing preference means no file logging.
function Get-CloudflaredLogging([string]$ProjectRoot) {
    $path = Join-Path $ProjectRoot 'data\config\cloudflared-logging'
    if (-not (Test-Path -LiteralPath $path)) { return 'off' }
    $level = ([string](Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop)).Trim()
    if ($level -cnotin @('off', 'on')) { throw 'cloudflared-logging 只接受 off 或 on' }
    return $level
}

function Set-CloudflaredLogPreference([string]$ProjectRoot, [byte[]]$Content) {
    $path = Join-Path $ProjectRoot 'data\config\cloudflared-logging'
    New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
    $temporary = $path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllBytes($temporary, $Content)
        if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-CloudflaredLogArguments([string]$ProjectRoot, [string]$Mode) {
    if ($Mode -ceq 'off') { return }
    if ($Mode -cne 'on') { throw 'cloudflared-logging 只接受 off 或 on' }
    # Enabled diagnostics always use Debug: request/response records are absent at Info.
    # --log-directory uses cloudflared's rolling logger; --logfile does not rotate.
    return @('--loglevel', 'debug', '--log-directory', (Join-Path $ProjectRoot 'logs'))
}

function Get-CloudflaredServiceCommand([string]$ProjectRoot, [string]$Executable, [string]$TokenFile, [string]$Mode) {
    foreach ($path in @($Executable, $TokenFile, $ProjectRoot)) {
        if ($path -match '["\r\n]') { throw '连接器路径无效' }
    }
    $logArgs = @(Get-CloudflaredLogArguments $ProjectRoot $Mode)
    $logging = if ($logArgs.Count) { ' --loglevel debug --log-directory "' + $logArgs[3] + '"' } else { '' }
    return '"' + $Executable + '" tunnel --no-autoupdate' + $logging + ' run --token-file "' + $TokenFile + '"'
}

function Start-CloudflaredChecked {
    Start-Service Cloudflared -ErrorAction Stop
    Start-Sleep -Milliseconds 750
    if ((Get-Service -Name Cloudflared -ErrorAction Stop).Status -ne 'Running') {
        throw 'Cloudflared 启动后未能保持运行'
    }
}

function Test-CloudflaredAdministrator {
    return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Set-CloudflaredLogging([string]$ProjectRoot, [string]$Mode) {
    if ($Mode -cnotin @('off', 'on')) { throw '请使用 tunnel-logging off 或 tunnel-logging on' }
    $stateDir = Join-Path $ProjectRoot 'data\state'
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    # Same lock as deployment; do not change service arguments halfway through a deployment.
    $lock = [IO.File]::Open((Join-Path $stateDir 'deploy.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        $previousMode = Get-CloudflaredLogging $ProjectRoot
        if ($previousMode -ceq $Mode) {
            Write-Host 'Cloudflared 日志设置未变化。'
            return
        }
        $preference = Join-Path $ProjectRoot 'data\config\cloudflared-logging'
        $hadPreference = Test-Path -LiteralPath $preference -PathType Leaf
        $previousContent = if ($hadPreference) { [IO.File]::ReadAllBytes($preference) } else { $null }
        $service = Get-Service -Name Cloudflared -ErrorAction SilentlyContinue
        $wasRunning = $false
        $previousCommand = $null
        $newCommand = $null
        if ($service) {
            if (-not (Test-Path -LiteralPath (Join-Path $stateDir 'cloudflared-managed') -PathType Leaf)) {
                throw '现有 Cloudflared 服务没有本项目归属记录，无法自动应用日志设置。'
            }
            if (-not (Test-CloudflaredAdministrator)) {
                throw '应用 Cloudflared 日志设置需要以管理员身份运行 TUI 或 PowerShell。'
            }
            if ([string]$service.Status -notin @('Running', 'Stopped')) { throw 'Cloudflared 正在切换状态，请稍后重试。' }
            $wasRunning = $service.Status -eq 'Running'
            $installed = Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" -ErrorAction Stop
            $previousCommand = $installed.PathName
            $executable = Join-Path $ProjectRoot 'cloudflared.exe'
            $tokenFile = Join-Path $ProjectRoot 'data\config\cloudflared-token'
            # Do not replace custom flags, a different executable, or another token.
            $knownCommands = @(
                (Get-CloudflaredServiceCommand $ProjectRoot $executable $tokenFile 'off'),
                (Get-CloudflaredServiceCommand $ProjectRoot $executable $tokenFile 'on')
            )
            if ($previousCommand -notin $knownCommands) {
                throw '现有服务使用自定义或旧的启动参数；请先通过“系统 → 服务部署 → 修复隧道”统一配置，再设置日志。'
            }
            if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or -not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
                throw '缺少项目 cloudflared.exe 或 data/config/cloudflared-token，尚未修改服务。'
            }
            $newCommand = Get-CloudflaredServiceCommand $ProjectRoot $executable $tokenFile $Mode
        }
        if ($Mode -eq 'on') { New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'logs') | Out-Null }
        $commandAttempted = $false
        try {
            if ($wasRunning) { Stop-Service Cloudflared -ErrorAction Stop }
            if ($service) {
                $commandAttempted = $true
                Set-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared' -Name ImagePath -Value $newCommand -ErrorAction Stop
                if ((Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" -ErrorAction Stop).PathName -cne $newCommand) {
                    throw 'Cloudflared 服务命令行校验失败'
                }
            }
            Set-CloudflaredLogPreference $ProjectRoot ([Text.Encoding]::ASCII.GetBytes($Mode))
            if ($wasRunning) { Start-CloudflaredChecked }
        } catch {
            $failure = $_.Exception.Message
            try {
                if ($commandAttempted) {
                    if ((Get-Service -Name Cloudflared -ErrorAction Stop).Status -ne 'Stopped') { Stop-Service Cloudflared -ErrorAction Stop }
                    Set-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared' -Name ImagePath -Value $previousCommand -ErrorAction Stop
                }
                if ($hadPreference) { Set-CloudflaredLogPreference $ProjectRoot $previousContent }
                elseif (Test-Path -LiteralPath $preference) { Remove-Item -LiteralPath $preference -Force -ErrorAction Stop }
                if ($wasRunning -and (Get-Service -Name Cloudflared -ErrorAction Stop).Status -ne 'Running') { Start-CloudflaredChecked }
            } catch { throw "应用失败：$failure；恢复原设置或服务失败：$($_.Exception.Message)" }
            throw "应用失败，已恢复原设置及运行状态：$failure"
        }
        $description = if ($Mode -eq 'on') { '已开启，日志：logs/cloudflared.log（自动轮转）' } else { '已关闭文件日志，已有日志保留' }
        Write-Host "Cloudflared $description。"
        if ($wasRunning) { Write-Host '隧道服务已重新启动。' }
        elseif ($service) { Write-Host '服务保持停止，下次启动生效。' }
        else { Write-Host '尚未安装隧道，下次部署时生效。' }
    } finally { $lock.Dispose() }
}
