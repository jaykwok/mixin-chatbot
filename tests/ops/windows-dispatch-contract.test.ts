import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempFixture } from "../../tests/helpers/temp.ts";

// The unmodified Invoke-TransactionCommand and Invoke-PendingDeployment of ops.ps1: a pending deployment goes to the shared core
// of this release with the console's confirmation as it came, and the core's exit code is the command's. The core's own check
// of that confirmation under the lock runs in core-windows-deploy.test.ts.
test.skipIf(process.platform !== "win32")("Windows ops dispatch hands a pending deployment and its confirmation to the shared core", async () => {
  const fixture = await tempFixture("dispatch-contract-"), root = join(fixture.root, "中文 project"), opsSource = join(fixture.root, "release");
  await mkdir(join(root, "data/state"), { recursive: true });
  const source = await readFile(new URL("../../scripts/ops/ops.ps1", import.meta.url), "utf8");
  const pending = source.match(/^function Invoke-PendingDeployment\([^\n]+[\s\S]*?^\}/m)![0];
  const command = source.match(/^function Invoke-TransactionCommand\([^\n]+[\s\S]*?^\}/m)![0];
  const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
  const marker = join(fixture.root, "dispatched.txt"), driver = join(fixture.root, "dispatch.ps1");
  await writeFile(driver, String.fromCharCode(0xfeff) + `param([string]$Action,[string]$Token)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$Project=${quote(root)}
$OpsSource=${quote(opsSource)}
function Test-Administrator { $env:FIXTURE_ADMIN -ne '0' }
function Err($text) { Write-Host ('ERR ' + $text) }
function Done($text) { Write-Host ('DONE ' + $text) }
function Get-BunPath { 'C:\\fixture\\bun.exe' }
function Get-GitPath { 'C:\\fixture\\git.exe' }
function Invoke-Update([string]$Action, [string]$Target, [string]$Confirmation) { [IO.File]::WriteAllText(${quote(marker)}, 'update ' + $Action + ' ' + $Confirmation); $true }
function Invoke-ConsoleProcess([string]$FilePath, [string[]]$Arguments) {
    [IO.File]::WriteAllText(${quote(marker)}, (@($FilePath) + $Arguments) -join ' ')
    [int]$env:FIXTURE_CORE_EXIT
}
${pending}
${command}
$ok = Invoke-TransactionCommand $Action $Token
Write-Host ('CODE ' + $script:OpsCoreExitCode)
if (-not $ok) { exit 7 }
`);
  const run = async (args: string[], env: Record<string, string> = {}) => {
    await rm(marker, { force: true });
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, MIXIN_OPS_BUN: undefined, FIXTURE_CORE_EXIT: "0", ...env } });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: stdout + stderr, dispatched: existsSync(marker) ? await readFile(marker, "utf8") : null };
  };
  const core = `--no-env-file ${join(opsSource, "scripts/ops/core/cli.ts")} deployment deploy --project ${root}`;
  try {
    await writeFile(join(root, "data/state/deploy-transaction"), "deploy-fixture\n");
    for (const action of ["continue", "rollback"] as const) {
      const accepted = await run([action, "token-" + action]);
      expect(accepted.code, accepted.output).toBe(0);
      expect(accepted.dispatched).toBe(`C:\\fixture\\bun.exe ${core}${action === "rollback" ? " --rollback" : ""} --confirmation token-${action} --git-path C:\\fixture\\git.exe`);
      // A refusal or failure of the core is the command's: its exit code, not a success.
      const refused = await run([action, "token-" + action], { FIXTURE_CORE_EXIT: "1" });
      expect(refused.code, refused.output).toBe(7); expect(refused.output).toContain("CODE 1");
    }
    // The console's pinned Bun runs the core; the terminal takes the one on PATH.
    expect((await run(["continue", ""], { MIXIN_OPS_BUN: "D:\\pinned\\bun.exe" })).dispatched).toBe(`D:\\pinned\\bun.exe ${core} --git-path C:\\fixture\\git.exe`);
    const user = await run(["continue", ""], { FIXTURE_ADMIN: "0" });
    expect(user.code).toBe(7); expect(user.dispatched).toBeNull(); expect(user.output).toContain("管理员");
    // An upgrade's transaction stays with the upgrade path; without any transaction a confirmation has nothing to act on.
    await rm(join(root, "data/state/deploy-transaction")); await writeFile(join(root, "data/state/upgrade-transaction"), "deploy-fixture\n");
    expect((await run(["rollback", "token-u"])).dispatched).toBe("update rollback token-u");
    await rm(join(root, "data/state/upgrade-transaction"));
    const gone = await run(["continue", "token-x"]);
    expect(gone.code).toBe(7); expect(gone.dispatched).toBeNull(); expect(gone.output).toContain("已消失");
    const nothing = await run(["continue", ""]);
    expect(nothing.code).toBe(0); expect(nothing.dispatched).toBeNull(); expect(nothing.output).toContain("没有未完成的部署或升级");
  } finally { await fixture.cleanup(); }
}, 60_000);
