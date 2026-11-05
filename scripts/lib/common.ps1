# Windows 脚本共用入口：加载实例控制、部署事务和交互/路径辅助函数。
# 用法：. (Join-Path $PSScriptRoot "..\lib\common.ps1")

. (Join-Path $PSScriptRoot 'lifecycle.ps1')
. (Join-Path $PSScriptRoot 'deployment.ps1')
. (Join-Path $PSScriptRoot 'console-plan.ps1')
. (Join-Path $PSScriptRoot 'bot-supervisor.ps1')

# 控制台沿用相同运维命令，但建议指向控制台中真实存在的页面；命令行调用仍显示可直接执行的命令。
function Get-OpsCommandHint([string]$Command) {
    if ($env:MIXIN_OPS_UI -eq 'console') {
        $paths = @{
            'deploy' = '维护 → 重新部署'
            'update' = '维护 → 升级'
            'resume' = '维护 → 继续上次操作'
            'rollback' = '维护 → 回滚上次操作'
            'start' = '维护 → 启动'
            'stop' = '维护 → 停止'
            'restart' = '维护 → 重启'
            'repair' = '维护 → 修复部署'
            'doctor -Repair' = '维护 → 修复部署'
            'doctor' = '体检 → 刷新'
            'status' = '总览 → 刷新'
            'logs' = '日志'
            'configure-app-bot' = '设置 → 应用机器人凭据'
            'relay-configure' = '设置 → 外链配置'
            'directory' = '通讯录'
        }
        if ($paths.ContainsKey($Command)) { return "「$($paths[$Command])」" }
    }
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

# 子进程直接使用本进程的控制台（标准输入、输出、错误都不重定向），返回退出码。函数的返回值被收集时，& 调用的原生
# 命令输出会改走管道：没有换行的提示（[Y/n]）要等用户回车才显示，子进程里的向导也没有终端。等子进程自己结束，
# Ctrl+C 由同一控制台上的子进程处理。参数按 Windows 命令行规则加引号。
# -Screen：标准输入是控制台而标准输出或标准错误是管道时（1.0.1 及更早的 ops.ps1 经 `| Out-Host` 运行目标升级器），
# 子进程的输出和错误改接到控制台的屏幕缓冲区（CONOUT$），让它像在终端里一样运行；本进程的标准句柄只在启动子进程的
# 一瞬间替换，随即换回。打不开 CONOUT$（没有控制台）时照常继承。
# -Environment：只给这个子进程的变量。本进程的环境不改：取消设置时 .NET 会删掉原本为空的变量，而控制台任务的核心要逐项
# 核对接单时的环境（空值也算）。
function Invoke-ConsoleProcess([string]$FilePath, [string[]]$Arguments, [switch]$Screen, [hashtable]$Environment = @{}) {
    $quoted = foreach ($argument in $Arguments) {
        if ($argument.Length -gt 0 -and $argument -notmatch '[\s"]') { $argument }
        else { '"' + ($argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }
    }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = @($quoted) -join ' '
    $info.UseShellExecute = $false
    $info.WorkingDirectory = (Get-Location -PSProvider FileSystem).ProviderPath
    foreach ($name in $Environment.Keys) { $info.EnvironmentVariables[$name] = [string]$Environment[$name] }
    $screenHandle = [IntPtr]::Zero
    $saved = @()
    if ($Screen -and (Test-ConsoleOutputPiped)) {
        Add-ConsoleScreenType
        $screenHandle = [MixinConsoleScreen]::Open()
        if ($screenHandle -ne [IntPtr]::Zero) {
            # STD_OUTPUT_HANDLE、STD_ERROR_HANDLE。Process.Start 不重定向时由 CreateProcess 继承本进程当时的标准句柄。
            foreach ($which in @(-11, -12)) {
                $saved += , @($which, [MixinConsoleScreen]::GetStdHandle($which))
                [void][MixinConsoleScreen]::SetStdHandle($which, $screenHandle)
            }
        }
    }
    try { $process = [Diagnostics.Process]::Start($info) }
    finally {
        foreach ($entry in $saved) { [void][MixinConsoleScreen]::SetStdHandle($entry[0], $entry[1]) }
        if ($screenHandle -ne [IntPtr]::Zero) { [void][MixinConsoleScreen]::CloseHandle($screenHandle) }
    }
    try { $process.WaitForExit(); return $process.ExitCode } finally { $process.Dispose() }
}

# 标准输入是控制台，而标准输出或标准错误是管道：1.0.1 及更早的 ops.ps1 经 `| Out-Host` 运行目标升级器时就是这样。
function Test-ConsoleOutputPiped {
    return (-not [Console]::IsInputRedirected) -and ([Console]::IsOutputRedirected -or [Console]::IsErrorRedirected)
}

# 控制台屏幕缓冲区的可继承句柄（CONOUT$），以及读写本进程标准句柄的 Win32 调用。只在用到时编译一次。
function Add-ConsoleScreenType {
    if ('MixinConsoleScreen' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MixinConsoleScreen {
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int Length; public IntPtr Descriptor; public bool Inherit; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, ref SecurityAttributes attributes,
        uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetStdHandle(int which, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
    /// <summary>The console's active screen buffer as an inheritable handle, or IntPtr.Zero without a console.</summary>
    public static IntPtr Open() {
        var attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Inherit = true };
        // GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING
        IntPtr handle = CreateFileW("CONOUT$", 0xC0000000, 3, ref attributes, 3, 0, IntPtr.Zero);
        return handle == new IntPtr(-1) ? IntPtr.Zero : handle;
    }
}
'@
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
    if ($env:MIXIN_OPS_CONSOLE -ceq '1') { throw '控制台操作遇到未提供的交互选择，请重新预览；未自动采用默认值' }
    while ($true) {
        # 标准输出是管道时（见 Test-ConsoleOutputPiped），没有换行的提示要等回车后才显示：提示单独成行，再在下一行读回答。
        $rawAnswer = if (Test-ConsoleOutputPiped) { Write-Host $Prompt; Read-Host } else { Read-Host $Prompt }
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
        & $bun[0] --no-env-file run (Join-Path $ProjectRoot 'scripts\config\validate-models.ts') $ProjectRoot 2>$null | Out-Null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}
