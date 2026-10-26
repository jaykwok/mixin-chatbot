import { CURRENT_APPLICATION, writeCurrentConfig } from "../helpers/current-config.ts";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_VERSION } from "../../src/core/version.ts";
import { fileHolderFunctions } from "../helpers/file-holder.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const quotePS = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const psFixtureTransaction = `function Write-FixtureTransaction($Directory, $Root, $Target = '') {
  Write-DeploymentTransaction $Directory @{format='2';operation='upgrade';snapshot=(Split-Path $Directory -Leaf);target_sha=$Target;original_sha='';original_branch='main';original_workspace_root=$Root;target_workspace_root=$Root
    was_running='1';bot_port='1011';reconfigure_ai='0'}
}`;
// Exercise each deployment engine on its supported OS; PowerShell cases remain on Windows.
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

test.skipIf(process.platform !== "win32")("Windows update reuses matching dependencies and reinstalls changed or incomplete installs", async () => {
  const fixture = await tempFixture("update-dependencies-");
  const script = join(fixture.root, "reuse.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
${psFixtureTransaction}
$root=Join-Path $PSScriptRoot 'repo'
New-Item -ItemType Directory -Force -Path $root | Out-Null
Set-Location $root
$git=(Get-Command git.exe).Source
function Git-Ok { & $git @args | Out-Null; if($LASTEXITCODE -ne 0){throw 'fixture Git operation failed'} }
function Commit-Fixture { Git-Ok add .; Git-Ok -c user.name=Test -c user.email=test@example.invalid commit -qm fixture; return (& $git rev-parse HEAD).Trim() }
function Check-Reuse([bool]$expected,[string]$label) {
    $actual=Test-DeploymentDependenciesReusable $root $git $script:original $script:target
    if($actual -ne $expected){throw ($label+': expected '+$expected+', got '+$actual)}
    Write-Output ('VERIFIED '+$label)
}
Git-Ok init -q
New-Item -ItemType Directory -Force -Path 'scripts/patches','node_modules/demo' | Out-Null
Set-Content .gitignore 'node_modules/'
Set-Content package.json '{"dependencies":{"demo":"1.2.3"},"patchedDependencies":{"demo@1.2.3":"scripts/patches/demo.patch"}}'
Set-Content bun.lock 'fixture-lock'
Set-Content scripts/patches/demo.patch 'fixture-patch'
Set-Content node_modules/demo/package.json '{"name":"demo","version":"1.2.3","bin":"cli.js"}'
Set-Content node_modules/demo/cli.js 'fixture-cli'
$script:original=Commit-Fixture; $script:target=$script:original
Check-Reuse $true 'unchanged'
Set-Content app.ts 'new application code'
$script:target=Commit-Fixture
Check-Reuse $true 'code-only'
foreach($version in @('1.2.2','1.2.4')) {
    Set-Content node_modules/demo/package.json ('{"name":"demo","version":"'+$version+'"}')
    Check-Reuse $false ('version-'+$version)
}
Set-Content node_modules/demo/package.json '{"name":"demo","version":"1.2.3","bin":"cli.js"}'
# Move fixture files rather than delete them.
Move-Item -LiteralPath (Join-Path $root 'node_modules/demo/cli.js') -Destination (Join-Path $PSScriptRoot 'saved-cli.js')
Check-Reuse $false 'missing-cli'
Move-Item -LiteralPath (Join-Path $PSScriptRoot 'saved-cli.js') -Destination (Join-Path $root 'node_modules/demo/cli.js')
Set-Content bun.lock 'changed-transitive-lock'
$script:target=Commit-Fixture
Check-Reuse $false 'lock-changed'
$script:original=$script:target
Set-Content scripts/patches/demo.patch 'changed-patch'
$script:target=Commit-Fixture
Check-Reuse $false 'patch-changed'
$script:original=$script:target
Move-Item -LiteralPath (Join-Path $root 'node_modules') -Destination (Join-Path $PSScriptRoot 'saved-node-modules')
Check-Reuse $false 'missing-install'
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output.match(/VERIFIED /g)).toHaveLength(8);
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(process.platform !== "win32")("Windows deployment rollback restores files, dependencies, task and run state across failure stages", async () => {
  const fixture = await tempFixture("deployment-windows-");
  const script = join(fixture.root, "rollback.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
. ${quotePS(join(project, "scripts/lib/lifecycle.ps1"))}
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
${psFixtureTransaction}
${await fileHolderFunctions(fixture.root)}
# Every host control API is replaced; only the fixture filesystem is real.
function Get-ProjectBotPids { @() }
function Stop-ProjectBot { $script:task.State='Ready'; return $true }
function Get-ScheduledTask { $script:task }
function Export-ScheduledTask { '<Task original="true" />' }
function Register-ScheduledTask { param($TaskName,$Xml,[switch]$Force,$ErrorAction); if($Xml -ne '<Task original="true" />'){throw 'wrong task XML'}; $script:task.State='Ready' }
function Unregister-ScheduledTask { throw 'unexpected unregister' }
function Start-ScheduledTask { $script:task.State='Running' }
function Move-Item { [CmdletBinding()]param($LiteralPath,$Destination,[switch]$Force); if($script:failBackup -and $LiteralPath -like '*\\node_modules'){throw 'injected backup failure'}; Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters }
$stages=@('snapshot','backup','dependencies','configuration','task','health','state')
foreach($running in @($true,$false)) { foreach($stage in $stages) {
    $root=Join-Path ${quotePS(fixture.root)} ($stage+'-'+$running)
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'data/config'),(Join-Path $root 'data/state'),(Join-Path $root 'node_modules') | Out-Null
    Set-Content (Join-Path $root 'data/config/models.json') 'old-config'
    Set-Content (Join-Path $root 'data/state/bot-port') '1011'
    Set-Content (Join-Path $root 'node_modules/version') 'old-dependencies'
    $script:task=[pscustomobject]@{State=$(if($running){'Running'}else{'Ready'})}
    $snapshot=New-DeploymentSnapshot $root 'test-task'
    try {
        $script:failBackup=$stage -eq 'backup'
        # Another process holds the snapshot record past the retry budget when the stopped deployment records its dependencies.
        $holder=if($stage -eq 'snapshot'){Start-FileHolder (Join-Path $snapshot.Path 'deployment.xml') 4000}
        $script:failure=$null
        try {
            Save-DeploymentDependencies $snapshot
            New-Item -ItemType Directory -Force -Path (Join-Path $root 'node_modules') | Out-Null
            Set-Content (Join-Path $root 'node_modules/version') 'new-dependencies'
            if($stage -eq 'dependencies'){throw 'install failure'}
            Set-Content (Join-Path $root 'data/config/models.json') 'new-config'
            if($stage -eq 'configuration'){throw 'config failure'}
            $script:task.State='Running'
            if($stage -in @('task','health')){throw 'task/health failure'}
            Set-Content (Join-Path $root 'data/state/bot-port') '2022'
            throw 'state failure'
        } catch { $script:failure=$_.Exception.Message; $script:failBackup=$false; Restore-DeploymentSnapshot $snapshot }
        if((Get-Content (Join-Path $root 'node_modules/version')).Trim() -ne 'old-dependencies'){throw 'dependencies not restored'}
        if((Get-Content (Join-Path $root 'data/config/models.json')).Trim() -ne 'old-config'){throw 'config not restored'}
        if((Get-Content (Join-Path $root 'data/state/bot-port')).Trim() -ne '1011'){throw 'state not restored'}
        if($script:task.State -ne $(if($running){'Running'}else{'Ready'})){throw 'task run state not preserved'}
        if($holder){
            Wait-FileHolder $holder
            if($script:failure -notmatch '错误码 32'){throw ('unexpected snapshot failure: '+$script:failure)}
            # The record kept on disk is still the one written before the stop, and no temporary was left behind.
            if((Import-Clixml -LiteralPath (Join-Path $snapshot.Path 'deployment.xml')).DependenciesAttempted){throw 'snapshot record changed'}
            if(Get-ChildItem -LiteralPath $snapshot.Path -Filter 'deployment.xml.*.tmp'){throw 'temporary snapshot remains'}
        }
        Write-Output ('VERIFIED '+$stage+' '+$running)
    } finally { $snapshot.Lock.Dispose() }
} }
# A rollback resumed by another process opens the snapshot through the transaction record.
$root=Join-Path ${quotePS(fixture.root)} 'resumed'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data/config'),(Join-Path $root 'data/state') | Out-Null
Set-Content (Join-Path $root 'data/config/models.json') 'old-config'
$script:task=[pscustomobject]@{State='Running'}
$snapshot=New-DeploymentSnapshot $root 'test-task'
Write-FixtureTransaction $snapshot.Path ''
[IO.File]::WriteAllText((Join-Path $root 'data\\state\\deploy-transaction'), (Split-Path $snapshot.Path -Leaf))
$snapshot.Lock.Dispose()
Set-Content (Join-Path $root 'data/config/models.json') 'new-config'; $script:task.State='Ready'
$resumed=Open-DeploymentTransaction $root
try {
    Restore-DeploymentSnapshot $resumed
    if((Get-Content (Join-Path $root 'data/config/models.json')).Trim() -ne 'old-config'){throw 'resumed rollback did not restore the configuration'}
    if($script:task.State -ne 'Running'){throw 'resumed rollback did not restore the run state'}
    Write-Output 'VERIFIED resumed'
} finally { $resumed.Lock.Dispose() }
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output.match(/VERIFIED /g)).toHaveLength(15);
  } finally { await fixture.cleanup(); }
}, 90000);

test.skipIf(process.platform !== "win32")("Windows continue keeps the original dependency state instead of snapshotting the interrupted install", async () => {
  const fixture = await tempFixture("deployment-resume-dependencies-");
  const script = join(fixture.root, "resume-dependencies.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
. ${quotePS(join(project, "scripts/lib/lifecycle.ps1"))}
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
${psFixtureTransaction}
function Get-ProjectBotPids { @() }
function Stop-ProjectBot { return $true }
function Get-ScheduledTask { [pscustomobject]@{State='Ready'} }
function Export-ScheduledTask { '<Task original="true" />' }
function Register-ScheduledTask { param($TaskName,$Xml,[switch]$Force,$ErrorAction) }
foreach ($original in @($false, $true)) {
    $root=Join-Path ${quotePS(fixture.root)} ('project-' + $original)
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'data/config'),(Join-Path $root 'data/state') | Out-Null
    if ($original) { New-Item -ItemType Directory -Force -Path (Join-Path $root 'node_modules') | Out-Null; Set-Content (Join-Path $root 'node_modules/version') 'original' }
    $snapshot=New-DeploymentSnapshot $root 'test-task'
    $record=@{ format='2'; operation='deploy'; snapshot=(Split-Path $snapshot.Path -Leaf); target_sha=''; original_sha=''; original_branch=''
        original_workspace_root=''; target_workspace_root=''; was_running='0'; bot_port='1011'; reconfigure_ai='0' }
    Publish-DeploymentTransaction $snapshot $record (Join-Path $root 'data\\state\\deploy-transaction')
    Save-DeploymentDependencies $snapshot
    # The install is interrupted after writing new dependencies; only the pointer survives the process.
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'node_modules') | Out-Null
    Set-Content (Join-Path $root 'node_modules/version') 'interrupted-install'
    $snapshot.Lock.Dispose()
    $resumed=Open-DeploymentTransaction $root
    try {
        Save-DeploymentDependencies $resumed
        $saved=Join-Path $resumed.Path 'node_modules/version'
        if ($original) { if ((Get-Content $saved).Trim() -ne 'original') { throw 'original dependencies replaced in the snapshot' } }
        elseif (Test-Path -LiteralPath $saved) { throw 'interrupted install captured as original dependencies' }
        Restore-DeploymentSnapshot $resumed
        $restored=Join-Path $root 'node_modules/version'
        if ($original) { if ((Get-Content $restored).Trim() -ne 'original') { throw 'original dependencies not restored' } }
        elseif (Test-Path -LiteralPath $restored) { throw 'interrupted install survived the rollback' }
        Write-Output ('VERIFIED original=' + $original)
    } finally { $resumed.Lock.Dispose() }
}
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("VERIFIED original=False"); expect(result.output).toContain("VERIFIED original=True");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows target upgrade previews before stopping and rolls data back before code or old service", async () => {
  const fixture = await tempFixture("update-flow-");
  const script = join(fixture.root, "update.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/operation-log.ps1"))}
$tokens=$null; $errors=$null
$sourcePath=${quotePS(join(project, "scripts/deploy/upgrade.ps1"))}
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
$body=(Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8).Substring($ast.ParamBlock.Extent.EndOffset)
$body=(($body -split '\\r?\\n') | Where-Object { -not $_.StartsWith('. (Join-Path') }) -join [Environment]::NewLine
$body=$body.Replace('$PSScriptRoot', "'" + $PSScriptRoot.Replace("'", "''") + "'")
$run=[scriptblock]::Create($body)
# The real conflict check runs against fixture-git: HEAD and the branch come from rev-parse, changes from status.
$libraryAst=[Management.Automation.Language.Parser]::ParseFile(${quotePS(join(project, "scripts/lib/deployment.ps1"))},[ref]$tokens,[ref]$errors)
foreach($name in @('Get-CodeRestoreConflicts','Get-UntrackedSwitchConflicts','Get-UpgradeCheckoutIdentity')) {
    Invoke-Expression $libraryAst.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true).Extent.Text
}
# The switch check before the stop runs against real repositories in switch-preflight.test.ts. Here it reports a conflict
# at the first check ('switch') or only at the recheck right before the stop ('switch-late'), and never runs after the stop.
function Get-UpgradeSwitchConflicts {
    if($script:stopped){throw 'switch checked after stop'}
    $script:switchChecks++
    if($script:failure -eq 'switch' -or ($script:failure -eq 'switch-late' -and $script:switchChecks -eq 2)){ '未跟踪的文件会被目标版本覆盖：added.txt' }
}
$BunPath='fixture-bun'; $GitPath='fixture-git'
$Project=$PSScriptRoot; $OriginalSha='1111111111111111111111111111111111111111'; $TargetSha='2222222222222222222222222222222222222222'; $OriginalBranch='main'
New-Item -ItemType Directory -Force -Path (Join-Path $Project 'data/state') | Out-Null
function Get-BunPath { 'fixture-bun' }; function Get-GitPath { 'fixture-git' }; function Get-OpsCommandHint($name) { 'ops ' + $name }
function Get-SavedWorkspaceRoot { '' }; function Test-TransactionValue { $true }
# The commit records the build that was checked out.
function Get-CheckoutBuild { if(-not $script:stopped){throw 'build read before the stop'}; 'abc1234' }
function Get-ScheduledTask { if($script:failure -ne 'task-missing'){ [pscustomobject]@{State='Ready'} } }
function fixture-git {
    $global:LASTEXITCODE=0
    if($args -contains 'show-ref' -and $script:failure -eq 'main-missing'){$global:LASTEXITCODE=1}
    if($args -contains 'merge-base' -and $script:failure -eq 'diverged'){$global:LASTEXITCODE=1}
    if(($args -contains 'checkout' -or $args -contains 'merge') -and -not $script:stopped){throw 'live checkout changed before stop'}
    if($args -contains 'rev-parse'){
        if($args -contains '--abbrev-ref'){$OriginalBranch}
        elseif(-not $script:stopped -or $args -contains 'refs/heads/main^{commit}'){$OriginalSha}
        elseif($script:failure -eq 'code'){'3333333333333333333333333333333333333333'}else{$TargetSha}
    }
    if($args -contains 'reset') { if($script:applied -and -not $script:dataRestored){throw 'code restored before data'}; $script:codeRestored=$true }
    if($args -contains 'status' -and $script:dirty) { ' M version.txt' }
}
function fixture-bun {
    $global:LASTEXITCODE=0
    if($args -contains '--version') { if($script:failure -eq 'old-bun'){'1.4.3'}else{'1.4.4'} }
    elseif($args -contains 'probe') { if($script:stopped){throw 'probe after stop'} }
    elseif($args -contains 'preview') { $script:previews++; if($script:stopped){throw 'preview after stop'}; if($script:failure -eq 'preview'){ $global:LASTEXITCODE=2 } }
    elseif($args -contains 'install') { if(-not $script:stopped){throw 'dependencies changed before stop'}; $script:installs++; if($script:failure -eq 'install'){$global:LASTEXITCODE=1} }
    elseif($args -contains 'apply') { $script:applied=$true; if($script:failure -eq 'apply'){$global:LASTEXITCODE=1} }
    elseif($args -contains 'committed') { if($script:stopped){throw 'commit check after stop'}; $global:LASTEXITCODE=[int](-not $script:committed) }
    elseif($args -contains 'commit') { if($env:APP_BUILD -ne 'abc1234'){throw 'commit without the checked-out build'}; if($script:failure -eq 'commit'){$global:LASTEXITCODE=1}else{$script:committed=$true} }
    elseif($args -contains 'rollback') { if($script:committed){$global:LASTEXITCODE=42}else{$script:dataRestored=$true} }
    else {
        $verifying=Test-Path -LiteralPath (Join-Path $Project 'data/state/verify-only')
        if($verifying -ne ($args -contains '--allow-verification')){throw 'wrong verification health policy'}
        if($script:failure -eq 'health'){throw 'health failure'}
    }
}
function New-DeploymentSnapshot { [pscustomobject]@{WasRunning=$script:running;TaskXml='<Task/>';Path=$Project;Lock=(New-Object IO.MemoryStream);PreviousBackupId='previous'} }
function Open-UpgradeSnapshot($root,$task,$original,$branch,$target) {
    $script:record=$args[0]
    $state=New-DeploymentSnapshot
    $state | Add-Member -NotePropertyName UpgradeOriginal -NotePropertyValue $original
    $state | Add-Member -NotePropertyName UpgradeBranch -NotePropertyValue $branch
    $state | Add-Member -NotePropertyName DependenciesAttempted -NotePropertyValue $false
    Set-Content -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction') 'fixture'
    return $state
}
function Stop-ProjectBot { $script:stopped=$true; $true }
function Test-DeploymentDependenciesReusable { $script:reuse }
function Save-DeploymentDependencies { $script:backups++ }
function Enable-ScheduledTask { }
function Start-ScheduledTask {
    if(Test-Path -LiteralPath (Join-Path $Project 'data/state/verify-only')){ $script:verifications++ }
    else { if(-not $script:committed){throw 'normal start before commit'}; $script:starts++; if($script:failure -eq 'postcommit'){throw 'normal start failed'} }
}
function Register-ScheduledTask { }
function Restore-DeploymentSnapshot { if(-not $script:codeRestored){throw 'old service before code restore'}; $script:restores++ }
function Remove-CompletedBackup($path) { if(Test-Path -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction')){throw 'backup removed before the transaction closed'}; $script:cleanups++ }
foreach($script:reuse in @($true,$false)) { foreach($script:running in @($true,$false)) { foreach($script:failure in @('none','old-bun','preview','app-bot-missing','main-missing','diverged','task-missing','switch','switch-late','code','install','apply','health','commit','postcommit')) {
    if(($script:failure -eq 'install' -and $script:reuse) -or ($script:failure -eq 'postcommit' -and -not $script:running)){continue}
    $script:stopped=$false; $script:applied=$false; $script:committed=$false; $script:dataRestored=$false; $script:codeRestored=$false
    $script:backups=0; $script:installs=0; $script:starts=0; $script:verifications=0; $script:restores=0; $script:cleanups=0; $script:switchChecks=0
    $env:APP_BUILD=$null
    Remove-Item -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction') -Force -ErrorAction SilentlyContinue
    # A compatible upgrade keeps the existing app-bot credentials and refuses before the stop when they are missing.
    New-Item -ItemType Directory -Force -Path (Join-Path $Project 'data/config') | Out-Null
    if($script:failure -eq 'app-bot-missing'){ Remove-Item -LiteralPath (Join-Path $Project 'data/config/app-bot.json') -Force -ErrorAction SilentlyContinue }
    else { Set-Content -LiteralPath (Join-Path $Project 'data/config/app-bot.json') '{}' }
    $ok=$true; $message=''
    try { & $run } catch { $ok=$false; $message=$_.Exception.Message; Write-Host $message }
    if($ok -ne ($script:failure -eq 'none')){throw ('wrong result: '+$script:failure)}
    if($script:failure -eq 'code' -and ($script:installs -or $script:applied)){throw 'wrong release mutated data or dependencies'}
    # Every upgrade that gets there checks the switch twice: in the preflight and again right before the stop.
    if($script:failure -in @('none','switch-late') -and $script:switchChecks -ne 2){throw ('switch not rechecked before the stop: ' + $script:failure)}
    if($script:failure -in @('switch','switch-late') -and $message -notmatch '本次升级没有停止服务[\\s\\S]*added\\.txt'){throw ('switch conflict not listed: ' + $message)}
    if($script:failure -eq 'switch' -and (Test-Path -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction'))){throw 'snapshot taken despite the switch conflict'}
    if($script:failure -eq 'app-bot-missing' -and $message -notmatch 'app-bot.json'){throw ('missing credentials not named: ' + $message)}
    # HEAD at a commit that is neither the original nor the target: the rollback never resets over it and keeps the transaction.
    if($script:failure -eq 'code') { if($script:codeRestored -or $script:restores){throw 'unknown commit overwritten'} }
    elseif($script:failure -in @('old-bun','preview','app-bot-missing','main-missing','diverged','task-missing','switch','switch-late')) { if($script:stopped -or $script:applied -or $script:installs){throw 'preflight failure mutated deployment'} }
    elseif($script:failure -in @('none','postcommit')) {
        if($script:restores -ne 0 -or -not $script:committed -or $script:starts -ne [int]$script:running){throw 'wrong committed state'}
        if($script:backups -ne [int](-not $script:reuse) -or $script:installs -ne $script:backups){throw 'dependency reuse failed'}
    } elseif($script:restores -ne 1) { throw 'rollback missing' }
    # Only a completed upgrade discards its own snapshot and archive; every other outcome keeps them for recovery.
    if($script:cleanups -ne [int]($script:failure -eq 'none')){throw ('wrong backup cleanup: ' + $script:failure)}
    Write-Output 'VERIFIED'
} } }
# Explicit rollback of an interrupted upgrade: no preview or preflight, committed data is refused before the stop.
function Read-DeploymentTransaction { @{ target_workspace_root = '' } }
# Rollback opens the recorded snapshot only: empty ordinary settings and missing credentials are never read.
Set-Content -LiteralPath (Join-Path $Project 'data/state/bot-port') '' -NoNewline
Remove-Item -LiteralPath (Join-Path $Project 'data/config/app-bot.json') -Force
$Rollback=$true; $script:failure='none'; $script:running=$true
Set-Content -LiteralPath (Join-Path $Project 'data/state/release-data.json') (@{deployment=(Split-Path $Project -Leaf)} | ConvertTo-Json)
foreach($script:committedBefore in @($true,$false)) {
    Set-Content -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction') ('deploy-' + ('a' * 32))
    $script:stopped=$false; $script:applied=$true; $script:committed=$script:committedBefore; $script:dataRestored=$false; $script:codeRestored=$false
    $script:previews=0; $script:installs=0; $script:restores=0; $script:cleanups=0
    $ok=$true
    try { & $run } catch { $ok=$false; Write-Host $_.Exception.Message }
    $pointer=Test-Path -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction')
    if($script:previews -or $script:installs){throw 'rollback previewed or installed'}
    if($script:cleanups){throw 'rollback removed the snapshot'}
    if($script:record){throw 'rollback built a new record from ordinary settings'}
    if($script:committedBefore) { if($ok -or $script:stopped -or $script:restores -or -not $pointer){throw 'committed upgrade rolled back'} }
    elseif(-not $ok -or -not $script:dataRestored -or -not $script:codeRestored -or $script:restores -ne 1 -or $pointer){throw 'rollback incomplete'}
    Write-Output 'ROLLBACK_VERIFIED'
}
# Manual changes after the upgrade are never reset: an explicit rollback stops before anything changes; a failed
# upgrade restores the data first, then stops before the code and the old task, keeping the transaction.
$script:dirty=$true
foreach($Rollback in @($true,$false)) {
    Set-Content -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction') ('deploy-' + ('a' * 32))
    $script:failure=if($Rollback){'none'}else{'apply'}; $script:reuse=$true
    $script:stopped=$false; $script:applied=$Rollback; $script:committed=$false; $script:dataRestored=$false; $script:codeRestored=$false; $script:restores=0
    $ok=$true; $message=''
    try { & $run } catch { $ok=$false; $message=$_.Exception.Message }
    if($ok -or $script:codeRestored -or $script:restores -or -not (Test-Path -LiteralPath (Join-Path $Project 'data/state/upgrade-transaction'))){throw 'manual change overwritten'}
    if($script:stopped -ne (-not $Rollback) -or $script:dataRestored -ne (-not $Rollback)){throw 'wrong rollback extent'}
    if($message -notmatch '未提交的改动： M version.txt'){throw ('conflict not listed: ' + $message)}
    Write-Output 'MANUAL_CHANGES_KEPT'
}
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output.match(/VERIFIED/g)).toHaveLength(58);
    expect(result.output.match(/ROLLBACK_VERIFIED/g)).toHaveLength(2);
    expect(result.output.match(/MANUAL_CHANGES_KEPT/g)).toHaveLength(2);
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(process.platform !== "win32")("Windows redeployment resolves the workspace root and checks the data version before preview and persistent changes", async () => {
  const f = await tempFixture("deploy-workspace-root-");
  try {
    const source = await readFile(join(project, "scripts/deploy/deploy.ps1"), "utf8");
    const start = source.indexOf("# ---- 4b. 共享资料目录"), end = source.indexOf("# ---- 停机前的交互选择", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const script = join(f.root, "workspace-root.ps1");
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
$Project=Join-Path $PSScriptRoot 'project'; $DataDir=Join-Path $Project 'data'; $StateDir=Join-Path $DataDir 'state'; $RuntimeDir=Join-Path $DataDir 'runtime'
$ModelsFile=Join-Path $DataDir 'config/models.json'; $external=Join-Path $PSScriptRoot 'shared files'
New-Item -ItemType Directory -Force -Path $StateDir,(Split-Path $ModelsFile),(Join-Path $RuntimeDir 'pi'),$external | Out-Null
Set-Content -LiteralPath $ModelsFile '{}'; Set-Content -LiteralPath (Join-Path $RuntimeDir 'pi/settings.json') '{}'
$resuming=$false; $record=$null; $pendingSnapshot=$null; $bunPath='fixture-bun'; $dataPreparationRunner='data-current.ts'; $script:checks=0; $script:previews=0
function Step {}; function Done {}; function Warn($message){throw $message}
function Get-SavedWorkspaceRoot { $env:FIXTURE_SAVED }
function fixture-bun {
    if($args -contains 'check'){ $script:checks++; $global:LASTEXITCODE=[int]$env:FIXTURE_CHECK; return }
    if($args -notcontains 'preview'){throw 'changed data before preview'}
    if($script:checks -ne 1){throw 'preview before the data version check'}
    if($args -contains '--groups'){throw 'preview still passes a group root'}
    $script:previews++; $global:LASTEXITCODE=0
}
${source.slice(start, end)}
if($script:previews -ne 1){throw 'missing preview'}
Write-Output ('RESULT root=' + $WorkspaceRoot)
`);
    const run = (env: Record<string, string> = {}) => execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root,
      { ...process.env, FIXTURE_CHECK: "0", FIXTURE_SAVED: "", WORKSPACE_ROOT: "", ...env });
    const external = join(f.root, "shared files");
    // No setting keeps the default (recorded as empty); WORKSPACE_ROOT wins over the saved root; naming data\workspace restores the default.
    let result = await run();
    expect(result.code, result.output).toBe(0); expect(result.output).toMatch(/RESULT root=\r?\n/);
    result = await run({ FIXTURE_SAVED: external });
    expect(result.code, result.output).toBe(0); expect(result.output).toContain(`RESULT root=${external}`);
    result = await run({ FIXTURE_SAVED: join(f.root, "missing"), WORKSPACE_ROOT: external });
    expect(result.code, result.output).toBe(0); expect(result.output).toContain(`RESULT root=${external}`);
    result = await run({ FIXTURE_SAVED: external, WORKSPACE_ROOT: "data\\workspace" });
    expect(result.code, result.output).toBe(0); expect(result.output).toMatch(/RESULT root=\r?\n/);
    // A missing external directory is never created: the deployment stops before the data check.
    result = await run({ WORKSPACE_ROOT: join(f.root, "missing") });
    expect(result.code).toBe(1); expect(result.output).toContain("共享资料目录不存在或不是目录"); expect(result.output).toContain("服务尚未停止");
    expect(result.output).not.toContain("RESULT");
    // Data without a valid version marker is refused before any preview.
    result = await run({ FIXTURE_CHECK: "1" });
    expect(result.code).toBe(1); expect(result.output).toContain("数据版本核对未通过"); expect(result.output).not.toContain("RESULT");
  } finally { await f.cleanup(); }
}, 15000);

test.skipIf(process.platform !== "win32")("Windows redeployment collects every answer before stopping the bot service", async () => {
  const f = await tempFixture("deploy-preflight-");
  try {
    const source = await readFile(join(project, "scripts/deploy/deploy.ps1"), "utf8");
    const start = source.indexOf("# ---- 停机前的交互选择"), end = source.indexOf("Set-OperationStage 'deployment-snapshot'", start);
    const stop = source.indexOf("机器人服务未能停止，部署已取消");
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); expect(stop).toBeGreaterThan(end);
    // From the stop through verification and commit to the normal start, only the configuration wizards may interact.
    const normalStart = source.indexOf("Enable-ScheduledTask -TaskName $TaskName", stop);
    expect(normalStart).toBeGreaterThan(source.indexOf("commit --project $Project", stop));
    expect(source.slice(stop, normalStart).match(/Read-Host|Read-YesNo/g)).toBeNull();
    const script = join(f.root, "preflight.ps1");
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
${psFixtureTransaction}
$Project=Join-Path $PSScriptRoot 'project'; $StateDir=Join-Path $Project 'data/state'
$ModelsFile=Join-Path $Project 'data/config/models.json'; $AppBotFile=Join-Path $Project 'data/config/app-bot.json'
$PortFile=Join-Path $StateDir 'bot-port'
New-Item -ItemType Directory -Force -Path $StateDir,(Split-Path $ModelsFile) | Out-Null
# The port is never asked: the saved one is kept (an empty one stops the deployment, never dereferenced as null), and an
# explicit BOT_PORT on a port another program listens on stops it too.
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Set-Content -LiteralPath $ModelsFile '{}'; Set-Content -LiteralPath $PortFile $(if ($env:FIXTURE_EMPTY -eq '1') { '' } else { '2022' }) -NoNewline
$listener=[System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start()
$env:BOT_PORT=$(if ($env:FIXTURE_TAKEN -eq '1') { "$($listener.LocalEndpoint.Port)" } else { '' })
function Step {}; function Done {}; function Warn($message){ throw $message }; function Fail($message){throw $message}
function Read-Host($Prompt) { throw ('unexpected prompt: ' + $Prompt) }
function Read-YesNo($Prompt, $Default) { if($Prompt -like '是否重新配置 AI*'){ return $true }; throw ('unexpected question: ' + $Prompt) }
try {
${source.slice(start, end)}
} catch { [Console]::WriteLine('FAILED ' + $_.Exception.Message); exit 1 } finally { $listener.Stop() }
# The HTTP listener is loopback-only; there is no connection mode, domain or connector to ask about.
if($Port -ne '2022' -or $BotHost -ne '127.0.0.1'){ throw 'answers not collected' }
if(-not $reconfigureAi){ throw 'deferred work not prepared' }
Write-Output 'PREFLIGHT_COLLECTED'
`);
    const run = (env: Record<string, string> = {}) =>
      execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root, { ...process.env, ...env });
    let result = await run();
    expect(result.code, result.output).toBe(0); expect(result.output).toContain("PREFLIGHT_COLLECTED");
    result = await run({ FIXTURE_EMPTY: "1" });
    expect(result.code).toBe(1); expect(result.output).toContain("data\\state\\bot-port 中的端口无效");
    expect(result.output).toContain("BOT_PORT=<端口>"); expect(result.output).not.toContain("PREFLIGHT_COLLECTED");
    result = await run({ FIXTURE_TAKEN: "1" });
    expect(result.code).toBe(1); expect(result.output).toContain("已被其他程序占用"); expect(result.output).not.toContain("PREFLIGHT_COLLECTED");
  } finally { await f.cleanup(); }
}, 15000);

test.skipIf(process.platform !== "win32")("Windows deployment continue takes every setting from the record without prompting", async () => {
  const f = await tempFixture("deploy-resume-");
  try {
    const source = await readFile(join(project, "scripts/deploy/deploy.ps1"), "utf8");
    const start = source.indexOf("# ---- 4b. 共享资料目录"), end = source.indexOf("Set-OperationStage 'deployment-snapshot'", start);
    const publish = source.indexOf("Publish-DeploymentTransaction $snapshot", end), stop = source.indexOf("机器人服务未能停止，部署已取消");
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    // The record and pointer are published before the service is stopped.
    expect(publish).toBeGreaterThan(end); expect(stop).toBeGreaterThan(publish);
    const script = join(f.root, "resume.ps1");
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
${psFixtureTransaction}
$Project=Join-Path $PSScriptRoot 'project'; $DataDir=Join-Path $Project 'data'; $StateDir=Join-Path $DataDir 'state'; $RuntimeDir=Join-Path $DataDir 'runtime'
$ModelsFile=Join-Path $DataDir 'config\\models.json'; $AppBotFile=Join-Path $DataDir 'config\\app-bot.json'
$PortFile=Join-Path $StateDir 'bot-port'
$target=Join-Path $PSScriptRoot 'target shared'; $elsewhere=Join-Path $PSScriptRoot 'elsewhere'
New-Item -ItemType Directory -Force -Path $StateDir,(Split-Path $ModelsFile),$target,$elsewhere | Out-Null
Set-Content -LiteralPath $ModelsFile '{}'; Set-Content -LiteralPath $PortFile '3000' -NoNewline
if ($env:FIXTURE_APP_BOT -eq '1') { Set-Content -LiteralPath $AppBotFile '{}' } else { Remove-Item -LiteralPath $AppBotFile -ErrorAction SilentlyContinue }
$env:BOT_PORT='9999'; $env:WORKSPACE_ROOT=$elsewhere
$resuming=$true; $pendingSnapshot=[pscustomobject]@{ Path=(Join-Path $PSScriptRoot 'snapshot') }
$record=@{ target_workspace_root=$target; bot_port='2022'; reconfigure_ai='1' }
$bunPath='fixture-bun'; $dataPreparationRunner='data-current.ts'
function fixture-bun { throw ('data command while continuing without a plan: ' + ($args -join ' ')) }
function Get-SavedWorkspaceRoot { throw 'read the saved workspace root while continuing' }
function Step {}; function Done {}; function Warn($message){ Write-Output ('WARN ' + $message) }; function Fail($message){throw $message}
function Read-Host($Prompt) { throw ('prompted while continuing: ' + $Prompt) }
function Read-YesNo($Prompt) { throw ('asked while continuing: ' + $Prompt) }
${source.slice(start, end)}
Write-Output ('RESULT root=' + $WorkspaceRoot + ' port=' + $Port + ' host=' + $BotHost + ' ai=' + $reconfigureAi)
`);
    const run = (appBot: string) => execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root, { ...process.env, FIXTURE_APP_BOT: appBot });
    let result = await run("1");
    expect(result.code, result.output).toBe(0);
    // The recorded port and workspace root win over the saved files and the current terminal's environment.
    expect(result.output).toContain(`RESULT root=${join(f.root, "target shared")} port=2022 host=127.0.0.1 ai=False`);
    expect(result.output).toContain("AI 重新配置不会在续做中运行");
    // Continuing never runs the credential wizard: missing credentials stop it and point at the rollback.
    result = await run("0");
    expect(result.code).toBe(1); expect(result.output).toContain("缺少 data\\config\\app-bot.json；续做不运行配置向导");
  } finally { await f.cleanup(); }
}, 15000);

test.skipIf(process.platform !== "win32")("Windows deployment continue after committed data only starts the new instance", async () => {
  const f = await tempFixture("deploy-resume-committed-");
  try {
    const source = await readFile(join(project, "scripts/deploy/deploy.ps1"), "utf8");
    const start = source.indexOf("# ---- 未完成的事务"), end = source.indexOf("$resuming = [bool]$pendingSnapshot", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const script = join(f.root, "committed.ps1");
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
${psFixtureTransaction}
$Project=Join-Path $PSScriptRoot 'project'; $StateDir=Join-Path $Project 'data\\state'; $TaskName='fixture'
$Resume=$true; $Rollback=$false; $bunPath='fixture-bun'; $gitPath='fixture-git'; $target=Join-Path $PSScriptRoot 'target'
New-Item -ItemType Directory -Force -Path $StateDir,$target | Out-Null
foreach ($name in @('deploy-transaction', 'verify-only', 'release-data.json')) { Set-Content -LiteralPath (Join-Path $StateDir $name) '{}' }
$env:BOT_DEPLOY_BACKUP_ID='deploy-fixture'; $lock=New-Object IO.MemoryStream; $script:calls=@()
function Open-DeploymentTransaction { [pscustomobject]@{ Path=(Join-Path $PSScriptRoot 'deploy-fixture'); Lock=$lock; PreviousBackupId='previous'
    Record=@{ target_sha=('a' * 40); target_workspace_root=$target; bot_port='2022' } } }
function Format-DeploymentTransaction { 'record' }
function Read-TransactionAction { throw 'asked while continuing' }
function Invoke-PendingDeploymentRollback { throw 'rolled back while continuing' }
function Step($message) { Write-Output ('STEP ' + $message) }; function Done($message) { Write-Output ('DONE ' + $message) }; function Warn {}; function Set-OperationStage {}
function fixture-git { 'a' * 40 }
function fixture-bun { $script:calls += ,('bun ' + $args[2]); $global:LASTEXITCODE = [int]($env:FIXTURE_COMMITTED -ne '1') }
function Stop-ProjectBot { $script:calls += ,'stop'; $true }
function Enable-ScheduledTask { $script:calls += ,'enable' }
function Start-ScheduledTask { $script:calls += ,'start' }
function Wait-BotHealth($port) { $script:calls += ,('health ' + $port); $env:FIXTURE_UNHEALTHY -ne '1' }
function Remove-CompletedBackup { $script:calls += ,'cleanup' }
try {
${source.slice(start, end)}
Write-Output 'FELL THROUGH'
} finally {
    Write-Output ('CALLS ' + ($script:calls -join '|') + ' pointer=' + (Test-Path -LiteralPath (Join-Path $StateDir 'deploy-transaction')) + ' verify=' + (Test-Path -LiteralPath (Join-Path $StateDir 'verify-only')) + ' lock=' + $lock.CanRead + ' backup=' + $env:BOT_DEPLOY_BACKUP_ID)
}
`);
    const run = (committed: string, unhealthy = "0") => execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root,
      { ...process.env, FIXTURE_COMMITTED: committed, FIXTURE_UNHEALTHY: unhealthy });
    // Committed data: applying again would start a new migration journal, so only the new instance is started.
    let result = await run("1");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("CALLS bun committed|stop|enable|start|health 2022|cleanup pointer=False verify=False lock=False backup=previous");
    expect(result.output).toContain("DONE 上次部署已完成"); expect(result.output).not.toContain("FELL THROUGH");
    // An instance that does not become healthy keeps the transaction, so continuing again retries only the activation.
    result = await run("1", "1");
    expect(result.code).not.toBe(0); expect(result.output).toContain("业务实例未就绪"); expect(result.output).toContain("resume");
    expect(result.output).toContain("CALLS bun committed|stop|enable|start|health 2022 pointer=True verify=False lock=False backup=previous");
    // Rollback and continue read only the record: corrupt ordinary runtime settings cannot block them.
    const runtimeEnd = source.indexOf("# ---- 4b. 共享资料目录", end);
    expect(runtimeEnd).toBeGreaterThan(end);
    const runtime = source.slice(start, runtimeEnd);
    expect(runtime).toContain("runtime.json");
    const gate = join(f.root, "runtime-gate.ps1");
    await writeFile(gate, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
${psFixtureTransaction}
$Project=Join-Path $PSScriptRoot 'gate'; $StateDir=Join-Path $Project 'data\\state'; $ConfigDir=Join-Path $Project 'data\\config'; $TaskName='fixture'
$Resume=$env:FIXTURE_RESUME -eq '1'; $Rollback=$env:FIXTURE_ROLLBACK -eq '1'; $bunPath='fixture-bun'; $gitPath='fixture-git'
New-Item -ItemType Directory -Force -Path $StateDir,$ConfigDir | Out-Null
Set-Content -LiteralPath (Join-Path $ConfigDir 'runtime.json') $env:FIXTURE_RUNTIME
if ($Rollback -or $Resume) { Set-Content -LiteralPath (Join-Path $StateDir 'deploy-transaction') 'deploy-fixture' } else { Remove-Item -LiteralPath (Join-Path $StateDir 'deploy-transaction') -ErrorAction SilentlyContinue }
function Open-DeploymentTransaction { [pscustomobject]@{ Path='deploy-fixture'; Lock=(New-Object IO.MemoryStream); PreviousBackupId=''; Record=@{ target_sha=''; target_workspace_root='' } } }
function Format-DeploymentTransaction { 'record' }; function Warn {}; function Step {}; function Done {}; function Fail($message) { throw $message }; function fixture-git {}
function Invoke-PendingDeploymentRollback { Write-Output 'ROLLED_BACK' }
${runtime}
Write-Output ('ORDINARY_SETTINGS_READ active=' + $BotMaxActiveRequests + ' env=' + $env:BOT_MAX_ACTIVE_REQUESTS + $env:BOT_BASH_TIMEOUT)
`);
    const gated = (env: Record<string, string>) => execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", gate], f.root,
      { ...process.env, FIXTURE_RUNTIME: "{broken-json", ...env });
    result = await gated({ FIXTURE_ROLLBACK: "1" });
    expect(result.code, result.output).toBe(0); expect(result.output).toContain("ROLLED_BACK"); expect(result.output).not.toContain("ORDINARY_SETTINGS_READ");
    result = await gated({});
    expect(result.code).not.toBe(0); expect(result.output).toContain("runtime.json 无法解析"); expect(result.output).toContain("重新部署");
    // Continuing keeps runtime.json; the new terminal's runtime variables are neither validated nor persisted.
    const terminal = { FIXTURE_RUNTIME: '{"BOT_MAX_ACTIVE_REQUESTS":"8"}', BOT_MAX_ACTIVE_REQUESTS: "0", BOT_BASH_TIMEOUT: "5" };
    result = await gated({ ...terminal, FIXTURE_RESUME: "1" });
    expect(result.code, result.output).toBe(0); expect(result.output).toContain("ORDINARY_SETTINGS_READ active=8 env=\r\n");
    result = await gated(terminal);
    expect(result.code).not.toBe(0); expect(result.output).toContain("BOT_MAX_ACTIVE_REQUESTS 必须是 1–1000 的整数");
    // A normal deployment whose committed instance is unhealthy keeps its transaction for the same activation-only continue.
    const cleanupStart = source.indexOf("    if (-not $deploymentCommitted -and $deploymentMutated) {"), cleanupEnd = source.indexOf("    $snapshot.Lock.Dispose()", cleanupStart);
    expect(cleanupStart).toBeGreaterThan(0); expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    const finish = join(f.root, "finish.ps1");
    await writeFile(finish, `\ufeff$ErrorActionPreference='Stop'
$transactionPointer=Join-Path $PSScriptRoot 'deploy-transaction'; $snapshot=[pscustomobject]@{ Path='deploy-fixture' }; $Project=$PSScriptRoot
$bunPath='fixture-bun'; $dataPreparationRunner='fixture-runner'
function fixture-bun { throw ('data command after the commit: ' + ($args -join ' ')) }
function Remove-CompletedBackup { Write-Output 'CLEANUP' }; function Write-OperationEvent {}; function Warn {}
foreach ($activated in @($false, $true)) {
    Set-Content -LiteralPath $transactionPointer 'deploy-fixture'
    $deploymentCommitted=$true; $deploymentMutated=$true; $deploymentActivated=$activated
${source.slice(cleanupStart, cleanupEnd)}
    Write-Output ('ACTIVATED=' + $activated + ' pointer=' + (Test-Path -LiteralPath $transactionPointer))
}
`);
    result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", finish], f.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/^ACTIVATED=False pointer=True\r?\nCLEANUP\r?\nACTIVATED=True pointer=False/m);
    result = await run("0");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("STEP 继续上次部署"); expect(result.output).toContain("FELL THROUGH");
    expect(result.output).toContain("CALLS bun committed pointer=True verify=True lock=True backup=deploy-fixture");
  } finally { await f.cleanup(); }
}, 15000);

test.skipIf(process.platform !== "win32")("Windows deployment rollback refuses committed data before touching the service", async () => {
  const f = await tempFixture("deploy-rollback-");
  try {
    const source = await readFile(join(project, "scripts/deploy/deploy.ps1"), "utf8");
    const rollback = source.match(/^function Invoke-PendingDeploymentRollback\(\$Snapshot\) \{[\s\S]*?^\}/m)?.[0];
    expect(rollback).toBeDefined();
    const script = join(f.root, "rollback.ps1");
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
${psFixtureTransaction}
$Project=Join-Path $PSScriptRoot 'project'; $StateDir=Join-Path $Project 'data\\state'; $TaskName='fixture'
$bunPath='fixture-bun'; $dataPreparationRunner='run.ts'; $target=Join-Path $PSScriptRoot 'target'
New-Item -ItemType Directory -Force -Path $StateDir,$target | Out-Null
function Step {}; function Done($message) { Write-Output $message }; function Set-OperationStage {}; function Write-OperationEvent {}
function fixture-bun { $script:calls += ,($args -join ' '); $global:LASTEXITCODE = if ($args -contains 'committed') { [int]($script:case -ne 'committed') } elseif ($script:case -eq 'refused') { 42 } else { 0 } }
function Stop-ProjectBot { $script:calls += ,'stop'; $true }
function Restore-DeploymentSnapshot { $script:calls += ,'restore' }
${rollback}
foreach ($script:case in @('committed', 'refused', 'original-missing', 'rolled-back')) {
    $script:calls=@()
    Set-Content -LiteralPath (Join-Path $StateDir 'deploy-transaction') 'deploy-fixture'
    Set-Content -LiteralPath (Join-Path $StateDir 'release-data.json') '{}'
    $original = if ($script:case -eq 'original-missing') { Join-Path $PSScriptRoot 'unmounted' } else { $target }
    $lock = New-Object IO.MemoryStream
    $snapshot=[pscustomobject]@{ Path=(Join-Path $PSScriptRoot 'deploy-fixture'); Lock=$lock; PreviousBackupId='previous'; WasRunning=$true
        Record=@{ original_workspace_root=$original; target_workspace_root=$target } }
    $message=''
    try { Invoke-PendingDeploymentRollback $snapshot } catch { $message=$_.Exception.Message }
    $pointer = Test-Path -LiteralPath (Join-Path $StateDir 'deploy-transaction')
    Write-Output ('CASE ' + $script:case + ' calls=' + ($script:calls -join '|') + ' pointer=' + $pointer + ' lock=' + $lock.CanRead + ' error=' + $message)
}
`);
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root);
    expect(result.code, result.output).toBe(0);
    const line = (name: string) => result.output.split(/\r?\n/).find(item => item.startsWith(`CASE ${name} `)) ?? "";
    // Committed data: only the read-only check ran; service, snapshot and pointer untouched.
    expect(line("committed")).toMatch(/calls=run run\.ts committed [^|]* pointer=True lock=False error=.*已经提交，不能回滚/);
    expect(line("refused")).toContain("pointer=True"); expect(line("refused")).toContain("已经提交，不能回滚");
    expect(line("refused")).not.toContain("restore");
    expect(line("original-missing")).toMatch(/calls= pointer=True lock=False error=原共享资料目录不存在/);
    expect(line("rolled-back")).toMatch(/calls=run run\.ts committed [^|]*\|stop\|run run\.ts rollback [^|]*\|restore pointer=False lock=False error=$/);
  } finally { await f.cleanup(); }
}, 15000);

test.skipIf(process.platform !== "win32")("Windows resume and rollback dispatch the recorded transaction without fetching a newer target", async () => {
  const f = await tempFixture("ops-transaction-");
  try {
    const script = join(f.root, "ops.ps1");
    await mkdir(join(f.root, "scripts/deploy"), { recursive: true });
    await writeFile(join(f.root, "scripts/deploy/deploy.ps1"), "\ufeffparam([switch]$Resume, [switch]$Rollback)\nWrite-Output ('DEPLOY resume=' + $Resume + ' rollback=' + $Rollback)\n");
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
${psFixtureTransaction}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quotePS(join(project, "scripts/ops/ops.ps1"))},[ref]$tokens,[ref]$errors)
foreach ($name in @('Invoke-PendingDeployment', 'Invoke-TransactionCommand', 'Invoke-Update')) {
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$Project=$PSScriptRoot; $original='1'*40; $latest='3'*40; $recorded='2'*40
New-Item -ItemType Directory -Force -Path (Join-Path $Project 'data\\state') | Out-Null
function IsAdmin { $true }; function Get-GitPath { 'git' }; function Get-BunPath { 'bun' }
function Step($m) { Write-Output "STEP $m" }; function Done($m) { Write-Output "DONE $m" }; function Warn($m) { Write-Output "WARN $m" }; function Err($m) { Write-Output "ERR $m" }
function Invoke-GitCapture([string[]]$GitArgs) {
    $script:git += ,($GitArgs -join ' ')
    $text = switch ($GitArgs[0]) { 'rev-parse' { if ($GitArgs[1] -eq 'origin/main') { $latest } elseif ($GitArgs[1] -eq 'HEAD') { $original } else { 'main' } } default { '' } }
    [pscustomobject]@{ ExitCode=0; Text=$text }
}
function Expand-Archive($LiteralPath, $DestinationPath) {
    New-Item -ItemType Directory -Force -Path (Join-Path $DestinationPath 'scripts\\deploy') | Out-Null
    [IO.File]::WriteAllText((Join-Path $DestinationPath 'scripts\\deploy\\upgrade.ps1'), "Set-Content -LiteralPath '" + (Join-Path $Project 'upgrader.txt') + "' -Value (\`$args -join ' ')", [Text.UTF8Encoding]::new($true))
}
function Case($name, [scriptblock]$body) {
    $script:git=@()
    $result = try { & $body } catch { 'THROWN ' + $_.Exception.Message }
    $upgrader = Join-Path $Project 'upgrader.txt'
    $launched = if (Test-Path -LiteralPath $upgrader) { 'UPGRADER ' + (Get-Content -LiteralPath $upgrader -Raw).Trim(); Remove-Item -LiteralPath $upgrader } else { 'no upgrader' }
    Write-Output ("CASE $name => " + (($result | ForEach-Object { [string]$_ }) -join ' / ') + ' ## ' + $launched + ' ## git: ' + ($script:git -join ' ; '))
}
$state=Join-Path $Project 'data\\state'
Case 'idle-resume' { Invoke-TransactionCommand 'continue' }
Set-Content -LiteralPath (Join-Path $state 'deploy-transaction') ('deploy-' + ('a' * 32))
Case 'deploy-rollback' { Invoke-TransactionCommand 'rollback' }
Case 'deploy-update-undecided' { Invoke-Update }
Remove-Item -LiteralPath (Join-Path $state 'deploy-transaction')
$snapshot=Join-Path $Project ('backup\\snapshots\\deploy-' + ('b' * 32))
New-Item -ItemType Directory -Force -Path $snapshot | Out-Null
[pscustomobject]@{ UpgradeTarget=$recorded } | Export-Clixml -LiteralPath (Join-Path $snapshot 'deployment.xml')
Write-FixtureTransaction $snapshot $Project $recorded
Set-Content -LiteralPath (Join-Path $state 'upgrade-transaction') ('deploy-' + ('b' * 32))
Case 'upgrade-rollback' { Invoke-TransactionCommand 'rollback' }
Case 'upgrade-resume' { Invoke-TransactionCommand 'continue' }
Remove-Item -LiteralPath (Join-Path $state 'upgrade-transaction')
Case 'fresh-update' { Invoke-Update }
`);
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root);
    expect(result.code, result.output).toBe(0);
    const line = (name: string) => result.output.split(/\r?\n/).find(item => item.startsWith(`CASE ${name} `)) ?? "";
    expect(line("idle-resume")).toMatch(/没有未完成的部署或升级 \/ True ## no upgrader ## git: $/);
    expect(result.output).toContain("DEPLOY resume=False rollback=True");
    expect(line("deploy-rollback")).toBe("CASE deploy-rollback => True ## no upgrader ## git: ");
    // Without a TTY the pending deployment must be resolved explicitly, before any git access.
    expect(line("deploy-update-undecided")).toMatch(/THROWN .*resume.*rollback.* ## git: $/);
    const recorded = "2".repeat(40), latest = "3".repeat(40);
    for (const name of ["upgrade-rollback", "upgrade-resume"]) {
      expect(line(name)).toContain(`-TargetSha ${recorded}`);
      expect(line(name)).toContain(`archive --format=zip`);
      expect(line(name)).not.toContain("fetch");
      expect(line(name)).not.toContain(latest);
    }
    expect(line("upgrade-rollback")).toContain(" -Rollback");
    expect(line("upgrade-resume")).not.toContain("-Rollback");
    expect(line("fresh-update")).toContain("fetch origin main"); expect(line("fresh-update")).toContain(`-TargetSha ${latest}`);
  } finally { await f.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows deployment commits only after the verification instance passed and stopped", async () => {
  const f = await tempFixture("deploy-commit-order-");
  try {
    const source = await readFile(join(project, "scripts/deploy/deploy.ps1"), "utf8");
    const start = source.indexOf('Step "等待部署预检通过..."'), end = source.indexOf('Done "可选大文件外链', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const script = join(f.root, "commit-order.ps1");
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
$Project=Join-Path $PSScriptRoot 'project'; $StateDir=Join-Path $Project 'data/state'; $verifyOnly=Join-Path $StateDir 'verify-only'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$Port='2022'; $TaskName='mixin-chatbot'; $bunPath='fixture-bun'; $dataPreparationRunner='fixture-runner'; $WorkspaceRoot=''; $DefaultWorkspace=Join-Path $Project 'data/workspace'
$taskUsesS4U=$true; $taskStartDescription='fixture'; $snapshot=[pscustomobject]@{ Path='deploy-fixture' }
function Step {}; function Done {}; function Warn {}; function Fail {}; function Get-ScheduledTaskInfo {}
function Read-Host { throw 'prompted while the bot service was stopped' }
function Read-YesNo { throw 'prompted while the bot service was stopped' }
function Save-DeploymentState {}; function Enable-ScheduledTask {}
function Wait-BotHealth($ListenPort, [switch]$AllowVerification) {
    if($AllowVerification) { if(-not (Test-Path -LiteralPath $verifyOnly)){throw 'verification without verify-only'}; $script:verified=$script:case -ne 'health'; return $script:verified }
    if($script:normalStarts -ne 1){throw 'normal health before the normal start'}; return $true
}
function Stop-ProjectBot { if(-not $script:verified){throw 'verification instance stopped before it passed'}; $script:verificationStopped=$true; $true }
function Start-ScheduledTask { if((Test-Path -LiteralPath $verifyOnly) -or -not $script:committed){throw 'normal start before commit'}; $script:normalStarts++ }
function fixture-bun {
    $global:LASTEXITCODE=0
    if($args -contains 'commit'){ if(-not $script:verificationStopped){throw 'commit while verifying'}; if($script:case -eq 'commit'){$global:LASTEXITCODE=1}else{$script:committed=$true} }
}
$run=[scriptblock]::Create(${quotePS(source.slice(start, end))})
foreach($script:case in @('ok','health','commit')) {
    Set-Content -LiteralPath $verifyOnly 'verify'
    $script:verified=$false; $script:verificationStopped=$false; $script:committed=$false; $script:normalStarts=0; $deploymentCommitted=$false; $deploymentActivated=$false
    $failure=$null
    # Dot-sourced: the section's commit and activation flags land in this scope, as they do in deploy.ps1.
    try { . $run } catch { $failure=$_.Exception.Message }
    if($script:case -eq 'ok') {
        if($failure){throw ('ok: '+$failure)}
        if(-not $script:committed -or -not $deploymentCommitted -or -not $deploymentActivated -or $script:normalStarts -ne 1 -or (Test-Path -LiteralPath $verifyOnly)){throw 'ok: normal start not reached'}
    } else {
        if(-not $failure -or $failure -like 'prompted*'){throw ($script:case+': expected rollback without prompting, got '+$failure)}
        if($script:committed -or $deploymentCommitted -or $script:normalStarts){throw ($script:case+': committed after a failure')}
    }
    Write-Output ('VERIFIED '+$script:case)
}
`);
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], f.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output.match(/VERIFIED /g), result.output).toHaveLength(3);
  } finally { await f.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows upgrade replaces the existing snapshot with durable upgrade metadata", async () => {
  const fixture = await tempFixture("upgrade-snapshot-replace-");
  const script = join(fixture.root, "replace.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
${psFixtureTransaction}
$root=Join-Path $PSScriptRoot 'project with spaces'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data/state') | Out-Null
function New-DeploymentSnapshot($projectRoot,$taskName) {
    $path=Join-Path $projectRoot ('backup/snapshots/deploy-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    $state=[pscustomobject]@{Project=$projectRoot;Path=$path;WasRunning=$false;TaskName=$taskName;Lock=(New-Object IO.MemoryStream)}
    Save-DeploymentSnapshot $state
    return $state
}
$snapshot=Open-UpgradeSnapshot $root 'fixture' 'old-commit' 'main' 'new-commit'
try {
    $saved=Import-Clixml -LiteralPath (Join-Path $snapshot.Path 'deployment.xml')
    if($saved.UpgradeOriginal -ne 'old-commit' -or $saved.UpgradeTarget -ne 'new-commit'){throw 'upgrade metadata not persisted'}
    if((Get-Content -LiteralPath (Join-Path $root 'data/state/upgrade-transaction')).Trim() -ne (Split-Path $snapshot.Path -Leaf)){throw 'transaction pointer not published'}
    if(Get-ChildItem -LiteralPath $snapshot.Path -Filter 'deployment.xml.*.tmp'){throw 'temporary snapshot remains'}
    $snapshot.UpgradeTarget='updated-commit'
    Save-DeploymentSnapshot $snapshot
    if((Import-Clixml -LiteralPath (Join-Path $snapshot.Path 'deployment.xml')).UpgradeTarget -ne 'updated-commit'){throw 'second replacement failed'}
} finally { $snapshot.Lock.Dispose() }
Write-Output 'SNAPSHOT_REPLACE_VERIFIED'
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("SNAPSHOT_REPLACE_VERIFIED");
  } finally { await fixture.cleanup(); }
}, 30000);

for (const [name, shell] of [["Windows PowerShell 5.1", "powershell.exe"], ["PowerShell 7", Bun.which("pwsh") ?? "C:/Program Files/PowerShell/7/pwsh.exe"]] as const) {
  test.skipIf(process.platform !== "win32" || (shell !== "powershell.exe" && !existsSync(shell)))(`${name}: a transaction left by another operation after the unlocked check is never replaced`, async () => {
    const fixture = await tempFixture("transaction-pointer-race-");
    const script = join(fixture.root, "race.ps1");
    await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
${psFixtureTransaction}
# Host discovery is stubbed; pointers, snapshots and the exclusive deployment lock are real.
function Save-DeploymentFiles([string]$ProjectRoot,[string]$Snapshot) { New-Item -ItemType Directory -Force -Path $Snapshot | Out-Null; return @() }
function Get-ScheduledTask { return $null }
function Get-ProjectBotPids { return @() }
$root=Join-Path $PSScriptRoot 'project'
$state=Join-Path $root 'data/state'
$snapshots=Join-Path $root 'backup/snapshots'
$script:realNew=\${function:New-DeploymentSnapshot}
$script:interleaved=$false
function New-DeploymentSnapshot([string]$ProjectRoot,[string]$TaskName) {
    if(-not $script:interleaved) {
        $script:interleaved=$true
        # A found no pointer but has not taken the lock yet: B starts an upgrade, records its progress and is interrupted.
        $b=Open-UpgradeSnapshot $ProjectRoot $TaskName ('a'*40) 'main' ('b'*40)
        $b.WasRunning=$true; $b.DependenciesAttempted=$true
        Save-DeploymentSnapshot $b
        Write-FixtureTransaction $b.Path $ProjectRoot ('b'*40)
        $script:b=Split-Path $b.Path -Leaf
        # B ran in its own process: its lock and environment end with it.
        $b.Lock.Dispose(); $env:BOT_DEPLOY_BACKUP_ID=$null
    }
    & $script:realNew $ProjectRoot $TaskName
}
function Assert-Untouched([string]$Pointer) {
    if([IO.File]::ReadAllText((Join-Path $state $Pointer)) -ne $script:b){throw 'pointer no longer names the interrupted upgrade'}
    $saved=Import-Clixml (Join-Path $snapshots ($script:b+'/deployment.xml'))
    if(-not $saved.WasRunning -or -not $saved.DependenciesAttempted -or $saved.UpgradeTarget -ne ('b'*40)){throw 'interrupted upgrade record changed'}
    if(@(Get-ChildItem -LiteralPath $snapshots -Directory).Count -ne 1){throw 'a refused operation left a snapshot'}
    if($env:BOT_DEPLOY_BACKUP_ID){throw 'backup id leaked from a refused operation'}
    $lock=[IO.File]::Open((Join-Path $state 'deploy.lock'),'OpenOrCreate','ReadWrite','None'); $lock.Dispose()
}
$failure=$null
try { $a=Open-UpgradeSnapshot $root 'fixture-task' ('a'*40) 'main' ('c'*40); $a.Lock.Dispose(); $failure='accepted' } catch { $failure=$_.Exception.Message }
if($failure -notmatch 'upgrade-transaction.*继续或回滚'){throw ('A was not refused under the lock: '+$failure)}
Assert-Untouched 'upgrade-transaction'
# The interrupted upgrade is still resumable.
$resumed=Open-UpgradeSnapshot $root 'fixture-task' ('a'*40) 'main' ('b'*40)
if((Split-Path $resumed.Path -Leaf) -ne $script:b){throw 'resume opened another snapshot'}
$resumed.Lock.Dispose(); $env:BOT_DEPLOY_BACKUP_ID=$null
# A new deployment rechecks both pointers under the lock.
foreach($pointer in @('upgrade-transaction','deploy-transaction')) {
    if($pointer -eq 'deploy-transaction'){Move-Item -LiteralPath (Join-Path $state 'upgrade-transaction') -Destination (Join-Path $state 'deploy-transaction')}
    try { $c=& $script:realNew $root 'fixture-task'; $c.Lock.Dispose(); throw ('deployment accepted beside '+$pointer) } catch { if($_.Exception.Message -notmatch ($pointer+'.*继续或回滚')){throw} }
    Assert-Untouched $pointer
}
# Publishing a pointer only ever creates it.
$other=Join-Path $snapshots ('deploy-'+('c'*32)); New-Item -ItemType Directory -Path $other | Out-Null
$record=@{format='2';operation='deploy';snapshot=(Split-Path $other -Leaf);target_sha='';original_sha='';original_branch='';original_workspace_root='';target_workspace_root=''
    was_running='0';bot_port='1011';reconfigure_ai='0'}
try { Publish-DeploymentTransaction ([pscustomobject]@{Path=$other}) $record (Join-Path $state 'deploy-transaction'); throw 'pointer replaced' } catch { if($_.Exception.Message -notmatch '目标已存在，未覆盖'){throw} }
if([IO.File]::ReadAllText((Join-Path $state 'deploy-transaction')) -ne $script:b){throw 'publication replaced the pointer'}
# The upgrade pointer too: one written after the recheck, by a writer ignoring the lock, is not replaced.
Move-Item -LiteralPath (Join-Path $state 'deploy-transaction') -Destination (Join-Path $root 'parked-pointer')
$script:realSave=\${function:Save-DeploymentSnapshot}
function Save-DeploymentSnapshot($Snapshot) { & $script:realSave $Snapshot; if($Snapshot.UpgradeTarget -eq ('d'*40)){[IO.File]::WriteAllText((Join-Path $script:state 'upgrade-transaction'), $script:b)} }
try { $d=Open-UpgradeSnapshot $root 'fixture-task' ('a'*40) 'main' ('d'*40); $d.Lock.Dispose(); throw 'upgrade pointer replaced' } catch { if($_.Exception.Message -notmatch '目标已存在，未覆盖'){throw} }
if([IO.File]::ReadAllText((Join-Path $state 'upgrade-transaction')) -ne $script:b){throw 'upgrade publication replaced the pointer'}
if($env:BOT_DEPLOY_BACKUP_ID){throw 'backup id leaked from a refused upgrade'}
$lock=[IO.File]::Open((Join-Path $state 'deploy.lock'),'OpenOrCreate','ReadWrite','None'); $lock.Dispose()
Write-Output 'POINTER_RACE_VERIFIED'
`);
    try {
      const result = await execute([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("POINTER_RACE_VERIFIED");
    } finally { await fixture.cleanup(); }
  }, 30000);
}

test.skipIf(process.platform !== "win32")("Windows upgrade snapshot survives restart and retains its original code and running state", async () => {
  const fixture = await tempFixture("upgrade-resume-");
  const script = join(fixture.root, "resume.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
${psFixtureTransaction}
$root=Join-Path $PSScriptRoot 'project'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data/state') | Out-Null
function New-DeploymentSnapshot($projectRoot,$taskName) {
    $path=Join-Path $projectRoot ('backup/snapshots/deploy-'+[Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $path | Out-Null
    $lease=[IO.File]::Open((Join-Path $projectRoot 'data/state/deploy.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    [pscustomobject]@{Project=$projectRoot;Path=$path;WasRunning=$true;TaskName=$taskName;Lock=$lease}
}
$first=Open-UpgradeSnapshot $root 'fixture' 'original' 'main' 'target'
$first.Lock.Dispose()
Write-FixtureTransaction $first.Path $root
$second=Open-UpgradeSnapshot $root 'fixture' 'wrong-current' 'HEAD' 'target'
try {
    if($second.Path -ne $first.Path -or -not $second.WasRunning -or $second.UpgradeOriginal -ne 'original' -or $second.UpgradeBranch -ne 'main'){throw 'lost original transaction'}
    $blocked=$false
    try { $other=Open-UpgradeSnapshot $root 'fixture' 'x' 'main' 'target'; $other.Lock.Dispose() } catch { $blocked=$true }
    if(-not $blocked){throw 'competing deployment acquired lock'}
} finally { $second.Lock.Dispose() }
$blocked=$false
try { $other=Open-UpgradeSnapshot $root 'fixture' 'x' 'main' 'different-target'; $other.Lock.Dispose() } catch { $blocked=$true }
if(-not $blocked){throw 'resumed a different release'}
Write-Output 'RESUME_VERIFIED'
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("RESUME_VERIFIED");
  } finally { await fixture.cleanup(); }
}, 30000);

for (const [name, shell] of [["Windows PowerShell 5.1", "powershell.exe"], ["PowerShell 7", Bun.which("pwsh") ?? "C:/Program Files/PowerShell/7/pwsh.exe"]] as const) {
  test.skipIf(process.platform !== "win32" || (shell !== "powershell.exe" && !existsSync(shell)))(`${name}: migration previews preserve native arguments and resume without interaction`, async () => {
    const fixture = await tempFixture("migration-native-args-");
    const script = join(fixture.root, "arguments.ps1"), probe = join(fixture.root, "native arguments.ts");
    const root = join(fixture.root, "project with spaces");
    const plan = join(fixture.root, "migration plan.json"), workspace = join(fixture.root, "external workspace");
    try {
      await writeFile(probe, "console.log(JSON.stringify(process.argv.slice(2)));\n");
      // Execute the real assignments and both preview invocations against a native argv recorder. PowerShell
      // function stubs hide the string-splatting bug, so these calls must cross the real executable boundary.
      await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
$bun=$bunPath=${quotePS(process.execPath)}
$previewRunner=$dataPreparationRunner=${quotePS(probe)}
$Project=${quotePS(root)}; $plan=$dataPreparationPlan=${quotePS(plan)}
$workspaceRoot=$finalWorkspace=${quotePS(workspace)}
foreach($file in @(${quotePS(join(project, "scripts/deploy/upgrade.ps1"))},${quotePS(join(project, "scripts/deploy/deploy.ps1"))})) {
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw ($errors | Out-String)}
    $commands=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and
        $node.CommandElements.Count -gt 3 -and $node.CommandElements[0].Extent.Text -in @('$bun','$bunPath') -and
        $node.CommandElements[3].Extent.Text -eq 'preview'},$true))
    if(-not $commands.Count){throw 'preview calls not found'}
    foreach($resuming in @($false,$true)) {
        $pendingPath=if($resuming){'recorded-snapshot'}else{$null}
        foreach($command in $commands) {
            Invoke-Expression $command.Extent.Text
            if($LASTEXITCODE -ne 0){throw 'native argv recorder failed'}
        }
    }
}
`);
      const result = await execute([shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
      expect(result.code, result.output).toBe(0);
      const actual = result.output.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const expected: string[][] = [];
      // upgrade.ps1 (one call) asks for a deployment record; deploy.ps1 (two calls) also accepts a fresh install.
      for (const [count, extra] of [[1, ["--upgrade"]], [2, []]] as const) for (const _resuming of [false, true]) {
        for (let i = 0; i < count; i++) expected.push(["preview", "--project", root, "--plan", plan, ...extra, "--workspace", workspace]);
      }
      expect(actual).toEqual(expected);
    } finally { await fixture.cleanup(); }
  }, 30000);
}

test.skipIf(process.platform !== "win32")("Windows target upgrade really boots and reaches Git preflight after a valid data preview", async () => {
  const fixture = await tempFixture("upgrade-bootstrap-");
  try {
    const command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(project, "scripts/deploy/upgrade.ps1"), "-Project", fixture.root,
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

test.skipIf(process.platform !== "win32")("Windows upgrade removes only its own export on success, export failure and child failure", async () => {
  const fixture = await tempFixture("upgrade-export-cleanup-");
  const script = join(fixture.root, "cleanup.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
${psFixtureTransaction}
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quotePS(join(project, "scripts/ops/ops.ps1"))},[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors | Out-String)}
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Update'},$true)
Invoke-Expression $definition.Extent.Text
$Project=Join-Path $PSScriptRoot 'project'
New-Item -ItemType Directory -Force -Path (Join-Path $Project 'tmp/keep') | Out-Null
Set-Content -LiteralPath (Join-Path $Project 'tmp/keep/evidence') 'original'
function IsAdmin { $true }; function Get-GitPath { 'fixture-git' }; function Get-BunPath { 'fixture-bun' }
function Err($message) { Write-Host $message }; function Warn($message) { throw $message }
function Invoke-GitCapture([string[]]$GitArgs) {
    if($GitArgs[0] -eq 'archive') { return @{ExitCode=$(if($env:UPGRADE_CASE -eq 'export'){1}else{0});Text='fixture export'} }
    $text=if($GitArgs -contains '--abbrev-ref'){'main'}elseif($GitArgs[0] -eq 'rev-parse'){'1'*40}else{''}
    return @{ExitCode=0;Text=$text}
}
function Expand-Archive($LiteralPath,$DestinationPath) {
    $target=Join-Path $DestinationPath 'scripts/deploy'
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Set-Content -LiteralPath (Join-Path $target 'upgrade.ps1') -Encoding ASCII -Value 'if($PSVersionTable.PSVersion.Major -ne 5){throw "wrong child host"}; if($env:UPGRADE_CASE -eq "child"){exit 17}; exit 0'
}
foreach($env:UPGRADE_CASE in @('success','export','child')) {
    $result=Invoke-Update
    if($result -ne ($env:UPGRADE_CASE -eq 'success')){throw 'wrong upgrade result'}
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

test.skipIf(!bash || !existsSync(bash))("Linux successful backup cleanup removes only its own snapshot and archive, and refuses links", async () => {
  const fixture = await tempFixture("backup-cleanup-linux-");
  const script = join(fixture.root, "cleanup.sh");
  const root = join(fixture.root, "project");
  for (const [path, text] of Object.entries(unrelatedBackups)) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text);
  }
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(realpath "$1/project")"
. '${posixPath(join(project, "scripts/lib/lifecycle.sh"))}'
snapshot="$PROJECT_DIR/backup/snapshots/deploy-current"
mkdir -p "$snapshot"
printf old > "$snapshot/old-config"
export BOT_DEPLOY_BACKUP_ID=deploy-current
printf old > "$PROJECT_DIR/old-file"
archive_project_path "$PROJECT_DIR/old-file"
[ -d "$PROJECT_DIR/backup/rm/deploy-current" ]
cleanup_completed_backup "$snapshot"
[ ! -e "$snapshot" ] && [ ! -e "$PROJECT_DIR/backup/rm/deploy-current" ]
if cleanup_completed_backup "$PROJECT_DIR/backup"; then exit 41; fi
# A link in place of the archive is refused before anything is removed, and its target is never entered.
if [ "$2" = links ]; then
    mkdir -p "$1/outside" "$PROJECT_DIR/backup/snapshots/deploy-linked"
    printf outside > "$1/outside/keep"
    ln -s "$1/outside" "$PROJECT_DIR/backup/rm/deploy-linked"
    if cleanup_completed_backup "$PROJECT_DIR/backup/snapshots/deploy-linked"; then exit 42; fi
    [ -d "$PROJECT_DIR/backup/snapshots/deploy-linked" ] && [ "$(cat "$1/outside/keep")" = outside ]
    rm -- "$PROJECT_DIR/backup/rm/deploy-linked"
fi
# With nothing else left, the empty directories go too; keep-root leaves backup/ itself for a running container's bind mount.
alone="$(realpath -m "$1/alone")"
mkdir -p "$alone/backup/snapshots/deploy-only" "$alone/backup/rm/deploy-only"
PROJECT_DIR="$alone" cleanup_completed_backup "$alone/backup/snapshots/deploy-only" keep-root
[ -d "$alone/backup" ] && [ -z "$(ls -A "$alone/backup")" ]
mkdir -p "$alone/backup/snapshots/deploy-only"
PROJECT_DIR="$alone" cleanup_completed_backup "$alone/backup/snapshots/deploy-only"
[ ! -e "$alone/backup" ]
`);
  try {
    // Git Bash on Windows copies instead of linking unless native symlinks are available; real links run on Linux.
    const links = process.platform === "win32" ? "none" : "links";
    const result = await execute([bash!, posixPath(script), posixPath(fixture.root), links], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    expect(result.code, result.output).toBe(0);
    for (const [path, text] of Object.entries(unrelatedBackups)) expect(await readFile(join(root, path), "utf8"), path).toBe(text);
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(!bash || !existsSync(bash))("Docker deployment never adopts a snapshot name whose archive already exists", async () => {
  const fixture = await tempFixture("deployment-fresh-name-");
  const script = join(fixture.root, "fresh.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$1" TAKEN="$2"
cd "$PROJECT_DIR"
. '${posixPath(join(project, "scripts/lib/lifecycle.sh"))}'
. '${posixPath(join(project, "scripts/lib/deployment.sh"))}'
LOG_DIR="$PROJECT_DIR/logs"
operation_start deploy
print_error(){ echo "$*" >&2; }; print_warning(){ echo "$*"; }; print_success(){ echo "$*"; }
flock(){ :; }
grant_service_access(){ echo "GRANT \${*##*/}"; }
docker(){ case "$1 \${2:-}" in ps*) : ;; "container inspect") return 1 ;; *) echo "unexpected Docker operation" >&2; return 1 ;; esac; }
# The first TAKEN names collide; command substitution runs mktemp in a subshell, so the count lives in a file.
mktemp(){
    local count name
    count=$(( $(cat mktemp-count 2>/dev/null || echo 0) + 1 )); printf '%s' "$count" > mktemp-count
    if [ "$count" -le "$TAKEN" ]; then name="deploy-taken$count"; else name="deploy-fresh$count"; fi
    mkdir -- "$PROJECT_DIR/backup/snapshots/$name" && printf '%s\\n' "$PROJECT_DIR/backup/snapshots/$name"
}
if begin_deployment; then trap - EXIT; echo "SNAPSHOT \${DEPLOY_SNAPSHOT##*/} ID $BOT_DEPLOY_BACKUP_ID"; else echo REFUSED; fi
`);
  try {
    for (const taken of [2, 5]) {
      const root = join(fixture.root, `taken-${taken}`);
      await mkdir(join(root, "data/state"), { recursive: true });
      for (let index = 1; index <= taken; index++) {
        await mkdir(join(root, `backup/rm/deploy-taken${index}`), { recursive: true });
        await writeFile(join(root, `backup/rm/deploy-taken${index}/old-config`), `earlier ${index}`);
      }
      const result = await execute([bash!, posixPath(script), posixPath(root), String(taken)], root, { ...process.env, MSYS_NO_PATHCONV: "1" });
      expect(result.code, result.output).toBe(0);
      if (taken === 2) {
        expect(result.output).toContain("SNAPSHOT deploy-fresh3 ID deploy-fresh3");
        expect(await readdir(join(root, "backup/snapshots"))).toEqual(["deploy-fresh3"]);
        // The service identity's containers (commit, rollback) look for the reset journal inside the snapshot.
        expect(result.output.match(/^GRANT .*$/gm)).toEqual(["GRANT deploy-fresh3"]);
      } else {
        expect(result.output).toContain("REFUSED"); expect(result.output).toContain("无法分配新的部署快照名称");
        expect(result.output).not.toContain("GRANT");
        expect(await readdir(join(root, "backup/snapshots"))).toEqual([]);
        expect(existsSync(join(root, "data/state/deploy-transaction"))).toBe(false);
      }
      for (let index = 1; index <= taken; index++) expect(await readFile(join(root, `backup/rm/deploy-taken${index}/old-config`), "utf8")).toBe(`earlier ${index}`);
    }
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows snapshots never adopt a name whose snapshot or archive already exists", async () => {
  const fixture = await tempFixture("snapshot-fresh-name-");
  const script = join(fixture.root, "fresh.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/lifecycle.ps1"))}
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
${psFixtureTransaction}
$root=Join-Path $PSScriptRoot 'project'
New-Item -ItemType Directory -Force -Path (Join-Path $root 'backup/rm/deploy-taken1'),(Join-Path $root 'backup/snapshots/deploy-taken3'),(Join-Path $PSScriptRoot 'gone') | Out-Null
# A dangling junction still occupies its name.
New-Item -ItemType Junction -Path (Join-Path $root 'backup/rm/deploy-taken2') -Target (Join-Path $PSScriptRoot 'gone') | Out-Null
[IO.Directory]::Delete((Join-Path $PSScriptRoot 'gone'))
# The real allocator, with its random part replaced by a fixed sequence.
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quotePS(join(project, "scripts/lib/deployment.ps1"))},[ref]$tokens,[ref]$errors)
$source=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-TransactionSnapshotPath'},$true).Extent.Text
if(-not $source.Contains("[Guid]::NewGuid().ToString('N')")){throw 'allocator changed shape'}
. ([scriptblock]::Create($source.Replace("[Guid]::NewGuid().ToString('N')", '(Get-FixtureName)')))
function Get-FixtureName { $script:count++; if($script:count -le $script:taken){'taken' + $script:count}else{'fresh' + $script:count} }
$script:count=0; $script:taken=3
$path=New-TransactionSnapshotPath $root 'deploy-'
if($path -ne (Join-Path $root 'backup\\snapshots\\deploy-fresh4')){throw ('taken name adopted: ' + $path)}
New-Item -ItemType Directory -Force -Path (Join-Path $root 'backup/rm/deploy-taken4'),(Join-Path $root 'backup/rm/deploy-taken5') | Out-Null
$script:count=0; $script:taken=5
$message=''; try { New-TransactionSnapshotPath $root 'deploy-' | Out-Null } catch { $message=$_.Exception.Message }
if($message -notmatch '无法分配新的快照名称'){throw ('exhausted names accepted: ' + $message)}
# Deployment snapshots take their names from the allocator.
function New-TransactionSnapshotPath($ProjectRoot, $Prefix) { $script:prefixes += ,$Prefix; Join-Path $ProjectRoot ('backup\\snapshots\\' + $Prefix + 'allocated') }
$script:prefixes=@()
function Save-DeploymentFiles([string]$ProjectRoot,[string]$Snapshot) { New-Item -ItemType Directory -Force -Path $Snapshot | Out-Null; return @() }
function Get-ScheduledTask { return $null }; function Get-ProjectBotPids { return @() }
$state=New-DeploymentSnapshot $root 'fixture-task'
$state.Lock.Dispose()
if($state.Path -ne (Join-Path $root 'backup\\snapshots\\deploy-allocated') -or ($script:prefixes -join ',') -ne 'deploy-'){throw 'snapshot name not allocated'}
Write-Output 'FRESH_NAMES_VERIFIED'
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("FRESH_NAMES_VERIFIED");
  } finally { await fixture.cleanup(); }
}, 30000);


test.skipIf(!bash || !existsSync(bash))("Docker deployment picks the port without asking and stops a bad, unpublishable or taken one before the build", async () => {
  const fixture = await tempFixture("deployment-rootless-port-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
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
BOT_PORT_FILE="$state/bot-port"; RECORDED="\${FIXTURE_RECORDED:-0}"; DOCKER_ROOTLESS="$FIXTURE_ROOTLESS"
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
      // A resumed transaction keeps its recorded port: it stops with the way forward instead of failing after the build.
      result = await run({ FIXTURE_ROOTLESS: "1", FIXTURE_RECORDED: "1", FIXTURE_PORT: low });
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain(`续做沿用事务记录的端口 ${low}`); expect(result.port).toBeUndefined();
      // Nor is it probed: the stopped transaction's own service may still be on the way down.
      result = await run({ FIXTURE_ROOTLESS: "0", FIXTURE_RECORDED: "1", FIXTURE_PORT: low, FIXTURE_TAKEN: low });
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

test.skipIf(!bash || !existsSync(bash))("Docker deployment explicitly accepts verification health without trusting the normal HEALTHCHECK", async () => {
  const fixture = await tempFixture("deployment-verification-health-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
  const wait = source.split("# ---- 等待健康检查 ----")[1]?.split("# 只有部署预检通过后才提交状态")[0];
  expect(wait).toBeDefined();
  const script = join(fixture.root, "health.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
probes=0
print_status(){ :; }; print_success(){ :; }; print_error(){ echo "$*" >&2; }
ops_command_hint(){ echo "$*"; }; sleep(){ :; }
docker(){
    if [ "$1" = exec ]; then
        [[ "$*" = *--allow-verification ]] || return 90
        probes=$((probes+1)); echo PROBE
        [ "$probes" -ge 3 ]
    elif [ "$1 $2" = "container inspect" ]; then
        if [[ "$*" = *State.Running* ]]; then [ "$FIXTURE_MODE" != stopped ] && echo true || echo false
        else echo unhealthy; fi
    fi
}
${wait}
[ "$probes" = 3 ]
`);
  try {
    for (const mode of ["verification", "stopped"]) {
      const result = await execute([bash!, posixPath(script)], fixture.root,
        { ...process.env, MSYS_NO_PATHCONV: "1", FIXTURE_MODE: mode });
      expect(result.code, result.output).toBe(mode === "verification" ? 0 : 1);
      expect(result.output.match(/PROBE/g)).toHaveLength(mode === "verification" ? 3 : 1);
    }
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!bash || !existsSync(bash))("Docker deployment collects every answer before stopping and commits only after verification", async () => {
  const fixture = await tempFixture("deployment-docker-preflight-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
  const stop = source.indexOf("\nbegin_deployment\n"), commit = source.indexOf("\ncommit_deployment\n", stop);
  const preflight = source.split("# ---- 停机前的交互选择")[1]?.split("# Decisions precede persistent changes")[0]?.replace(/^[^\n]*/, "");
  expect(preflight).toBeDefined();
  expect(source.indexOf("# ---- 停机前的交互选择")).toBeLessThan(stop);
  // Only the configuration wizard containers may interact between the stop and the commit.
  expect(stop).toBeGreaterThan(0); expect(commit).toBeGreaterThan(stop);
  expect(source.slice(stop, commit).match(/read_input|ask_yes_no/g)).toBeNull();
  // After the last answer and right before the stop, a new deployment checks again that the snapshot fits.
  expect(source.slice(source.indexOf("# Decisions precede persistent changes"), stop)).toMatch(/\n    check_stop_disk_space "\$DATA_DIR" \|\|\n/);
  // The commit follows the verification instance's health check.
  const verification = source.indexOf("--allow-verification", stop);
  expect(verification).toBeGreaterThan(stop); expect(verification).toBeLessThan(commit);
  const state = join(fixture.root, "state");
  await mkdir(state, { recursive: true });
  await writeFile(join(fixture.root, "models.json"), "{}");
  await writeFile(join(fixture.root, "preflight.sh"), `#!/usr/bin/env bash
set -euo pipefail
. '${posixPath(join(project, "scripts/lib/common.sh"))}'
PROJECT_DIR="$PWD"; STATE_DIR="$PWD/state"; LOG_DIR="$PWD/logs"; PROMPTS="$STATE_DIR/prompts"; RECORDED="\${FIXTURE_RECORDED:-0}"
declare -A TRANSACTION=([reconfigure_ai]=1)
print_status(){ :; }; print_success(){ :; }; print_warning(){ echo "WARN $*"; }; print_error(){ echo "$*" >&2; }
settings_fixed_hint(){ echo 'recorded settings only'; }
read_input(){ printf '%s\\n' "$1" >> "$PROMPTS"; echo "unexpected prompt: $1" >&2; exit 97; }
ask_yes_no(){ printf '%s\\n' "$1" >> "$PROMPTS"; case "$1" in *重新配置\\ AI*) return 0 ;; *) exit 98 ;; esac; }
MODELS_FILE="$PWD/models.json"; APP_BOT_FILE="$PWD/app-bot.json"
if [ "\${FIXTURE_APP_BOT:-1}" = 1 ]; then printf '{}' > "$APP_BOT_FILE"; else rm -f "$APP_BOT_FILE"; fi
${preflight}
echo "RESULT ai=$RECONFIGURE_AI"
`);
  const run = async (env: Record<string, string>) => {
    await writeFile(join(state, "prompts"), "");
    const result = await execute([bash!, posixPath(join(fixture.root, "preflight.sh"))], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1", ...env });
    return { ...result, prompts: await readFile(join(state, "prompts"), "utf8") };
  };
  try {
    // A recorded continue asks nothing and never runs the wizard it recorded.
    let result = await run({ FIXTURE_RECORDED: "1" });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("RESULT ai=0"); expect(result.output).toContain("AI 重新配置不会在续做中运行"); expect(result.prompts).toBe("");
    // Without the app-bot credentials a continue stops instead of asking.
    result = await run({ FIXTURE_RECORDED: "1", FIXTURE_APP_BOT: "0" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("data/config/app-bot.json"); expect(result.prompts).toBe("");
    // A new deployment asks its only question before the stop.
    result = await run({});
    expect(result.code, result.output).toBe(0); expect(result.output).toContain("RESULT ai=1"); expect(result.prompts).toContain("重新配置 AI");
  } finally { await fixture.cleanup(); }
}, 90000);

test.skipIf(!bash || !existsSync(bash))("Docker deployment refuses the legacy update entry before any change", async () => {
  const fixture = await tempFixture("deployment-legacy-entry-");
  const root = join(fixture.root, "project"), dockerLog = join(fixture.root, "docker.log");
  await mkdir(join(root, "scripts/deploy"), { recursive: true });
  await Bun.write(join(root, "scripts/deploy/deploy.sh"), Bun.file(join(project, "scripts/deploy/deploy.sh")));
  for (const name of await readdir(join(project, "scripts/lib"))) {
    if (name.endsWith(".sh")) await Bun.write(join(root, "scripts/lib", name), Bun.file(join(project, "scripts/lib", name)));
  }
  // An exported function, not a PATH stub: the Windows CI runner skipped the stub and reached its real Docker.
  const docker = `() { echo "$*" >> '${posixPath(dockerLog)}'; return 1\n}`;
  const run = (env: Record<string, string>) => execute([bash!, posixPath(join(root, "scripts/deploy/deploy.sh"))], root,
    { ...process.env, MSYS_NO_PATHCONV: "1", "BASH_FUNC_docker%%": docker, ...env });
  try {
    // The previous ops.sh stopped the service and handed over with DEPLOY_REUSE_SETTINGS=1: refuse before Docker, data or state.
    let result = await run({ DEPLOY_REUSE_SETTINGS: "1" });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("旧版（webhook）部署不支持升级到应用机器人版本，请在新目录全新部署");
    expect(result.output).toContain("本次未改动数据和配置");
    expect(existsSync(dockerLog)).toBe(false);
    expect(existsSync(join(root, "data"))).toBe(false); expect(existsSync(join(root, "backup"))).toBe(false);
    // Without the legacy flag (or with an explicit transaction action) deployment proceeds to its normal checks.
    for (const env of [{}, { DEPLOY_REUSE_SETTINGS: "1", DEPLOY_TRANSACTION_ACTION: "continue" }] as Record<string, string>[]) {
      await rm(dockerLog, { force: true });
      result = await run(env);
      expect(result.code, result.output).toBe(1);
      expect(result.output).not.toContain("旧版（webhook）部署"); expect(result.output).toContain("无法连接 Docker");
      expect(await readFile(dockerLog, "utf8")).toBe("info\n");
    }
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(!bash || !existsSync(bash))("Docker continue and rollback use only the transaction record and never wait for input", async () => {
  const fixture = await tempFixture("deployment-docker-transaction-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
  const settings = source.split("# ---- 目录 + 监听端口 ----")[1]?.split("\n# ---- 目录 ----\n")[0];
  const preflight = source.split("# ---- 停机前的交互选择")[1]?.split("# Decisions precede persistent changes")[0]?.replace(/^[^\n]*/, "");
  const helpers = ["trim_input", "settings_fixed_hint", "read_input", "ask_yes_no", "choose_transaction_action", "workspace_mount", "rollback_pending_deployment",
    "activate_committed_deployment", "finish_committed_transaction", "check_deploy_environment"]
    .map(name => source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0]);
  expect(settings).toBeDefined(); expect(preflight).toBeDefined(); expect(helpers.every(Boolean)).toBe(true);
  const root = join(fixture.root, "project"), state = join(root, "data/state"), snapshot = join(root, "backup/snapshots/deploy-fixture");
  const receipt = join(fixture.root, "update-commit"), dockerLog = join(fixture.root, "docker.log");
  const target = join(fixture.root, "target shared"), original = join(fixture.root, "original shared"), elsewhere = join(fixture.root, "elsewhere");
  for (const dir of [state, join(root, "data/config"), snapshot, target, original, elsewhere]) await mkdir(dir, { recursive: true });
  // Saved settings and the environment deliberately disagree with the record.
  await writeFile(join(state, "bot-port"), "3000"); await writeFile(join(state, "workspace-root"), posixPath(original));
  await writeFile(join(root, "data/config/models.json"), "{}"); await writeFile(join(root, "data/config/app-bot.json"), "{}");
  await writeFile(join(state, "deploy-transaction"), "deploy-fixture");
  const lines = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  // The candidate image and the service identity are recorded beside the transaction; recovery reads them first.
  const candidateId = `sha256:${"c".repeat(64)}`, candidateTag = "mixin-chatbot:candidate-0123456789ab-0123456789abcdef";
  const record = async (overrides: Record<string, string> = {}) => {
    const values = { format: "2", operation: "upgrade", snapshot: "deploy-fixture", target_sha: "", original_sha: "", original_branch: "",
      original_workspace_root: posixPath(original), target_workspace_root: posixPath(target), was_running: "1", bot_port: "2022",
      reconfigure_ai: "1", ...overrides };
    await writeFile(join(snapshot, "transaction"), lines(values));
    await writeFile(join(snapshot, "candidate-image"), lines({ format: "1", source: values.target_sha ? "commit" : "workspace", target_sha: values.target_sha,
      image_id: candidateId, image_tag: candidateTag, daemon_id: "5eec1de4-4518-46da-a461-80c0866ec11d", project_id: "0123456789ab", operation_id: "0123456789abcdef" }));
    await writeFile(join(snapshot, "service-user"), lines({ format: "1", user: "1000:1000", source: "container" }));
  };
  const script = join(fixture.root, "transaction.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
. '${posixPath(join(project, "scripts/lib/deployment.sh"))}'
PROJECT_DIR="$1"; RECORDED=0; DOCKER_ROOTLESS=0; IMAGE_ID=''; SERVICE_USER=''; SERVICE_USER_SOURCE=''; CANDIDATE_PRESENT=1
TRANSACTION_ACTION="\${FIXTURE_ACTION:-}"
# The recorded image as the daemon reports it: 0 present, 3 another daemon, 4 removed (see candidate_verify).
candidate_verify(){ return "\${FIXTURE_CANDIDATE:-0}"; }
DATA_DIR="$PROJECT_DIR/data"; CONFIG_DIR="$DATA_DIR/config"; STATE_DIR="$DATA_DIR/state"; RUNTIME_HOME_DIR="$DATA_DIR/runtime/home"
LOG_DIR="$PROJECT_DIR/logs"; MODELS_FILE="$CONFIG_DIR/models.json"
APP_BOT_FILE="$CONFIG_DIR/app-bot.json"; BOT_PORT_FILE="$STATE_DIR/bot-port"
print_status(){ echo "$*"; }; print_success(){ echo "$*"; }; print_warning(){ echo "$*" >&2; }; print_error(){ echo "$*" >&2; }; print_prompt(){ :; }
flock(){ :; }; acquire_deploy_lock(){ :; }; determine_service_user(){ echo 'normal settings read' >&2; exit 90; }
data_preparation_docker(){
    [ "$1" = committed ] || { echo "MIGRATION $1" >&2; exit 93; }; [ "\${FIXTURE_COMMITTED:-0}" = 1 ]
}
begin_deployment(){ echo "BEGIN rollback=\${ROLLBACK_REQUESTED:-0} root=$HOST_WORKSPACE_ROOT mount=\${WORKSPACE_ARGS[*]-}"; }
docker(){
    echo "$*" >> '${posixPath(dockerLog)}'
    case "$1" in
        container)
            [ "$2" = inspect ] && { [ "\${!#}" != mixin-chatbot-rollback ] || [ "\${FIXTURE_ROLLBACK_CONTAINER:-0}" = 1 ]; } || return 1
            [ "\${4:-}" != '{{.Image}}' ] || echo "\${FIXTURE_CONTAINER_IMAGE:-${candidateId}}" ;;
        exec) [ "\${FIXTURE_UNHEALTHY:-0}" != 1 ] ;;
        tag) [ "\${FIXTURE_TAG_FAIL:-0}" != 1 ] ;;
        image) [ "$2" != inspect ] || [ "\${4:-}" != '{{.Id}}' ] || echo ${candidateId} ;;
    esac
}
sleep(){ :; }; cleanup_completed_backup(){ echo "CLEANUP $1"; }
${helpers.join("\n")}
${settings}
${preflight}
echo "RESULT port=$BOT_PORT root=$HOST_WORKSPACE_ROOT ai=$RECONFIGURE_AI runtime=\${BOT_MAX_ACTIVE_REQUESTS-}\${BOT_BASH_TIMEOUT-}\${PI_CACHE_RETENTION-}"
`);
  // The new terminal's ordinary environment is invalid on purpose: recovery neither validates nor adopts it.
  const run = (env: Record<string, string>) => execute([bash!, posixPath(script), posixPath(root)], fixture.root,
    { ...process.env, MSYS_NO_PATHCONV: "1", BOT_PORT: "9999", WORKSPACE_ROOT: posixPath(elsewhere),
      BOT_MAX_ACTIVE_REQUESTS: "0", BOT_BASH_TIMEOUT: "5", PI_CACHE_RETENTION: "short", ...env });
  try {
    await record();
    let result = await run({ FIXTURE_ACTION: "continue" });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`RESULT port=2022 root=${posixPath(target)} ai=0 runtime=\n`);
    expect(result.output).toContain("继续上次操作");
    // Continuing never runs the credential wizard: missing app-bot credentials stop it instead of asking.
    await rm(join(root, "data/config/app-bot.json"));
    result = await run({ FIXTURE_ACTION: "continue" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("data/config/app-bot.json"); expect(result.output).not.toContain("RESULT");
    await writeFile(join(root, "data/config/app-bot.json"), "{}");
    // A record of another format is refused before anything is read or changed.
    await record({ format: "1" });
    result = await run({ FIXTURE_ACTION: "continue" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("事务记录无效：format"); expect(result.output).not.toContain("RESULT");
    await record();
    // Without an explicit action a pending upgrade is left to resume / rollback, which also switch or restore the code.
    result = await run({});
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("未完成的是升级"); expect(result.output).toContain("resume");
    expect(result.output).not.toContain("RESULT");
    // Data, configuration and containers already rolled back, only the code left: neither continued nor rolled back again here.
    await writeFile(join(snapshot, "code-restore"), "");
    for (const action of ["continue", "rollback"]) {
      result = await run({ FIXTURE_ACTION: action });
      expect(result.code, result.output).toBe(1); expect(result.output).toContain("只剩代码待恢复");
      expect(result.output).not.toContain("BEGIN"); expect(result.output).not.toContain("RESULT");
    }
    await rm(join(snapshot, "code-restore"));
    // A pending deployment without a TTY and without an explicit action: nothing is decided.
    await record({ operation: "deploy" });
    result = await run({});
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("发现未完成的部署"); expect(result.output).toContain("resume");
    expect(result.output).not.toContain("RESULT");
    await record();
    // A recorded target commit must be checked out.
    await record({ target_sha: "a".repeat(40) });
    result = await run({ FIXTURE_ACTION: "continue" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("不是上次操作的目标提交");
    // A missing mount stops the continue; the empty root is never recreated.
    const missing = join(fixture.root, "unmounted");
    await record({ target_workspace_root: posixPath(missing) });
    result = await run({ FIXTURE_ACTION: "continue" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("事务记录的共享资料目录不存在");
    expect(existsSync(missing)).toBe(false);
    // Rollback: committed data is refused before any container change; otherwise the snapshot is restored against the target root.
    await record();
    await writeFile(join(state, "release-data.json"), "{}");
    result = await run({ FIXTURE_ACTION: "rollback", FIXTURE_COMMITTED: "1" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("已经提交，不能回滚");
    expect(result.output).not.toContain("BEGIN");
    result = await run({ FIXTURE_ACTION: "rollback" });
    expect(result.output).toContain(`BEGIN rollback=1 root=${posixPath(target)} mount=-v ${posixPath(target)}:/app/workspace:ro -e WORKSPACE_ROOT=/app/workspace`);
    await record({ original_workspace_root: posixPath(missing) });
    result = await run({ FIXTURE_ACTION: "rollback" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("原共享资料目录不存在");
    expect(result.output).not.toContain("BEGIN");
    // Continue after the data was committed: no new transaction, build or migration; only the verification
    // instance is replaced by the normal one, and the transaction ends only once it is healthy.
    const committed = async (env: Record<string, string>) => {
      await writeFile(join(state, "deploy-transaction"), "deploy-fixture"); await writeFile(receipt, ""); await writeFile(dockerLog, "");
      const output = await run({ FIXTURE_ACTION: "continue", FIXTURE_COMMITTED: "1", BOT_UPDATE_COMMIT_FILE: posixPath(receipt), ...env });
      return { ...output, docker: (await readFile(dockerLog, "utf8")).trim().split("\n") };
    };
    await record();
    // The upgrader that stopped the service in the same operation passes the time of the stop: the operation log records
    // the downtime until the new instance is healthy.
    const operationLog = join(fixture.root, "operation.log");
    await writeFile(operationLog, "");
    let activation = await committed({ FIXTURE_ROLLBACK_CONTAINER: "1", BOT_OPERATION_LOG_PATH: posixPath(operationLog),
      BOT_DOWNTIME_STARTED: String(Math.floor(Date.now() / 1000) - 7) });
    expect(activation.code, activation.output).toBe(0);
    expect(Number(/service back \(new version healthy\); downtime (\d+)s/.exec(await readFile(operationLog, "utf8"))?.[1])).toBeGreaterThanOrEqual(7);
    // The new instance must run the recorded image. Once it is healthy the official tag names that image and is
    // verified; only then the transaction ends and the reserved tag, the rollback container and its tag are released.
    const publish = [`tag ${candidateId} mixin-chatbot`, "image inspect --format {{.Id}} mixin-chatbot"];
    const released = [`image inspect --format {{.Id}} ${candidateTag}`, `image rm --force ${candidateTag}`];
    expect(activation.docker).toEqual(["container inspect mixin-chatbot-rollback", "container inspect --format {{.Image}} mixin-chatbot",
      "stop --time 30 mixin-chatbot", "start mixin-chatbot", "exec mixin-chatbot bun run scripts/ops/health-check.ts", ...publish, ...released,
      "rm mixin-chatbot-rollback", "image inspect mixin-chatbot:previous", "image rm mixin-chatbot:previous"]);
    expect(activation.output).toContain(`CLEANUP ${posixPath(snapshot)}`); expect(activation.output).toContain("机器人已启动");
    expect(activation.output).not.toContain("BEGIN"); expect(activation.output).not.toContain("RESULT"); expect(activation.output).not.toContain("MIGRATION");
    expect(existsSync(join(state, "deploy-transaction"))).toBe(false);
    expect(await readFile(receipt, "utf8")).toBe("committed\n");
    // An upgrade that found the service stopped keeps it stopped; the official tag still moves, for the maintenance commands.
    await record({ was_running: "0" });
    activation = await committed({});
    expect(activation.code, activation.output).toBe(0); expect(activation.output).toContain("保持停止");
    expect(activation.docker).toEqual(["container inspect mixin-chatbot-rollback", "container inspect --format {{.Image}} mixin-chatbot",
      "stop --time 30 mixin-chatbot", ...publish, ...released, "image inspect mixin-chatbot:previous", "image rm mixin-chatbot:previous"]);
    // An unhealthy instance, or an official tag that cannot be moved, keeps the transaction: continuing again retries only
    // the activation. The committed data is never rolled back.
    await record();
    activation = await committed({ FIXTURE_UNHEALTHY: "1" });
    expect(activation.code, activation.output).toBe(1); expect(activation.output).toContain("业务实例未就绪"); expect(activation.output).toContain("resume");
    expect(existsSync(join(state, "deploy-transaction"))).toBe(true);
    expect(activation.output).not.toContain("CLEANUP"); expect(activation.docker.filter(line => line.startsWith("tag"))).toEqual([]);
    activation = await committed({ FIXTURE_TAG_FAIL: "1" });
    expect(activation.code, activation.output).toBe(1); expect(activation.output).toContain("正式标签 mixin-chatbot 未能指向");
    expect(existsSync(join(state, "deploy-transaction"))).toBe(true); expect(activation.output).not.toContain("CLEANUP");
    expect(activation.docker.filter(line => line.startsWith("image rm"))).toEqual([]);
    // The container left by the interrupted operation must run the recorded image; another one is not activated.
    activation = await committed({ FIXTURE_CONTAINER_IMAGE: `sha256:${"d".repeat(64)}` });
    expect(activation.code, activation.output).toBe(1); expect(activation.output).toContain("不是记录的候选镜像");
    expect(activation.docker).toEqual(["container inspect mixin-chatbot-rollback", "container inspect --format {{.Image}} mixin-chatbot"]);
    // Recovery reads the image and the identity first. Another Docker daemon, a missing record, a candidate recorded for
    // another commit or an identity that does not fit the daemon refuses both ways before any container is touched; the
    // pointer and the records stay for the operator.
    for (const [change, message] of [["daemon", "Docker daemon 与开始事务时不同"], ["record", "缺少服务身份记录"], ["candidate", "缺少候选镜像记录"],
      ["commit", "与事务的目标提交"], ["identity", "记录的服务身份与当前 Docker 的模式不符"]] as const) {
      await record();
      if (change === "record") await rm(join(snapshot, "service-user"));
      if (change === "candidate") await rm(join(snapshot, "candidate-image"));
      if (change === "commit") await writeFile(join(snapshot, "candidate-image"), (await readFile(join(snapshot, "candidate-image"), "utf8"))
        .replace("source=workspace\n", "source=commit\n").replace("target_sha=\n", `target_sha=${"b".repeat(40)}\n`));
      if (change === "identity") await writeFile(join(snapshot, "service-user"), lines({ format: "1", user: "0:0", source: "container" }));
      const records = async () => Promise.all(["transaction", "candidate-image", "service-user"].map(name => readFile(join(snapshot, name), "utf8").catch(() => null)));
      const kept = await records();
      for (const action of ["continue", "rollback"]) {
        await writeFile(dockerLog, "");
        result = await run({ FIXTURE_ACTION: action, FIXTURE_COMMITTED: "1", FIXTURE_CANDIDATE: change === "daemon" ? "3" : "0" });
        expect(result.code, result.output).toBe(1); expect(result.output).toContain(message);
        expect(await readFile(dockerLog, "utf8")).toBe(""); expect(result.output).not.toContain("BEGIN");
        expect(await readFile(join(state, "deploy-transaction"), "utf8")).toBe("deploy-fixture"); expect(await records()).toEqual(kept);
      }
    }
    // A removed candidate cannot be replaced by a rebuild: continuing is refused, and so is a rollback once this
    // transaction's migration started; a rollback that never reached the migration restores the original container.
    await record(); await rm(join(state, "release-data.json"), { force: true });
    result = await run({ FIXTURE_ACTION: "continue", FIXTURE_CANDIDATE: "4" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("重新构建的镜像不能代替"); expect(result.output).not.toContain("RESULT");
    await writeFile(join(state, "release-data.json"), `{\n  "deployment": "deploy-fixture"\n}\n`);
    result = await run({ FIXTURE_ACTION: "rollback", FIXTURE_CANDIDATE: "4" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("数据迁移已经开始"); expect(result.output).not.toContain("BEGIN");
    await rm(join(state, "release-data.json"));
    result = await run({ FIXTURE_ACTION: "rollback", FIXTURE_CANDIDATE: "4" });
    expect(result.output).toContain(`BEGIN rollback=1 root=${posixPath(target)}`);
    // Without a transaction the ordinary environment is validated before any setting is read.
    await rm(join(state, "deploy-transaction"));
    result = await run({ BOT_MAX_ACTIVE_REQUESTS: "0" });
    expect(result.code, result.output).toBe(1); expect(result.output).toContain("BOT_MAX_ACTIVE_REQUESTS 必须是"); expect(result.output).not.toContain("normal settings read");
    result = await run({ BOT_MAX_ACTIVE_REQUESTS: "32" });
    expect(result.code, result.output).toBe(90); expect(result.output).toContain("normal settings read");
  } finally { await fixture.cleanup(); }
}, 120000);

test.skipIf(!bash || !existsSync(bash))("Docker redeployment checks the data version before the stop, whatever model files exist", async () => {
  const fixture = await tempFixture("deployment-docker-version-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
  const start = source.indexOf("# 数据版本在停机前核对"), end = source.indexOf("\nDATA_PREPARATION_PLANNED=0\n", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  // The check precedes the preview that is skipped when settings.json is missing, and every stop.
  expect(end).toBeLessThan(source.indexOf("\nbegin_deployment\n"));
  const script = join(fixture.root, "version.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
RECORDED="$FIXTURE_RECORDED"
print_error(){ echo "$*" >&2; }
data_preparation_docker(){ echo "CHECK $*"; return "$FIXTURE_STATUS"; }
${source.slice(start, end)}
echo CONTINUED
`);
  const run = (recorded: string, status: string) => execute([bash!, posixPath(script)], fixture.root, { ...process.env, FIXTURE_RECORDED: recorded, FIXTURE_STATUS: status });
  try {
    // Data without a valid record (the legacy webhook release included) is refused while the old service still runs.
    let result = await run("0", "1");
    expect(result.code).toBe(1); expect(result.output).toContain("CHECK check"); expect(result.output).toContain("数据版本核对未通过");
    expect(result.output).toContain("服务尚未停止"); expect(result.output).not.toContain("CONTINUED");
    result = await run("0", "0");
    expect(result.code, result.output).toBe(0); expect(result.output).toContain("CONTINUED");
    // A recorded transaction follows its confirmed plan without checking again.
    result = await run("1", "1");
    expect(result.code, result.output).toBe(0); expect(result.output).not.toContain("CHECK"); expect(result.output).toContain("CONTINUED");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!bash || !existsSync(bash))("Docker continue applies the migration plan confirmed before the stop instead of previewing again", async () => {
  const fixture = await tempFixture("deployment-docker-plan-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
  const block = source.split("\nDATA_PREPARATION_PLANNED=0\n")[1]?.split("# ---- 停机前的交互选择")[0];
  expect(block).toBeDefined();
  const root = fixture.root, state = join(root, "state"), snapshot = join(root, "snapshot");
  for (const dir of [state, snapshot, join(root, "runtime/pi")]) await mkdir(dir, { recursive: true });
  await writeFile(join(root, "models.json"), "{}"); await writeFile(join(root, "runtime/pi/settings.json"), "{}");
  await writeFile(join(snapshot, "data-plan.json"), "confirmed-before-stop");
  const script = join(root, "plan.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$1"; STATE_DIR="$PROJECT_DIR/state"; TRANSACTION_SNAPSHOT="$PROJECT_DIR/snapshot"; RECORDED="$FIXTURE_RECORDED"
MODELS_FILE="$PROJECT_DIR/models.json"; RUNTIME_DIR="$PROJECT_DIR/runtime"; DATA_PREPARATION_PLAN=/app/data/state/data-plan.json
print_error(){ echo "$*" >&2; }; settings_fixed_hint(){ echo hint; }; grant_service_access(){ echo "GRANT $*"; }
data_preparation_docker(){ echo "PREVIEW $*"; }
DATA_PREPARATION_PLANNED=0
${block}
echo "PLANNED=$DATA_PREPARATION_PLANNED"
`);
  const run = (recorded: string) => execute([bash!, posixPath(script), posixPath(root)], root, { ...process.env, MSYS_NO_PATHCONV: "1", FIXTURE_RECORDED: recorded });
  try {
    await writeFile(join(state, "data-plan.json"), "stale");
    // The snapshot is readable only by the deploying user; the plan is copied back where the container reads it.
    let result = await run("1");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("PLANNED=1"); expect(result.output).not.toContain("PREVIEW");
    expect(await readFile(join(state, "data-plan.json"), "utf8")).toBe("confirmed-before-stop");
    // The copy belongs to the deploying user; the migration container reads it as the service identity.
    expect(result.output).toContain(`GRANT ${posixPath(state)}/data-plan.json`);
    result = await run("0");
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("PREVIEW preview --plan /app/data/state/data-plan.json"); expect(result.output).toContain("PLANNED=1");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!bash || !existsSync(bash))("Docker data preparation passes the service identity and native cache environment", async () => {
  const fixture = await tempFixture("deployment-migration-env-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
  const migration = source.match(/^data_preparation_docker\(\) \{[\s\S]*?^\}/m)?.[0];
  expect(migration).toBeDefined();
  const script = join(fixture.root, "environment.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$1"
SERVICE_USER=1001:1002; IMAGE_ID=sha256:${"c".repeat(64)}; CANDIDATE_PRESENT=1
print_error(){ echo "$*" >&2; }
export PI_CACHE_RETENTION=long BOT_DEPLOY_BACKUP_ID=deploy-fixture BOT_OPERATION_LOG=upgrade-20260925T000000Z-fixture.log
docker(){
    while [ "$#" -gt 0 ]; do
        if [ "$1" = -e ]; then shift; case "$1" in
            PI_CACHE_RETENTION|BOT_DEPLOY_BACKUP_ID|BOT_OPERATION_LOG) printf '%s=%s\\n' "$1" "\${!1}" ;;
            *) printf '%s\\n' "$1" ;;
        esac
        else printf '%s\\n' "$1"; fi
        shift
    done
}
${migration}
data_preparation_docker preview --plan plan
echo DONE
# Without the recorded image nothing runs: nothing of this transaction can be committed, and there is nothing to undo.
CANDIDATE_PRESENT=0
if data_preparation_docker committed --deployment deploy-fixture; then echo COMMITTED; fi
data_preparation_docker rollback --deployment deploy-fixture && echo ROLLBACK_SKIPPED
data_preparation_docker apply --plan plan || echo APPLY_REFUSED
`);
  try {
    const result = await execute([bash!, posixPath(script), posixPath(fixture.root)], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("PI_CACHE_RETENTION=long");
    expect(result.output).toContain("BOT_DEPLOY_BACKUP_ID=deploy-fixture");
    expect(result.output).toContain("BOT_OPERATION_LOG=upgrade-20260925T000000Z-fixture.log");
    expect(result.output).toContain("logs:/app/logs");
    expect(result.output).toContain("--user\n1001:1002\n");
    // The data gate reads data/ only: the shared workspace is not mounted.
    expect(result.output).not.toContain("/app/workspace");
    // The transaction's image by ID, never the mutable mixin-chatbot tag.
    expect(result.output).toContain(`sha256:${"c".repeat(64)}\nbun\nrun\nscripts/runtime/data-current.ts\npreview\n`);
    expect(result.output).not.toContain("\nmixin-chatbot\n");
    const after = result.output.slice(result.output.indexOf("DONE"));
    expect(after).not.toContain("COMMITTED"); expect(after).toContain("ROLLBACK_SKIPPED"); expect(after).toContain("APPLY_REFUSED");
    expect(after).toContain("候选镜像已不存在，不能运行迁移 apply"); expect(after).not.toContain("--user");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!bash || !existsSync(bash))("Linux deployment transaction restores old container and configuration at every failure stage", async () => {
  const fixture = await tempFixture("deployment-linux-");
  const script = join(fixture.root, "rollback.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$1"
cd "$PROJECT_DIR"
. '${posixPath(join(project, "scripts/lib/lifecycle.sh"))}'
. '${posixPath(join(project, "scripts/lib/deployment.sh"))}'
LOG_DIR="$PROJECT_DIR/logs"
operation_start deploy
print_error(){ echo "$*" >&2; operation_event error "$*"; }; print_warning(){ echo "$*"; operation_event warn "$*"; }
print_success(){ echo "$*"; }
flock(){ :; }
# This deployment's candidate: its reserved tag is released once the rollback has completed.
declare -A CANDIDATE=([image_tag]=mixin-chatbot:candidate-0123456789ab-0123456789abcdef)
release_candidate(){ printf '%s\\n' "\${CANDIDATE[image_tag]}" >> mock/released; }
docker(){
    if [ "$1" = container ]; then shift; elif [ "$1" = inspect ]; then return 97; fi
    local cmd="$1"; shift
    case "$cmd" in
        ps) for file in mock/containers/*; do [ -f "$file" ] && basename "$file"; done ;;
        inspect)
            local name="\${!#}" image running
            [ -f "mock/containers/$name" ] || return 1
            read -r image running < "mock/containers/$name"
            if [ "\${2:-}" = '{{.Image}}' ]; then printf '%s' "$image"; elif [ "\${2:-}" = '{{.State.Running}}' ]; then printf '%s' "$running"; elif [ "\${2:-}" = '{{.Id}}' ]; then printf '%064d' 1; fi ;;
        stop|start)
            local name="\${!#}" image running
            # Interrupts that arrive during the rollback: Ctrl+C and a hangup reach the terminal's whole foreground process
            # group, which this script leads. The docker client stopping the new container, here a child process, must
            # finish all the same.
            if [ "$cmd" = stop ] && [ -f mock/interrupt-rollback ]; then
                rm -f mock/interrupt-rollback
                bash -c 'for signal in INT TERM HUP; do kill -s "$signal" -- "-$1"; done; sleep 0.5' - "$$" || return 1
            fi
            read -r image running < "mock/containers/$name"
            [ "$cmd" != stop ] || running=false
            [ "$cmd" != start ] || running=true
            printf '%s %s\\n' "$image" "$running" > "mock/containers/$name" ;;
        rename) mv -- "mock/containers/$1" "mock/containers/$2" ;;
        # Like the containerd image store: an image that lost its last tag is gone, even while a container uses it.
        tag)
            if [ "$1" != "$(cat mock/image 2>/dev/null)" ] && [ "$1" != "$(cat mock/previous 2>/dev/null)" ]; then echo "No such image: $1" >&2; return 1; fi
            if [ "$2" = mixin-chatbot:previous ]; then printf '%s' "$1" > mock/previous; else printf '%s' "$1" > mock/image; fi ;;
        image) case "$1" in inspect) [ -f mock/previous ] ;; rm) rm -- mock/previous ;; *) return 1 ;; esac ;;
        *) echo "unexpected Docker operation" >&2; return 1 ;;
    esac
}
begin_deployment
printf 'new-config' > data/config/models.json
[ "$2" != configuration ] || exit 42
printf 'new-image' > mock/image
[ "$2" != image ] || exit 42
NEW_CONTAINER_ATTEMPTED=1
printf 'new-image true\\n' > mock/containers/mixin-chatbot
[ "$2" != container ] && [ "$2" != health ] || exit 42
printf '2022' > data/state/bot-port
if [ "$2" = signal ]; then : > mock/interrupt-rollback; kill -TERM $$; fi
exit 42
`);
  try {
    // Windows cannot deliver the signals to bash.
    const stages = ["configuration", "image", "container", "health", "state", ...(process.platform === "win32" ? [] : ["signal"])];
    for (const running of [true, false]) for (const stage of stages) {
      const root = join(fixture.root, `${stage}-${running}`);
      await Promise.all(["data/config", "data/state", "mock/containers", "logs"].map(dir => mkdir(join(root, dir), { recursive: true })));
      await writeFile(join(root, "data/config/models.json"), "old-config");
      await writeFile(join(root, "data/state/bot-port"), "1011");
      await writeFile(join(root, "mock/containers/mixin-chatbot"), `old-image ${running}\n`);
      await writeFile(join(root, "mock/image"), "old-image");
      const result = await execute([bash!, posixPath(script), posixPath(root), stage], root, { ...process.env, MSYS_NO_PATHCONV: "1" }, stage === "signal");
      const label = `${stage} running=${running}`;
      // A TERM rolls back as well, and further interrupts during the rollback do not cut it short.
      const status = stage === "signal" ? 143 : 42;
      expect(result.code, `${label}: ${result.output}`).toBe(status);
      const logs = await readdir(join(root, "logs/operations")); expect(logs).toHaveLength(1);
      const text = await readFile(join(root, "logs/operations", logs[0]!), "utf8");
      expect(text).toContain("rollback"); expect(text).toContain("已恢复配置"); expect(text).toContain(`operation finished; exit=${status}`);
      // The downtime window: from stopping the running service until the old container runs again.
      if (running) { expect(text).toContain("service stopped; downtime begins"); expect(text).toMatch(/service back \(previous version restarted\); downtime \d+s/); }
      else expect(text).not.toContain("downtime");
      expect(existsSync(join(root, "mock/interrupt-rollback"))).toBe(false);
      expect(await readFile(join(root, "data/config/models.json"), "utf8")).toBe("old-config");
      expect(await readFile(join(root, "data/state/bot-port"), "utf8")).toBe("1011");
      expect(await readFile(join(root, "mock/containers/mixin-chatbot"), "utf8")).toBe(`old-image ${running}\n`);
      // The rebuild moved the tag; the rollback tag kept the original image, and is released once it is restored.
      expect(await readFile(join(root, "mock/image"), "utf8")).toBe("old-image");
      expect(existsSync(join(root, "mock/previous"))).toBe(false);
      expect(await readFile(join(root, "mock/released"), "utf8"), label).toBe("mixin-chatbot:candidate-0123456789ab-0123456789abcdef\n");
    }
  } finally { await fixture.cleanup(); }
}, 120000);

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

// Windows cannot deliver the signals to bash.
test.skipIf(!bash || !existsSync(bash) || process.platform === "win32")("deploy.sh releases its reserved tag before the transaction pointer, from the build on, even when interrupted again meanwhile", async () => {
  const fixture = await tempFixture("deploy-release-");
  try {
    const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
    const extract = (name: string) => {
      const start = source.indexOf(`\n${name}() {\n`), end = source.indexOf("\n}\n", start);
      expect(start).toBeGreaterThan(0);
      return source.slice(start + 1, end + 3);
    };
    const script = join(fixture.root, "release.sh");
    // Ctrl+C and a hangup reach the terminal's whole foreground process group, which this script leads, while the docker
    // client (here a child process) removes the tag: it must finish all the same. BUILD is the build's exit status.
    await writeFile(script, `STATE_DIR="$1" DATA_DIR="$1" PROJECT_DIR="$1"
. '${join(project, "scripts/lib/deployment.sh")}'
release_transaction_candidate() { bash -c 'for signal in INT TERM HUP; do kill -s "$signal" -- "-$1"; done; sleep 0.5; echo released' - "$$"; }
operation_finish() { echo "finished $1"; }
print_status() { :; }; print_success() { :; }; print_error() { echo error; }; print_warning() { echo warning; }
docker() { return 1; }; check_build_disk_space() { :; }; prepare_candidate_image() { return "$BUILD"; }
${extract("build_workspace_candidate")}${extract("release_before_pointer")}if [ "$2" = build ]; then build_workspace_candidate; else trap release_before_pointer EXIT; fi
exit 7
`);
    const run = async (mode: string, build = 0) => {
      const result = await execute([bash!, script, fixture.root, mode], fixture.root, { ...process.env, BUILD: String(build) }, true);
      return { code: result.code, output: result.output.trim() };
    };
    expect(await run("exit")).toEqual({ code: 7, output: "released\nfinished 7" });
    // A failed or interrupted build releases the tag as well: it exists before the build ends.
    expect(await run("build", 1)).toEqual({ code: 1, output: "error\nreleased\nfinished 1" });
    expect(await run("build", 130)).toEqual({ code: 130, output: "warning\nreleased\nfinished 130" });
    // Once the pointer is published the transaction's commit or rollback owns the tag.
    await writeFile(join(fixture.root, "deploy-transaction"), "deploy-fixture");
    expect(await run("exit")).toEqual({ code: 7, output: "finished 7" });
  } finally { await fixture.cleanup(); }
});

test.skipIf(!bash || !existsSync(bash))("Docker rollback of an upgrade keeps the transaction until the upgrader has restored the code", async () => {
  const fixture = await tempFixture("deployment-code-restore-");
  const root = fixture.root, script = join(root, "rollback.sh"), pointer = join(root, "data/state/deploy-transaction");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$1" OPERATION="$2" ORIGINAL_SHA="$3"
cd "$PROJECT_DIR"
. '${posixPath(join(project, "scripts/lib/lifecycle.sh"))}'
. '${posixPath(join(project, "scripts/lib/deployment.sh"))}'
LOG_DIR="$PROJECT_DIR/logs"
operation_start deploy
print_error(){ echo "$*" >&2; }; print_warning(){ echo "$*"; }; print_success(){ echo "$*"; }
flock(){ :; }
docker(){ case "$1 \${2:-}" in ps*) : ;; "container inspect") return 1 ;; *) echo "unexpected Docker operation" >&2; return 1 ;; esac; }
record_deployment_transaction(){ declare -gA TRANSACTION=([operation]="$OPERATION" [original_sha]="$ORIGINAL_SHA"); }
begin_deployment
exit 42
`);
  try {
    await mkdir(join(root, "data/state"), { recursive: true });
    // No MSYS_NO_PATHCONV: the rollback asks the native git.exe for HEAD with a POSIX project path.
    const git = (...args: string[]) => execute(["git", "-C", root, ...args], root);
    await git("init", "--initial-branch=main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, ".gitignore"), "*\n"); await git("add", "-f", ".gitignore"); await git("commit", "-m", "fixture");
    const head = (await git("rev-parse", "HEAD")).output.trim();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    for (const [operation, original, kept] of [["upgrade", "0".repeat(40), true], ["upgrade", head, false], ["deploy", "", false]] as const) {
      const result = await execute([bash!, posixPath(script), posixPath(root), operation, original], root);
      expect(result.code, result.output).toBe(42);
      expect(result.output).toContain("已恢复配置");
      // An upgrade still on other code keeps its pointer, marked so that retrying only restores the code.
      const [snapshot] = await readdir(join(root, "backup/snapshots"));
      expect(existsSync(pointer), `${operation} ${original}`).toBe(kept);
      expect(existsSync(join(root, "backup/snapshots", snapshot!, "code-restore"))).toBe(kept);
      await rm(join(root, "backup"), { recursive: true }); await rm(pointer, { force: true });
    }
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(!bash || !existsSync(bash))("Docker deployment resumes the original snapshot and restores data before starting the old container", async () => {
  const fixture = await tempFixture("deployment-resume-linux-");
  const script = join(fixture.root, "resume.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$1"; phase="$2"; cd "$PROJECT_DIR"
. '${posixPath(join(project, "scripts/lib/lifecycle.sh"))}'
. '${posixPath(join(project, "scripts/lib/deployment.sh"))}'
LOG_DIR="$PROJECT_DIR/logs"
print_error(){ echo "$*" >&2; }; print_warning(){ echo "$*"; }; print_success(){ echo "$*"; }
flock(){ :; }
docker(){
    if [ "$1" = container ]; then shift; elif [ "$1" = inspect ]; then return 97; fi
    local cmd="$1"; shift
    case "$cmd" in
        ps) for file in mock/*; do [ -f "$file" ] && basename "$file"; done ;;
        inspect)
            local name="\${!#}" image running
            [ -f "mock/$name" ] || return 1
            read -r image running < "mock/$name"
            if [ "\${2:-}" = '{{.State.Running}}' ]; then echo "$running"; else echo "$image"; fi ;;
        stop|start)
            local name="\${!#}" image running
            read -r image running < "mock/$name"
            if [ "$cmd" = start ]; then
                test "$(cat data/config/models.json)" = original
                test "$(cat restored-data)" = yes
                running=true
            else running=false; fi
            printf '%s %s\\n' "$image" "$running" > "mock/$name" ;;
        rename) mv -- "mock/$1" "mock/$2" ;;
        tag) : ;;
        *) return 1 ;;
    esac
}
if [ "$phase" = initial ]; then
    begin_deployment
    printf '%s' "$DEPLOY_SNAPSHOT" > original-snapshot
    printf changed > data/config/models.json
    printf 'new-image true\\n' > mock/mixin-chatbot
    # Simulate termination without running EXIT recovery.
    trap - EXIT INT TERM
    exit 0
fi
if [ "$phase" = committed ]; then
    # Committed data is activated by deploy.sh before any settings are read; the transaction is never reopened here.
    data_preparation_docker(){ [ "$1" = committed ]; }
    if begin_deployment; then echo REOPENED; fi
    exit 0
fi
rollback_current_data(){ printf yes > restored-data; }
begin_deployment
test "$DEPLOY_SNAPSHOT" = "$(cat original-snapshot)"
test "$PREVIOUS_RUNNING" = 1
test "$PREVIOUS_IMAGE" = old-image
exit 42
`);
  try {
    for (const dir of ["data/config", "data/state", "mock", "logs"]) await mkdir(join(fixture.root, dir), { recursive: true });
    await writeFile(join(fixture.root, "data/config/models.json"), "original");
    await writeFile(join(fixture.root, "mock/mixin-chatbot"), "old-image true\n");
    const operationLog = join(fixture.root, "operation.log");
    const run = (phase: string) => execute([bash!, posixPath(script), posixPath(fixture.root), phase], fixture.root,
      { ...process.env, MSYS_NO_PATHCONV: "1", BOT_OPERATION_LOG_PATH: phase === "resume" ? posixPath(operationLog) : "" });
    const first = await run("initial"); expect(first.code, first.output).toBe(0);
    const refused = await run("committed");
    expect(refused.code, refused.output).toBe(0); expect(refused.output).toContain("已经提交"); expect(refused.output).not.toContain("REOPENED");
    expect(await readFile(join(fixture.root, "mock/mixin-chatbot"), "utf8")).toBe("new-image true\n");
    await writeFile(operationLog, "");
    const second = await run("resume"); expect(second.code, second.output).toBe(42);
    expect(await readFile(join(fixture.root, "mock/mixin-chatbot"), "utf8")).toBe("old-image true\n");
    expect(existsSync(join(fixture.root, "data/state/deploy-transaction"))).toBe(false);
    // The original service was stopped by the interrupted process; stopping the new instance does not start the window again.
    let text = await readFile(operationLog, "utf8");
    expect(text).toContain("resuming snapshot"); expect(text).not.toContain("downtime begins");
    expect(text).toContain("service back (previous version restarted); the stop happened in an earlier process");
    // Interrupted after the pointer was published but before the stop: the resumed process stops the original service,
    // and the downtime runs from there until the old container is back.
    await run("initial");
    await rm(join(fixture.root, "mock/mixin-chatbot")); await rm(join(fixture.root, "restored-data"));
    await rename(join(fixture.root, "mock/mixin-chatbot-rollback"), join(fixture.root, "mock/mixin-chatbot"));
    await writeFile(join(fixture.root, "mock/mixin-chatbot"), "old-image true\n"); await writeFile(operationLog, "");
    const third = await run("resume"); expect(third.code, third.output).toBe(42);
    expect(await readFile(join(fixture.root, "mock/mixin-chatbot"), "utf8")).toBe("old-image true\n");
    text = await readFile(operationLog, "utf8");
    expect(text).toContain("resuming snapshot");
    expect(text.indexOf("service stopped; downtime begins")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("service stopped; downtime begins")).toBeLessThan(text.search(/service back \(previous version restarted\); downtime \d+s/));
  } finally { await fixture.cleanup(); }
}, 30000);
