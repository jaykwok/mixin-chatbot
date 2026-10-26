# Windows 脚本共用入口：加载实例控制、部署事务和交互/路径辅助函数。
# 用法：. (Join-Path $PSScriptRoot "..\lib\common.ps1")

. (Join-Path $PSScriptRoot 'lifecycle.ps1')
. (Join-Path $PSScriptRoot 'deployment.ps1')
. (Join-Path $PSScriptRoot 'bot-supervisor.ps1')

# 交互界面沿用相同运维命令，但建议指向界面中真实存在的入口。
function Get-OpsCommandHint([string]$Command) {
    if ($env:MIXIN_OPS_TUI -eq '1') {
        $paths = @{
            'deploy' = '系统 → 服务部署 → 重新部署'
            'update' = '系统 → 服务部署 → 升级'
            'resume' = '系统 → 服务部署 → 继续上次操作'
            'rollback' = '系统 → 服务部署 → 回滚上次操作'
            'start' = '系统 → 服务部署 → 启动'
            'stop' = '系统 → 服务部署 → 停止'
            'restart' = '系统 → 服务部署 → 重启'
            'doctor -Repair' = '系统 → 服务部署 → 修复部署'
            'uninstall' = '系统 → 服务部署 → 卸载'
            'doctor' = '监控 → 体检（按 r 刷新）'
            'logs' = '监控 → 日志'
            'configure-app-bot' = '系统 → 设置 → 应用机器人'
            'directory-confirm' = '系统 → 通讯录 → 确认暂停的撤销'
        }
        if ($paths.ContainsKey($Command)) { return "「$($paths[$Command])」" }
        if ($Command -eq 'configure') {
            return '先修正 data/config/models.json 和 data/runtime/pi/settings.json；配置有效后，可在「系统 → 设置 → 模型配置」重新选择模型'
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

# 未完成的部署或升级只能继续或回滚；非交互调用必须用 resume / rollback 明确指定。返回空串表示不处理。
function Read-TransactionAction {
    if ([Console]::IsInputRedirected) {
        throw "发现未完成的部署或升级；请使用 $(Get-OpsCommandHint 'resume') 继续，或 $(Get-OpsCommandHint 'rollback') 回滚"
    }
    while ($true) {
        switch ((Read-Host '1 继续上次操作  2 回滚到操作前  0 退出 [默认 0]').Trim()) {
            '1' { return 'continue' }
            '2' { return 'rollback' }
            '' { return '' }
            '0' { return '' }
            default { Write-Host '请输入 1、2 或 0' -ForegroundColor Yellow }
        }
    }
}

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
function Test-ProjectBotHealth([string]$ProjectRoot, [int]$ListenPort, [switch]$AllowVerification, [ref]$VerificationOnly) {
    if ($VerificationOnly) { $VerificationOnly.Value = $false }
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
            $matches = ($body.service -ceq 'mixin-chatbot' -and $body.version -eq 1 -and $body.status -ceq 'ready' -and
                $body.instanceId -cmatch '^[a-f0-9-]{36}$' -and $body.instanceId -ceq $expected.instanceId -and
                $body.pid -gt 0 -and $body.pid -eq $expected.pid -and $expected.port -eq $ListenPort -and
                $body.startedAt -gt 0 -and $body.startedAt -eq $expected.startedAt)
            if (-not $matches) { return $false }
            if ($VerificationOnly) { $VerificationOnly.Value = [bool]$body.verificationOnly }
            return ($AllowVerification -or -not $body.verificationOnly)
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
