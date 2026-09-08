import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
print_error(){ echo "$*" >&2; }; print_warning(){ echo "$*"; }
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
            if [ "\${2:-}" = '{{.Image}}' ]; then printf '%s' "$image"; elif [ "\${2:-}" = '{{.State.Running}}' ]; then printf '%s' "$running"; fi ;;
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
begin_deployment
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
    for (const running of [true, false]) for (const stage of ["configuration", "image", "container", "health", "tunnel", "firewall", "state"]) {
      const root = join(fixture.root, `${stage}-${running}`);
      await Promise.all(["data/config", "data/state", "mock/containers", "logs"].map(dir => mkdir(join(root, dir), { recursive: true })));
      await writeFile(join(root, "data/config/models.json"), "old-config");
      await writeFile(join(root, "data/state/bot-port"), "1011");
      await writeFile(join(root, "mock/containers/mixin-chatbot"), `old-image ${running}\n`);
      await writeFile(join(root, "mock/ufw"), "ufw allow 22/tcp\nufw allow proto tcp from 192.0.2.1 to any port 1011 comment 'Mixin-Chatbot (平台IP)'\n");
      const result = await execute([bash!, posixPath(script), posixPath(root), stage], root, { ...process.env, MSYS_NO_PATHCONV: "1" });
      expect(result.code, `${stage}: ${result.output}`).toBe(42);
      expect(await readFile(join(root, "data/config/models.json"), "utf8")).toBe("old-config");
      expect(await readFile(join(root, "data/state/bot-port"), "utf8")).toBe("1011");
      expect(await readFile(join(root, "mock/containers/mixin-chatbot"), "utf8")).toBe(`old-image ${running}\n`);
      expect(await readFile(join(root, "mock/image"), "utf8")).toBe("old-image");
      const rules = await readFile(join(root, "mock/ufw"), "utf8");
      expect(rules).toContain("ufw allow 22/tcp"); expect(rules).toContain("192.0.2.1"); expect(rules).not.toContain("192.0.2.2");
    }
  } finally { await fixture.cleanup(); }
}, 60000);
