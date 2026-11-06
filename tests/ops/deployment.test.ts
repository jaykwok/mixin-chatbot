import { CURRENT_APPLICATION, writeCurrentConfig } from "../helpers/current-config.ts";
import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_VERSION } from "../../src/core/version.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const quotePS = (text: string) => "'" + text.replaceAll("'", "''") + "'";
// The Docker entry's shell checks run on Linux; PowerShell cases remain on Windows. Transactions run in the core tests.
const bash = process.platform === "linux" ? Bun.which("bash") : null;
const posixPath = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

test("Docker COPY inputs and dependency patch paths exist in the checkout", async () => {
  const dockerfile = await readFile(join(project, "Dockerfile"), "utf8");
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  const lock = JSON.parse((await readFile(join(project, "bun.lock"), "utf8")).replace(/,\s*([}\]])/g, "$1"));
  expect(lock.patchedDependencies).toEqual(manifest.patchedDependencies);
  for (const path of Object.values(manifest.patchedDependencies) as string[]) {
    expect(existsSync(join(project, path)), `Missing dependency patch: ${path}`).toBe(true);
  }
  // This Dockerfile uses one-line COPY instructions with unquoted source paths.
  for (const line of dockerfile.split(/\r?\n/).filter(line => /^COPY\s/.test(line) && !line.includes("--from="))) {
    const sources = line.split(/\s+/).slice(1, -1).filter(part => !part.startsWith("--"));
    for (const source of sources) {
      const matches = source.includes("*") ? [...new Bun.Glob(source).scanSync({ cwd: project })] : existsSync(join(project, source)) ? [source] : [];
      expect(matches.length, `Missing Docker COPY input: ${source}`).toBeGreaterThan(0);
    }
  }
});

test("every relative import of the code in the image resolves to a file the Dockerfile copies", async () => {
  const dockerfile = await readFile(join(project, "Dockerfile"), "utf8");
  const copied = new Set<string>();
  for (const line of dockerfile.split(/\r?\n/).filter(line => /^COPY\s/.test(line) && !line.includes("--from="))) {
    for (const source of line.split(/\s+/).slice(1, -1).filter(part => !part.startsWith("--"))) {
      const directory = !source.includes("*") && statSync(join(project, source)).isDirectory();
      for (const file of new Bun.Glob(directory ? `${source}/**` : source).scanSync({ cwd: project })) copied.add(file.replaceAll("\\", "/"));
    }
  }
  // The console runs on the host; the glob copies their entry files, which the image never runs.
  const hostOnly = new Set(["console/server/start.ts"]);
  const loaders = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
  const missing: string[] = [];
  for (const file of [...copied].filter(file => /\.tsx?$/.test(file) && !hostOnly.has(file))) {
    const source = (await readFile(join(project, file), "utf8")).replace(/^#!.*/, "");
    for (const { path } of loaders[file.endsWith(".tsx") ? "tsx" : "ts"].scanImports(source)) {
      if (!path.startsWith(".")) continue;
      const target = relative(project, join(project, dirname(file), path)).replaceAll("\\", "/");
      if (!copied.has(target)) missing.push(`${file} -> ${target}`);
    }
  }
  expect(copied.has("ops/tools/data-current.ts")).toBe(true);
  expect(missing).toEqual([]);
});

/** bun.lock is JSON with trailing commas; a Windows checkout (core.autocrlf) may give it CRLF line endings. */
const parseLock = (text: string) => JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));

/**
 * Pi publishes its packages together and declares caret ranges between them, so pinning only the direct dependencies
 * can still resolve a newer agent-core/codemode/mcp next to them and nest a second pi-ai. Every lock entry is checked
 * by the package name it resolves to, not by its key, so nested copies are found too.
 */
function piBaselineProblems(manifest: Record<string, any>, lock: Record<string, any>): string[] {
  const scope = "@earendil-works/";
  const pinned = (record: Record<string, string> = {}) => Object.entries(record).filter(([name]) => name.startsWith(scope));
  const direct = pinned(manifest.dependencies);
  const overrides = new Map(pinned(manifest.overrides));
  const version = direct[0]?.[1];
  const problems: string[] = [];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) problems.push(`direct Pi dependency is not an exact version: ${version}`);
  for (const [name, value] of direct) {
    if (value !== version) problems.push(`direct ${name}@${value} differs from ${version}`);
    if (overrides.has(name) && overrides.get(name) !== value) problems.push(`override for direct ${name} is ${overrides.get(name)}, expected ${value}`);
  }
  for (const [name, value] of overrides) if (value !== version) problems.push(`override ${name}@${value} differs from ${version}`);
  if (JSON.stringify(lock.overrides) !== JSON.stringify(manifest.overrides)) problems.push("bun.lock overrides differ from package.json");
  if (JSON.stringify(pinned(lock.workspaces?.[""]?.dependencies)) !== JSON.stringify(direct)) problems.push("bun.lock direct Pi dependencies differ from package.json");
  const entries = new Map<string, string[]>();
  for (const [key, value] of Object.entries(lock.packages ?? {}) as [string, unknown[]][]) {
    const resolution = typeof value[0] === "string" ? value[0] : "";
    const at = resolution.lastIndexOf("@");
    if (at <= 0 || !resolution.startsWith(scope)) continue;
    const name = resolution.slice(0, at);
    entries.set(name, [...entries.get(name) ?? [], `${key} -> ${resolution}`]);
    if (resolution.slice(at + 1) !== version) problems.push(`lock entry ${key} resolves ${resolution}, expected ${version}`);
  }
  for (const [name, found] of entries) if (found.length !== 1) problems.push(`${name} is locked ${found.length} times: ${found.join("; ")}`);

  for (const name of overrides.keys()) if (!entries.has(name)) problems.push(`override ${name} is not in the lock`);
  return problems;
}

test("Pi packages resolve to one pinned version, nested lock entries included", async () => {
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  expect(piBaselineProblems(manifest, parseLock(await readFile(join(project, "bun.lock"), "utf8")))).toEqual([]);
  const version = manifest.dependencies["@earendil-works/pi-coding-agent"];
  for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith("@earendil-works/"))) {
    const installed = JSON.parse(await readFile(join(project, "node_modules", name, "package.json"), "utf8"));
    expect(`${name}@${installed.version}`).toBe(`${name}@${version}`);
  }
});

test.each([["LF", "\n"], ["CRLF", "\r\n"]])("the Pi lock check reads a %s lockfile and still sees split installs", async (_, eol) => {
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  const lockText = (await readFile(join(project, "bun.lock"), "utf8")).replace(/\r?\n/g, eol);
  expect(lockText.includes("\r\n")).toBe(eol === "\r\n");
  const lock = parseLock(lockText);
  expect(piBaselineProblems(manifest, lock)).toEqual([]);
  // The check must see what a split install looks like: a nested second copy, a floating transitive version,
  // and an override that no longer matches the direct dependency. Edit parsed copies, not the text, so the
  // cases do not depend on how the lockfile was checked out.
  const nested = structuredClone(lock);
  nested.packages["@earendil-works/pi-agent-core/@earendil-works/pi-ai"] = lock.packages["@earendil-works/pi-ai"];
  expect(piBaselineProblems(manifest, nested).join("\n")).toContain("@earendil-works/pi-ai is locked 2 times");
  const floating = structuredClone(lock);
  floating.packages["@earendil-works/pi-tui"][0] = "@earendil-works/pi-tui@9.9.9";
  expect(piBaselineProblems(manifest, floating).join("\n")).toContain("resolves @earendil-works/pi-tui@9.9.9");
  const stale = { ...manifest, overrides: { ...manifest.overrides, "@earendil-works/pi-ai": "0.0.1" } };
  expect(piBaselineProblems(stale, lock).join("\n")).toContain("override for direct @earendil-works/pi-ai is 0.0.1");
  expect(Object.keys(manifest.overrides).some(name => name.startsWith("@earendil-works/"))).toBe(false);
});

/** `group`: the command leads its own process group (POSIX only), as a terminal's foreground job would. */
async function execute(args: string[], cwd: string, env = process.env, group = false) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", windowsHide: true, detached: group });
  const timeout = setTimeout(() => child.kill(), 45000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: out + "\n" + err };
  } finally { clearTimeout(timeout); child.kill(); await child.exited; }
}

test.skipIf(process.platform !== "win32")("Windows directory scope choice runs the real tool before the stop: the choice goes to a plan, the scope file stays for the core; a missing choice throws and writes nothing", async () => {
  const fixture = await tempFixture("directory-scope-ps-");
  const script = join(fixture.root, "scope.ps1");
  // The fixture project has no app-bot.json and the only choice given is BOT_DIRECTORY_SCOPE=all: the tool reaches no platform.
  // The helper is called as a statement, as deploy.ps1 and upgrade.ps1 call it; the tool's own lines pass through. The core
  // installs the plan after the stop (core-windows-deploy.test.ts).
  await writeFile(script, String.fromCharCode(0xfeff) + `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
$bun=${quotePS(process.execPath)}
$tool=${quotePS(join(project, "ops/config/directory-scope.ts"))}
$root=Join-Path $PSScriptRoot 'project with spaces'
$scopeFile=Join-Path $root 'data\\config\\directory.json'
$plan=Join-Path $root 'tmp\\directory-scope-plan-fixture.json'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\\config'), (Join-Path $root 'tmp') | Out-Null
function Show([string]$Name, $Value) { Write-Output ("MARK $Name=" + $Value) }
function Content([string]$Path) { if (Test-Path -LiteralPath $Path) { (Get-Content -LiteralPath $Path -Raw) -replace '\\s', '' } else { 'absent' } }
Set-Content -LiteralPath $plan -Value 'stale' -Encoding ASCII
Remove-Item Env:BOT_DIRECTORY_SCOPE -ErrorAction SilentlyContinue
try { Select-DirectoryScope $bun $tool $root $plan; Show 'choose-none' 'ok' } catch { Show 'choose-none' $_.Exception.Message }
Show 'plan-after-none' (Content $plan)
$env:BOT_DIRECTORY_SCOPE='all'
try { Select-DirectoryScope $bun $tool $root $plan; Show 'choose-all' 'ok' } catch { Show 'choose-all' $_.Exception.Message }
Show 'plan' (Content $plan)
Show 'scope-before-install' (Content $scopeFile)
`);
  try {
    const { BOT_DIRECTORY_SCOPE: _, ...env } = process.env;
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root, env);
    expect(result.code, result.output).toBe(0);
    const marks = Object.fromEntries(result.output.split(/\r?\n/).filter(line => line.startsWith("MARK ")).map(line => {
      const [name, ...value] = line.slice(5).split("=");
      return [name, value.join("=")];
    }));
    const all = '{"format":1,"all":true}';
    expect(marks).toEqual({
      "choose-none": "没有选定通讯录同步范围（原因见上方）；服务尚未停止，未做任何改动", "plan-after-none": "absent",
      "choose-all": "ok", plan: all, "scope-before-install": "absent",
    });
    // The reasons the tool printed reach the console.
    for (const reason of ["没有终端，不能运行通讯录同步范围的选择向导", "已选择通讯录同步范围：整个通讯录（停止服务后写入 data/config/directory.json）"]) expect(result.output).toContain(reason);
  } finally { await fixture.cleanup(); }
}, 60000);

for (const [name, shell] of [["Windows PowerShell 5.1", "powershell.exe"], ["PowerShell 7", Bun.which("pwsh") ?? "C:/Program Files/PowerShell/7/pwsh.exe"]] as const) {
  test.skipIf(process.platform !== "win32" || (shell !== "powershell.exe" && !existsSync(shell)))(`${name}: data previews preserve native arguments`, async () => {
    const fixture = await tempFixture("migration-native-args-");
    const script = join(fixture.root, "arguments.ps1"), probe = join(fixture.root, "native arguments.ts");
    const root = join(fixture.root, "project with spaces"), stage = join(fixture.root, "deploy stage");
    const plan = join(fixture.root, "migration plan.json"), workspace = join(fixture.root, "external workspace");
    try {
      await writeFile(probe, "console.log(JSON.stringify(process.argv.slice(2)));\n");
      // Execute the real preview invocations of both entries against a native argv recorder. PowerShell function stubs
      // hide the string-splatting bug, so these calls must cross the real executable boundary.
      await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
$bun=$bunPath=${quotePS(process.execPath)}
$preview=$dataTool=${quotePS(probe)}
$Project=${quotePS(root)}; $plan=${quotePS(plan)}; $Stage=${quotePS(stage)}
$workspace=$finalWorkspace=${quotePS(workspace)}
foreach($file in @(${quotePS(join(project, "scripts/upgrade.ps1"))},${quotePS(join(project, "scripts/deploy.ps1"))})) {
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw ($errors | Out-String)}
    # Bun options may precede 'run'; the action is the word right after the runner script.
    $commands=@($ast.FindAll({param($node) if($node -isnot [Management.Automation.Language.CommandAst] -or
        $node.CommandElements[0].Extent.Text -notin @('$bun','$bunPath')){return $false}
        $texts=@($node.CommandElements | ForEach-Object { $_.Extent.Text }); $run=[Array]::IndexOf($texts,'run')
        $run -gt 0 -and $texts.Count -gt $run + 2 -and $texts[$run + 2] -eq 'preview'},$true))
    if($commands.Count -ne 1){throw 'expected one preview call'}
    Invoke-Expression $commands[0].Extent.Text
    if($LASTEXITCODE -ne 0){throw 'native argv recorder failed'}
}
`);
      const result = await execute([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
      expect(result.code, result.output).toBe(0);
      expect(result.output.trim().split(/\r?\n/).map(line => JSON.parse(line))).toEqual([
        ["preview", "--project", root, "--plan", plan, "--upgrade", "--workspace", workspace],
        // The deployment previews into its private stage, which the core keeps with the transaction.
        ["preview", "--project", root, "--plan", join(stage, "data-plan.json"), "--workspace", workspace]]);
    } finally { await fixture.cleanup(); }
  }, 30000);
}

test.skipIf(process.platform !== "win32")("Windows target upgrade really boots and reaches Git preflight after a valid data preview", async () => {
  const fixture = await tempFixture("upgrade-bootstrap-");
  try {
    const command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(project, "scripts/upgrade.ps1"), "-Project", fixture.root,
      "-OriginalSha", "1".repeat(40), "-TargetSha", "2".repeat(40),
      "-BunPath", process.execPath, "-GitPath", Bun.which("git")!];
    // A compatible upgrade keeps the existing app-bot credentials: without them it stops before the preview.
    const missing = await execute(command, fixture.root);
    expect(missing.code, missing.output).toBe(1);
    expect(missing.output).toContain("缺少 data\\config\\app-bot.json");
    expect(missing.output).not.toContain("数据版本或配置校验未通过");
    expect(existsSync(join(fixture.root, "data/state/upgrade-transaction"))).toBe(false);
    const [missingLog] = await readdir(join(fixture.root, "logs/operations"));
    // Configuration without a deployment record is not an upgrade: the real preview refuses it before anything stops.
    await writeCurrentConfig(fixture.root);
    const result = await execute(command, fixture.root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("目录没有部署记录，不能升级");
    expect(result.output).toContain("数据版本或配置校验未通过；旧服务尚未停止");
    expect(existsSync(join(fixture.root, "data/state/upgrade-transaction"))).toBe(false);
    const logs = (await readdir(join(fixture.root, "logs/operations"))).filter(name => name !== missingLog); expect(logs).toHaveLength(1);
    const text = await readFile(join(fixture.root, "logs/operations", logs[0]!), "utf8");
    expect(text).toContain("data-preparation-preview"); expect(text).toContain("数据版本或配置校验未通过");
    expect(text).toContain("upgrade.ps1"); expect(text).toContain("exit=1");
    // A valid deployment record must complete the real preview before the deliberate missing-main refusal. Use a
    // separate empty repository so Git cannot discover the surrounding developer checkout or reach service control.
    const init = await execute([Bun.which("git")!, "init", "--quiet", fixture.root], fixture.root);
    expect(init.code, init.output).toBe(0);
    const marker = join(fixture.root, "data/state/data-version.json");
    const deployed = JSON.stringify({ dataVersion: DATA_VERSION, appVersion: "1.0.0", build: "0011223", transaction: "deploy-previous", application: CURRENT_APPLICATION });
    await mkdir(join(fixture.root, "data/state"), { recursive: true });
    await writeFile(marker, deployed);
    const ready = await execute(command, fixture.root);
    expect(ready.code, ready.output).toBe(1);
    expect(ready.output).toContain("本地 main 分支不存在；旧服务尚未停止");
    expect(ready.output).not.toContain("数据版本或配置校验未通过");
    const allLogs = await readdir(join(fixture.root, "logs/operations")); expect(allLogs).toHaveLength(3);
    const readyLog = await readFile(join(fixture.root, "logs/operations", allLogs.find(name => name !== logs[0] && name !== missingLog)!), "utf8");
    expect(readyLog).toContain("upgrade-preflight");
    expect(readyLog).not.toContain("stop-service");
    expect(await readFile(marker, "utf8")).toBe(deployed);
    expect(existsSync(join(fixture.root, "data/state/upgrade-transaction"))).toBe(false);
  } finally { await fixture.cleanup(); }
}, 30000);

// The target upgrader asks questions before the stop (revision cleanup, directory scope), so it runs on the console
// itself: through a pipe its prompts without a newline would only show after the answer, and its wizard has no terminal.
test.skipIf(process.platform !== "win32")("Windows upgrade removes only its own export on success, export failure and child failure", async () => {
  const fixture = await tempFixture("upgrade-export-cleanup-");
  const script = join(fixture.root, "cleanup.ps1");
  const source = await readFile(join(project, "scripts/ops.ps1"), "utf8");
  const update = source.match(/^function Invoke-Update\([^\n]+[\s\S]*?^\}/m)?.[0] ?? "";
  expect(update).toContain("Invoke-ConsoleProcess $shell $arguments");
  expect(update).not.toContain("| Out-Host");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quotePS(join(project, "scripts/ops.ps1"))},[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Update'},$true)
Invoke-Expression $definition.Extent.Text
$Project=Join-Path $PSScriptRoot 'project dir'
New-Item -ItemType Directory -Force -Path (Join-Path $Project 'tmp/keep') | Out-Null
Set-Content -LiteralPath (Join-Path $Project 'tmp/keep/evidence') 'original'
function Test-Administrator { $true }; function Get-GitPath { 'fixture-git' }; function Get-BunPath { 'C:\\fixture bun\\say "bun"\\' }
function Err($message) { Write-Host $message }; function Warn($message) { throw $message }
function Invoke-GitCapture([string[]]$GitArgs) {
    if($GitArgs[0] -eq 'archive') { return @{ExitCode=$(if($env:UPGRADE_CASE -eq 'export'){1}else{0});Text='fixture export'} }
    $text=if($GitArgs -contains '--abbrev-ref'){'main'}elseif($GitArgs[0] -eq 'rev-parse'){'1'*40}else{''}
    return @{ExitCode=0;Text=$text}
}
function Expand-Archive($LiteralPath,$DestinationPath) {
    $target=Join-Path $DestinationPath 'scripts'
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Set-Content -LiteralPath (Join-Path $target 'upgrade.ps1') -Encoding ASCII -Value @'
param([string]$Project, [string]$BunPath, [string]$OriginalBranch)
if($PSVersionTable.PSVersion.Major -ne 5){throw "wrong child host"}
Write-Output "CHILD_ARGS=[$Project][$BunPath][$OriginalBranch]"
if($env:UPGRADE_CASE -eq "child"){exit 17}; exit 0
'@
}
foreach($env:UPGRADE_CASE in @('success','export','child')) {
    $result=Invoke-Update
    # The child's output goes to the console, not into the return value.
    if($result -isnot [bool] -or $result -ne ($env:UPGRADE_CASE -eq 'success')){throw "wrong upgrade result: $result"}
    if(@(Get-ChildItem -LiteralPath (Join-Path $Project 'tmp') -Filter 'upgrade-*').Count){throw 'export directory leaked'}
}
foreach($invalid in @((Join-Path $Project 'tmp/keep'), (Join-Path $PSScriptRoot ('upgrade-'+('a'*32))))) {
    $rejected=$false
    try { Remove-UpgradeStage $Project $invalid } catch { $rejected=$true }
    if(-not $rejected){throw 'accepted invalid cleanup path'}
}
if((Get-Content -LiteralPath (Join-Path $Project 'tmp/keep/evidence')).Trim() -ne 'original'){throw 'unrelated data changed'}
Write-Output 'EXPORT_CLEANUP_VERIFIED'
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("EXPORT_CLEANUP_VERIFIED");
    // Spaces, quotes and trailing backslashes reach the child unchanged (success and child cases).
    const childArgs = `CHILD_ARGS=[${join(fixture.root, "project dir")}][C:\\fixture bun\\say "bun"\\][main]`;
    expect(result.output.split(childArgs).length - 1, result.output).toBe(2);
    const pwsh = Bun.which("pwsh");
    if (pwsh) {
      const fromPS7 = await execute([pwsh, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
      expect(fromPS7.code, fromPS7.output).toBe(0);
      expect(fromPS7.output).toContain("EXPORT_CLEANUP_VERIFIED");
    }
  } finally { await fixture.cleanup(); }
}, 30000);

// What a successful operation must leave in backup/: everything it does not own by name.
const unrelatedBackups = {
  "backup/snapshots/deploy-failed/recovery": "failed transaction",
  "backup/snapshots/tunnel-0123456789abcdef0123456789abcdef/tunnel.xml": "connector snapshot",
  "backup/snapshots/migration-7d7c1a2e-0d0b-4a8e-9a55-3c1f6a2b9e10/data/state/version": "migration snapshot",
  "backup/rm/deploy-previous/old-config": "earlier transaction",
  "backup/rm/deploy-currentX/old-config": "name sharing the prefix",
  "backup/rm/loose-file": "loose archive",
  "backup/rm/.hidden-file": "hidden archive",
  "backup/rm/1758000000000-5f3a1c2e-8b4d-4e6f-9a1b-2c3d4e5f6a7b-session.jsonl": "manual history archive",
  "backup/reports/usage.html": "report",
};

test.skipIf(process.platform !== "win32")("Windows successful backup cleanup removes only its own snapshot and archive, and refuses links", async () => {
  const fixture = await tempFixture("backup-cleanup-windows-");
  const script = join(fixture.root, "cleanup.ps1");
  const root = join(fixture.root, "project");
  for (const [path, text] of Object.entries(unrelatedBackups)) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text);
  }
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/lifecycle.ps1"))}
$root=Join-Path $PSScriptRoot 'project'
$snapshot=Join-Path $root 'backup/snapshots/deploy-current'
New-Item -ItemType Directory -Force -Path $snapshot,(Join-Path $root 'data/state') | Out-Null
Set-Content (Join-Path $snapshot 'old-config') 'old'
$env:BOT_DEPLOY_BACKUP_ID='deploy-current'
Set-Content (Join-Path $root 'old-file') 'old'
Move-ToProjectArchive (Join-Path $root 'old-file') $root
if(-not (Test-Path (Join-Path $root 'backup/rm/deploy-current'))){throw 'wrong archive directory'}
$lock=[IO.File]::Open((Join-Path $root 'data/state/deploy.lock'),'OpenOrCreate','ReadWrite','None')
try {
    Remove-CompletedBackup $snapshot $root
    if((Test-Path $snapshot) -or (Test-Path (Join-Path $root 'backup/rm/deploy-current'))){throw 'own snapshot or archive retained'}
    $rejected=$false
    try { Remove-CompletedBackup (Join-Path $root 'data') $root } catch { $rejected=$true }
    if(-not $rejected){throw 'out-of-scope cleanup accepted'}
    # A junction in place of the archive is refused before anything is removed, and its target is never entered.
    $outside=Join-Path $PSScriptRoot 'outside'
    New-Item -ItemType Directory -Force -Path $outside,(Join-Path $root 'backup/snapshots/deploy-linked') | Out-Null
    Set-Content (Join-Path $outside 'keep') 'outside'
    New-Item -ItemType Junction -Path (Join-Path $root 'backup/rm/deploy-linked') -Target $outside | Out-Null
    $message=''
    try { Remove-CompletedBackup (Join-Path $root 'backup/snapshots/deploy-linked') $root } catch { $message=$_.Exception.Message }
    if($message -ne '\u5907\u4efd\u6e05\u7406\u8def\u5f84\u5305\u542b\u94fe\u63a5'){throw ('link accepted: ' + $message)}
    if(-not (Test-Path (Join-Path $root 'backup/snapshots/deploy-linked')) -or (Get-Content (Join-Path $outside 'keep')) -ne 'outside'){throw 'removed before the link check'}
    [IO.Directory]::Delete((Join-Path $root 'backup/rm/deploy-linked'))
    # With nothing else left, the empty directories go too; the active lock stays.
    $alone=Join-Path $PSScriptRoot 'alone'
    New-Item -ItemType Directory -Force -Path (Join-Path $alone 'backup/snapshots/deploy-only'),(Join-Path $alone 'backup/rm/deploy-only') | Out-Null
    Remove-CompletedBackup (Join-Path $alone 'backup/snapshots/deploy-only') $alone
    if(Test-Path (Join-Path $alone 'backup')){throw 'empty backup directory retained'}
    if(-not (Test-Path (Join-Path $root 'data/state/deploy.lock'))){throw 'active lock removed'}
} finally { $lock.Dispose() }
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    for (const [path, text] of Object.entries(unrelatedBackups)) expect(await readFile(join(root, path), "utf8"), path).toBe(text);
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(!bash || !existsSync(bash))("Docker deployment picks the port without asking and stops a bad, unpublishable or taken one before the build", async () => {
  const fixture = await tempFixture("deployment-rootless-port-");
  const source = await readFile(join(project, "scripts/deploy.sh"), "utf8");
  const section = source.split("# 本机管理端口不再询问")[1]?.split('print_success "本机管理端口：127.0.0.1:$BOT_PORT')[0]?.replace(/^[^\n]*/, "");
  const trim = /^trim_input\(\) \{[\s\S]*?^\}/m.exec(source)?.[0];
  expect(section).toBeDefined(); expect(trim).toBeDefined();
  const script = join(fixture.root, "port.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
state="$1"
. '${posixPath(join(project, "scripts/lib/common.sh"))}'
# No rootlesskit holding CAP_NET_BIND_SERVICE: only the kernel's unprivileged port start decides.
pgrep() { return 1; }
# Another program listens on FIXTURE_TAKEN (the real probe is checked below against a live listener).
local_port_in_use() { [ "$1" = "\${FIXTURE_TAKEN:-}" ]; }
print_warning() { echo "WARN $*"; }; print_error() { echo "ERROR $*"; }
read_input() { echo "PROMPT $1"; exit 130; }
${trim}
echo "START=$(unprivileged_port_start)"
BOT_PORT_FILE="$state/bot-port"; DOCKER_ROOTLESS="$FIXTURE_ROOTLESS"
unset BOT_PORT; [ -z "\${FIXTURE_PORT:-}" ] || BOT_PORT="$FIXTURE_PORT"
${section}
echo "PORT=$BOT_PORT"
`);
  const state = join(fixture.root, "state");
  await mkdir(state);
  const run = async (env: Record<string, string>) => {
    const result = await execute([bash!, posixPath(script), posixPath(state)], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1", ...env });
    expect(result.output).not.toContain("PROMPT");
    return { ...result, port: /^PORT=(\d+)/m.exec(result.output)?.[1] };
  };
  const fix = "改端口：设置环境变量 BOT_PORT=<端口> 后重新部署";
  try {
    let result = await run({ FIXTURE_ROOTLESS: "0" });
    const kernel = "/proc/sys/net/ipv4/ip_unprivileged_port_start";
    const start = process.platform !== "win32" && existsSync(kernel) ? Number((await readFile(kernel, "utf8")).trim()) : 1024;
    expect(result.output).toContain(`START=${start}`);
    expect({ code: result.code, port: result.port }).toEqual({ code: 0, port: "1011" });
    // A first rootless deployment defaults to a port it can publish.
    const fallback = start > 1011 ? "11011" : "1011";
    result = await run({ FIXTURE_ROOTLESS: "1" });
    expect({ code: result.code, port: result.port }).toEqual({ code: 0, port: fallback });
    // A new port another program already listens on stops the deployment with the way to choose another.
    result = await run({ FIXTURE_ROOTLESS: "0", FIXTURE_TAKEN: "1011" });
    expect(result.code, result.output).toBe(1); expect(result.port).toBeUndefined();
    expect(result.output).toContain("本机端口 1011 已被其他程序占用"); expect(result.output).toContain(fix);
    // The explicit override is trimmed and probed as well.
    result = await run({ FIXTURE_ROOTLESS: "0", FIXTURE_PORT: " 3000 " });
    expect({ code: result.code, port: result.port }).toEqual({ code: 0, port: "3000" });
    result = await run({ FIXTURE_ROOTLESS: "0", FIXTURE_PORT: "3000", FIXTURE_TAKEN: "3000" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("本机端口 3000 已被其他程序占用");
    // The saved port is kept without probing: the running service itself may be listening there.
    await writeFile(join(state, "bot-port"), "3000\n");
    result = await run({ FIXTURE_ROOTLESS: "0", FIXTURE_TAKEN: "3000" });
    expect({ code: result.code, port: result.port }).toEqual({ code: 0, port: "3000" });
    // An invalid saved port (or override) is refused instead of quietly moving to the default.
    for (const [env, file, label] of [[{}, "abc", "data/state/bot-port"], [{ FIXTURE_PORT: "70000" }, "3000", "BOT_PORT"]] as const) {
      await writeFile(join(state, "bot-port"), file);
      result = await run({ FIXTURE_ROOTLESS: "0", ...env });
      expect(result.code, result.output).toBe(1); expect(result.port).toBeUndefined();
      expect(result.output).toContain(`${label} 中的端口无效`); expect(result.output).toContain(fix);
    }
    if (start > 1) {
      // A saved privileged port is explained and refused under rootless Docker; the override moves it.
      const low = String(Math.min(1011, start - 1));
      await writeFile(join(state, "bot-port"), low);
      result = await run({ FIXTURE_ROOTLESS: "1" });
      expect(result.code, result.output).toBe(1); expect(result.port).toBeUndefined();
      expect(result.output).toContain(`ERROR rootless Docker 不能发布低于 ${start} 的端口 ${low}：请改用 ${start}–65535 的端口`);
      expect(result.output).toContain(`sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${low}`); expect(result.output).toContain(fix);
      result = await run({ FIXTURE_ROOTLESS: "1", FIXTURE_PORT: "20000" });
      expect({ code: result.code, port: result.port }).toEqual({ code: 0, port: "20000" });
      // Rootful Docker publishes it on the host network as before.
      result = await run({ FIXTURE_ROOTLESS: "0" });
      expect({ code: result.code, port: result.port }).toEqual({ code: 0, port: low });
    }
    // The real probe: a live loopback listener is in use, the same port after it closes is not.
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }), port = listener.port;
    const probe = () => execute([bash!, "-c", `. '${posixPath(join(project, "scripts/lib/common.sh"))}'; local_port_in_use ${port} && echo TAKEN || echo FREE`],
      fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    try { expect((await probe()).output).toContain("TAKEN"); } finally { listener.stop(true); }
    expect((await probe()).output).toContain("FREE");
  } finally { await fixture.cleanup(); }
}, 60000);

// Windows' ps cannot show process groups.
test.skipIf(!bash || !existsSync(bash) || process.platform === "win32")("cleanups run in their own process group with stdin from /dev/null", async () => {
  const fixture = await tempFixture("deployment-shielded-");
  try {
    const script = join(fixture.root, "shielded.sh");
    await writeFile(script, `exec < "$0"
. '${join(project, "scripts/lib/deployment.sh")}'
where() {
    if [ "$(ps -o pgid= -p "$BASHPID")" = "$(ps -o pgid= -p "$$")" ]; then echo "same group"; else echo "own group"; fi
    echo "stdin $(readlink /proc/self/fd/0)"
}
where
run_shielded where
run_shielded sh -c 'exit 7'; echo "status $?"
`);
    const result = await execute([bash!, script], fixture.root);
    expect(result.output.trim().split("\n")).toEqual(["same group", `stdin ${script}`, "own group", "stdin /dev/null", "status 7"]);
  } finally { await fixture.cleanup(); }
});
