# Windows 脚本共用入口：加载实例控制、部署事务和交互/路径辅助函数。
# 用法：. (Join-Path $PSScriptRoot "..\lib\common.ps1")

. (Join-Path $PSScriptRoot 'lifecycle.ps1')
. (Join-Path $PSScriptRoot 'deployment.ps1')

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

function Test-ModelConfiguration([string]$ProjectRoot, [string]$ModelPath) {
    try {
        $bun = @(Get-ApplicationPaths 'bun' | Select-Object -First 1)
        if ($bun.Count -ne 1) { return $false }
        & $bun[0] run (Join-Path $ProjectRoot 'scripts\config\validate-models.ts') $ModelPath 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
