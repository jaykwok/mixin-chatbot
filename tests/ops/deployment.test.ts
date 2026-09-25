import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const quotePS = (text: string) => "'" + text.replaceAll("'", "''") + "'";
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
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

async function execute(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", windowsHide: true });
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

test.skipIf(process.platform !== "win32")("Windows deployment rollback restores files, dependencies, task and connector across failure stages", async () => {
  const fixture = await tempFixture("deployment-windows-");
  const script = join(fixture.root, "rollback.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
. ${quotePS(join(project, "scripts/lib/lifecycle.ps1"))}
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
# Every host control API is replaced; only the fixture filesystem is real.
function Get-ProjectBotPids { @() }
function Stop-ProjectBot { $script:task.State='Ready'; return $true }
function Get-ScheduledTask { $script:task }
function Export-ScheduledTask { '<Task original="true" />' }
function Register-ScheduledTask { param($TaskName,$Xml,[switch]$Force,$ErrorAction); if($Xml -ne '<Task original="true" />'){throw 'wrong task XML'}; $script:task.State='Ready' }
function Unregister-ScheduledTask { throw 'unexpected unregister' }
function Start-ScheduledTask { $script:task.State='Running' }
function Get-CimInstance { $script:tunnel }
function Get-Service { if($script:serviceExists){[pscustomobject]@{Status=$script:serviceStatus}} }
function Stop-Service { $script:serviceStatus='Stopped' }
function Start-Service { $script:serviceStatus='Running' }
function Set-Service { param($Name,$StartupType,$ErrorAction); $script:startMode=$StartupType }
function New-Service { param($Name,$BinaryPathName,$StartupType,$ErrorAction); $script:serviceExists=$true; $script:serviceCommand=$BinaryPathName; $script:startMode=$StartupType }
function Set-ItemProperty { param($LiteralPath,$Name,$Value); $script:serviceCommand=$Value }
function Get-NetFirewallRule { param($Group,$Name,$ErrorAction); if($Name){$script:rules | Where-Object Name -eq $Name}else{$script:rules} }
function Get-NetFirewallPortFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$Rule); process{[pscustomobject]@{Protocol='TCP';LocalPort='1011';RemotePort='Any'}} }
function Get-NetFirewallAddressFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$Rule); process{[pscustomobject]@{LocalAddress='Any';RemoteAddress='192.0.2.1'}} }
function Remove-NetFirewallRule { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$Rule); process{$script:rules=@($script:rules | Where-Object Name -ne $Rule.Name)} }
function New-NetFirewallRule { param($Name,$DisplayName,$Group,$Direction,$Action,$Enabled,$Profile,$Protocol,$LocalPort,$RemotePort,$LocalAddress,$RemoteAddress,$ErrorAction); $script:rules+=@{Name=$Name} }
function Move-Item { [CmdletBinding()]param($LiteralPath,$Destination,[switch]$Force); if($script:failBackup -and $LiteralPath -like '*\\node_modules'){throw 'injected backup failure'}; Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters }
$stages=@('backup','dependencies','configuration','task','health','tunnel','firewall','state')
foreach($running in @($true,$false)) { foreach($stage in $stages) {
    $root=Join-Path ${quotePS(fixture.root)} ($stage+'-'+$running)
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'data/config'),(Join-Path $root 'data/state'),(Join-Path $root 'node_modules') | Out-Null
    $env:ProgramData=Join-Path $root 'programdata'
    New-Item -ItemType Directory -Force -Path (Join-Path $env:ProgramData 'cloudflared') | Out-Null
    Set-Content (Join-Path $root 'data/config/models.json') 'old-config'
    Set-Content (Join-Path $root 'data/config/cloudflared-token') 'old-project-token'
    Set-Content (Join-Path $root 'data/state/cloudflared-managed') 'Cloudflared'
    Set-Content (Join-Path $root 'data/state/bot-port') '1011'
    Set-Content (Join-Path $root 'node_modules/version') 'old-dependencies'
    Set-Content (Join-Path $env:ProgramData 'cloudflared/token') 'fake-original-token'
    $script:task=[pscustomobject]@{State=$(if($running){'Running'}else{'Ready'})}
    $script:tunnel=[pscustomobject]@{PathName='old-connector-command';StartMode='Auto';Started=$running}
    $script:serviceExists=$true; $script:serviceStatus=$(if($running){'Running'}else{'Stopped'})
    $script:rules=@([pscustomobject]@{Name='old-rule';DisplayName='old';Group='mixin-chatbot';Direction='Inbound';Action='Allow';Enabled='True';Profile='Any'})
    $snapshot=New-DeploymentSnapshot $root 'test-task'
    try {
        $script:failBackup=$stage -eq 'backup'
        try {
            Save-DeploymentDependencies $snapshot
            New-Item -ItemType Directory -Force -Path (Join-Path $root 'node_modules') | Out-Null
            Set-Content (Join-Path $root 'node_modules/version') 'new-dependencies'
            if($stage -eq 'dependencies'){throw 'install failure'}
            Set-Content (Join-Path $root 'data/config/models.json') 'new-config'
            if($stage -eq 'configuration'){throw 'config failure'}
            $script:task.State='Running'
            if($stage -in @('task','health')){throw 'task/health failure'}
            $script:serviceExists=$false
            Set-Content (Join-Path $env:ProgramData 'cloudflared/token') 'new-token'
            Set-Content (Join-Path $root 'data/config/cloudflared-token') 'new-project-token'
            if($stage -eq 'tunnel'){throw 'tunnel failure'}
            $script:rules=@([pscustomobject]@{Name='new-rule'})
            if($stage -eq 'firewall'){throw 'firewall failure'}
            Set-Content (Join-Path $root 'data/state/bot-port') '2022'
            throw 'state failure'
        } catch { $script:failBackup=$false; Restore-DeploymentSnapshot $snapshot }
        if((Get-Content (Join-Path $root 'node_modules/version')).Trim() -ne 'old-dependencies'){throw 'dependencies not restored'}
        if((Get-Content (Join-Path $root 'data/config/models.json')).Trim() -ne 'old-config'){throw 'config not restored'}
        if((Get-Content (Join-Path $root 'data/state/bot-port')).Trim() -ne '1011'){throw 'state not restored'}
        if((Get-Content (Join-Path $env:ProgramData 'cloudflared/token')).Trim() -ne 'fake-original-token'){throw 'connector token not restored'}
        if((Get-Content (Join-Path $root 'data/config/cloudflared-token')).Trim() -ne 'old-project-token'){throw 'project connector token not restored'}
        if($script:task.State -ne $(if($running){'Running'}else{'Ready'})){throw 'task run state not preserved'}
        if($script:serviceStatus -ne $(if($running){'Running'}else{'Stopped'})){throw 'connector run state not preserved'}
        if($script:rules.Count -ne 1 -or $script:rules[0].Name -ne 'old-rule'){throw 'firewall not restored'}
        Write-Output ('VERIFIED '+$stage+' '+$running)
    } finally { $snapshot.Lock.Dispose() }
} }
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output.match(/VERIFIED /g)).toHaveLength(16);
  } finally { await fixture.cleanup(); }
}, 60000);

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
$BunPath='fixture-bun'; $GitPath='fixture-git'
$Project=$PSScriptRoot; $OriginalSha='1111111111111111111111111111111111111111'; $TargetSha='2222222222222222222222222222222222222222'; $OriginalBranch='main'
New-Item -ItemType Directory -Force -Path (Join-Path $Project 'data/state'),(Join-Path $Project 'data/groups') | Out-Null
function Get-BunPath { 'fixture-bun' }; function Get-GitPath { 'fixture-git' }
function fixture-git {
    $global:LASTEXITCODE=0
    if(($args -contains 'checkout' -or $args -contains 'merge') -and -not $script:stopped){throw 'live checkout changed before stop'}
    if($args -contains 'rev-parse'){ if($script:failure -eq 'code'){'3333333333333333333333333333333333333333'}else{$TargetSha} }
    if($args -contains 'reset') { if($script:applied -and -not $script:dataRestored){throw 'code restored before data'}; $script:codeRestored=$true }
}
function fixture-bun {
    $global:LASTEXITCODE=0
    if($args -contains 'preview') { if($script:stopped){throw 'preview after stop'}; if($script:failure -eq 'preview'){ $global:LASTEXITCODE=2 } }
    elseif($args -contains 'install') { if(-not $script:stopped){throw 'dependencies changed before stop'}; $script:installs++; if($script:failure -eq 'install'){$global:LASTEXITCODE=1} }
    elseif($args -contains 'apply') { $script:applied=$true; if($script:failure -eq 'apply'){$global:LASTEXITCODE=1} }
    elseif($args -contains 'committed') { $global:LASTEXITCODE=1 }
    elseif($args -contains 'commit') { if($script:failure -eq 'commit'){$global:LASTEXITCODE=1}else{$script:committed=$true} }
    elseif($args -contains 'rollback') { if($script:committed){$global:LASTEXITCODE=42}else{$script:dataRestored=$true} }
    else {
        $verifying=Test-Path -LiteralPath (Join-Path $Project 'data/state/verify-only')
        if($verifying -ne ($args -contains '--allow-verification')){throw 'wrong verification health policy'}
        if($script:failure -eq 'health'){throw 'health failure'}
    }
}
function New-DeploymentSnapshot { [pscustomobject]@{WasRunning=$script:running;TaskXml='<Task/>';Path=$Project;Lock=(New-Object IO.MemoryStream);PreviousBackupId='previous'} }
function Open-UpgradeSnapshot($root,$task,$original,$branch,$target) {
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
foreach($script:reuse in @($true,$false)) { foreach($script:running in @($true,$false)) { foreach($script:failure in @('none','preview','code','install','apply','health','commit','postcommit')) {
    if(($script:failure -eq 'install' -and $script:reuse) -or ($script:failure -eq 'postcommit' -and -not $script:running)){continue}
    $script:stopped=$false; $script:applied=$false; $script:committed=$false; $script:dataRestored=$false; $script:codeRestored=$false
    $script:backups=0; $script:installs=0; $script:starts=0; $script:verifications=0; $script:restores=0
    $ok=$true
    try { & $run } catch { $ok=$false; Write-Host $_.Exception.Message }
    if($ok -ne ($script:failure -eq 'none')){throw ('wrong result: '+$script:failure)}
    if($script:failure -eq 'code' -and ($script:installs -or $script:applied)){throw 'wrong release mutated data or dependencies'}
    if($script:failure -eq 'preview') { if($script:stopped){throw 'stopped after failed preview'} }
    elseif($script:failure -in @('none','postcommit')) {
        if($script:restores -ne 0 -or -not $script:committed -or $script:starts -ne [int]$script:running){throw 'wrong committed state'}
        if($script:backups -ne [int](-not $script:reuse) -or $script:installs -ne $script:backups){throw 'dependency reuse failed'}
    } elseif($script:restores -ne 1) { throw 'rollback missing' }
    Write-Output 'VERIFIED'
} } }
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
    expect(result.output.match(/VERIFIED/g)).toHaveLength(28);
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(process.platform !== "win32")("Windows upgrade replaces the existing snapshot with durable upgrade metadata", async () => {
  const fixture = await tempFixture("upgrade-snapshot-replace-");
  const script = join(fixture.root, "replace.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
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
    if(Test-Path -LiteralPath (Join-Path $snapshot.Path 'deployment.xml.tmp')){throw 'temporary snapshot remains'}
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

test.skipIf(process.platform !== "win32")("Windows upgrade snapshot survives restart and retains its original code and running state", async () => {
  const fixture = await tempFixture("upgrade-resume-");
  const script = join(fixture.root, "resume.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
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

test.skipIf(process.platform !== "win32")("Windows target upgrade really boots in a fresh process and rejects preflight before service control", async () => {
  const fixture = await tempFixture("upgrade-bootstrap-");
  try {
    await mkdir(join(fixture.root, "data/groups"), { recursive: true });
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(project, "scripts/deploy/upgrade.ps1"), "-Project", fixture.root,
      "-OriginalSha", "1".repeat(40), "-TargetSha", "2".repeat(40),
      "-BunPath", process.execPath, "-GitPath", Bun.which("git")!], fixture.root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("迁移预览未完成");
    expect(existsSync(join(fixture.root, "data/state/upgrade-transaction"))).toBe(false);
    const logs = await readdir(join(fixture.root, "logs/operations")); expect(logs).toHaveLength(1);
    const text = await readFile(join(fixture.root, "logs/operations", logs[0]!), "utf8");
    expect(text).toContain("migration-preview"); expect(text).toContain("迁移预览未完成");
    expect(text).toContain("upgrade.ps1"); expect(text).toContain("exit=1");
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(process.platform !== "win32")("Windows upgrade removes only its own export on success, export failure and child failure", async () => {
  const fixture = await tempFixture("upgrade-export-cleanup-");
  const script = join(fixture.root, "cleanup.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
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

test.skipIf(process.platform !== "win32")("Windows successful backup cleanup empties all recycled files and preserves other tmp snapshots", async () => {
  const fixture = await tempFixture("backup-cleanup-windows-");
  const script = join(fixture.root, "cleanup.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/lifecycle.ps1"))}
$root=Join-Path $PSScriptRoot 'project'
$snapshot=Join-Path $root 'backup/snapshots/deploy-current'
$failed=Join-Path $root 'backup/snapshots/deploy-failed'
New-Item -ItemType Directory -Force -Path $snapshot,$failed,(Join-Path $root 'data/state') | Out-Null
Set-Content (Join-Path $snapshot 'old-config') 'old'
Set-Content (Join-Path $failed 'recovery') 'preserve'
$env:BOT_DEPLOY_BACKUP_ID='deploy-current'
Set-Content (Join-Path $root 'old-file') 'old'
Move-ToProjectArchive (Join-Path $root 'old-file') $root
if(-not (Test-Path (Join-Path $root 'backup/rm/deploy-current'))){throw 'wrong archive directory'}
New-Item -ItemType Directory -Force -Path (Join-Path $root 'backup/rm/deploy-previous') | Out-Null
Set-Content (Join-Path $root 'backup/rm/deploy-previous/old-config') 'historical'
Set-Content (Join-Path $root 'backup/rm/loose-file') 'unscoped'
Set-Content (Join-Path $root 'backup/rm/.hidden-file') 'hidden'
$lock=[IO.File]::Open((Join-Path $root 'data/state/deploy.lock'),'OpenOrCreate','ReadWrite','None')
try {
    Remove-CompletedBackup $snapshot $root
    if((Test-Path $snapshot) -or (Test-Path (Join-Path $root 'backup/rm'))){throw 'completed backup or recycled files retained'}
    if((Get-Content (Join-Path $failed 'recovery')) -ne 'preserve'){throw 'unrelated backup lost'}
    $rejected=$false
    try { Remove-CompletedBackup (Join-Path $root 'data') $root } catch { $rejected=$true }
    if(-not $rejected){throw 'out-of-scope cleanup accepted'}
    Move-Item -LiteralPath $failed -Destination (Join-Path $PSScriptRoot 'saved-failure')
    Remove-CompletedBackup $snapshot $root
    if(Test-Path (Join-Path $root 'backup')){throw 'empty backup directory retained'}
    if(-not (Test-Path (Join-Path $root 'data/state/deploy.lock'))){throw 'active lock removed'}
} finally { $lock.Dispose() }
`);
  try {
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0);
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(!bash || !existsSync(bash))("Linux successful backup cleanup empties all recycled files and preserves other tmp snapshots", async () => {
  const fixture = await tempFixture("backup-cleanup-linux-");
  const script = join(fixture.root, "cleanup.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(realpath "$1")"
. '${posixPath(join(project, "scripts/lib/lifecycle.sh"))}'
snapshot="$PROJECT_DIR/backup/snapshots/deploy-current"
failed="$PROJECT_DIR/backup/snapshots/deploy-failed"
mkdir -p "$snapshot" "$failed"
printf old > "$snapshot/old-config"
printf preserve > "$failed/recovery"
export BOT_DEPLOY_BACKUP_ID=deploy-current
printf old > "$PROJECT_DIR/old-file"
archive_project_path "$PROJECT_DIR/old-file"
[ -d "$PROJECT_DIR/backup/rm/deploy-current" ]
mkdir -p "$PROJECT_DIR/backup/rm/deploy-previous"
printf historical > "$PROJECT_DIR/backup/rm/deploy-previous/old-config"
printf unscoped > "$PROJECT_DIR/backup/rm/loose-file"
printf hidden > "$PROJECT_DIR/backup/rm/.hidden-file"
cleanup_completed_backup "$snapshot"
[ ! -e "$snapshot" ] && [ ! -e "$PROJECT_DIR/backup/rm" ]
[ "$(cat "$failed/recovery")" = preserve ]
if cleanup_completed_backup "$PROJECT_DIR/backup"; then exit 41; fi
mv -- "$failed" "$PROJECT_DIR/saved-failure"
cleanup_completed_backup "$snapshot" keep-root
[ -d "$PROJECT_DIR/backup" ] && [ -z "$(ls -A "$PROJECT_DIR/backup")" ]
cleanup_completed_backup "$snapshot"
[ ! -e "$PROJECT_DIR/backup" ]
`);
  try {
    const result = await execute([bash!, posixPath(script), posixPath(fixture.root)], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    expect(result.code, result.output).toBe(0);
  } finally { await fixture.cleanup(); }
}, 60000);

test.skipIf(!bash || !existsSync(bash))("Docker deployment refuses missing persisted group roots before recreating directories", async () => {
  const fixture = await tempFixture("deployment-group-root-");
  const script = join(fixture.root, "preflight.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$1"; cd "$PROJECT_DIR"
. '${posixPath(join(project, "scripts/lib/deployment.sh"))}'
print_error(){ echo "$*" >&2; }
verify_deployed_group_root
mkdir -p data/state
printf 'data/groups' > data/state/group-data-root
if verify_deployed_group_root; then exit 1; fi
test ! -e data/groups
mkdir -p data/groups
verify_deployed_group_root
printf '%s' "$PROJECT_DIR/external groups" > data/state/group-data-root
if verify_deployed_group_root; then exit 1; fi
mkdir -p 'external groups'
verify_deployed_group_root
`);
  try {
    const result = await execute([bash!, posixPath(script), posixPath(fixture.root)], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    expect(result.code, result.output).toBe(0);
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!bash || !existsSync(bash))("Docker deployment explicitly accepts verification health without trusting the normal HEALTHCHECK", async () => {
  const fixture = await tempFixture("deployment-verification-health-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
  const wait = source.split("# ---- 等待健康检查 ----")[1]?.split("# ---- Cloudflare 模式：")[0];
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
    elif [ "$1" = inspect ]; then
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

test.skipIf(!bash || !existsSync(bash))("Docker migration passes the service identity, mounted group root and native cache environment", async () => {
  const fixture = await tempFixture("deployment-migration-env-");
  const source = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
  const migration = source.match(/^migration_docker\(\) \{[\s\S]*?^\}/m)?.[0];
  expect(migration).toBeDefined();
  const script = join(fixture.root, "environment.sh");
  await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$1"
CONTAINER_UID=1001; CONTAINER_GID=1002; GROUP_ROOT_ENV_VAL=/app/group-data
GROUP_ROOT_ARGS=(-v "$PROJECT_DIR/external groups:/app/group-data")
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
migration_docker preview --decisions-only
`);
  try {
    const result = await execute([bash!, posixPath(script), posixPath(fixture.root)], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("PI_CACHE_RETENTION=long");
    expect(result.output).toContain("BOT_DEPLOY_BACKUP_ID=deploy-fixture");
    expect(result.output).toContain("BOT_OPERATION_LOG=upgrade-20260925T000000Z-fixture.log");
    expect(result.output).toContain("logs:/app/logs");
    expect(result.output).toContain("1001:1002");
    expect(result.output).toContain("external groups:/app/group-data");
    expect(result.output).toContain("GROUP_DATA_ROOT=/app/group-data");
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
LOG_DIR="$PROJECT_DIR/logs"; TUNNEL_PID_FILE="$PROJECT_DIR/data/state/cloudflared.pid"
operation_start deploy
print_error(){ echo "$*" >&2; operation_event error "$*"; }; print_warning(){ echo "$*"; operation_event warn "$*"; }
flock(){ :; }; can_manage_ufw(){ return 0; }
managed_cloudflared_pid(){ return 1; }; stop_tunnel_launcher(){ :; }
ufw(){ :; }
run_ufw(){
    if [ "$1" = show ]; then cat mock/ufw; else printf 'ufw allow from %s to any port %s proto tcp comment Mixin-Chatbot (平台IP)\n' "$3" "$7" >> mock/ufw; fi
}
remove_managed_ufw_rules(){ printf 'ufw allow 22/tcp\n' > mock/ufw; }
docker(){
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
            read -r image running < "mock/containers/$name"
            [ "$cmd" != stop ] || running=false
            [ "$cmd" != start ] || running=true
            printf '%s %s\n' "$image" "$running" > "mock/containers/$name" ;;
        rename) mv -- "mock/containers/$1" "mock/containers/$2" ;;
        tag) printf '%s' "$1" > mock/image ;;
        *) echo "unexpected Docker operation" >&2; return 1 ;;
    esac
}
if [ "$2" = pre-stopped ]; then
    DEPLOY_PREVIOUS_RUNNING=0
    if [ "$(docker inspect --format '{{.State.Running}}' mixin-chatbot)" = true ]; then DEPLOY_PREVIOUS_RUNNING=1; fi
    DEPLOY_ORIGINAL_CONTAINER="$(docker inspect --format '{{.Id}}' mixin-chatbot)"
    export DEPLOY_PREVIOUS_RUNNING DEPLOY_ORIGINAL_CONTAINER
    docker stop mixin-chatbot
fi
begin_deployment
if [ "$2" = pre-stopped ]; then test "$(cat "$DEPLOY_SNAPSHOT/was-running")" = "$DEPLOY_PREVIOUS_RUNNING"; fi
printf 'new-config' > data/config/models.json
[ "$2" != configuration ] || exit 42
printf 'new-image' > mock/image
[ "$2" != image ] || exit 42
NEW_CONTAINER_ATTEMPTED=1
printf 'new-image true\n' > mock/containers/mixin-chatbot
[ "$2" != container ] && [ "$2" != health ] || exit 42
TUNNEL_STARTED_BY_DEPLOY=1
[ "$2" != tunnel ] || exit 42
printf 'ufw allow 22/tcp\nufw allow from 192.0.2.2 to any port 2022 proto tcp comment Mixin-Chatbot (平台IP)\n' > mock/ufw
[ "$2" != firewall ] || exit 42
printf '2022' > data/state/bot-port
exit 42
`);
  try {
    for (const running of [true, false]) for (const stage of ["configuration", "image", "container", "health", "tunnel", "firewall", "state", "pre-stopped"]) {
      const root = join(fixture.root, `${stage}-${running}`);
      await Promise.all(["data/config", "data/state", "mock/containers", "logs"].map(dir => mkdir(join(root, dir), { recursive: true })));
      await writeFile(join(root, "data/config/models.json"), "old-config");
      await writeFile(join(root, "data/state/bot-port"), "1011");
      await writeFile(join(root, "mock/containers/mixin-chatbot"), `old-image ${running}\n`);
      await writeFile(join(root, "mock/ufw"), "ufw allow 22/tcp\nufw allow proto tcp from 192.0.2.1 to any port 1011 comment 'Mixin-Chatbot (平台IP)'\n");
      const result = await execute([bash!, posixPath(script), posixPath(root), stage], root, { ...process.env, MSYS_NO_PATHCONV: "1" });
      expect(result.code, `${stage}: ${result.output}`).toBe(42);
      const logs = await readdir(join(root, "logs/operations")); expect(logs).toHaveLength(1);
      const text = await readFile(join(root, "logs/operations", logs[0]!), "utf8");
      expect(text).toContain("rollback"); expect(text).toContain("已恢复配置"); expect(text).toContain("operation finished; exit=42");
      expect(await readFile(join(root, "data/config/models.json"), "utf8")).toBe("old-config");
      expect(await readFile(join(root, "data/state/bot-port"), "utf8")).toBe("1011");
      expect(await readFile(join(root, "mock/containers/mixin-chatbot"), "utf8")).toBe(`old-image ${running}\n`);
      expect(await readFile(join(root, "mock/image"), "utf8")).toBe("old-image");
      const rules = await readFile(join(root, "mock/ufw"), "utf8");
      expect(rules).toContain("ufw allow 22/tcp"); expect(rules).toContain("192.0.2.1"); expect(rules).not.toContain("192.0.2.2");
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
LOG_DIR="$PROJECT_DIR/logs"; TUNNEL_PID_FILE="$PROJECT_DIR/data/state/cloudflared.pid"
print_error(){ echo "$*" >&2; }; print_warning(){ echo "$*"; }
flock(){ :; }; can_manage_ufw(){ return 1; }
managed_cloudflared_pid(){ return 1; }; stop_tunnel_launcher(){ :; }
docker(){
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
rollback_data_migration(){ printf yes > restored-data; }
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
    const run = (phase: string) => execute([bash!, posixPath(script), posixPath(fixture.root), phase], fixture.root, { ...process.env, MSYS_NO_PATHCONV: "1" });
    const first = await run("initial"); expect(first.code, first.output).toBe(0);
    const second = await run("resume"); expect(second.code, second.output).toBe(42);
    expect(await readFile(join(fixture.root, "mock/mixin-chatbot"), "utf8")).toBe("old-image true\n");
    expect(existsSync(join(fixture.root, "data/state/deploy-transaction"))).toBe(false);
  } finally { await fixture.cleanup(); }
}, 30000);
