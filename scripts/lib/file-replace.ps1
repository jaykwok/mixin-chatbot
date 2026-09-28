. (Join-Path $PSScriptRoot 'operation-log.ps1')

# 替换小型状态文件：同目录临时文件写完并落盘后替换目标（目标不存在时改名），读者只会看到旧文件或完整的新文件。
# 另一个进程短暂占用时退避重试，总等待约 2 秒：共享冲突 32、锁冲突 33，以及 1175（目标删不掉，两个文件都没动）。
# 其他错误（权限、无效路径等）立即失败。1176/1177 表示替换只做了一半：目标可能已被移走或改名，
# 新内容只在临时文件里，此时保留临时文件并报告路径，交给上层恢复。
# 错误码取自异常链中的 HRESULT，Windows PowerShell 5.1 与 PowerShell 7 相同。

function Get-Win32ErrorCode([Exception]$Exception) {
    for ($current = $Exception; $current; $current = $current.InnerException) {
        if ((($current.HResult -shr 16) -band 0xFFFF) -eq 0x8007) { return $current.HResult -band 0xFFFF }
    }
    return $null
}

# 单次替换；测试覆盖这个函数来注入 1175–1177。-CreateOnly 只改名，目标已存在时失败（80/183），不覆盖。
function Move-FileOverTarget([string]$Temporary, [string]$Path, [switch]$CreateOnly) {
    # Windows PowerShell 5.1 binds $null to an empty string for .NET string arguments.
    if (-not $CreateOnly -and [IO.File]::Exists($Path)) { [IO.File]::Replace($Temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($Temporary, $Path) }
}

# $Writer 接收临时文件路径并写入完整内容。调用方用 GetNewClosure() 带入所需的值：否则按动态作用域查找，
# 会先找到这里的同名变量（PowerShell 变量名不区分大小写，例如 $path 会读到 $Path）。
# -CreateOnly 用于首次发布（例如事务指针）：目标已存在时立即失败并保留原文件，绝不覆盖。
function Save-FileAtomically([string]$Path, [scriptblock]$Writer, [switch]$CreateOnly) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $keepTemporary = $false
    try {
        & $Writer $temporary
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]'ReadWrite, Delete')
        try { $stream.Flush($true) } finally { $stream.Dispose() }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $attempt = 0
        $delay = 50
        while ($true) {
            $attempt++
            try { Move-FileOverTarget $temporary $Path -CreateOnly:$CreateOnly; break }
            catch {
                $failure = $_.Exception
                $code = Get-Win32ErrorCode $failure
                $detail = "目标 $Path，错误码 $(if ($null -ne $code) { $code } else { '未知' })，尝试 $attempt 次，耗时 $($clock.ElapsedMilliseconds) ms"
                if ($CreateOnly -and $code -in 80, 183) {
                    $message = "目标已存在，未覆盖（$detail）"
                    Write-OperationEvent 'error' $message
                    throw [IO.IOException]::new($message, $failure)
                }
                if ($code -in 1176, 1177) {
                    $keepTemporary = $true
                    $message = "替换文件中途失败（$detail）：目标可能已被移走或改名，新内容保留在 $temporary，未删除；恢复目标后重试。原始错误：$($failure.Message)"
                    Write-OperationEvent 'error' $message
                    throw [IO.IOException]::new($message, $failure)
                }
                $remaining = 2000 - $clock.ElapsedMilliseconds
                if ($code -notin 32, 33, 1175 -or $remaining -le 0) {
                    $message = "替换文件失败（$detail）：$($failure.Message)"
                    Write-OperationEvent 'error' $message
                    throw [IO.IOException]::new($message, $failure)
                }
                [Threading.Thread]::Sleep([int][Math]::Min($delay, $remaining))
                $delay = [Math]::Min($delay * 2, 400)
            }
        }
        if ($attempt -gt 1) { Write-OperationEvent 'warn' "文件被占用，重试后替换成功（目标 $Path，尝试 $attempt 次，耗时 $($clock.ElapsedMilliseconds) ms）" }
    } finally {
        # 清理失败只记录，不能盖住写入或替换本身的错误。
        if (-not $keepTemporary -and [IO.File]::Exists($temporary)) {
            try { [IO.File]::Delete($temporary) }
            catch {
                $message = "临时文件未能删除：$temporary：$($_.Exception.Message)"
                Write-OperationEvent 'warn' $message
                Write-Warning $message
            }
        }
    }
}
