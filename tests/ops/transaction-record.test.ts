import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { opsCommand } from "../../scripts/ops/tui/platform.ts";
import { describePendingTransaction, loadPendingTransaction, parseTransactionRecord, transactionValueValid, type TransactionRecord } from "../../scripts/ops/tui/transaction.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posixPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const quotePS = (text: string) => "'" + text.replaceAll("'", "''") + "'";

const record: TransactionRecord = {
  format: "1", operation: "deploy", snapshot: "deploy-abc123", target_sha: "a".repeat(40), original_sha: "", original_branch: "",
  original_group_root: "/srv/old groups", target_group_root: "/srv/new", was_running: "1", bot_port: "2022", deploy_mode: "cloudflare",
  bot_domain: "bot.example.com", domain_action: "persist", unmanaged_tunnel: "", platform_ip: "203.0.113.17", reconfigure_ai: "0",
};
const serialize = (value: Record<string, string>) => Object.entries(value).map(([key, item]) => `${key}=${item}`).join("\n") + "\n";
// All three parsers must agree: an address one side accepts must never be refused by another after the stop.
const platformIps = ["203.0.113.17", "203.0.113.0/24", "2001:db8::1", "::1", "2001:db8::/32", "", "localhost", "203.0.113.17 ",
  "1.2.3.4;ufw disable", "1.2.3", "1".repeat(65)];
const platformIpVerdicts = () => platformIps.map(value => `${JSON.stringify(value)}=${transactionValueValid("platform_ip", value) ? 1 : 0}`).join(" ");

async function execute(args: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: out + "\n" + err };
}

test("事务记录逐键校验：重复、未知、缺失或非法的值拒绝整份记录", () => {
  expect(parseTransactionRecord(serialize(record))).toEqual(record);
  expect(parseTransactionRecord(serialize({ ...record, target_group_root: "D:\\groups", original_branch: "feature/x" })).target_group_root).toBe("D:\\groups");
  const invalid: Record<string, string>[] = [
    { ...record, bot_port: "70000" }, { ...record, bot_port: "0080" }, { ...record, target_sha: "abc" },
    { ...record, target_group_root: "groups" }, { ...record, snapshot: "../deploy-x" }, { ...record, bot_domain: "Bot.Example.com" },
    { ...record, bot_domain: "https://bot.example.com" }, { ...record, deploy_mode: "tunnel" }, { ...record, domain_action: "drop" },
    { ...record, original_branch: "bad branch" }, { ...record, target_group_root: "/srv/new\u0007" }, { ...record, extra: "1" },
    { ...record, platform_ip: "" }, { ...record, platform_ip: "localhost" }, { ...record, platform_ip: "1.2.3.4;ufw disable" },
  ];
  for (const value of invalid) expect(() => parseTransactionRecord(serialize(value)), JSON.stringify(value)).toThrow();
  for (const platform_ip of ["203.0.113.0/24", "2001:db8::1"]) expect(parseTransactionRecord(serialize({ ...record, platform_ip })).platform_ip).toBe(platform_ip);
  expect(platformIpVerdicts()).toContain('"203.0.113.17"=1'); expect(platformIpVerdicts()).toContain('"1.2.3"=0');
  const { reconfigure_ai: _, ...missing } = record;
  expect(() => parseTransactionRecord(serialize(missing))).toThrow("缺少");
  expect(() => parseTransactionRecord(serialize(record) + "bot_port=2022\n")).toThrow("bot_port");
});

test("运维界面按指针读取事务，数据已提交只看本事务的迁移回执", async () => {
  const fixture = await tempFixture("transaction-pending-");
  const root = fixture.root, state = join(root, "data/state"), snapshot = join(root, "backup/snapshots/deploy-abc123");
  try {
    await mkdir(state, { recursive: true }); await mkdir(snapshot, { recursive: true });
    expect(loadPendingTransaction(root)).toBeNull();
    await writeFile(join(state, "deploy-transaction"), "deploy-abc123");
    await writeFile(join(snapshot, "transaction"), serialize(record));
    expect(loadPendingTransaction(root)).toMatchObject({ operation: "deploy", snapshot: "deploy-abc123", record, targetSha: record.target_sha, committed: false, codeRestorePending: false });
    // An upgrade whose data was rolled back but whose code restore failed can only finish rolling back.
    await writeFile(join(snapshot, "code-restore"), "");
    expect(loadPendingTransaction(root)?.codeRestorePending).toBe(true);
    await Bun.file(join(snapshot, "code-restore")).delete();
    // Direct entries show the recorded firewall source that continuing will use.
    await writeFile(join(snapshot, "transaction"), serialize({ ...record, deploy_mode: "direct", bot_domain: "" }));
    expect(describePendingTransaction(loadPendingTransaction(root)!).record).toContain("端口 2022 · 入口 直连（来源 203.0.113.17）");
    // A legacy snapshot without a record: Linux continues only after the one-time backfill in a terminal.
    await Bun.file(join(snapshot, "transaction")).delete();
    const legacy = loadPendingTransaction(root)!;
    expect(describePendingTransaction(legacy, "linux").record).toEqual(["旧版事务没有记录：继续前需在终端逐项确认并补录一次，回滚不需要"]);
    for (const [pending, platform] of [[legacy, "windows"], [{ ...legacy, snapshot: null }, "linux"], [{ ...legacy, codeRestorePending: true }, "linux"]] as const) {
      expect(describePendingTransaction(pending, platform).record).toEqual(["旧版事务：继续时按已保存设置处理"]);
    }
    await writeFile(join(snapshot, "transaction"), serialize(record));
    // A committed journal from another deployment does not block rolling back this one.
    const journal = { id: "migration-1", target: 1, phase: "committed", groups: "/srv/new", deployment: "deploy-older" };
    await writeFile(join(state, "migration.json"), JSON.stringify(journal));
    expect(loadPendingTransaction(root)?.committed).toBe(false);
    await writeFile(join(state, "migration.json"), JSON.stringify({ ...journal, deployment: "deploy-abc123" }));
    expect(loadPendingTransaction(root)?.committed).toBe(true);
    await writeFile(join(state, "migration.json"), JSON.stringify({ ...journal, deployment: "deploy-abc123", phase: "validated", kind: "migration" }));
    expect(loadPendingTransaction(root)?.committed).toBe(false);
    // The record must belong to the pointed snapshot, and pointer names are never paths.
    await writeFile(join(snapshot, "transaction"), serialize({ ...record, snapshot: "deploy-other" }));
    expect(() => loadPendingTransaction(root)).toThrow("不一致");
    await writeFile(join(state, "deploy-transaction"), "../deploy-abc123");
    expect(() => loadPendingTransaction(root)).toThrow("名称无效");
    // Legacy Docker deployment: no record, target from the snapshot.
    await writeFile(join(state, "deploy-transaction"), "deploy-abc123");
    await Bun.write(join(snapshot, "transaction"), ""); await Bun.file(join(snapshot, "transaction")).delete();
    await writeFile(join(snapshot, "target-sha"), "b".repeat(40) + "\n");
    expect(loadPendingTransaction(root)).toMatchObject({ operation: "deploy", record: null, targetSha: "b".repeat(40) });
    // Legacy Linux upgrade stopped before the deployment began: only the stop record and receipt exist.
    await Bun.file(join(state, "deploy-transaction")).delete(); await Bun.file(join(state, "migration.json")).delete();
    await writeFile(join(state, "update-transaction"), ["1", "c".repeat(40), "main", "d".repeat(40), "-", "1", ""].join("\n"));
    await writeFile(join(state, "update-commit"), "");
    expect(loadPendingTransaction(root)).toMatchObject({ operation: "upgrade", snapshot: null, record: null, targetSha: "d".repeat(40), committed: false, codeRestorePending: false });
    await writeFile(join(state, "update-commit"), "committed");
    expect(loadPendingTransaction(root)?.committed).toBe(true);
    // Legacy Windows upgrade keeps its target only in the Clixml snapshot.
    await Bun.file(join(state, "update-transaction")).delete(); await Bun.file(join(state, "update-commit")).delete();
    await Bun.file(join(snapshot, "target-sha")).delete();
    await writeFile(join(state, "upgrade-transaction"), "deploy-abc123");
    await writeFile(join(snapshot, "deployment.xml"), `<Objs><Obj><MS><S N="UpgradeTarget">${"e".repeat(40)}</S></MS></Obj></Objs>`);
    expect(loadPendingTransaction(root)).toMatchObject({ operation: "upgrade", snapshot: "deploy-abc123", record: null, targetSha: "e".repeat(40) });
  } finally { await fixture.cleanup(); }
});

test.skipIf(!bash || !existsSync(bash))("Docker 事务记录可往返读写，拒绝篡改，并能从旧版快照合成", async () => {
  const fixture = await tempFixture("transaction-bash-");
  const script = join(fixture.root, "record.sh"), snapshot = join(fixture.root, "backup/snapshots/deploy-abc123");
  await mkdir(snapshot, { recursive: true }); await mkdir(join(fixture.root, "data/state"), { recursive: true });
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
. '${posixPath(join(project, "scripts/lib/common.sh"))}'
PROJECT_DIR="$1"; snap="$PROJECT_DIR/backup/snapshots/deploy-abc123"
declare -gA TRANSACTION=([format]=1 [operation]=upgrade [snapshot]=deploy-abc123 [target_sha]="$(printf 'a%.0s' {1..40})"
  [original_sha]="$(printf 'b%.0s' {1..40})" [original_branch]=main [original_group_root]=/srv/old [target_group_root]="/srv/new groups"
  [was_running]=1 [bot_port]=2022 [deploy_mode]=cloudflare [bot_domain]=bot.example.com [domain_action]=keep [unmanaged_tunnel]=''
  [platform_ip]=203.0.113.17 [reconfigure_ai]=0)
write_transaction_record "$snap"
verdicts=''
for value in ${platformIps.map(value => `'${value}'`).join(" ")}; do
    if transaction_value_valid platform_ip "$value"; then ok=1; else ok=0; fi
    verdicts+="$(printf '"%s"=%s ' "$value" "$ok")"
done
echo "VERDICTS \${verdicts% }"
# Values that could not be read back are refused before anything is written.
TRANSACTION[bot_port]=70000
if write_transaction_record "$snap" 2>/dev/null; then echo 'invalid value written'; exit 1; fi
printf deploy-abc123 > "$PROJECT_DIR/data/state/deploy-transaction"
unset TRANSACTION
load_pending_transaction
echo "RECORD port=\${TRANSACTION[bot_port]} root=\${TRANSACTION[target_group_root]} platform=\${TRANSACTION[platform_ip]} legacy=$TRANSACTION_LEGACY"
cp "$snap/transaction" "$snap/transaction.good"
printf 'bot_port=2023\\n' >> "$snap/transaction"
if load_pending_transaction 2>/dev/null; then echo 'duplicate accepted'; exit 1; fi
sed 's/^deploy_mode=.*/deploy_mode=tunnel/' "$snap/transaction.good" > "$snap/transaction"
if load_pending_transaction 2>/dev/null; then echo 'invalid mode accepted'; exit 1; fi
sed 's/^snapshot=.*/snapshot=deploy-other/' "$snap/transaction.good" > "$snap/transaction"
if load_pending_transaction 2>/dev/null; then echo 'foreign record accepted'; exit 1; fi
# Legacy snapshot: target root, target commit and running state from the snapshot; port, mode and domain from saved settings.
rm "$snap/transaction" "$snap/transaction.good"
printf '%s' "$(printf 'c%.0s' {1..40})" > "$snap/target-sha"; printf 0 > "$snap/was-running"; printf /srv/legacy > "$snap/group-root"
printf 3033 > "$PROJECT_DIR/data/state/bot-port"; printf 'Bot.Example.com' > "$PROJECT_DIR/data/state/bot-domain"
# Old snapshots never recorded the source address; they keep the old behaviour of the current setting.
PLATFORM_IP=198.51.100.9
load_pending_transaction
echo "LEGACY port=\${TRANSACTION[bot_port]} root=\${TRANSACTION[target_group_root]} original=\${TRANSACTION[original_group_root]} domain=\${TRANSACTION[bot_domain]} action=\${TRANSACTION[domain_action]} platform=\${TRANSACTION[platform_ip]} legacy=$TRANSACTION_LEGACY"
describe_pending_transaction; echo
# The original group root comes from the snapshot's copy of the saved setting when there is one; every value names its source.
mkdir -p "$snap/data/state"; printf /srv/original > "$snap/data/state/group-data-root"
load_pending_transaction
echo "SOURCES original=\${TRANSACTION[original_group_root]} from=\${TRANSACTION_SOURCE[original_group_root]} target=\${TRANSACTION_SOURCE[target_sha]} port=\${TRANSACTION_SOURCE[bot_port]} platform=\${TRANSACTION_SOURCE[platform_ip]}"
# Continuing needs the values confirmed in a terminal; without one nothing is written.
if backfill_legacy_transaction </dev/null; then echo 'backfilled without a terminal'; exit 1; fi
[ ! -e "$snap/transaction" ] || { echo 'record written without confirmation'; exit 1; }
`);
  try {
    const result = await execute([bash!, posixPath(script), posixPath(fixture.root)], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("RECORD port=2022 root=/srv/new groups platform=203.0.113.17 legacy=0");
    expect(result.output).toContain(`LEGACY port=3033 root=/srv/legacy original=${posixPath(fixture.root)}/data/groups domain=bot.example.com action=persist platform=198.51.100.9 legacy=1`);
    expect(result.output).toContain(`VERDICTS ${platformIpVerdicts()}\n`);
    expect(result.output).toContain("旧版事务");
    expect(result.output).toContain("SOURCES original=/srv/original from=快照 data/state/group-data-root target=快照 target-sha port=已保存设置 platform=当前终端的 PLATFORM_IP");
    expect(result.output).toContain("逐项确认并补录");
  } finally { await fixture.cleanup(); }
}, 30000);

// The confirmation reads a terminal: util-linux script provides one on Linux.
test.skipIf(process.platform !== "linux" || !Bun.which("script"))("旧版事务继续前在终端核对每个值的来源，确认后只补录一次完整记录", async () => {
  const fixture = await tempFixture("transaction-backfill-");
  const snap = join(fixture.root, "backup/snapshots/deploy-abc123"), state = join(fixture.root, "data/state"), script = join(fixture.root, "backfill.sh");
  await mkdir(join(snap, "data/state"), { recursive: true }); await mkdir(state, { recursive: true });
  await writeFile(join(snap, "target-sha"), "c".repeat(40)); await writeFile(join(snap, "was-running"), "1");
  await writeFile(join(snap, "group-root"), "/srv/groups"); await writeFile(join(snap, "data/state/group-data-root"), "/srv/groups");
  await writeFile(join(state, "bot-port"), "3033"); await writeFile(join(state, "deploy-transaction"), "deploy-abc123");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
. '${join(project, "scripts/lib/common.sh")}'
PROJECT_DIR="$1"
load_pending_transaction
if backfill_legacy_transaction; then echo "BACKFILLED legacy=$TRANSACTION_LEGACY"; else echo DECLINED; fi
load_pending_transaction
echo "RELOADED legacy=$TRANSACTION_LEGACY port=\${TRANSACTION[bot_port]} root=\${TRANSACTION[target_group_root]}"
`);
  const answer = async (input: string) => {
    const child = Bun.spawn(["script", "-qec", `bash '${script}' '${fixture.root}'`, "/dev/null"], {
      cwd: fixture.root, env: { ...process.env, PLATFORM_IP: "" }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    return out + err;
  };
  try {
    let output = await answer("n\n");
    expect(output).toContain("DECLINED"); expect(output).toContain("RELOADED legacy=1");
    expect(output).toMatch(/目标提交\s+c{40}（快照 target-sha）/); expect(output).toMatch(/端口\s+3033（已保存设置）/);
    expect(output).toMatch(/原群数据总根\s+\/srv\/groups（快照 data\/state\/group-data-root）/); expect(output).toMatch(/平台IP\s+\S+（默认值）/);
    expect(existsSync(join(snap, "transaction"))).toBe(false);
    output = await answer("y\n");
    expect(output).toContain("BACKFILLED legacy=0"); expect(output).toContain("RELOADED legacy=0 port=3033 root=/srv/groups");
    const record = await readFile(join(snap, "transaction"), "utf8");
    expect(record).toContain(`target_sha=${"c".repeat(40)}\n`); expect(record).toContain("operation=deploy\n"); expect(record).toContain("was_running=1\n");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows 事务记录与 Docker 同一格式，拒绝篡改，指针在记录之后发布", async () => {
  const fixture = await tempFixture("transaction-windows-");
  const script = join(fixture.root, "record.ps1"), snapshot = join(fixture.root, "backup/snapshots/deploy-" + "f".repeat(32));
  await mkdir(snapshot, { recursive: true }); await mkdir(join(fixture.root, "data/state"), { recursive: true });
  await writeFile(join(fixture.root, "plan.json"), "{}");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
$snapshot=${quotePS(snapshot)}; $pointer=Join-Path $PSScriptRoot 'data\\state\\deploy-transaction'
if (Read-DeploymentTransaction $snapshot) { throw 'absent record not null' }
$verdicts=foreach ($value in @(${platformIps.map(value => `'${value}'`).join(", ")})) { '"' + $value + '"=' + [int](Test-TransactionValue 'platform_ip' $value) }
Write-Output ('VERDICTS ' + ($verdicts -join ' '))
$record=@{ format='1'; operation='deploy'; snapshot=(Split-Path $snapshot -Leaf); target_sha=''; original_sha=''; original_branch=''
    original_group_root='D:\\old groups'; target_group_root='E:\\groups'; was_running='0'; bot_port='2022'; deploy_mode='direct'
    bot_domain=''; domain_action='clear'; unmanaged_tunnel='direct'; platform_ip='203.0.113.17'; reconfigure_ai='1' }
$bad=$record.Clone(); $bad.bot_port='70000'
try { Publish-DeploymentTransaction ([pscustomobject]@{Path=$snapshot}) $bad $pointer; throw 'invalid record published' } catch { if ($_.Exception.Message -eq 'invalid record published') { throw } }
if (Test-Path -LiteralPath $pointer) { throw 'pointer published without a valid record' }
Publish-DeploymentTransaction ([pscustomobject]@{Path=$snapshot}) $record $pointer (Join-Path $PSScriptRoot 'plan.json')
if (-not (Test-Path -LiteralPath (Join-Path $snapshot 'migration-plan.json'))) { throw 'plan not kept with the snapshot' }
$read=Read-DeploymentTransaction $snapshot
if ($read.target_group_root -cne 'E:\\groups' -or $read.unmanaged_tunnel -cne 'direct' -or $read.platform_ip -cne '203.0.113.17') { throw 'record not read back' }
Write-Output (Format-DeploymentTransaction $read)
Add-Content -LiteralPath (Join-Path $snapshot 'transaction') 'bot_port=2023' -NoNewline
try { $null = Read-DeploymentTransaction $snapshot; throw 'duplicate accepted' } catch { if ($_.Exception.Message -eq 'duplicate accepted') { throw } }
# Empty pointers are refused by name and an empty saved root means the default; neither is dereferenced as null.
Set-Content -LiteralPath $pointer '' -NoNewline
try { $null = Open-DeploymentTransaction $PSScriptRoot; throw 'empty pointer opened' } catch { if ($_.Exception.Message -ne '部署事务快照名称无效') { throw } }
$upgradePointer=Join-Path $PSScriptRoot 'data\\state\\upgrade-transaction'
Set-Content -LiteralPath $upgradePointer '' -NoNewline
try { $null = Open-UpgradeSnapshot $PSScriptRoot 'task' '' '' ''; throw 'empty upgrade pointer opened' } catch { if ($_.Exception.Message -ne '升级事务快照名称无效') { throw } }
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'data\\state\\group-data-root') '' -NoNewline
if ((Get-SavedGroupDataRoot $PSScriptRoot) -ne [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'data\\groups'))) { throw 'empty saved root not defaulted' }
Write-Output 'RECORD_OK'
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0); expect(result.output).toContain("RECORD_OK");
    expect(result.output).toContain(`VERDICTS ${platformIpVerdicts()}\r\n`);
    expect(result.output).toContain("入口 direct（来源 203.0.113.17）");
    // The UI parses the Windows record with the same rules (UTF-8 without BOM, LF lines).
    const text = await readFile(join(snapshot, "transaction"), "utf8");
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(() => parseTransactionRecord(text)).toThrow("bot_port");
    expect(parseTransactionRecord(text.replace(/bot_port=2023$/, "")).bot_port).toBe("2022");
  } finally { await fixture.cleanup(); }
}, 30000);

// A broken ordinary setting is exactly what a recovery may need to repair; it must not block continue or rollback.
async function entryFixture(prefix: string, entry: string) {
  const fixture = await tempFixture(prefix), root = fixture.root, state = join(root, "data/state");
  await cp(join(project, "scripts/lib"), join(root, "scripts/lib"), { recursive: true });
  await mkdir(join(root, "scripts/ops"), { recursive: true }); await mkdir(join(root, "scripts/deploy"), { recursive: true });
  await copyFile(join(project, entry), join(root, entry));
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "bot-port"), "invalid"); await writeFile(join(state, "deploy-mode"), "bogus");
  return fixture;
}

test.skipIf(!bash || !existsSync(bash))("Linux 恢复入口先读事务记录，普通设置损坏不挡住继续或回滚", async () => {
  const fixture = await entryFixture("transaction-entry-linux-", "scripts/ops/ops.sh"), root = fixture.root;
  try {
    await writeFile(join(root, "scripts/deploy/deploy.sh"), '#!/usr/bin/env bash\necho "DISPATCHED action=${DEPLOY_TRANSACTION_ACTION:-}"\n');
    await mkdir(join(root, "backup/snapshots/deploy-abc123"), { recursive: true });
    await writeFile(join(root, "backup/snapshots/deploy-abc123/transaction"), serialize(record));
    await writeFile(join(root, "data/state/deploy-transaction"), "deploy-abc123");
    // resume / rollback read the record under the deployment lock; Git Bash has no util-linux flock, Linux uses the real one.
    // An exported function, not a PATH stub: the Windows CI runner did not find a stub script written just before.
    const lock = process.platform === "win32" ? { "BASH_FUNC_flock%%": "() { return 0\n}" } : {};
    const ops = (command: string, entry = "scripts/ops/ops.sh") => execute([bash!, posixPath(join(root, entry)), command], root,
      { ...process.env, ...lock, MSYS_NO_PATHCONV: "1", BOT_PORT: "", BOT_DOMAIN: "" });
    for (const [command, action] of [["resume", "continue"], ["rollback", "rollback"]]) {
      const result = await ops(command!);
      expect(result.code, result.output).toBe(0); expect(result.output).toContain(`DISPATCHED action=${action}`);
      expect(result.output).not.toContain("无效");
    }
    // The health check after a resumed upgrade uses the recorded settings, not the broken saved ones.
    const source = await readFile(join(root, "scripts/ops/ops.sh"), "utf8");
    // Everything before the command dispatch (the last case), including the entry's settings gate.
    await writeFile(join(root, "scripts/ops/settings.sh"), source.slice(0, source.lastIndexOf('\ncase "${1:-}" in\n')) +
      '\necho "SETTINGS port=$PORT mode=$DEPLOY_MODE domain=$DOMAIN root=$DEPLOYED_GROUP_DATA_ROOT"\n');
    const settings = await ops("resume", "scripts/ops/settings.sh");
    expect(settings.output).toContain("SETTINGS port=2022 mode=cloudflare domain=bot.example.com root=/srv/new\n");
    // The deployment script validates and offers to correct saved settings itself.
    expect((await ops("deploy")).output).toContain("DISPATCHED action=\n");
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
}, 30000);

test.skipIf(process.platform !== "win32")("Windows 恢复入口先读事务记录，普通设置损坏不挡住继续或回滚", async () => {
  const fixture = await entryFixture("transaction-entry-windows-", "scripts/ops/ops.ps1"), root = fixture.root;
  const entry = join(root, "scripts/ops/ops.ps1");
  try {
    const positional = (command: string) => execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & ${quotePS(entry)} ${command}; exit $LASTEXITCODE`], root,
      { ...process.env, BOT_PORT: "" });
    // The TUI encodes the command; it must be decoded before any ordinary setting is read.
    const encoded = (command: string) => {
      const tui = opsCommand("windows", [command]);
      tui.args[4] = entry;
      return execute([tui.command, ...tui.args], root, { ...process.env, ...tui.env, BOT_PORT: "" });
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
