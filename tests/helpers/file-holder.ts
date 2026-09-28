import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";

/**
 * PowerShell functions that hold a file open from a separate process, as a scanner or an editor would: read access
 * with read sharing only (no write or delete), or with -Exclusive no sharing at all. Start-FileHolder returns once
 * the handle is open; Wait-FileHolder waits for the holder to release it and exit. The holder runs on the same
 * PowerShell host as the caller.
 */
export async function fileHolderFunctions(directory: string): Promise<string> {
  const script = join(directory, "hold-file.ps1");
  await writeFile(script, "\ufeff" + [
    "param([string]$Path, [string]$Ready, [int]$Milliseconds, [string]$Share)",
    "$stream = [IO.File]::Open($Path, 'Open', 'Read', $Share)",
    "try { [IO.File]::WriteAllText($Ready, [string]$PID); Start-Sleep -Milliseconds $Milliseconds } finally { $stream.Dispose() }",
  ].join("\r\n") + "\r\n");
  return [
    `$script:FileHolderScript = ${ps(script)}`,
    "function Start-FileHolder([string]$Path, [int]$Milliseconds, [switch]$Exclusive) {",
    "    $ready = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N') + '.held')",
    "    $shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName",
    "    $share = if ($Exclusive) { 'None' } else { 'Read' }",
    "    $arguments = '-NoProfile -ExecutionPolicy Bypass -File \"' + $script:FileHolderScript + '\" -Path \"' + $Path + '\" -Ready \"' + $ready + '\" -Milliseconds ' + $Milliseconds + ' -Share ' + $share",
    "    $process = Start-Process -FilePath $shell -ArgumentList $arguments -PassThru -WindowStyle Hidden",
    "    $clock = [Diagnostics.Stopwatch]::StartNew()",
    "    while (-not (Test-Path -LiteralPath $ready)) {",
    "        if ($process.HasExited) { throw 'file holder exited before opening ' + $Path }",
    "        if ($clock.ElapsedMilliseconds -gt 20000) { $process.Kill(); throw 'file holder did not open ' + $Path }",
    "        [Threading.Thread]::Sleep(20)",
    "    }",
    "    Remove-Item -LiteralPath $ready -Force",
    "    return $process",
    "}",
    "function Wait-FileHolder($Process) {",
    "    if (-not $Process.WaitForExit(20000)) { $Process.Kill(); throw 'file holder did not exit' }",
    "}",
  ].join("\n");
}
