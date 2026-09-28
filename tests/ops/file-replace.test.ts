import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileHolderFunctions } from "../helpers/file-holder.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const pwsh = process.platform === "win32" ? (Bun.which("pwsh") ?? "C:/Program Files/PowerShell/7/pwsh.exe") : null;
const secret = "content-that-must-not-be-logged";

interface Case { case: string; failure: string | null; ms: number; calls: number; content: string | null; leftovers: string[] }

for (const [name, shell] of [["Windows PowerShell 5.1", "powershell.exe"], ["PowerShell 7", pwsh]] as const) {
  test.skipIf(process.platform !== "win32" || !shell || (shell !== "powershell.exe" && !existsSync(shell)))(
    `${name}: file replacement retries a briefly held file, fails bounded on a held one and keeps a half-done replacement`, async () => {
      const fixture = await tempFixture("file-replace-");
      const script = join(fixture.root, "replace.ps1");
      await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${ps(join(project, "scripts/lib/file-replace.ps1"))}
${await fileHolderFunctions(fixture.root)}
$root=$PSScriptRoot
$log=Start-OperationLog $root 'deploy'
$secret=${ps(secret)}
# Replace the single step so 1175-1177 can be injected; everything else runs the real replacement.
$script:realMove=\${function:Move-FileOverTarget}
$script:inject=$null
$script:calls=0
function Move-FileOverTarget([string]$Temporary, [string]$Path, [switch]$CreateOnly) {
    $script:calls++
    if ($script:inject) { & $script:inject $Temporary $Path } else { & $script:realMove $Temporary $Path -CreateOnly:$CreateOnly }
}
function Get-HResult([int]$Code) { return -2147024896 + $Code }
function New-Target([string]$Name) { $path=Join-Path $root $Name; [IO.File]::WriteAllText($path, 'old'); return $path }
function Invoke-Case([string]$Name, [string]$Path, [scriptblock]$Writer = { param($temporary) [IO.File]::WriteAllText($temporary, $secret) }, [switch]$CreateOnly) {
    $script:calls=0
    $clock=[Diagnostics.Stopwatch]::StartNew(); $failure=$null
    try { Save-FileAtomically $Path $Writer -CreateOnly:$CreateOnly } catch { $failure=$_.Exception.Message }
    $leftovers=@(Get-ChildItem -LiteralPath (Split-Path $Path) -Filter ((Split-Path $Path -Leaf) + '.*.tmp') | ForEach-Object { try { [IO.File]::ReadAllText($_.FullName) } catch { '(in use)' } })
    $content=if ([IO.File]::Exists($Path)) { [IO.File]::ReadAllText($Path) } else { $null }
    'CASE ' + ([pscustomobject]@{case=$Name; failure=$failure; ms=$clock.ElapsedMilliseconds; calls=$script:calls; content=$content; leftovers=$leftovers} | ConvertTo-Json -Compress)
}
$path=New-Target 'released.txt'
$holder=Start-FileHolder $path 700
Invoke-Case 'released' $path
Wait-FileHolder $holder
$path=New-Target 'held.txt'
$holder=Start-FileHolder $path 4000
Invoke-Case 'held' $path
Wait-FileHolder $holder
$path=New-Target 'readonly.txt'
(Get-Item -LiteralPath $path).Attributes='ReadOnly'
Invoke-Case 'readonly' $path
(Get-Item -LiteralPath $path).Attributes='Normal'
$path=Join-Path $root 'directory'
New-Item -ItemType Directory -Path $path | Out-Null
Invoke-Case 'directory' $path
$script:inject={ param($temporary, $target) if ($script:calls -le 2) { throw [IO.IOException]::new('injected', (Get-HResult 1175)) }; & $script:realMove $temporary $target }
Invoke-Case 'unable-to-remove' (New-Target 'unable-to-remove.txt')
# 1176: the target is gone and the replacement kept its temporary name.
$script:inject={ param($temporary, $target) [IO.File]::Delete($target); throw [IO.IOException]::new('injected', (Get-HResult 1176)) }
Invoke-Case 'unable-to-move' (New-Target 'unable-to-move.txt')
# 1177: the target was renamed aside and the replacement was not moved into place.
$script:inject={ param($temporary, $target) [IO.File]::Move($target, $target + '.aside'); throw [IO.IOException]::new('injected', (Get-HResult 1177)) }
Invoke-Case 'unable-to-move-2' (New-Target 'unable-to-move-2.txt')
$script:inject=$null
# First publication creates the file and never replaces an existing one.
Invoke-Case 'create-new' (Join-Path $root 'create-new.txt') -CreateOnly
Invoke-Case 'create-existing' (New-Target 'create-existing.txt') -CreateOnly
# The writer fails and its temporary cannot be removed: the writer's error wins, the cleanup failure is logged.
$path=New-Target 'cleanup.txt'
Invoke-Case 'cleanup' $path { param($temporary) [IO.File]::WriteAllText($temporary, 'partial'); $script:handle=[IO.File]::Open($temporary, 'Open', 'Read', 'None'); throw 'writer failed' } 3>$null
$script:handle.Dispose()
Stop-OperationLog $log 0
'LOG ' + ([IO.File]::ReadAllText($log.Path) | ConvertTo-Json -Compress)
`);
      try {
        const child = Bun.spawn([shell!, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, out + err).toBe(0);
        const cases = Object.fromEntries(out.split(/\r?\n/).filter(line => line.startsWith("CASE ")).map(line => {
          const value = JSON.parse(line.slice(5)) as Case;
          return [value.case, { ...value, leftovers: [value.leftovers ?? []].flat() }];
        }));
        const log = JSON.parse(out.split(/\r?\n/).find(line => line.startsWith("LOG "))!.slice(4)) as string;
        const attempts = (failure: string | null) => Number(/尝试 (\d+) 次/.exec(failure ?? "")?.[1]);

        // Released within the budget: retried until the replacement went through.
        const released = cases.released!;
        expect(released.failure, out).toBeNull(); expect(released.content).toBe(secret); expect(released.leftovers).toEqual([]);
        expect(released.calls).toBeGreaterThan(1); expect(released.ms).toBeLessThan(2500);
        expect(log).toMatch(/文件被占用，重试后替换成功（目标 [^）]*released\.txt，尝试 \d+ 次，耗时 \d+ ms）/);
        // Held past the budget: a bounded failure that names path, code, attempts and time; the old file stays.
        const held = cases.held!;
        expect(held.failure).toContain("held.txt"); expect(held.failure).toContain("错误码 32");
        expect(attempts(held.failure)).toBeGreaterThan(3); expect(held.failure).toMatch(/耗时 \d+ ms/);
        expect(held.ms).toBeGreaterThan(1500); expect(held.ms).toBeLessThan(3500);
        expect(held.content).toBe("old"); expect(held.leftovers).toEqual([]);
        expect(log).toMatch(/error [^:]*: 替换文件失败（目标 [^，]*held\.txt，错误码 32，尝试 \d+ 次，耗时 \d+ ms）/);
        // Deterministic errors fail on the first attempt and leave the old file.
        for (const [key, code] of [["readonly", "错误码 5，"], ["directory", "错误码 "]] as const) {
          expect(cases[key]!.failure, key).toContain(code); expect(attempts(cases[key]!.failure), key).toBe(1);
          expect(cases[key]!.ms, key).toBeLessThan(1000); expect(cases[key]!.leftovers, key).toEqual([]);
        }
        expect(cases.readonly!.content).toBe("old");
        // 1175 left both files untouched: retried.
        expect(cases["unable-to-remove"]!.failure).toBeNull(); expect(cases["unable-to-remove"]!.calls).toBe(3);
        expect(cases["unable-to-remove"]!.content).toBe(secret); expect(cases["unable-to-remove"]!.leftovers).toEqual([]);
        // 1176/1177 changed the files: no retry, the new content stays in the temporary for recovery.
        for (const [key, code] of [["unable-to-move", 1176], ["unable-to-move-2", 1177]] as const) {
          const value = cases[key]!;
          expect(value.failure, key).toContain(`错误码 ${code}`); expect(value.failure, key).toContain("未删除");
          expect(value.calls, key).toBe(1); expect(value.content, key).toBeNull(); expect(value.leftovers, key).toEqual([secret]);
          expect(value.failure, key).toContain(`${key}.txt.`);
        }
        expect(await readFile(join(fixture.root, "unable-to-move-2.txt.aside"), "utf8")).toBe("old");
        // Create-only publication: a new file is created, an existing one is refused at once and left as it was.
        expect(cases["create-new"]!.failure).toBeNull(); expect(cases["create-new"]!.content).toBe(secret);
        const existing = cases["create-existing"]!;
        expect(existing.failure).toContain("目标已存在，未覆盖"); expect(attempts(existing.failure)).toBe(1);
        expect(existing.content).toBe("old"); expect(existing.leftovers).toEqual([]);
        // A failed cleanup never replaces the original error.
        expect(cases.cleanup!.failure).toBe("writer failed"); expect(cases.cleanup!.content).toBe("old");
        expect(log).toContain("临时文件未能删除");
        // Paths, codes and timings only: never the content.
        expect(log).not.toContain(secret);
      } finally { await fixture.cleanup(); }
    }, 90000);
}
