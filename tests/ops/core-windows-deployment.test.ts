import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";
import { WindowsDeployment } from "../../scripts/ops/core/windows-deployment.ts";
import { WindowsPlatform } from "../../scripts/ops/core/windows-host.ts";
import { runNative, type NativeRunner } from "../../scripts/ops/core/native-process.ts";
import { readTransaction } from "../../scripts/lib/confirmed-transaction.ts";
import { serializeTransactionRecord } from "../../scripts/ops/core/transaction-record.ts";
const source = resolve(import.meta.dir, "../.."), windows = process.platform === "win32";
const harness = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$fixture=Get-Content -LiteralPath $env:FIXTURE_FACTS -Raw -Encoding UTF8 | ConvertFrom-Json
$global:effects=[Collections.Generic.List[string]]::new()
function Get-ScheduledTask { param($TaskName,$ErrorAction); $fixture.task }
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) }
function Export-ScheduledTask { param($TaskName,$ErrorAction); '<Task>fixture</Task>' }
function Register-ScheduledTask { param($TaskName,$Xml,[switch]$Force,$ErrorAction); $global:effects.Add('register') }
function Disable-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('disable'); $fixture.task.State='Disabled' }
function Enable-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('enable'); $fixture.task.State='Ready' }
function Stop-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('stop'); $fixture.task.State='Disabled' }
function Start-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('start'); $fixture.task.State='Running' }
$global:LASTEXITCODE=0
& $env:FIXTURE_PLATFORM -RequestBase64 $env:FIXTURE_REQUEST
$code=$LASTEXITCODE
[IO.File]::WriteAllText($env:FIXTURE_EFFECTS,(ConvertTo-Json -InputObject @($global:effects) -Compress),[Text.UTF8Encoding]::new($false))
exit $code
`;
async function fixture() {
  const f = await tempFixture("core-windows-deployment-"), script = join(f.root, "native.ps1"), project = join(f.root, "中文 project");
  const facts = join(f.root, "facts.json"), effects = join(f.root, "effects.json"), task = { TaskName: "mixin-chatbot", TaskPath: "\\", State: "Ready",
    Principal: { UserId: "fixture", GroupId: null, LogonType: "S4U", RunLevel: "Highest" },
    Actions: [{ Execute: "powershell.exe", Arguments: "-File fixture.ps1", WorkingDirectory: project }] };
  await mkdir(join(project, "data/config"), { recursive: true }); await mkdir(join(project, "data/state"));
  await writeFile(join(project, "data/config/app-bot.json"), "synthetic-private-value");
  await writeFile(script, "\ufeff" + harness.replace(/\r?\n/g, "\r\n"));
  const output: string[] = [];
  const runner: NativeRunner = async command => {
    await writeFile(facts, JSON.stringify({ task }));
    return runNative({ ...command, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      env: { ...command.env, ...process.env, FIXTURE_FACTS: facts, FIXTURE_EFFECTS: effects,
        FIXTURE_PLATFORM: command.args[command.args.indexOf("-File") + 1], FIXTURE_REQUEST: command.args.at(-1) } }, text => { output.push(text); });
  };
  const identity = (await new WindowsPlatform(project, source, runner).inspect()).identity;
  const adapter = new WindowsDeployment(project, source, "deploy-nativefixture", identity, runner), snapshot = join(project, "backup/snapshots/deploy-nativefixture");
  return { ...f, project, snapshot, task, adapter, identity, output, runner, effects: async () => JSON.parse(await readFile(effects, "utf8")) };
}
test.skipIf(!windows)("Windows 部署原生动作只复制配置与依赖、保留停止，恢复任务定义不自行启动", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.project, "node_modules")); await writeFile(join(f.project, "node_modules/original"), "old");
    expect(await f.adapter.capture("a".repeat(40), "b".repeat(40), "main")).toMatchObject({ wasRunning: false, hasTask: true, identity: f.identity });
    const xml = await readFile(join(f.snapshot, "deployment.xml")); expect(xml.length).toBeGreaterThan(100);
    await writeFile(join(f.snapshot, "transaction"), serializeTransactionRecord({ format: "2", operation: "upgrade", snapshot: "deploy-nativefixture",
      target_sha: "b".repeat(40), original_sha: "a".repeat(40), original_branch: "main", original_workspace_root: "", target_workspace_root: "",
      was_running: "0", bot_port: "1011", reconfigure_ai: "0" }));
    await writeFile(join(f.project, "data/state/upgrade-transaction"), "deploy-nativefixture");
    expect(readTransaction(f.project)?.id).toBe("deploy-nativefixture");
    expect(await readFile(join(f.snapshot, "data/config/app-bot.json"), "utf8")).toBe("synthetic-private-value");
    expect(JSON.stringify(await f.adapter.read())).not.toContain("synthetic-private-value");
    f.task.State = "Running"; await f.adapter.effect("stop"); expect(await f.effects()).toEqual(["disable", "stop"]);
    f.task.State = "Disabled"; await f.adapter.effect("save-dependencies");
    expect(existsSync(join(f.project, "node_modules"))).toBe(false); expect((await f.adapter.read()).dependenciesMoved).toBe(true);
    await mkdir(join(f.project, "node_modules")); await writeFile(join(f.project, "node_modules/new"), "new");
    await f.adapter.effect("save-dependencies"); // A retry keeps the original snapshot, never adopts the new dependencies.
    await f.adapter.effect("restore-dependencies"); expect(await readFile(join(f.project, "node_modules/original"), "utf8")).toBe("old");
    await writeFile(join(f.project, "data/config/app-bot.json"), "changed"); await f.adapter.effect("restore-configuration");
    expect(await readFile(join(f.project, "data/config/app-bot.json"), "utf8")).toBe("synthetic-private-value");
    expect((await readdir(join(f.project, "backup/rm/deploy-nativefixture"))).length).toBeGreaterThan(0);
    await f.adapter.effect("restore-task"); expect(await f.effects()).toEqual(["register"]);
    expect(f.output.join("")).not.toContain("synthetic-private-value");
  } finally { await f.cleanup(); }
}, 60_000);

test.skipIf(!windows)("Windows 部署拒绝陌生任务、运行中的文件覆盖与快照字段篡改", async () => {
  const f = await fixture();
  try {
    await f.adapter.capture("a".repeat(40), "b".repeat(40), "main");
    f.task.State = "Running";
    await expect(f.adapter.effect("restore-configuration")).rejects.toThrow(); expect(await f.effects()).toEqual([]);
    f.task.State = "Ready"; f.task.Actions[0]!.WorkingDirectory = f.root;
    await expect(f.adapter.effect("stop")).rejects.toThrow(); expect(await f.effects()).toEqual([]);
    f.task.Actions[0]!.WorkingDirectory = f.project;
    const path = join(f.snapshot, "deployment.xml"), bytes = await readFile(path);
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe, encoding = utf16 ? "utf16le" : "utf8";
    const text = bytes.toString(encoding); expect(text).toContain("data\\config");
    await writeFile(path, Buffer.from(text.replaceAll("data\\config", "data\\conversations"), encoding));
    await expect(f.adapter.effect("restore-configuration")).rejects.toThrow(); expect(await f.effects()).toEqual([]);
    expect(await readFile(join(f.project, "data/config/app-bot.json"), "utf8")).toBe("synthetic-private-value");
  } finally { await f.cleanup(); }
}, 30_000);

// A deployment registers and removes the task, so this scheduler keeps its state in the facts file between calls.
const deployHarness = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$global:fixture=Get-Content -LiteralPath $env:FIXTURE_FACTS -Raw -Encoding UTF8 | ConvertFrom-Json
$global:effects=[Collections.Generic.List[string]]::new()
function Get-ScheduledTask { param($TaskName,$ErrorAction); if ($global:fixture.task) { $global:fixture.task } }
function Get-ScheduledTaskInfo { param($TaskName,$ErrorAction); [pscustomobject]@{ LastTaskResult=[int]$global:fixture.lastResult } }
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction) }
function Start-Sleep { param($Seconds,$Milliseconds) }
function Export-ScheduledTask { param($TaskName,$ErrorAction); '<Task>' + $global:fixture.task.Principal.LogonType + '</Task>' }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); [pscustomobject]@{ Execute=$Execute; Arguments=$Argument; WorkingDirectory=$WorkingDirectory } }
function New-ScheduledTaskSettingsSet { param($RestartCount,$RestartInterval,[switch]$StartWhenAvailable,[switch]$DontStopIfGoingOnBatteries,$ExecutionTimeLimit)
  [pscustomobject]@{ Enabled=$true; RestartCount=$RestartCount; Limit=[string]$ExecutionTimeLimit } }
function New-ScheduledTaskTrigger { param([switch]$AtStartup,[switch]$AtLogOn,$User); [pscustomobject]@{ AtStartup=[bool]$AtStartup; User=$User } }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel); [pscustomobject]@{ UserId=$UserId; GroupId=$null; LogonType=$LogonType; RunLevel=$RunLevel } }
function Register-ScheduledTask { param($TaskName,$Xml,$Action,$Trigger,$Settings,$Principal,[switch]$Force,$ErrorAction)
  if ($Xml) { $global:effects.Add('register-xml'); $global:fixture.task=$global:fixture.saved; return }
  if ($Principal.LogonType -eq 'S4U' -and $global:fixture.refuseS4U) { $global:effects.Add('refused-S4U'); throw 'S4U refused by policy' }
  $global:effects.Add('register-' + $Principal.LogonType)
  $global:fixture.task=[pscustomobject]@{ TaskName='mixin-chatbot'; TaskPath='\\'; State=$(if ($Settings.Enabled) { 'Ready' } else { 'Disabled' }); Principal=$Principal;
    Actions=@($Action | ForEach-Object { [pscustomobject]@{ Execute=$_.Execute; Arguments=$_.Arguments; WorkingDirectory=$_.WorkingDirectory } }); Settings=$Settings; Trigger=$Trigger } }
function Unregister-ScheduledTask { param($TaskName,[switch]$Confirm,$ErrorAction); $global:effects.Add('unregister'); $global:fixture.task=$null }
function Disable-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('disable'); $global:fixture.task.State='Disabled'; $global:fixture.task.Settings.Enabled=$false }
function Enable-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('enable'); $global:fixture.task.State='Ready'; $global:fixture.task.Settings.Enabled=$true }
function Stop-ScheduledTask { param($TaskName,$ErrorAction); $global:effects.Add('stop'); if ($global:fixture.task.State -eq 'Running') { $global:fixture.task.State='Ready' } }
function Start-ScheduledTask { param($TaskName,$ErrorAction)
  $global:effects.Add('start')
  if ($global:fixture.task.State -eq 'Disabled') { throw 'The task is disabled' }
  if ($global:fixture.task.Principal.LogonType -eq 'S4U' -and $global:fixture.failS4UStart) { throw 'S4U start refused' }
  if ($global:fixture.task.Principal.LogonType -eq 'S4U' -and $global:fixture.s4uLogonFailure) { $global:fixture.lastResult=-2147023570; return }
  $global:fixture.task.State='Running'; $global:fixture.lastResult=267009 }
$global:LASTEXITCODE=0
try { & $env:FIXTURE_PLATFORM -RequestBase64 $env:FIXTURE_REQUEST; $code=$LASTEXITCODE }
finally {
  [IO.File]::WriteAllText($env:FIXTURE_FACTS,(ConvertTo-Json -InputObject $global:fixture -Depth 8 -Compress),[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($env:FIXTURE_EFFECTS,(ConvertTo-Json -InputObject @($global:effects) -Compress),[Text.UTF8Encoding]::new($false))
}
exit $code
`;
interface DeployFacts { task: any; saved?: any; lastResult?: number; refuseS4U?: boolean; failS4UStart?: boolean; s4uLogonFailure?: boolean }
async function deployFixture(task: "none" | "ours" | "foreign") {
  const f = await tempFixture("core-windows-deploy-"), script = join(f.root, "native.ps1"), project = join(f.root, "中文 project");
  const factsPath = join(f.root, "facts.json"), effects = join(f.root, "effects.json");
  const original = { TaskName: "mixin-chatbot", TaskPath: "\\", State: "Ready", Principal: { UserId: "fixture", GroupId: null, LogonType: "S4U", RunLevel: "Limited" },
    Actions: [{ Execute: "powershell.exe", Arguments: "-File old-launcher.ps1", WorkingDirectory: task === "foreign" ? f.root : project }], Settings: { Enabled: true } };
  const facts: { value: DeployFacts } = { value: { task: task === "none" ? null : original, saved: original, lastResult: 0 } };
  await mkdir(project, { recursive: true });
  await writeFile(script, "\ufeff" + deployHarness.replace(/\r?\n/g, "\r\n"));
  const output: string[] = [];
  const runner: NativeRunner = async command => {
    await writeFile(factsPath, JSON.stringify(facts.value)); await writeFile(effects, "[]");
    try {
      return await runNative({ ...command, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
        env: { ...command.env, ...process.env, FIXTURE_FACTS: factsPath, FIXTURE_EFFECTS: effects,
          FIXTURE_PLATFORM: command.args[command.args.indexOf("-File") + 1], FIXTURE_REQUEST: command.args.at(-1) } }, text => { output.push(text); });
    } finally { facts.value = JSON.parse(await readFile(factsPath, "utf8")); }
  };
  const adapter = new WindowsDeployment(project, source, "deploy-nativefixture", "", runner, runner, "deploy");
  const tools = { bun: "C:\\Tools\\it's\\bun.exe", git: "C:\\Program Files\\Git\\cmd\\git.exe", uv: "D:\\uv\\uv.exe", bash: "C:\\Program Files\\Git\\bin\\bash.exe" };
  return { ...f, project, facts, adapter, tools, output, runner, snapshot: join(project, "backup/snapshots/deploy-nativefixture"),
    effects: async () => JSON.parse(await readFile(effects, "utf8")) as string[] };
}
test.skipIf(!windows)("Windows 首次部署：准备目录、安装禁用的任务和启动器，S4U 登录被拒时回退登录启动，回滚注销任务", async () => {
  const f = await deployFixture("none");
  try {
    expect(await f.adapter.capture("", "", "")).toMatchObject({ wasRunning: false, hasTask: false, dependenciesAttempted: false });
    await f.adapter.effect("stop"); expect(await f.effects()).toEqual([]);
    await f.adapter.effect("prepare-directories");
    for (const relative of ["data/config", "data/state", "data/runtime", "logs"]) expect(existsSync(join(f.project, relative))).toBe(true);
    await f.adapter.effect("save-dependencies"); expect((await f.adapter.read()).dependenciesAttempted).toBe(true);
    await f.adapter.effect("install-task", { tools: f.tools }); expect(await f.effects()).toEqual(["register-S4U", "disable"]);
    const task = f.facts.value.task;
    expect(task).toMatchObject({ State: "Disabled", Principal: { LogonType: "S4U", RunLevel: "Limited" } });
    expect(task.Actions).toHaveLength(1); expect(task.Actions[0].WorkingDirectory).toBe(f.project);
    const launcherPath = join(f.project, "data\\runtime\\bot-launcher.ps1");
    expect(task.Actions[0].Arguments).toBe(`-NoProfile -ExecutionPolicy Bypass -File "${launcherPath}"`);
    const launcher = await readFile(join(f.project, "data/runtime/bot-launcher.ps1"));
    expect([...launcher.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = launcher.subarray(3).toString("utf8");
    expect(text).toContain("-BunPath 'C:\\Tools\\it''s\\bun.exe'");
    expect(text).toContain("-GitPath 'C:\\Program Files\\Git\\cmd\\git.exe'");
    expect(text).toContain("$env:PATH = 'D:\\uv;C:\\Program Files\\Git\\bin;' + $env:PATH");
    expect(text).toContain(`Set-Location '${f.project}'`);
    // The shell would refuse an unbalanced quote: the launcher parses.
    const parse = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", "$e=$null;[void][Management.Automation.Language.Parser]::ParseFile($env:LAUNCHER,[ref]$null,[ref]$e);$e.Count"],
      { env: { ...process.env, LAUNCHER: launcherPath } });
    expect(parse.stdout.toString().trim()).toBe("0");

    f.facts.value.s4uLogonFailure = true;
    await f.adapter.effect("start-task", { fallback: true });
    expect(await f.effects()).toEqual(["enable", "start", "register-Interactive", "enable", "start"]);
    expect(f.facts.value.task).toMatchObject({ State: "Running", Principal: { LogonType: "Interactive" } });
    expect(f.facts.value.task.Actions[0].Arguments).toBe(task.Actions[0].Arguments);
    const notices = f.output.join("");
    expect(notices).toContain("系统拒绝 S4U 任务登录（0x8007052E）"); expect(notices).toContain("登录时启动（无人值守重启后不会自动运行）");
    expect(await new WindowsPlatform(f.project, source, f.runner).lastResult()).toBe("0x00041301 / 267009");

    await f.adapter.effect("stop"); expect(await f.effects()).toEqual(["disable", "stop"]);
    await f.adapter.effect("restore-task"); expect(await f.effects()).toEqual(["unregister"]); expect(f.facts.value.task).toBeNull();
    await f.adapter.effect("restore-configuration"); expect(existsSync(join(f.project, "data/runtime/bot-launcher.ps1"))).toBe(false);
    expect(await new WindowsPlatform(f.project, source, f.runner).lastResult()).toBeNull();
    await f.adapter.effect("cleanup"); expect(existsSync(f.snapshot)).toBe(false);
  } finally { await f.cleanup(); }
}, 90_000);

test.skipIf(!windows)("Windows 部署：重部署恢复原任务定义；S4U 注册或启动被拒时回退；不回退的启动失败照实报错；拒绝他项目任务与带引号的工具路径", async () => {
  const foreign = await deployFixture("foreign");
  try {
    await expect(foreign.adapter.capture("", "", "")).rejects.toThrow(); expect(existsSync(foreign.snapshot)).toBe(false);
  } finally { await foreign.cleanup(); }
  const f = await deployFixture("ours");
  try {
    expect(await f.adapter.capture("", "a".repeat(40), "")).toMatchObject({ hasTask: true, wasRunning: false });
    await f.adapter.effect("prepare-directories");
    await expect(f.adapter.effect("install-task", { tools: { ...f.tools, bun: 'C:\\Tools\\"bun.exe' } })).rejects.toThrow(); expect(await f.effects()).toEqual([]);
    f.facts.value.refuseS4U = true;
    await f.adapter.effect("install-task", { tools: f.tools }); expect(await f.effects()).toEqual(["refused-S4U", "register-Interactive", "disable"]);
    expect(f.output.join("")).toContain("无法注册无需登录的开机任务：S4U refused by policy");
    await f.adapter.effect("restore-task"); expect(await f.effects()).toEqual(["register-xml"]);
    expect(f.facts.value.task.Actions[0].Arguments).toBe("-File old-launcher.ps1");
    // The verification start of a candidate does not fall back: the refusal is the failure the core rolls back on.
    f.facts.value.task.State = "Disabled"; f.facts.value.failS4UStart = true;
    await expect(f.adapter.effect("start-task", { fallback: false })).rejects.toThrow(); expect(await f.effects()).toEqual(["enable", "start"]);
    expect(f.facts.value.task.Principal.LogonType).toBe("S4U");
    // With the fallback, a refused start re-registers the task enabled before trying again.
    f.facts.value.task.State = "Disabled"; f.facts.value.task.Settings.Enabled = false;
    await f.adapter.effect("start-task", { fallback: true });
    expect(await f.effects()).toEqual(["enable", "start", "register-Interactive", "enable", "start"]);
    expect(f.facts.value.task).toMatchObject({ State: "Running", Principal: { LogonType: "Interactive" } });
    // Upgrade requests cannot install or start: those belong to a deployment.
    const upgrade = new WindowsDeployment(f.project, source, "deploy-nativefixture", "b".repeat(64), f.runner);
    await expect(upgrade.effect("install-task", { tools: f.tools })).rejects.toThrow();
  } finally { await f.cleanup(); }
}, 90_000);
