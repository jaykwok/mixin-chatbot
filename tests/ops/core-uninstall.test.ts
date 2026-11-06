import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDeploymentLock } from "../../ops/core/deployment-lock.ts";
import { serializeTransactionRecord, type TransactionRecord } from "../../ops/core/transaction-record.ts";
import { checkUninstall } from "../../ops/core/uninstall.ts";
import { CONFIGURATION_STATE_FILE } from "../../src/core/configuration-state.ts";
import { OPS_MAINTENANCE_FILE } from "../../src/core/ops-maintenance-state.ts";
import { opsShellFunctions } from "../helpers/ops-shell.ts";
import { tempFixture } from "../helpers/temp.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const record: TransactionRecord = { format: "2", operation: "upgrade", snapshot: "deploy-uninstall", target_sha: "a".repeat(40),
  original_sha: "b".repeat(40), original_branch: "main", original_workspace_root: "", target_workspace_root: "",
  was_running: "1", bot_port: "2022", reconfigure_ai: "0" };
const checkpoint = { version: 1, request: { id: "a".repeat(32), runtime: "d".repeat(64), command: "history-clear", label: "清空会话", intent: "conversation-write" },
  phase: "acting", original: { identity: "c".repeat(64), state: "running", ready: true, owned: true, pending: false } };
const finished = { protocol: "mixin-ops", version: 1, command: "history-clear", outcome: "success", exitCode: 0, wasRunning: true, finalState: "running", message: "完成" };

type Setup = "clean" | "transaction" | "maintenance" | "finished-maintenance" | "configuration";
async function project(root: string, setup: Setup) {
  await mkdir(join(root, "data/state"), { recursive: true });
  await mkdir(join(root, "data/config"), { recursive: true });
  await writeFile(join(root, "data/config/marker"), "keep");
  if (setup === "transaction") {
    await mkdir(join(root, "backup/snapshots", record.snapshot), { recursive: true });
    await writeFile(join(root, "data/state/upgrade-transaction"), record.snapshot + "\n");
    await writeFile(join(root, "backup/snapshots", record.snapshot, "transaction"), serializeTransactionRecord(record));
  }
  if (setup === "maintenance") await writeFile(join(root, OPS_MAINTENANCE_FILE), JSON.stringify({ version: 1, checkpoint }));
  if (setup === "finished-maintenance") await writeFile(join(root, OPS_MAINTENANCE_FILE), JSON.stringify({ version: 1, checkpoint, result: finished }));
  if (setup === "configuration") await writeFile(join(root, CONFIGURATION_STATE_FILE), JSON.stringify({ version: 1, id: "config-" + "e".repeat(32),
    kind: "relay", phase: "ready", binding: null, rows: [{ key: "relay", before: null, after: "f".repeat(64) }] }));
  return root;
}

test("卸载前检查在部署锁内拒绝未完成的部署/升级、运维任务和配置提交；已收尾的运维任务不挡卸载", async () => {
  const f = await tempFixture("core-uninstall-");
  try {
    let n = 0;
    const check = async (setup: Setup) => checkUninstall(await project(join(f.root, `项目 ${++n}`), setup), {});
    for (const setup of ["clean", "finished-maintenance"] as const) {
      expect(await check(setup)).toEqual({ protocol: "mixin-ops", version: 1, command: "uninstall", outcome: "success", exitCode: 0,
        wasRunning: false, finalState: "unknown", message: "卸载前检查通过：没有未完成的部署、升级、运维任务或配置提交" });
    }
    for (const [setup, reason] of [["transaction", "有未完成的部署或升级"], ["maintenance", "有未收尾的运维任务"], ["configuration", "有未结束的配置提交"]] as const) {
      const result = await check(setup);
      expect(result).toMatchObject({ command: "uninstall", outcome: "refused", exitCode: 1 });
      expect(result.message).toStartWith(reason); expect(result.message).toEndWith("卸载未开始");
    }
    // An unreadable record is not taken as "nothing pending".
    const broken = await project(join(f.root, "坏记录"), "clean");
    await writeFile(join(broken, OPS_MAINTENANCE_FILE), "{");
    expect(await checkUninstall(broken, {})).toMatchObject({ outcome: "failed", exitCode: 1, message: expect.stringContaining("卸载未开始") });
  } finally { await f.cleanup(); }
});

test("另一个进程持有部署锁时拒绝；Windows 只认入口点名的本项目锁", async () => {
  const f = await tempFixture("core-uninstall-lock-");
  try {
    const root = await project(join(f.root, "含空格 项目"), "clean"), other = await project(join(f.root, "另一项目"), "clean");
    const lock = acquireDeploymentLock(root), otherLock = acquireDeploymentLock(other);
    try {
      const busy = await checkUninstall(root, {});
      expect(busy).toMatchObject({ outcome: "refused", exitCode: 1 }); expect(busy.message).toStartWith("部署、升级或另一个维护操作正在进行");
      expect(await checkUninstall(root, { BOT_DEPLOY_LOCK_HELD: otherLock.path })).toMatchObject({ outcome: "refused" });
      // The uninstalling PowerShell entry holds deploy.lock with FileShare.None and names it; Linux adopts descriptor 9 instead.
      expect(await checkUninstall(root, { BOT_DEPLOY_LOCK_HELD: lock.path })).toMatchObject({ outcome: process.platform === "win32" ? "success" : "refused" });
    } finally { lock.close(); otherLock.close(); }
  } finally { await f.cleanup(); }
});

test.skipIf(process.platform !== "win32")("真实 PowerShell 卸载持锁运行核心检查：拒绝时不停机不归档，通过后释放锁再归档 data/", async () => {
  const f = await tempFixture("core-uninstall-windows-");
  try {
    const driver = join(f.root, "uninstall.ps1");
    await writeFile(driver, "\ufeff" + [
      "param([string]$Project,[string]$Archive)", "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      `. ${ps(join(repo, "scripts/lib/common.ps1"))}`,
      `$OpsSource=${ps(repo)}; $DataDir=Join-Path $Project 'data'; $RuntimeDir=Join-Path $DataDir 'runtime'; $TaskName='mixin-bot-fixture'; $DeployedWorkspaceRoot=''; $Json=$false`,
      `function Get-BunPath { ${ps(process.execPath)} }`,
      "foreach($name in @('Step','Err','Warn','Done')) { Set-Item \"function:$name\" { param($text) [Console]::Error.WriteLine($text) } }",
      "function Get-OpsCommandHint($name) { \"ops.ps1 $name\" }; function Test-Administrator { $true }",
      "function Stop-Bot { [Console]::Out.WriteLine('STOP'); $true }; function Get-BotPids { @() }; function Get-ScheduledTask { $null }",
      "function Read-YesNo { $Archive -eq 'y' }",
      `$tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${ps(join(repo, "scripts/ops.ps1"))},[ref]$tokens,[ref]$errors); if($errors){throw 'syntax'}`,
      "foreach($name in @('Uninstall-Bot','Remove-BotInstallation','Invoke-CoreMaintenance')) {",
      "$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)",
      ". ([scriptblock]::Create($definition.Extent.Text)) }",
      "$ok=Uninstall-Bot",
      "[Console]::Out.WriteLine('HELD=' + [string]$env:BOT_DEPLOY_LOCK_HELD)",
      // The entry's handle is closed on every path: the same process can take the lock again.
      "$state=Join-Path $Project 'data\\state'; if(Test-Path -LiteralPath $state){ $again=[IO.File]::Open((Join-Path $state 'deploy.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $again.Dispose(); [Console]::Out.WriteLine('RELEASED') }",
      "if($ok){exit 0}else{exit 1}",
    ].join("\r\n"));
    const run = async (root: string, archive: "y" | "n") => {
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driver, root, archive], {
        cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, BOT_DEPLOY_LOCK_HELD: "", MIXIN_OPS_BUN: "" } });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out: out.trim().split(/\r?\n/), err };
    };
    // Kept data: the core passed while the entry held the lock (FileShare.None) and named it; the handle is released afterwards.
    const passed = "卸载前检查通过：没有未完成的部署、升级、运维任务或配置提交";
    const kept = await project(join(f.root, "保留 数据"), "clean");
    let value = await run(kept, "n");
    expect(value.code, value.err).toBe(0); expect(value.out).toEqual([passed, "STOP", "HELD=", "RELEASED"]);
    expect(existsSync(join(kept, "data/config/marker"))).toBe(true);
    // Archived data: the lock is released before data\ moves (the lock file lives in data\state).
    const archived = await project(join(f.root, "归档 数据"), "clean");
    value = await run(archived, "y");
    expect(value.code, value.err).toBe(0); expect(value.out).toEqual([passed, "STOP", "HELD="]);
    expect(existsSync(join(archived, "data"))).toBe(false);
    expect(readdirSync(join(archived, "backup/rm")).filter(name => name.endsWith("-data"))).toHaveLength(1);
    // Refusals stop before the bot is stopped or anything moves.
    const pending = await project(join(f.root, "未完成 升级"), "transaction");
    value = await run(pending, "y");
    expect(value.code).toBe(1); expect(value.out).toEqual(["HELD=", "RELEASED"]);
    expect(value.err).toContain("有未完成的部署或升级"); expect(value.err).toContain("卸载未开始（原因见上方）");
    expect(existsSync(join(pending, "data/config/marker"))).toBe(true);
    const busy = await project(join(f.root, "锁被占用"), "clean"), lock = acquireDeploymentLock(busy);
    try {
      value = await run(busy, "y");
      expect(value.code).toBe(1); expect(value.out).toEqual(["HELD="]);
      expect(value.err).toContain("部署、升级或另一个维护操作正在进行；卸载未开始");
      expect(existsSync(join(busy, "data/config/marker"))).toBe(true);
    } finally { lock.close(); }
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(process.platform !== "linux")("真实 Shell 卸载经 fd 9 持锁运行核心检查：拒绝时不动容器和数据，通过后才停容器", async () => {
  const f = await tempFixture("core-uninstall-shell-");
  try {
    const driver = join(f.root, "uninstall.sh"), events = join(f.root, "events.txt");
    await writeFile(driver, [
      "set -uo pipefail", 'PROJECT_DIR="$1"; OPS_SOURCE_DIR="$2"; CONTAINER=mixin-bot; ROLLBACK_CONTAINER=mixin-bot-rollback; DEPLOYED_WORKSPACE_ROOT=""',
      `. ${JSON.stringify(join(repo, "scripts/lib/common.sh"))}`, `. ${JSON.stringify(join(repo, "scripts/lib/ops-runtime.sh"))}`,
      'P() { printf "%s\\n" "$1" >&2; }; OK() { printf "%s\\n" "$1" >&2; }; WA() { printf "%s\\n" "$1" >&2; }; ER() { printf "%s\\n" "$1" >&2; }',
      'has_container() { return 0; }; has_rollback_container() { return 1; }',
      'docker() { printf "docker %s\\n" "$*" >> "$FIXTURE_EVENTS"; }',
      'ask_yes_no() { case "$1" in *镜像*) return 1 ;; *) [ "$FIXTURE_ARCHIVE" = y ] ;; esac; }',
      await opsShellFunctions("uninstall"),
      "uninstall",
    ].join("\n") + "\n");
    const run = async (root: string, archive: "y" | "n") => {
      await writeFile(events, "");
      const child = Bun.spawn(["bash", "--noprofile", "--norc", driver, root, repo], { cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, MIXIN_OPS_BUN: process.execPath, MIXIN_OPS_TASK_ID: "", BOT_DEPLOY_LOCK_HELD: "", FIXTURE_EVENTS: events, FIXTURE_ARCHIVE: archive } });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, out, err, events: (await Bun.file(events).text()).trim() };
    };
    const archived = await project(join(f.root, "归档 数据"), "clean");
    let value = await run(archived, "y");
    expect(value.code, value.err).toBe(0); expect(value.events).toBe("docker stop mixin-bot\ndocker rm mixin-bot");
    expect(value.out).toContain("卸载前检查通过"); expect(existsSync(join(archived, "data"))).toBe(false);
    const pending = await project(join(f.root, "未完成 升级"), "transaction");
    value = await run(pending, "y");
    expect(value.code).toBe(1); expect(value.events).toBe("");
    expect(value.err).toContain("有未完成的部署或升级"); expect(value.err).toContain("卸载未开始（原因见上方）");
    expect(existsSync(join(pending, "data/config/marker"))).toBe(true);
    const busy = await project(join(f.root, "锁被占用"), "clean"), lock = acquireDeploymentLock(busy);
    try {
      value = await run(busy, "y");
      expect(value.code).toBe(1); expect(value.events).toBe("");
      expect(value.err).toContain("部署、升级或另一个维护操作正在进行；卸载未开始");
      expect(existsSync(join(busy, "data/config/marker"))).toBe(true);
    } finally { lock.close(); }
  } finally { await f.cleanup(); }
}, 60_000);
