import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { opsCommand } from "../../ops/core/platform.ts";
import { describePendingTransaction, loadPendingTransaction } from "../../ops/core/pending-transaction.ts";
import { parseTransactionRecord, serializeTransactionRecord, transactionValueValid, type TransactionRecord } from "../../ops/core/transaction-record.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posixPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const quotePS = (text: string) => "'" + text.replaceAll("'", "''") + "'";

const record: TransactionRecord = {
  format: "2", operation: "deploy", snapshot: "deploy-abc123", target_sha: "a".repeat(40), original_sha: "", original_branch: "",
  original_workspace_root: "/srv/old shared", target_workspace_root: "/srv/new", was_running: "1", bot_port: "2022", reconfigure_ai: "0",
};
// Records of earlier releases (the webhook versions wrote format 1) are not recognised; legacy directories are deployed fresh.
const legacy = { ...record, format: "1", deploy_mode: "cloudflare", bot_domain: "bot.example.com", domain_action: "persist",
  unmanaged_tunnel: "", platform_ip: "203.0.113.17" };
const serialize = (value: Record<string, string>) => Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n") + "\n";

async function execute(args: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: out + "\n" + err };
}

test("事务记录逐键校验：重复、未知、缺失或非法的值拒绝整份记录", () => {
  expect(parseTransactionRecord(serialize(record))).toEqual(record);
  expect(parseTransactionRecord(serialize({ ...record, target_workspace_root: "D:\\shared", original_branch: "feature/x" })).target_workspace_root).toBe("D:\\shared");
  // An empty root is the default data/workspace.
  expect(parseTransactionRecord(serialize({ ...record, target_workspace_root: "", original_workspace_root: "" })).target_workspace_root).toBe("");
  const invalid: Record<string, string>[] = [
    { ...record, bot_port: "70000" }, { ...record, bot_port: "0080" }, { ...record, target_sha: "abc" },
    { ...record, target_workspace_root: "shared" }, { ...record, snapshot: "../deploy-x" }, { ...record, was_running: "2" },
    { ...record, original_branch: "bad branch" }, { ...record, target_workspace_root: "/srv/new\u0007" }, { ...record, extra: "1" },
    { ...record, platform_ip: "203.0.113.17" }, { ...record, deploy_mode: "direct" }, { ...record, target_group_root: "/srv/new" },
  ];
  for (const value of invalid) expect(() => parseTransactionRecord(serialize(value)), JSON.stringify(value)).toThrow();
  expect(transactionValueValid("format", "1")).toBe(false);
  expect(() => parseTransactionRecord(serialize(legacy))).toThrow("事务记录无效：format");
  const { reconfigure_ai: _, ...missing } = record;
  expect(() => parseTransactionRecord(serialize(missing))).toThrow("缺少");
  expect(() => parseTransactionRecord(serialize(record) + "bot_port=2022\n")).toThrow("bot_port");
});

test("控制台按指针读取事务，数据已提交只看本事务的当前格式回执", async () => {
  const fixture = await tempFixture("transaction-pending-");
  const root = fixture.root, state = join(root, "data/state"), snapshot = join(root, "backup/snapshots/deploy-abc123");
  try {
    await mkdir(state, { recursive: true }); await mkdir(snapshot, { recursive: true });
    expect(loadPendingTransaction(root)).toBeNull();
    await writeFile(join(state, "deploy-transaction"), "deploy-abc123");
    await writeFile(join(snapshot, "transaction"), serialize(record));
    expect(loadPendingTransaction(root)).toMatchObject({ operation: "deploy", snapshot: "deploy-abc123", record, targetSha: record.target_sha, committed: false });
    expect(loadPendingTransaction(root)?.rollbackPending).toBeUndefined();
    expect(describePendingTransaction(loadPendingTransaction(root)!).record).toContain("本机端口 2022");
    expect(describePendingTransaction(loadPendingTransaction(root)!).record).toContain("共享资料目录：/srv/new（原 /srv/old shared）");
    await writeFile(join(snapshot, "transaction"), serialize(legacy));
    expect(() => loadPendingTransaction(root)).toThrow("事务记录无效：format");
    await Bun.file(join(snapshot, "transaction")).delete();
    expect(() => loadPendingTransaction(root)).toThrow("事务格式不匹配");
    await writeFile(join(snapshot, "transaction"), serialize(record));
    // A committed journal from another deployment does not block rolling back this one.
    const journal = { format: 1, phase: "committed", deployment: "deploy-older", previous: null };
    await writeFile(join(state, "release-data.json"), JSON.stringify(journal));
    expect(loadPendingTransaction(root)?.committed).toBe(false);
    await writeFile(join(state, "release-data.json"), JSON.stringify({ ...journal, deployment: "deploy-abc123" }));
    expect(loadPendingTransaction(root)?.committed).toBe(true);
    await writeFile(join(state, "release-data.json"), JSON.stringify({ ...journal, deployment: "deploy-abc123", phase: "prepared" }));
    expect(loadPendingTransaction(root)?.committed).toBe(false);
    // The record must belong to the pointed snapshot, and pointer names are never paths.
    await writeFile(join(snapshot, "transaction"), serialize({ ...record, snapshot: "deploy-other" }));
    expect(() => loadPendingTransaction(root)).toThrow("不一致");
    await writeFile(join(state, "deploy-transaction"), "../deploy-abc123");
    expect(() => loadPendingTransaction(root)).toThrow("名称无效");
    await writeFile(join(state, "deploy-transaction"), "deploy-abc123");
    await Bun.file(join(snapshot, "transaction")).delete();
    await writeFile(join(snapshot, "target-sha"), "b".repeat(40));
    expect(() => loadPendingTransaction(root)).toThrow("事务格式不匹配");
    // A Windows upgrade pointer whose snapshot has no current record is refused too.
    await Bun.file(join(state, "deploy-transaction")).delete(); await Bun.file(join(state, "release-data.json")).delete();
    await Bun.file(join(snapshot, "target-sha")).delete();
    await writeFile(join(state, "upgrade-transaction"), "deploy-abc123");
    await writeFile(join(snapshot, "deployment.xml"), `<Objs><Obj><MS><S N="UpgradeTarget">${"e".repeat(40)}</S></MS></Obj></Objs>`);
    expect(() => loadPendingTransaction(root)).toThrow("事务格式不匹配");
  } finally { await fixture.cleanup(); }
});

// The shared core writes the record (serializeTransactionRecord); the shell entries read it to offer resume or rollback.
test.skipIf(!bash || !existsSync(bash))("Docker 入口读得懂核心写的事务记录，拒绝篡改，拒绝没有记录的旧快照", async () => {
  const fixture = await tempFixture("transaction-bash-");
  const script = join(fixture.root, "record.sh"), snapshot = join(fixture.root, "backup/snapshots/deploy-abc123");
  await mkdir(snapshot, { recursive: true }); await mkdir(join(fixture.root, "data/state"), { recursive: true });
  await writeFile(join(snapshot, "transaction"), serializeTransactionRecord({ ...record, operation: "upgrade", original_sha: "b".repeat(40),
    original_branch: "main", original_workspace_root: "", target_workspace_root: "/srv/new shared" }));
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
. '${posixPath(join(project, "scripts/lib/common.sh"))}'
PROJECT_DIR="$1"; snap="$PROJECT_DIR/backup/snapshots/deploy-abc123"
printf deploy-abc123 > "$PROJECT_DIR/data/state/deploy-transaction"
load_pending_transaction
echo "RECORD port=\${TRANSACTION[bot_port]} root=\${TRANSACTION[target_workspace_root]}"
echo "DESCRIBE $(describe_pending_transaction)"
cp "$snap/transaction" "$snap/transaction.good"
# A deployment without git has no target commit; the summary says so instead of leaving it blank.
sed -e 's/^operation=.*/operation=deploy/' -e 's/^target_sha=.*/target_sha=/' -e 's/^original_sha=.*/original_sha=/' -e 's/^original_branch=.*/original_branch=/' \\
  "$snap/transaction.good" > "$snap/transaction"
load_pending_transaction
echo "NON-GIT $(describe_pending_transaction)"
cp "$snap/transaction.good" "$snap/transaction"
printf 'bot_port=2023\\n' >> "$snap/transaction"
if load_pending_transaction 2>/dev/null; then echo 'duplicate accepted'; exit 1; fi
sed 's/^was_running=.*/was_running=2/' "$snap/transaction.good" > "$snap/transaction"
if load_pending_transaction 2>/dev/null; then echo 'invalid value accepted'; exit 1; fi
{ echo format=1; sed 1d "$snap/transaction.good"; echo deploy_mode=cloudflare; } > "$snap/transaction"
if load_pending_transaction; then echo 'legacy record accepted'; exit 1; fi
sed 's/^snapshot=.*/snapshot=deploy-other/' "$snap/transaction.good" > "$snap/transaction"
if load_pending_transaction 2>/dev/null; then echo 'foreign record accepted'; exit 1; fi
# Historical fragments cannot synthesize current release choices.
rm "$snap/transaction" "$snap/transaction.good"
printf '%s' "$(printf 'c%.0s' {1..40})" > "$snap/target-sha"
if load_pending_transaction; then echo 'old snapshot accepted'; exit 1; fi
`);
  try {
    const result = await execute([bash!, posixPath(script), posixPath(fixture.root)], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("RECORD port=2022 root=/srv/new shared");
    expect(result.output).toContain("DESCRIBE 未完成的升级：目标提交 aaaaaaa；");
    expect(result.output).toContain("NON-GIT 未完成的部署：目标提交 （非 git 部署）；");
    expect(result.output).toContain("事务记录无效：format");
    expect(result.output).toContain("事务格式不匹配");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows 入口读得懂核心写的事务记录，拒绝篡改和没有记录的旧快照", async () => {
  const fixture = await tempFixture("transaction-windows-");
  const script = join(fixture.root, "record.ps1"), snapshot = join(fixture.root, "backup/snapshots/deploy-" + "f".repeat(32));
  await mkdir(snapshot, { recursive: true }); await mkdir(join(fixture.root, "data/state"), { recursive: true });
  const good = serializeTransactionRecord({ ...record, snapshot: "deploy-" + "f".repeat(32), target_sha: "", original_workspace_root: "",
    target_workspace_root: "E:\\shared", was_running: "0", reconfigure_ai: "1" });
  await writeFile(join(fixture.root, "good.txt"), good);
  await writeFile(script, `﻿$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
$snapshot=${quotePS(snapshot)}; $record=Join-Path $snapshot 'transaction'; $good=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'good.txt'))
try { Read-DeploymentTransaction $snapshot; throw 'old snapshot accepted' } catch { if ($_.Exception.Message -notmatch '事务格式不匹配') { throw } }
[IO.File]::WriteAllText($record, $good)
$read=Read-DeploymentTransaction $snapshot
if ($read.target_workspace_root -cne 'E:\\shared' -or $read.original_workspace_root -cne '' -or $read.bot_port -cne '2022') { throw 'record not read back' }
Write-Output (Format-DeploymentTransaction $read)
[IO.File]::WriteAllText($record, ($good -replace '^format=2', 'format=1'))
try { $null = Read-DeploymentTransaction $snapshot; throw 'legacy record accepted' } catch { if ($_.Exception.Message -notmatch '事务记录无效：format') { throw } }
[IO.File]::WriteAllText($record, $good + 'bot_port=2023')
try { $null = Read-DeploymentTransaction $snapshot; throw 'duplicate accepted' } catch { if ($_.Exception.Message -eq 'duplicate accepted') { throw } }
# An empty saved root means the default; it is not dereferenced as null.
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'data\\state\\workspace-root') '' -NoNewline
if ((Get-SavedWorkspaceRoot $PSScriptRoot) -ne '') { throw 'empty saved root not defaulted' }
Write-Output 'RECORD_OK'
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0); expect(result.output).toContain("RECORD_OK");
    expect(result.output).toContain("本机端口 2022");
  } finally { await fixture.cleanup(); }
}, 30000);

// A broken ordinary setting is exactly what a recovery may need to repair; it must not block continue or rollback.
async function entryFixture(prefix: string, entry: string) {
  const fixture = await tempFixture(prefix), root = fixture.root, state = join(root, "data/state");
  await cp(join(project, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(join(project, entry), join(root, entry));
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "bot-port"), "invalid");
  return fixture;
}

test.skipIf(!bash || !existsSync(bash))("Linux 恢复入口先读事务记录，普通设置损坏不挡住继续或回滚", async () => {
  const fixture = await entryFixture("transaction-entry-linux-", "scripts/ops.sh"), root = fixture.root;
  try {
    // A pending deployment goes to the core through the host Bun, here a stand-in; a new one to the deploy entry.
    const runtime = join(root, "bun-stand-in");
    await writeFile(runtime, '#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo 1.4.4; exit 0; fi\necho "DISPATCHED ${*:3} end"\n', { mode: 0o755 });
    await writeFile(join(root, "scripts/deploy.sh"), '#!/usr/bin/env bash\necho "DEPLOY ENTRY command=$1"\n');
    await mkdir(join(root, "backup/snapshots/deploy-abc123"), { recursive: true });
    await writeFile(join(root, "backup/snapshots/deploy-abc123/transaction"), serialize(record));
    await writeFile(join(root, "data/state/deploy-transaction"), "deploy-abc123");
    // resume / rollback read the record under the deployment lock; Git Bash has no util-linux flock, Linux uses the real one.
    // An exported function, not a PATH stub: the Windows CI runner did not find a stub script written just before.
    const lock = process.platform === "win32" ? { "BASH_FUNC_flock%%": "() { return 0\n}" } : {};
    const ops = (command: string, entry = "scripts/ops.sh") => execute([bash!, posixPath(join(root, entry)), command], root,
      { ...process.env, ...lock, MSYS_NO_PATHCONV: "1", BOT_PORT: "", MIXIN_OPS_BUN: posixPath(runtime) });
    for (const [command, tail] of [["resume", " end"], ["rollback", " --rollback end"]] as const) {
      const result = await ops(command);
      expect(result.code, result.output).toBe(0); expect(result.output).toContain("DISPATCHED deployment deploy --project ");
      expect(result.output).toContain(tail + "\n"); expect(result.output.includes("--rollback")).toBe(command === "rollback");
      expect(result.output).not.toContain("无效");
    }
    // The health check after a resumed upgrade uses the recorded settings, not the broken saved ones.
    const source = await readFile(join(root, "scripts/ops.sh"), "utf8");
    // Everything before the command dispatch (the last case), including the entry's settings gate.
    await writeFile(join(root, "scripts/settings.sh"), source.slice(0, source.lastIndexOf('\ncase "${1:-}" in\n')) +
      '\necho "SETTINGS port=$PORT root=$DEPLOYED_WORKSPACE_ROOT"\n');
    const settings = await ops("resume", "scripts/settings.sh");
    expect(settings.output).toContain("SETTINGS port=2022 root=/srv/new\n");
    // The deployment script validates saved settings itself, and takes the command it runs for.
    expect((await ops("deploy")).output).toContain("DEPLOY ENTRY command=deploy\n");
    expect((await ops("repair")).output).toContain("DEPLOY ENTRY command=repair\n");
    // Ordinary operations still refuse to run on broken settings.
    const doctor = await ops("doctor");
    expect(doctor.code).toBe(1); expect(doctor.output).toContain("端口无效");
    // A damaged record, the record of another snapshot or a pointer whose snapshot is gone: continuing and rolling back both
    // refuse before anything is dispatched, and the pointer and the record stay as they were for the operator to inspect.
    const pointer = join(root, "data/state/deploy-transaction"), recorded = join(root, "backup/snapshots/deploy-abc123/transaction");
    for (const [fault, message] of [["duplicate", "事务记录无效：bot_port"], ["foreign", "事务记录与指针不一致"], ["gone", "部署快照缺失"]] as const) {
      await writeFile(recorded, fault === "duplicate" ? serialize(record) + "bot_port=2023\n" : serialize(fault === "foreign" ? { ...record, snapshot: "deploy-other" } : record));
      await writeFile(pointer, fault === "gone" ? "deploy-gone" : "deploy-abc123");
      const before = [await readFile(pointer, "utf8"), await readFile(recorded, "utf8")];
      for (const command of ["resume", "rollback"]) {
        const result = await ops(command);
        expect(result.code, `${fault} ${command}\n${result.output}`).toBe(1);
        expect(result.output).toContain("未完成事务的记录无法读取"); expect(result.output).toContain(message);
        expect(result.output).not.toContain("DISPATCHED");
        expect([await readFile(pointer, "utf8"), await readFile(recorded, "utf8")]).toEqual(before);
      }
    }
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(process.platform !== "win32")("Windows 恢复入口先读事务记录，普通设置损坏不挡住继续或回滚", async () => {
  const fixture = await entryFixture("transaction-entry-windows-", "scripts/ops.ps1"), root = fixture.root;
  const entry = join(root, "scripts/ops.ps1");
  try {
    const positional = (command: string) => execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & ${quotePS(entry)} ${command}; exit $LASTEXITCODE`], root,
      { ...process.env, BOT_PORT: "" });
    // The console encodes the command; it must be decoded before any ordinary setting is read.
    const encoded = (command: string) => {
      const request = opsCommand("windows", [command]);
      request.args[4] = entry;
      return execute([request.command, ...request.args], root, { ...process.env, ...request.env, BOT_PORT: "" });
    };
    // An empty file is as broken as an invalid value, and must not crash the entry either.
    for (const port of ["invalid", ""]) {
      await writeFile(join(root, "data/state/bot-port"), port);
      for (const ops of [positional, encoded]) {
        for (const command of ["resume", "rollback"]) {
          const result = await ops(command);
          expect(result.code, `${ops.name} ${command} port=${JSON.stringify(port)}\n${result.output}`).toBe(0);
          expect(result.output).toContain("没有未完成的部署或升级");
        }
        const status = await ops("status");
        expect(status.code, status.output).not.toBe(0); expect(status.output).toContain("端口无效");
        expect(status.output).not.toContain("InvokeMethodOnNull");
      }
    }
  } finally { await fixture.cleanup(); }
}, 120000);
