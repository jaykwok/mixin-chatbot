# mixin-chatbot - Windows Server 部署入口（原生 Bun，无需 Docker）。
# agent 的 bash 工具需要 bash.exe；请安装 Git for Windows（同时提供 git）。运行时：Bun（https://bun.sh）和 uv。
# 服务运行时完成全部准备：找到工具，确认端口和共享资料目录，核对数据版本，运行配置向导（回答写进本次的暂存目录，不改项目
# 文件），预览旧修订链，选择通讯录同步范围，算出运行参数；再交给共享运维核心（scripts\ops\core）。核心在部署锁内逐项复核后
# 记录事务、停止机器人、写入配置、安装依赖、迁移、注册计划任务（优先开机启动、无需用户登录；失败自动重试）、验证并提交；提交
# 前失败自动回滚，首次部署的回滚不留计划任务。部署不移动代码。未完成的事务由 ops.ps1 resume / rollback 处理。
# 消息经平台事件 Stream 主动连出接收（imtwo.zdxlz.com、imfl.zdxlz.com 的 443 端口）；HTTP 只监听 127.0.0.1，无需入站端口。
#
# 请在管理员 PowerShell 中运行：
#   powershell -ExecutionPolicy Bypass -File scripts\deploy\deploy.ps1
$ErrorActionPreference = 'Stop'
$Project = if ($env:MIXIN_OPS_PROJECT) { (Resolve-Path -LiteralPath $env:MIXIN_OPS_PROJECT).Path } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
# 运维核心随本脚本的版本运行（控制台任务运行冻结的运行包）；数据工具和配置向导属于要部署的代码，取自项目。
$ReleaseRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ($env:MIXIN_OPS_CONSOLE -ceq '1') { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding }
Set-Location $Project
$CommonLib = Join-Path $PSScriptRoot '..\lib\common.ps1'
if (-not (Test-Path -LiteralPath $CommonLib -PathType Leaf)) {
    Write-Host "缺少 $CommonLib；请从仓库完整获取脚本目录后重试。" -ForegroundColor Red
    exit 1
}
. $CommonLib
$operation = Start-OperationLog $Project 'deploy'
$operationExit = 1
$Stage = ''
$Unchanged = '服务尚未停止，未做任何改动'
try {
$DataDir = Join-Path $Project 'data'
$ConfigDir = Join-Path $DataDir 'config'
$StateDir = Join-Path $DataDir 'state'
$ModelsFile = Join-Path $ConfigDir 'models.json'
$SettingsFile = Join-Path $DataDir 'runtime\pi\settings.json'
$AppBotFile = Join-Path $ConfigDir 'app-bot.json'
$PortFile = Join-Path $StateDir 'bot-port'
$DefaultWorkspace = Join-Path $DataDir 'workspace'

function Step($m) { Write-Host "[*] $m" -ForegroundColor Cyan; Set-OperationStage $m }
function Done($m) { Write-Host "[+] $m" -ForegroundColor Green; Write-OperationEvent 'info' $m }
function Fail($m) { Write-Host $m -ForegroundColor Red; Write-OperationEvent 'error' $m }

# ---- 1. 运行环境 ----
Step "检查运行环境..."
if (-not (Test-Administrator)) { throw "部署需要管理员权限；请在管理员终端中使用 $(Get-OpsCommandHint 'deploy')。" }
$tools = Find-DeployTools
$gitPath = $tools.Git; $bashPath = $tools.Bash; $bunPath = $tools.Bun; $uvPath = $tools.Uv
Done "已找到 git（$gitPath）和 GNU bash（$bashPath）"
Done "bun 版本：$($tools.BunVersion)"
foreach ($required in @('package.json', 'src\server\index.ts', 'scripts\config\configure.ts')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Project $required) -PathType Leaf)) { Fail "缺少必要文件：$required"; exit 1 }
}

# ---- 2. 未完成的事务和只读预检 ----
foreach ($pointer in @('deploy-transaction', 'upgrade-transaction')) {
    if (Test-Path -LiteralPath (Join-Path $StateDir $pointer)) {
        $kind = if ($pointer -ceq 'deploy-transaction') { '部署' } else { '升级' }
        Fail "发现未完成的$kind（data\state\$pointer）。续做和回滚只使用事务记录，不重新部署；请使用 $(Get-OpsCommandHint 'resume') 继续，或 $(Get-OpsCommandHint 'rollback') 回滚。"
        exit 1
    }
}
Assert-ConsoleLifecycle 'deploy' $Project
$core = Join-Path $ReleaseRoot 'scripts\ops\core\cli.ts'
# 部署锁、运维任务和计划任务归属先由核心只读检查一次，提问之前就能拒绝；交接后它在锁内再查。
Set-OperationStage 'deploy-preflight'
if ((Invoke-ConsoleProcess $bunPath @('--no-env-file', $core, 'deployment', 'deploy', '--project', $Project, '--preflight', '--git-path', $gitPath)) -ne 0) {
    throw "部署预检未通过（原因见上方）；$Unchanged"
}
# 上次被强行终止的部署留下的暂存（含应用凭据）：一天以前的不再有用，更新的可能属于正在进行的另一次部署。链接不跟随。
$tmpDir = Join-Path $Project 'tmp'
if (Test-Path -LiteralPath $tmpDir -PathType Container) {
    Get-ChildItem -LiteralPath $tmpDir -Directory -Force | Where-Object {
        $_.Name -cmatch '^deploy-stage-[0-9a-f]{8}$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.LastWriteTime -lt (Get-Date).AddDays(-1)
    } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
# 停机前的核对和配置向导要用依赖：首次部署先安装（这时没有可以停止的服务进程）。核心停机后照常重新安装。
if (-not (Test-Path -LiteralPath (Join-Path $Project 'node_modules') -PathType Container)) {
    Step '首次部署：先安装依赖（bun install --frozen-lockfile），供停机前的核对和配置向导使用...'
    $installCode = Invoke-ConsoleProcess $bunPath @('install', '--frozen-lockfile')
    if ($installCode -ne 0) { throw "bun install 执行失败（退出码 $installCode）；$Unchanged" }
}

# ---- 3. 本机管理端口（不询问：显式 BOT_PORT 高级覆盖 > 已保存值 > 1011）----
# 无效或被其他程序占用的端口在停机前停止并说明改法，不自动换成别的端口。
$savedPort = if (Test-Path -LiteralPath $PortFile) { "$(Get-Content -LiteralPath $PortFile -Raw)".Trim() } else { $null }
$portSource = ""
$rawPort = if (-not [string]::IsNullOrWhiteSpace($env:BOT_PORT)) { $portSource = "BOT_PORT"; $env:BOT_PORT.Trim() }
    elseif ($null -ne $savedPort) { $portSource = "data\state\bot-port"; $savedPort }
    else { "1011" }
$portFix = "改端口：设置环境变量 BOT_PORT=<端口> 后重新部署（$(Get-OpsCommandHint deploy)）；服务尚未停止"
$portNumber = 0
if (-not ([int]::TryParse($rawPort, [ref]$portNumber) -and $portNumber -ge 1 -and $portNumber -le 65535)) {
    throw "$portSource 中的端口无效（应为 1–65535 的整数）：$rawPort；$portFix"
}
$Port = "$portNumber"
# 沿用的端口可能正由原服务监听，不探测；新端口（含首次部署）要先确认没有其他程序占用。
if ($Port -ne $savedPort) {
    $probe = [System.Net.Sockets.TcpClient]::new()
    try {
        $inUse = $false
        try { $inUse = $probe.ConnectAsync('127.0.0.1', $portNumber).Wait(2000) } catch { $inUse = $false }
    } finally { $probe.Dispose() }
    if ($inUse) { throw "本机端口 $Port 已被其他程序占用；$portFix" }
}
Done "本机管理端口：127.0.0.1:$Port$(if ($portSource) { "（来自 $portSource）" })"

# ---- 4. 共享资料目录（默认 data\workspace；WORKSPACE_ROOT 可指向已存在的外置目录，服务只读）----
# 取 WORKSPACE_ROOT，未设置时沿用已保存设置；设为 data\workspace 即恢复默认。外置目录不创建。
$workspaceRequest = if (-not [string]::IsNullOrWhiteSpace($env:WORKSPACE_ROOT)) { $env:WORKSPACE_ROOT.Trim() } else { Get-SavedWorkspaceRoot $Project }
$WorkspaceRoot = ''
if ($workspaceRequest) {
    try {
        $workspaceCandidate = if ([System.IO.Path]::IsPathRooted($workspaceRequest)) { [System.IO.Path]::GetFullPath($workspaceRequest) }
            else { [System.IO.Path]::GetFullPath((Join-Path $Project $workspaceRequest)) }
    } catch { throw "WORKSPACE_ROOT 路径无效：$workspaceRequest；$Unchanged" }
    if ($workspaceCandidate.TrimEnd('\') -ne $DefaultWorkspace.TrimEnd('\')) {
        if (-not (Test-Path -LiteralPath $workspaceCandidate -PathType Container)) { throw "共享资料目录不存在或不是目录：$workspaceCandidate；外置资料目录必须已存在；$Unchanged" }
        $WorkspaceRoot = (Resolve-Path -LiteralPath $workspaceCandidate).Path
    }
}
# 数据核对按最终资料目录检查布局；空字符串参数会被 Windows PowerShell 丢弃，默认目录写全路径。
$finalWorkspace = if ($WorkspaceRoot) { $WorkspaceRoot } else { $DefaultWorkspace }
Done "共享资料目录：$(if ($WorkspaceRoot) { "$WorkspaceRoot（外置，服务只读）" } else { "$DefaultWorkspace（默认）" })"

# ---- 5. 停机前的准备：只读取和校验，回答写进本次的私有暂存目录 ----
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
$Stage = Join-Path $tmpDir ('deploy-stage-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Stage -ErrorAction Stop | Out-Null
# 暂存含应用凭据：只有当前用户、SYSTEM 和管理员可读；核心在部署锁内读一次后存入事务快照，本脚本退出时删除。
Protect-ProjectSecretPath $Stage
$dataTool = Join-Path $Project 'scripts\runtime\data-current.ts'
if ((Test-Path -LiteralPath $ModelsFile -PathType Leaf) -and (Test-Path -LiteralPath $SettingsFile -PathType Leaf) -and (Test-Path -LiteralPath $AppBotFile -PathType Leaf)) {
    # 配置齐全时在停机前校验它，计划中的版本标记摘要用于停机后的 apply。
    Set-OperationStage 'data-preparation-preview'
    & $bunPath --no-env-file run $dataTool preview --project $Project --plan (Join-Path $Stage 'data-plan.json') --workspace $finalWorkspace
    if ($LASTEXITCODE -ne 0) { throw "数据版本或配置校验未通过（原因见上方）；$Unchanged" }
} else {
    # 首次部署（或缺少要由向导补上的配置）这里只核对数据版本：有数据但没有有效版本标记（含旧版 webhook 数据）时拒绝。
    # 配置写入之后由核心预检。
    & $bunPath --no-env-file run $dataTool check --project $Project --workspace $finalWorkspace
    if ($LASTEXITCODE -ne 0) { throw "数据版本核对未通过（原因见上方）；$Unchanged" }
}
# 控制台部署沿用网页确认的配置，不运行向导（Assert-ConsoleLifecycle 已要求配置齐全）。
if ($env:MIXIN_OPS_CONSOLE -ceq '1') {
    Done '沿用网页确认的模型与机器人配置'
} elseif (-not (Test-Path -LiteralPath $ModelsFile -PathType Leaf) -or -not (Test-Path -LiteralPath $SettingsFile -PathType Leaf)) {
    # 没有应用机器人配置时，这个向导先问它。
    Invoke-StagedWizard $bunPath $Project $Stage '首次配置 AI（provider/key/model）' 'configure.ts' 'configuration-models.json'
} else {
    if (-not (Test-Path -LiteralPath $AppBotFile -PathType Leaf)) { Invoke-StagedWizard $bunPath $Project $Stage '配置应用机器人凭据（AppID/AppSecret）' 'configure-app-bot.ts' 'configuration-app.json' }
    Done 'data\config\models.json 已存在'
    if (Read-YesNo "是否重新配置 AI（provider/key/model）？[y/N]" $false) { Invoke-StagedWizard $bunPath $Project $Stage '重新配置 AI（provider/key/model）' 'configure.ts' 'configuration-models.json' }
}
$stagedApp = Join-Path $Stage 'configuration-app.json'
if (-not (Test-Path -LiteralPath $AppBotFile -PathType Leaf) -and -not (Test-Path -LiteralPath $stagedApp -PathType Leaf)) { throw "没有得到应用机器人凭据（AppID/AppSecret）；$Unchanged" }
# 会话库的旧修订链：停机前只读预览，决定停机后整理或跳过。
Set-OperationStage 'revision-cleanup-preview'
$cleanup = Select-RevisionCleanup $bunPath (Join-Path $Project 'scripts\runtime\revision-cleanup.ts') $Project
# 通讯录同步范围必须明确选择：没有 data\config\directory.json 时在这里选定，计划由核心存入快照、停机后写入。
if (-not (Test-Path -LiteralPath (Join-Path $ConfigDir 'directory.json') -PathType Leaf)) {
    Set-OperationStage 'directory-scope'
    Select-DirectoryScope $bunPath (Join-Path $Project 'scripts\config\directory-scope.ts') $Project (Join-Path $Stage 'directory-scope-plan.json') $(if (Test-Path -LiteralPath $stagedApp -PathType Leaf) { $stagedApp } else { '' })
}
# 部署要写入的 runtime.json：现有文件加上环境中设置的受支持键（目标版本的 RUNTIME_KEYS），停机后由核心安装。端口、共享资料
# 目录和监听地址用本次确定的值，只交给这个工具；本进程的环境保持接单时的样子（见 Invoke-ConsoleProcess）。
Set-OperationStage 'runtime-values'
$runtimeCode = Invoke-ConsoleProcess $bunPath @('--no-env-file', 'run', (Join-Path $Project 'scripts\config\runtime-settings.ts'), '--prepare-values',
    (Join-Path $Stage 'runtime-values.json'), '--deployment', 'windows') -Environment @{ BOT_PORT = $Port; BOT_HOST = '127.0.0.1'; WORKSPACE_ROOT = $finalWorkspace }
if ($runtimeCode -ne 0) { throw "运行参数校验未通过（原因见上方）；$Unchanged" }
# 本次的选择和计划任务要运行的工具交给核心，它在部署锁内复核：提交须仍是这里读到的（解压得到的部署没有提交）。
$target = ''
try {
    $head = [string](& $gitPath -C $Project rev-parse --verify --quiet 'HEAD^{commit}' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $head.Trim() -cmatch '^[0-9a-f]{40}([0-9a-f]{24})?$') { $target = $head.Trim() }
} catch { $target = '' }
$utf8 = [Text.UTF8Encoding]::new($false)
$choices = [ordered]@{ format = 1; target = $target; port = $portNumber; workspace = $WorkspaceRoot; cleanup = $cleanup } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $Stage 'deployment.json'), $choices + "`n", $utf8)
[IO.File]::WriteAllText((Join-Path $Stage 'windows-tools'), "format=1`nbun=$bunPath`ngit=$gitPath`nuv=$uvPath`nbash=$bashPath`n", $utf8)

# ---- 6. 交给运维核心 ----
Set-OperationStage 'shared-deployment-core'
Step '交给运维核心：在部署锁内复核后记录事务并停止机器人服务；此后写入配置、安装依赖、迁移和验证期间服务保持停止'
$operationExit = Invoke-ConsoleProcess $bunPath @('--no-env-file', $core, 'deployment', 'deploy', '--project', $Project, '--stage', $Stage, '--command', 'deploy', '--git-path', $gitPath)
if ($operationExit -ne 0) {
    if (Test-Path -LiteralPath (Join-Path $StateDir 'deploy-transaction')) {
        Fail "部署未完成，事务已保留（原因见上方）；处理后可用 $(Get-OpsCommandHint 'resume') 继续，或 $(Get-OpsCommandHint 'rollback') 回滚（数据已提交时只能继续）。"
    }
} else {
    Done "机器人已启动（共享资料目录=$finalWorkspace）。停止请用 $(Get-OpsCommandHint 'stop')；日志：$(Get-OpsCommandHint 'logs')"
    Done "消息接收：平台事件 Stream（主动连出 imtwo.zdxlz.com、imfl.zdxlz.com 的 443 端口，无需入站端口或公网域名）。"
    Done "可选大文件外链：不超过 30 MiB 的文件直接发送；更大的文件需要外链，用 $(Get-OpsCommandHint 'relay-configure') 按需启用。"
}
} catch { Write-OperationFailure $_; throw }
finally {
    # 只删本次的暂存；事务快照有自己的副本。
    if ($Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
    Stop-OperationLog $operation $operationExit
}
exit $operationExit
