# Windows 脚本共用入口：加载实例控制、部署事务和交互/路径辅助函数。
# 用法：. (Join-Path $PSScriptRoot "..\lib\common.ps1")

. (Join-Path $PSScriptRoot 'lifecycle.ps1')
. (Join-Path $PSScriptRoot 'deployment.ps1')

# 交互界面沿用相同运维命令，但建议指向界面中真实存在的入口。
function Get-OpsCommandHint([string]$Command) {
    if ($env:MIXIN_OPS_TUI -eq '1') {
        $paths = @{
            'deploy' = '系统 → 服务部署 → 部署 / 重部署'
            'update' = '系统 → 服务部署 → 升级'
            'start' = '系统 → 服务部署 → 启动'
            'stop' = '系统 → 服务部署 → 停止'
            'restart' = '系统 → 服务部署 → 重启'
            'doctor -Repair' = '系统 → 服务部署 → 修复部署'
            'repair-tunnel' = '系统 → 服务部署 → 修复隧道'
            'uninstall' = '系统 → 服务部署 → 卸载'
            'doctor' = '监控 → 体检（按 r 刷新）'
            'logs' = '监控 → 日志'
        }
        if ($paths.ContainsKey($Command)) { return "「$($paths[$Command])」" }
        if ($Command -eq 'configure') {
            return '先修正 data/config/models.json 和 data/runtime/pi/settings.json；配置有效后，可在「系统 → 服务部署 → 部署 / 重部署」重新选择模型'
        }
    }
    if ($Command -eq 'configure') { return 'bun run configure' }
    return "scripts\ops\ops.ps1 $Command"
}

# 列出 PATH 上的真实可执行文件，调用方再验证版本并排除 shim。
function Get-ApplicationPaths([string]$Name) {
    $paths = @()
    foreach ($command in @(Get-Command $Name -All -CommandType Application -ErrorAction SilentlyContinue)) {
        foreach ($rawCandidate in @($command.Path)) {
            $candidate = [string]$rawCandidate
            if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            if ($paths -notcontains $candidate) { $paths += $candidate }
        }
    }
    return $paths
}

function Test-CloudflaredApplication([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $output = @(& $Path --version 2>$null)
        return $LASTEXITCODE -eq 0 -and (($output -join "`n") -match '(?i)^cloudflared\s+version')
    } catch { return $false }
}

# Only the project copy is used. Validate the download before executing or replacing anything.
function Ensure-ProjectCloudflared([string]$ProjectRoot) {
    $executable = Join-Path $ProjectRoot 'cloudflared.exe'
    if (Test-CloudflaredApplication $executable) { return $executable }
    if ((Test-Path -LiteralPath $executable) -and -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "cloudflared 路径不是文件：$executable"
    }
    $asset = switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
        'X64' { 'cloudflared-windows-amd64.exe' }
        'X86' { 'cloudflared-windows-386.exe' }
        default { throw '当前 Windows 架构没有自动下载项，请将可用的 cloudflared.exe 放在项目根目录。' }
    }
    $release = @(Get-Content -LiteralPath (Join-Path $ProjectRoot 'scripts\tunnel\cloudflared-release.txt') -ErrorAction Stop |
        ForEach-Object { $fields = $_.Trim() -split '\s+'; if ($fields.Count -eq 3 -and $fields[1] -eq $asset) { ,$fields } })
    if ($release.Count -ne 1 -or $release[0][0] -notmatch '^\d{4}\.\d+\.\d+$' -or $release[0][2] -notmatch '^[a-fA-F0-9]{64}$') {
        throw "cloudflared 下载清单无效或缺少 $asset，请获取完整的项目脚本。"
    }
    $version = $release[0][0]
    $checksum = $release[0][2]
    $url = "https://github.com/cloudflare/cloudflared/releases/download/$version/$asset"
    $download = "$executable.download-$([Guid]::NewGuid().ToString('N')).exe"
    Write-Host "[*] 正在从 Cloudflare 官方发布下载 cloudflared $version 到项目根目录..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing -TimeoutSec 180 -ErrorAction Stop
        # 从 PowerShell 7 调起 5.1 时，避免继承的 PSModulePath 选错内置模块。
        Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256 -ErrorAction Stop).Hash -ine $checksum) { throw 'cloudflared 下载文件 SHA-256 校验失败' }
        if (-not (Test-CloudflaredApplication $download)) { throw '下载的 cloudflared 无法运行或版本检查失败' }
        Move-ToProjectArchive $executable $ProjectRoot
        Move-Item -LiteralPath $download -Destination $executable -ErrorAction Stop
        return $executable
    } finally {
        if (Test-Path -LiteralPath $download -PathType Leaf) { Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue }
    }
}

function Show-TunnelTokenHelp {
    Write-Host 'token 获取：Cloudflare 控制台 → Networking → Tunnels → 创建 Cloudflared 隧道，或选择已有隧道 → Add a replica（添加副本）。'
    Write-Host '控制台入口：https://dash.cloudflare.com/?to=/:account/tunnels'
    Write-Host '复制安装命令中 eyJ 开头的完整 token，可直接粘贴，或保存到 data\config\cloudflared-token（不要带 .txt 后缀）。'
    Write-Host '部署时可输入 token 或文件路径；留空读取 data\config\cloudflared-token，已设置的 TUNNEL_TOKEN_FILE / TUNNEL_TOKEN 环境变量优先。'
    Write-Host '默认文件直接用于运行；直接粘贴的 token 也保存到 data\config\cloudflared-token。'
}

function ConvertTo-TunnelTokenValue([string]$Value) {
    # Only remove paste formatting; do not turn arbitrary text or a path into a token.
    $clean = $Value -replace '[\s"''\uFEFF]', ''
    if ($clean -cmatch '^eyJ[A-Za-z0-9+/_-]{17,}={0,2}$') { return $clean }
    return $null
}

function Read-TunnelTokenFile([string]$Path) {
    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction Stop
    $match = [regex]::Match($content, '(?m)^[ \t]*(?:export[ \t]+)?TUNNEL_TOKEN[ \t]*=(.*)$')
    if ($match.Success) { return ConvertTo-TunnelTokenValue $match.Groups[1].Value }
    # A bare base64 token may end in "=" or "=="; that does not make it a .env assignment.
    return ConvertTo-TunnelTokenValue $content
}

function Resolve-TunnelToken([string]$ProjectRoot, [string]$InputValue = '') {
    $path = $null
    $value = $null
    $kind = 'file'
    $display = ''
    $selection = $InputValue.Trim().Trim('"').Trim("'")
    if ($selection) {
        try {
            $candidate = if ([IO.Path]::IsPathRooted($selection)) { [IO.Path]::GetFullPath($selection) } else {
                [IO.Path]::GetFullPath((Join-Path $ProjectRoot $selection))
            }
            if ([IO.File]::Exists($candidate)) { $path = $candidate }
        } catch { }
        if (-not $path) {
            $value = ConvertTo-TunnelTokenValue $selection
            if (-not $value) { throw '未找到 token 文件或输入格式无效；请输入文件路径或 eyJ 开头的完整 token。' }
            $kind = 'input'
            $display = '直接输入（值已隐藏）'
        }
    } elseif (-not [string]::IsNullOrWhiteSpace($env:TUNNEL_TOKEN_FILE)) {
        $selection = $env:TUNNEL_TOKEN_FILE.Trim().Trim('"').Trim("'")
        try {
            $path = if ([IO.Path]::IsPathRooted($selection)) { [IO.Path]::GetFullPath($selection) } else {
                [IO.Path]::GetFullPath((Join-Path $ProjectRoot $selection))
            }
        } catch { throw 'TUNNEL_TOKEN_FILE 路径无效。' }
    } elseif (-not [string]::IsNullOrWhiteSpace($env:TUNNEL_TOKEN)) {
        $value = ConvertTo-TunnelTokenValue $env:TUNNEL_TOKEN
        $kind = 'env'
        $display = 'env:TUNNEL_TOKEN（值已隐藏）'
    } else {
        $path = Join-Path $ProjectRoot 'data\config\cloudflared-token'
    }
    if ($path) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw '找不到隧道 token 文件；请检查 TUNNEL_TOKEN_FILE，或保存到 data\config\cloudflared-token。'
        }
        try { $value = Read-TunnelTokenFile $path }
        catch { throw '无法读取隧道 token 文件，请检查文件权限和编码。' }
        $display = $path
    }
    if (-not $value) { throw 'token 为空或格式无效；需要 eyJ 开头的完整 token，.env 文件需包含 TUNNEL_TOKEN。' }
    return [pscustomobject]@{ Token = $value; Kind = $kind; Path = $path; Display = $display }
}

function Save-ProjectTunnelToken([string]$ProjectRoot, [string]$Token) {
    $value = ConvertTo-TunnelTokenValue $Token
    if (-not $value) { throw '不能保存无效的隧道 token。' }
    $path = Join-Path $ProjectRoot 'data\config\cloudflared-token'
    New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
    # Reuse an already normalized default file without rewriting it.
    $current = if (Test-Path -LiteralPath $path -PathType Leaf) { [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($path)) } else { $null }
    if ($current -cne $value) { [IO.File]::WriteAllText($path, $value, [Text.UTF8Encoding]::new($false)) }
    Protect-ProjectSecretPath $path
    return $path
}

function Read-TunnelTokenInput {
    $secret = Read-Host '隧道 token 或文件路径（输入隐藏；留空自动读取，默认 data\config\cloudflared-token）' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secret.Dispose()
    }
}

function Get-ServiceStateLabel($State) {
    switch ([string]$State) {
        "Running" { return "运行中" }
        "Stopped" { return "已停止" }
        "StartPending" { return "正在启动" }
        "StopPending" { return "正在停止" }
        default { return [string]$State }
    }
}

function Test-Hostname([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 253) { return $false }
    foreach ($label in $Value.Split('.')) {
        if ($label.Length -lt 1 -or $label.Length -gt 63 -or
            $label -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$') {
            return $false
        }
    }
    return $true
}

# 把用户输入规范化成裸 hostname。允许直接填 https://bot.example.com 这种整段 URL——
# 从浏览器地址栏复制粘贴是最自然的动作——但只接受不带端口、路径、查询和凭据的根地址，
# 其余一律判为无效，免得把一段面目不清的输入写进部署状态。
function ConvertTo-Hostname([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $candidate = $Value.Trim()
    if (Test-Hostname $candidate) { return $candidate.ToLowerInvariant() }

    $uri = $null
    if ([Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri) -and
        $uri.Scheme -in @("http", "https") -and
        $uri.IsDefaultPort -and
        [string]::IsNullOrEmpty($uri.UserInfo) -and
        $uri.AbsolutePath -eq "/" -and
        [string]::IsNullOrEmpty($uri.Query) -and
        [string]::IsNullOrEmpty($uri.Fragment) -and
        (Test-Hostname $uri.DnsSafeHost)) {
        return $uri.DnsSafeHost.ToLowerInvariant()
    }
    return $null
}

# 临时按 UTF-8 解码 Bun 等原生命令的输出，finally 恢复控制台原编码。
# Windows 系统工具可能使用本地代码页，因此不全局切换；没有控制台时跳过编码设置。
function Invoke-WithUtf8Output([Parameter(Mandatory = $true)][scriptblock]$Command) {
    $previous = $null
    try {
        $previous = [Console]::OutputEncoding
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    } catch {
        $previous = $null
    }
    try {
        & $Command
    } finally {
        if ($null -ne $previous) {
            try { [Console]::OutputEncoding = $previous } catch { }
        }
    }
}

# 提示不复用调用方的 Warn：start-tunnel.ps1 没有定义它，共用文件不该对宿主脚本
# 有隐式要求。输出与 deploy.ps1 / ops.ps1 原来的 Warn 完全一致。
function Read-YesNo([string]$Prompt, [bool]$Default = $false) {
    while ($true) {
        $rawAnswer = Read-Host $Prompt
        $answer = if ($null -eq $rawAnswer) { "" } else { $rawAnswer.Trim().ToLowerInvariant() }
        if (-not $answer) { return $Default }
        if ($answer -in @("y", "yes", "是")) { return $true }
        if ($answer -in @("n", "no", "否")) { return $false }
        Write-Host "[!] 请输入 y 或 n（也可直接回车采用默认值）" -ForegroundColor Yellow
    }
}
function Test-ProjectBotHealth([string]$ProjectRoot, [int]$ListenPort) {
    try {
        $expected = Get-Content -LiteralPath (Join-Path $ProjectRoot 'data\state\instance.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$ListenPort/health")
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        try {
            if ([int]$response.StatusCode -ne 200) { return $false }
            $reader = New-Object IO.StreamReader($response.GetResponseStream())
            try { $body = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
            return ($body.service -ceq 'mixin-chatbot' -and $body.version -eq 1 -and $body.status -ceq 'ready' -and
                $body.instanceId -cmatch '^[a-f0-9-]{36}$' -and $body.instanceId -ceq $expected.instanceId -and
                $body.pid -gt 0 -and $body.pid -eq $expected.pid -and $expected.port -eq $ListenPort -and
                $body.startedAt -gt 0 -and $body.startedAt -eq $expected.startedAt)
        } finally { $response.Close() }
    } catch { return $false }
}

function Test-ModelConfiguration([string]$ProjectRoot) {
    try {
        $bun = @(Get-ApplicationPaths 'bun' | Select-Object -First 1)
        if ($bun.Count -ne 1) { return $false }
        & $bun[0] run (Join-Path $ProjectRoot 'scripts\config\validate-models.ts') $ProjectRoot 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
