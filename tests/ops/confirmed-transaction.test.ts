import { expect, spyOn, test } from "bun:test";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfirmedTransaction, confirmTransaction, readTransaction } from "../../scripts/lib/confirmed-transaction.ts";
import * as transaction from "../../scripts/ops/tui/transaction.ts";
import * as data from "../../scripts/ops/tui/data.ts";
import { opsCommand } from "../../scripts/ops/tui/platform.ts";
import { MaintainView } from "../../scripts/ops/tui/views/maintain.ts";
import { createTheme } from "../../scripts/ops/tui/render/theme.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const first = "deploy-" + "a".repeat(32), second = "deploy-" + "b".repeat(32);

async function synthetic(root: string) {
  const state = join(root, "data/state");
  await mkdir(state, { recursive: true });
  for (const [name, sha] of [[first, "1".repeat(40)], [second, "2".repeat(40)]]) {
    const directory = join(root, "backup/snapshots", name!);
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "target-sha"), sha!);
  }
  await writeFile(join(state, "deploy-transaction"), first);
}

for (const action of ["continue", "rollback"] as const) test(`confirmation binds ${action} to identity, bytes and action, including legacy snapshots`, async () => {
  const fixture = await tempFixture("confirmed-state-");
  try {
    await synthetic(fixture.root);
    const capture = readTransaction(fixture.root)!, token = confirmTransaction(capture, action);
    expect(() => assertConfirmedTransaction(fixture.root, action, token)).not.toThrow();
    expect(() => assertConfirmedTransaction(fixture.root, action === "continue" ? "rollback" : "continue", token)).toThrow();
    for (const change of ["pointer", "same-id", "missing", "committed", "restore"] as const) {
      const state = join(fixture.root, "data/state"), directory = join(fixture.root, "backup/snapshots", first);
      await synthetic(fixture.root);
      if (change === "pointer") await writeFile(join(state, "deploy-transaction"), second);
      if (change === "same-id") await writeFile(join(directory, "target-sha"), "3".repeat(40));
      if (change === "missing") await rm(join(state, "deploy-transaction"));
      if (change === "committed") await writeFile(join(state, "migration.json"), '{"phase":"committed"}');
      if (change === "restore") await writeFile(join(directory, "code-restore"), "pending");
      expect(() => assertConfirmedTransaction(fixture.root, action, token), change).toThrow("变化");
      await rm(join(state, "migration.json"), { force: true }); await rm(join(directory, "code-restore"), { force: true });
    }
  } finally { await fixture.cleanup(); }
});

for (const action of ["resume", "rollback"] as const) test(`TUI ${action} carries the exact previewed transaction after confirmation swaps the pointer`, async () => {
  const fixture = await tempFixture("confirmed-tui-");
  await synthetic(fixture.root);
  const load = transaction.loadPendingTransaction;
  const pendingSpy = spyOn(transaction, "loadPendingTransaction").mockImplementation(() => load(fixture.root));
  const gitSpy = spyOn(data, "loadGit").mockResolvedValue(null);
  let subject = "", args: string[] = [];
  const app = { deployment: { platform: "windows", runtime: "scheduled-task", mode: "direct", port: 1011, domain: "", groupDataRoot: fixture.root, groupDataRootIsCustom: true },
    theme: createTheme("none"), redraw() {}, go() {}, toast() {},
    async confirm(spec: { subject: string }) { subject = spec.subject; await writeFile(join(fixture.root, "data/state/deploy-transaction"), second); return true; },
    async runInteractive(_title: string, sent: string[]) { args = sent; return 1; },
  };
  try {
    const view = new MaintainView(); await view.refresh(app as never); await view.onKey({ name: action } as never, app as never); view.onLeave();
    expect(subject).toContain("1111111"); expect(args.slice(0, 2)).toEqual([action, "--confirmed-transaction"]);
    const token = args[2]!;
    expect(JSON.parse(Buffer.from(token, "base64").toString()).id).toBe(first);
    expect(() => assertConfirmedTransaction(fixture.root, action === "resume" ? "continue" : "rollback", token)).toThrow("变化");
    const command = opsCommand("windows", args);
    expect(JSON.parse(Buffer.from(command.args.at(-1)!, "base64").toString()).ConfirmedTransaction).toBe(token);
  } finally { pendingSpy.mockRestore(); gitSpy.mockRestore(); await fixture.cleanup(); }
});

test.skipIf(process.platform !== "win32")("Windows deployment and upgrade check the confirmation only after acquiring the real lock", async () => {
  const fixture = await tempFixture("confirmed-win-");
  const root = join(fixture.root, "project"), lib = join(root, "scripts/lib");
  await synthetic(root); await mkdir(lib, { recursive: true });
  await copyFile(join(project, "scripts/lib/confirmed-transaction.ts"), join(lib, "confirmed-transaction.ts"));
  const driver = join(fixture.root, "check.ps1");
  await writeFile(driver, String.fromCharCode(0xfeff) + `param([string]$Root, [string]$Action, [string]$Token, [string]$Kind)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. ${psQuote(join(project, "scripts/lib/deployment.ps1"))}
function Get-ApplicationPaths { ${psQuote(process.execPath)} }
# The real comparison launches only while this exclusive lock is held.
$original = (Get-Command Assert-ConfirmedTransaction).ScriptBlock
function Assert-ConfirmedTransaction($ProjectRoot, $ChosenAction, $Confirmation) {
  try { $probe = [IO.File]::Open((Join-Path $Root 'data/state/deploy.lock'), 'Open', 'ReadWrite', 'None'); $probe.Dispose(); throw 'not locked' }
  catch [IO.IOException] { }
  & $original $ProjectRoot $ChosenAction $Confirmation
}
try {
  if ($Kind -eq 'deploy') { $snapshot = Open-DeploymentTransaction $Root $Token $Action }
  else { $snapshot = Open-UpgradeSnapshot $Root 'test' '' '' '' $null '' $Token $Action }
  if ($snapshot.Lock) { $snapshot.Lock.Dispose() }
  throw 'unexpected dispatch'
} catch { Write-Host $_; exit 7 }
`);
  try {
    for (const kind of ["deploy", "upgrade"]) for (const action of ["continue", "rollback"] as const) {
      await synthetic(root);
      if (kind === "upgrade") await writeFile(join(root, "data/state/upgrade-transaction"), first);
      const token = confirmTransaction(readTransaction(root)!, action);
      await writeFile(join(root, `data/state/${kind}-transaction`), second);
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver, root, action, token, kind], { stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(7); expect(stdout).toContain("变化"); expect(stdout).not.toContain("not locked");
      await rm(join(root, "data/state/upgrade-transaction"), { force: true });
    }
  } finally { await fixture.cleanup(); }
}, 60_000);

test.skipIf(!bash)("Bash ops rejects a changed confirmation under its deployment lock before dispatch", async () => {
  const fixture = await tempFixture("confirmed-bash-");
  const root = join(fixture.root, "project"), lib = join(root, "scripts/lib");
  await synthetic(root); await mkdir(lib, { recursive: true });
  await copyFile(join(project, "scripts/lib/confirmed-transaction.ts"), join(lib, "confirmed-transaction.ts"));
  const ops = await readFile(join(project, "scripts/ops/ops.sh"), "utf8");
  const update = ops.match(/^update\(\) \{[\s\S]*?^\}/m)![0];
  const command = ops.match(/^transaction_command\(\) \{[\s\S]*?^\}/m)![0];
  const driver = join(fixture.root, "check.sh");
  await writeFile(driver, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_DIR="$1"; STATE_DIR="$PROJECT_DIR/data/state"
. "$2/scripts/lib/common.sh"
operation_start() { :; }; operation_finish() { :; }; remove_upgrade_stage() { :; }
ER() { echo "$*" >&2; }; WA() { :; }
load_pending_transaction() { echo 'unexpected dispatch'; return 9; }
${update}
${command}
transaction_command "$3" --confirmed-transaction "$4"
`);
  try {
    for (const action of ["continue", "rollback"] as const) {
      await synthetic(root); const token = confirmTransaction(readTransaction(root)!, action);
      await writeFile(join(root, "data/state/deploy-transaction"), second);
      const env: Record<string, string | undefined> = { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? "") };
      delete env.MSYS_NO_PATHCONV; delete env.MSYS2_ARG_CONV_EXCL;
      // Ordinary Windows ops tests use a flock stub; Linux runs the real exclusive lock.
      if (process.platform === "win32") Object.assign(env, { "BASH_FUNC_flock%%": "() { return 0;\n}" });
      const child = Bun.spawn([bash!, driver, posix(root), posix(project), action, token], { env, stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(1); expect(stderr).toContain("变化"); expect(stdout).not.toContain("unexpected dispatch");
    }
  } finally { await fixture.cleanup(); }
}, 60_000);
