. (Join-Path $PSScriptRoot 'tunnel-logging.ps1')

function Get-CloudflaredUpdateVersion([string]$Executable) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable; $info.Arguments = '--version'
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'cloudflared 版本检查无法启动' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); $process.WaitForExit(); throw 'cloudflared 版本检查超时' }
        $output = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or $output -notmatch '^cloudflared version (\d{4}\.\d{1,2}\.\d{1,3})(\s|$)') {
            throw 'cloudflared 版本检查无效'
        }
        return $Matches[1]
    } finally { $process.Dispose() }
}

function Get-CloudflaredUpdateHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path); $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Invoke-CloudflaredDownload([string]$ProjectRoot, [string]$BunPath, [string]$Version, [string]$Arch, [string]$Candidate) {
    $output = @(& $BunPath (Join-Path $ProjectRoot 'scripts\ops\cloudflared-download.ts') --version $Version --os windows --arch $Arch --output $Candidate)
    if ($LASTEXITCODE -eq 3) { return [pscustomobject]@{ Updated = $false; Version = $Version } }
    if ($LASTEXITCODE -ne 0) { throw "cloudflared 下载或校验失败（退出码 $LASTEXITCODE），原程序和隧道未改动。" }
    $next = ($output -join "`n").Trim()
    if ($next -notmatch '^\d{4}\.\d{1,2}\.\d{1,3}$') { throw 'cloudflared 下载结果无效' }
    return [pscustomobject]@{ Updated = $true; Version = $next }
}

function Get-CloudflaredUpdateState([string]$ProjectRoot, [string]$Executable) {
    $service = Get-Service -Name Cloudflared -ErrorAction SilentlyContinue
    $command = ''
    if ($service) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'data\state\cloudflared-managed') -PathType Leaf)) {
            throw '现有 Cloudflared 服务没有本项目归属记录，拒绝更新。'
        }
        if (-not (Test-CloudflaredAdministrator)) { throw '更新 Cloudflared 服务需要以管理员身份运行 TUI 或 PowerShell。' }
        if ([string]$service.Status -notin @('Running', 'Stopped')) { throw 'Cloudflared 正在切换状态，请稍后重试。' }
        $command = (Get-CimInstance Win32_Service -Filter "Name='Cloudflared'" -ErrorAction Stop).PathName
        $token = Join-Path $ProjectRoot 'data\config\cloudflared-token'
        $known = @(foreach ($mode in @('off', 'on')) {
            foreach ($transport in @('auto', 'http2', 'quic')) { Get-CloudflaredServiceCommand $ProjectRoot $Executable $token $mode $transport }
        })
        if ($command -cnotin $known -or -not (Test-Path -LiteralPath $token -PathType Leaf)) {
            throw '现有服务的归属或启动参数不符合本项目配置；请先使用“系统 → 服务部署 → 修复隧道”。'
        }
    }
    if (-not $service -or $service.Status -eq 'Stopped') {
        $foreground = @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop | Where-Object {
            -not $_.ExecutablePath -or $_.ExecutablePath -ieq $Executable
        })
        if ($foreground.Count) { throw '发现前台或归属不明的 Cloudflared 进程，请先停止后再更新。' }
    }
    return [pscustomobject]@{ Status = $(if ($service) { [string]$service.Status } else { 'Absent' }); Command = $command }
}

function Update-ProjectCloudflared([string]$ProjectRoot, [string]$BunPath) {
    if (-not $BunPath) { throw '更新 cloudflared 需要宿主机 Bun，请先按项目环境指引安装。' }
    $stateDir = Join-Path $ProjectRoot 'data\state'
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $lock = [IO.File]::Open((Join-Path $stateDir 'deploy.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stage = $null; $keepStage = $false
    try {
        foreach ($pointer in @('deploy-transaction', 'upgrade-transaction', 'update-transaction')) {
            if (Test-Path -LiteralPath (Join-Path $stateDir $pointer)) { throw '有未完成的部署或升级，请先继续或回滚，再更新 cloudflared。' }
        }
        $executable = Join-Path $ProjectRoot 'cloudflared.exe'
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf) -or
            ((Get-Item -LiteralPath $executable).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw '缺少有效的项目 cloudflared.exe；请先部署隧道。'
        }
        $version = Get-CloudflaredUpdateVersion $executable
        $arch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
            'X64' { 'amd64' }; 'X86' { '386' }; 'Arm64' { 'arm64' }; 'Arm' { 'arm' }; default { throw 'cloudflared 更新不支持此系统架构' }
        }
        $previous = Get-CloudflaredUpdateState $ProjectRoot $executable
        $originalHash = Get-CloudflaredUpdateHash $executable
        $stage = Join-Path $ProjectRoot ('.cloudflared-update-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
        $candidate = Join-Path $stage 'candidate.exe'; $backup = Join-Path $stage 'previous.exe'
        $download = Invoke-CloudflaredDownload $ProjectRoot $BunPath $version $arch $candidate
        if (-not $download.Updated) { Write-Host "cloudflared $version 已是官方稳定版。"; return }
        if ((Get-CloudflaredUpdateVersion $candidate) -cne $download.Version) { throw '候选程序版本验证失败，尚未停止隧道。' }
        if ((Get-CloudflaredUpdateHash $executable) -cne $originalHash) { throw '下载期间原程序发生变化，拒绝覆盖。' }
        $current = Get-CloudflaredUpdateState $ProjectRoot $executable
        if ($current.Status -cne $previous.Status -or $current.Command -cne $previous.Command) { throw '下载期间隧道状态或启动参数发生变化，请重试。' }
        [IO.File]::Copy($executable, $backup, $false)
        $stopAttempted = $false; $switched = $false
        try {
            if ($previous.Status -eq 'Running') {
                $stopAttempted = $true
                Stop-Service Cloudflared -ErrorAction Stop
                if ((Get-Service -Name Cloudflared -ErrorAction Stop).Status -ne 'Stopped') { throw 'Cloudflared 未停止，拒绝替换程序。' }
            }
            $switched = $true
            Save-FileAtomically $executable { param($temporary); [IO.File]::Copy($candidate, $temporary, $false) }.GetNewClosure()
            if ($previous.Status -eq 'Running') { Start-CloudflaredChecked }
        } catch {
            $failure = $_.Exception.Message
            try {
                if ($switched) {
                    if ($previous.Status -ne 'Absent' -and (Get-Service -Name Cloudflared -ErrorAction Stop).Status -ne 'Stopped') {
                        Stop-Service Cloudflared -ErrorAction Stop
                        if ((Get-Service -Name Cloudflared -ErrorAction Stop).Status -ne 'Stopped') { throw 'Cloudflared 无法停止以恢复旧程序' }
                    }
                    # File.Replace may have failed halfway; only skip a restore if the exact original bytes remain.
                    if (-not [IO.File]::Exists($executable) -or (Get-CloudflaredUpdateHash $executable) -cne $originalHash) {
                        Save-FileAtomically $executable { param($temporary); [IO.File]::Copy($backup, $temporary, $false) }.GetNewClosure()
                    }
                }
                if ($stopAttempted -and (Get-Service -Name Cloudflared -ErrorAction Stop).Status -ne 'Running') { Start-CloudflaredChecked }
            } catch {
                $keepStage = $true
                throw "更新失败：$failure；恢复也失败：$($_.Exception.Message)。旧程序保留在 $backup，请人工恢复隧道。"
            }
            throw "更新失败，已恢复原程序及运行状态：$failure"
        }
        Write-Host "cloudflared 已更新：$version → $($download.Version)。"
        if ($previous.Status -eq 'Running') { Write-Host '隧道已按原参数重新启动。' } else { Write-Host '隧道保持停止。' }
    } finally {
        try {
            if ($stage -and -not $keepStage) {
                # Only known files created by this operation; no recursive deletion or traversal.
                foreach ($name in @('candidate.exe', 'previous.exe')) {
                    $temporary = Join-Path $stage $name
                    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
                }
                if ([IO.Directory]::Exists($stage)) { [IO.Directory]::Delete($stage, $false) }
            }
        } catch { Write-Warning "更新临时文件未清理，保留 $stage：$($_.Exception.Message)" }
        finally { $lock.Dispose() }
    }
}
