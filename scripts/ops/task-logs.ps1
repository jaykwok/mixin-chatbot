[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$TaskId,
    [ValidateRange(0, 100)]
    [int]$Context = 3,
    [string]$LogDir,
    [Alias('h')]
    [switch]$Help
)

# Keep this file UTF-8 with BOM for Windows PowerShell 5.1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

function Show-Usage {
    Write-Output '用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ops/task-logs.ps1 <任务ID> [-Context 3] [-LogDir <日志目录>]'
    Write-Output '任务 ID 为 8 位十六进制，例如 555d838a。扫描当前及轮转日志，结果写入项目 backup/tmp。'
    Write-Output '退出码：0=找到任务；2=没有匹配日志；1=参数或读取/写入失败。'
}

if ($Help) { Show-Usage; exit 0 }
if ($TaskId -notmatch '^[0-9a-fA-F]{8}$') {
    Show-Usage
    [Console]::Error.WriteLine('请提供完整的 8 位任务 ID。')
    exit 1
}
$TaskId = $TaskId.ToLowerInvariant()
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $LogDir) { $LogDir = Join-Path $project 'logs' }
$outputDir = $null
$taskWriter = $null
$contextWriter = $null

function Write-ContextEntry($Entry) {
    if ($Entry.Number -le $script:lastWritten) { return }
    if ($script:lastWritten -gt 0 -and $Entry.Number -gt $script:lastWritten + 1) {
        $contextWriter.WriteLine('--')
    }
    $contextWriter.WriteLine($Entry.Text)
    $script:lastWritten = $Entry.Number
}

function Show-Record([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '（保留日志中未找到）' }
    return $Text
}

try {
    $LogDir = [IO.Path]::GetFullPath($LogDir)
    $files = @(Get-ChildItem -LiteralPath $LogDir -File |
        Where-Object {
            $_.Name -cmatch '^mixin-chatbot\.log(?:\.[1-9][0-9]*)?$' -and
            -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
        } |
        Sort-Object -Property @{
            Expression = { if ($_.Name -match '\.([0-9]+)$') { [long]$Matches[1] } else { 0 } }
            Descending = $true
        })
    if ($files.Count -eq 0) {
        [Console]::Error.WriteLine("没有找到 mixin-chatbot.log 或数字后缀的轮转日志：$LogDir")
        exit 2
    }

    $name = 'task-logs-' + $TaskId + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $outputDir = Join-Path (Join-Path $project 'backup/tmp') $name
    [IO.Directory]::CreateDirectory($outputDir) | Out-Null
    $taskWriter = New-Object IO.StreamWriter((Join-Path $outputDir 'task.log'), $false, $utf8)
    $contextWriter = New-Object IO.StreamWriter((Join-Path $outputDir 'context.log'), $false, $utf8)
    $pattern = New-Object Text.RegularExpressions.Regex(
        ('任务(?::|：)\s*' + $TaskId + '(?![0-9A-Za-z_-])'),
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    $recent = New-Object 'System.Collections.Generic.Queue[object]'
    $lineNumber = 0
    $lastWritten = 0
    $through = 0
    $count = 0
    $starts = 0
    $latestModel = ''
    $modelAtFirstMatch = ''
    $firstMatch = ''
    $lastMatch = ''
    $lastHeartbeat = ''
    $timeoutRecord = ''
    $modelIdleRecord = ''
    $lastStreamEnd = ''

    # Scan oldest rotation first; the context buffer spans rotation boundaries.
    foreach ($file in $files) {
        $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read,
            ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        $reader = New-Object IO.StreamReader($stream, $utf8, $true)
        try {
            $fileLine = 0
            while ($null -ne ($line = $reader.ReadLine())) {
                $fileLine++
                $lineNumber++
                $text = '{0}:{1}: {2}' -f $file.Name, $fileLine, $line
                $entry = [pscustomobject]@{ Number = $lineNumber; Text = $text }
                $recent.Enqueue($entry)
                if ($recent.Count -gt $Context + 1) { $recent.Dequeue() | Out-Null }

                if ($line.Contains('Pi ModelRuntime 就绪')) { $latestModel = $text }
                if ($pattern.IsMatch($line)) {
                    if ($count -eq 0) {
                        $firstMatch = $text
                        $modelAtFirstMatch = $latestModel
                    }
                    $count++
                    $lastMatch = $text
                    if ($line.Contains('任务开始 -')) { $starts++ }
                    if ($line.Contains('任务仍在运行 -')) { $lastHeartbeat = $text }
                    if ($line.Contains('任务总时限到达 -')) { $timeoutRecord = $text }
                    if ($line.Contains('模型无有效进展超时 -')) { $modelIdleRecord = $text }
                    if ($line.Contains('模型流结束 -')) { $lastStreamEnd = $text }
                    $taskWriter.WriteLine($text)
                    foreach ($previous in $recent) { Write-ContextEntry $previous }
                    $through = $lineNumber + $Context
                } elseif ($lineNumber -le $through) {
                    Write-ContextEntry $entry
                }
            }
        } finally {
            $reader.Dispose()
        }
    }

    $summary = @(
        '任务日志提取',
        "任务 ID: $TaskId",
        "日志目录: $LogDir",
        "匹配行数: $count",
        "前后文: 各 $Context 行",
        '扫描顺序（旧到新）:'
    ) + @($files | ForEach-Object { '  ' + $_.Name }) + @(
        '',
        '模型信息（首次匹配前最近的就绪记录）:',
        (Show-Record $modelAtFirstMatch),
        '',
        '首条任务记录:',
        (Show-Record $firstMatch),
        '',
        '最后一条运行心跳（含耗时、阶段、最近进展距今）:',
        (Show-Record $lastHeartbeat),
        '',
        '总时限到达记录（取消清理前）:',
        (Show-Record $timeoutRecord),
        '',
        '模型无有效进展超时记录（取消清理前）:',
        (Show-Record $modelIdleRecord),
        '',
        '最后一条模型流结束记录（含流统计和结束原因）:',
        (Show-Record $lastStreamEnd),
        '',
        '最后一条任务记录:',
        (Show-Record $lastMatch),
        '',
        'task.log: 仅任务匹配行；context.log: 匹配行及前后文，重叠行只保留一次。',
        '每行带原日志文件名和行号；-- 表示省略了不相关的日志。',
        '接收模型输出阶段要结合有效内容增长和流事件统计判断；旧版本可能未记录这些字段，本报告不直接断言超时原因。',
        '这是已写入日志的一次读取，运行中的任务可能继续产生日志。'
    )
    if ($count -eq 0) {
        $summary += '未找到任务。请确认任务 ID、生产实例及日志目录；较早日志可能已轮转覆盖。'
    } elseif ($starts -eq 0) {
        $summary += '未找到任务开始记录，当前提取的任务日志可能不完整。'
    } elseif ($starts -gt 1) {
        $summary += '同一短任务 ID 有多条开始记录，请按时间、群和用户区分任务。'
    }
    $summary += '日志保留原文，前后文可能包含其他任务；分享前请脱敏。'
    [IO.File]::WriteAllLines((Join-Path $outputDir 'summary.txt'), [string[]]$summary, $utf8)
    $summary | Write-Output
    Write-Output ''
    Write-Output "结果目录: $outputDir"
} catch {
    [Console]::Error.WriteLine('提取失败：' + $_.Exception.Message)
    if ($outputDir) { [Console]::Error.WriteLine("已写入的内容保留在：$outputDir") }
    exit 1
} finally {
    if ($taskWriter) { $taskWriter.Dispose() }
    if ($contextWriter) { $contextWriter.Dispose() }
}
if ($count -eq 0) { exit 2 }
exit 0
