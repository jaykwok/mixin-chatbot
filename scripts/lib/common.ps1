# Windows 脚本共用的纯辅助函数。deploy.ps1 / ops.ps1 / start-tunnel.ps1 都 dot-source 它。
#
# 这里只放「不依赖调用方任何变量、也不碰部署状态」的东西：主机名校验、可执行文件发现、
# 服务状态翻译、交互提示。Docker、计划任务、隧道这些核心流程各脚本继续各自维护——它们
# 的差异是本质的，硬抽出来只会做出一个到处是 if 的四不像。
#
# 用法：. (Join-Path $PSScriptRoot "..\lib\common.ps1")

# 列出 PATH 上某个命令的全部真实可执行文件。Get-Command 会把 .cmd shim 和无扩展名的
# 同名文件一并报出来，逐个验证过再交给调用方，避免把一个 shim 当成真程序。
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
