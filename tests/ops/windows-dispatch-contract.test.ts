import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfirmedTransaction, confirmTransaction, readTransaction } from "../../scripts/lib/confirmed-transaction.ts";
import { tempFixture } from "../../tests/helpers/temp.ts";

test.skipIf(process.platform !== "win32")("real Windows ops dispatch preserves the confirmation; matched actions proceed and changed ones never dispatch", async () => {
  const fixture = await tempFixture("dispatch-contract-"), root = join(fixture.root, "project");
  const name = "deploy-" + "a".repeat(32), other = "deploy-" + "b".repeat(32), state = join(root, "data/state");
  const snapshot = join(root, "backup/snapshots", name), lib = join(root, "scripts/lib"), deploy = join(root, "scripts/deploy");
  await mkdir(state, { recursive: true }); await mkdir(snapshot, { recursive: true }); await mkdir(lib, { recursive: true }); await mkdir(deploy, { recursive: true });
  const project = new URL("../../", import.meta.url);
  const source = await readFile(new URL("scripts/ops/ops.ps1", project), "utf8");
  const pending = source.match(/^function Invoke-PendingDeployment\([^\n]+[\s\S]*?^\}/m)![0];
  const command = source.match(/^function Invoke-TransactionCommand\([^\n]+[\s\S]*?^\}/m)![0];
  const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'";
  const common = fileURLToPath(new URL("scripts/lib/deployment.ps1", project));
  await copyFile(new URL("scripts/lib/confirmed-transaction.ts", project), join(lib, "confirmed-transaction.ts"));
  const record = { format: "1", operation: "deploy", snapshot: name, target_sha: "1".repeat(40), original_sha: "", original_branch: "",
    original_group_root: root, target_group_root: root, was_running: "0", bot_port: "1011", deploy_mode: "direct", bot_domain: "", domain_action: "keep", unmanaged_tunnel: "", platform_ip: "203.0.113.17", reconfigure_ai: "0" };
  await writeFile(join(snapshot, "transaction"), Object.entries(record).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  const marker = join(fixture.root, "dispatched.txt"), driver = join(fixture.root, "dispatch.ps1");
  await writeFile(join(deploy, "deploy.ps1"), String.fromCharCode(0xfeff) + `param([switch]$Resume,[switch]$Rollback,[string]$ConfirmedTransaction)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quote(common)}
function Get-ApplicationPaths { ${quote(process.execPath)} }
$root=${quote(root)}
try {
  $action=if($Rollback){'rollback'}else{'continue'}
  $snapshot=Open-DeploymentTransaction $root $ConfirmedTransaction $action
  try { [IO.File]::WriteAllText(${quote(marker)}, $action+':'+(Split-Path $snapshot.Path -Leaf)) }
  finally { $snapshot.Lock.Dispose() }
} catch { Write-Host $_; exit 7 }
`);
  await writeFile(driver, String.fromCharCode(0xfeff) + `param([string]$Action,[string]$Token,[switch]$Seed)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$Project=${quote(root)}
if($Seed) { [pscustomobject]@{Project=$Project;Path=${quote(snapshot)}} | Export-Clixml -LiteralPath ${quote(join(snapshot, "deployment.xml"))}; exit 0 }
function IsAdmin { $true }
function Invoke-WithUtf8Output($block) { & $block }
function Err($text) { throw $text }
function Done($text) { Write-Host $text }
function Invoke-Update { throw 'Unexpected upgrade' }
${pending}
${command}
if(-not (Invoke-TransactionCommand $Action $Token)) { exit 7 }
`);
  const run = async (args: string[]) => {
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: stdout + stderr };
  };
  try {
    expect((await run(["-Seed"])).code).toBe(0);
    for (const action of ["continue", "rollback"] as const) {
      await writeFile(join(state, "deploy-transaction"), name);
      const token = confirmTransaction(readTransaction(root)!, action);
      assertConfirmedTransaction(root, action, token);
      const accepted = await run([action, token]); expect(accepted.code, accepted.output).toBe(0);
      expect(await readFile(marker, "utf8")).toBe(action + ":" + name); await rm(marker);
      await writeFile(join(state, "deploy-transaction"), other);
      const rejected = await run([action, token]); expect(rejected.code, rejected.output).toBe(7); expect(rejected.output).toContain("变化");
      expect(await readFile(marker, "utf8").catch(() => "absent")).toBe("absent");
    }
  } finally { await fixture.cleanup(); }
}, 60_000);
