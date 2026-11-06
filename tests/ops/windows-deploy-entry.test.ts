// The unmodified deploy.ps1 runs through powershell.exe -File from an exported release whose lib\common.ps1 is a recording
// stub library: real argument binding, $PSScriptRoot, the port probe, the stage directory and exit codes. Tool discovery,
// wizards and questions are stubs; the core is the recording Invoke-ConsoleProcess. Stop, configuration, task registration,
// verification and rollback run in core-windows-deploy.test.ts.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, utimesSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";

const source = resolve(import.meta.dir, "../.."), quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const head = "c".repeat(40);
const library = "\ufeff" + `. ${quote(join(source, "scripts/lib/operation-log.ps1"))}
function Add-FixtureEvent([string]$Text) {
    $line = ($Text.Replace($env:FIXTURE_RELEASE, '<release>').Replace($env:FIXTURE_PROJECT, '<project>') -replace 'deploy-stage-[0-9a-f]{8}', 'deploy-stage-<id>')
    [IO.File]::AppendAllText($env:FIXTURE_EVENTS, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
function Stop-ProjectBot { throw 'deploy entry stopped the bot' }
function Register-ScheduledTask { throw 'deploy entry changed the scheduler' }
function Start-ScheduledTask { throw 'deploy entry started the bot' }
function Get-OpsCommandHint([string]$Command) { "ops $Command" }
function Test-Administrator { $env:FIXTURE_MODE -cne 'not-admin' }
function Find-DeployTools {
    [pscustomobject]@{ Git = 'fixture-git'; Bash = 'C:\\fixture\\Git\\bin\\bash.exe'; Bun = 'fixture-bun'; BunVersion = '1.4.4'; Uv = 'C:\\fixture\\uv\\uv.exe' }
}
function Assert-ConsoleLifecycle([string]$Operation, [string]$ProjectRoot) { Add-FixtureEvent ('lifecycle ' + $Operation) }
function Get-SavedWorkspaceRoot([string]$ProjectRoot) { $env:FIXTURE_WORKSPACE }
function Protect-ProjectSecretPath([string]$Path) { Add-FixtureEvent ('protect ' + $Path) }
function Read-YesNo([string]$Prompt, [bool]$Default) { Add-FixtureEvent 'reconfigure?'; $env:FIXTURE_MODE -ceq 'reconfigure' }
function Invoke-StagedWizard([string]$Bun, [string]$ProjectRoot, [string]$Stage, [string]$Label, [string]$Wizard, [string]$Staged) {
    Add-FixtureEvent ('wizard ' + $Wizard)
    if ($env:FIXTURE_MODE -ceq 'wizard-cancel') { throw '配置未完成（取消或失败，原因见上方）；服务尚未停止，未做任何改动' }
    [IO.File]::WriteAllText((Join-Path $Stage $Staged), '{}')
    # Without app credentials, configure.ts asks for them first.
    if ($Wizard -ceq 'configure.ts' -and -not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'data\\config\\app-bot.json'))) { [IO.File]::WriteAllText((Join-Path $Stage 'configuration-app.json'), '{}') }
}
function Select-DirectoryScope([string]$Bun, [string]$Tool, [string]$Root, [string]$Plan, [string]$App = '') {
    if ($Tool -ne (Join-Path $env:FIXTURE_PROJECT 'ops\\config\\directory-scope.ts')) { throw ('scope not chosen with the deployed code: ' + $Tool) }
    Add-FixtureEvent ('scope? app=' + $App)
    [IO.File]::WriteAllText($Plan, '{"format":1,"all":true}')
}
function fixture-bun {
    $global:LASTEXITCODE = 0
    if ($args[0] -cne '--no-env-file' -or $args[1] -cne 'run' -or $args[2] -ne (Join-Path $env:FIXTURE_PROJECT 'ops\\tools\\data-current.ts')) { throw ('unexpected Bun call: ' + ($args -join ' ')) }
    $index = [Array]::IndexOf($args, '--plan')
    if ($index -ge 0) { [IO.File]::WriteAllText($args[$index + 1], '{}') }
    Add-FixtureEvent ('data ' + (@($args | Select-Object -Skip 3) -join ' '))
    if ($env:FIXTURE_MODE -ceq 'preview') { $global:LASTEXITCODE = 2 }
}
function fixture-git {
    if (($args -join ' ') -cne ('-C ' + $env:FIXTURE_PROJECT + ' rev-parse --verify --quiet HEAD^{commit}')) { throw ('unexpected Git call: ' + ($args -join ' ')) }
    if ($env:FIXTURE_HEAD) { $global:LASTEXITCODE = 0; $env:FIXTURE_HEAD } else { $global:LASTEXITCODE = 128 }
}
function Invoke-ConsoleProcess([string]$FilePath, [string[]]$Arguments, [switch]$Screen, [hashtable]$Environment = @{}) {
    if ($FilePath -cne 'fixture-bun') { throw ('unexpected process: ' + $FilePath) }
    # The entry's own environment stays as the task saw it: the console rechecks it under the lock.
    $own = 'own=' + $env:BOT_PORT + '|' + $env:WORKSPACE_ROOT + '|' + $env:BOT_HOST
    if ($Arguments[0] -ceq 'install') { Add-FixtureEvent ('install ' + ($Arguments -join ' ')); return 0 }
    if ($Arguments[2] -eq (Join-Path $env:FIXTURE_PROJECT 'ops\\config\\runtime-settings.ts')) {
        $file = $Arguments[[Array]::IndexOf($Arguments, '--prepare-values') + 1]
        [IO.File]::WriteAllText($file, '{"format":1}')
        Add-FixtureEvent ('runtime ' + (@($Arguments | Select-Object -Skip 3) -join ' ') + ' child=' + ((@($Environment.Keys) | Sort-Object | ForEach-Object { $_ + '=' + $Environment[$_] }) -join ',') + ' ' + $own)
        return 0
    }
    if ($Arguments[0] -cne '--no-env-file' -or $Arguments[1] -ne (Join-Path $env:FIXTURE_RELEASE 'ops\\core\\cli.ts')) { throw 'core not run from the release' }
    Add-FixtureEvent ('core ' + (@($Arguments | Select-Object -Skip 2) -join ' ') + ' ' + $own)
    if ($Arguments -contains '--preflight') { return [int]($env:FIXTURE_MODE -ceq 'preflight') }
    # The stage as the core reads it; the entry removes it afterwards.
    Copy-Item -LiteralPath $Arguments[[Array]::IndexOf($Arguments, '--stage') + 1] -Destination $env:FIXTURE_STAGE -Recurse
    if ($env:FIXTURE_MODE -ceq 'core-failed') { [IO.File]::WriteAllText((Join-Path $env:FIXTURE_PROJECT 'data\\state\\deploy-transaction'), 'deploy-fixture'); return 1 }
    return 0
}
`.replace(/\r?\n/g, "\r\n");

const free = () => new Promise<number>((done, fail) => {
  const server = createServer(); server.once("error", fail);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => done(port)); });
});
type Mode = "first" | "redeploy" | "reconfigure" | "console" | "pending" | "preflight" | "preview" | "workspace-missing" | "port-in-use" | "wizard-cancel"
  | "core-failed" | "not-admin";
const MODES: Mode[] = ["first", "redeploy", "reconfigure", "console", "pending", "preflight", "preview", "workspace-missing", "port-in-use", "wizard-cancel", "core-failed",
  "not-admin"];

for (const mode of MODES) test.skipIf(process.platform !== "win32")(`Windows deploy entry: ${mode}`, async () => {
  const f = await tempFixture("deploy-entry-");
  const listener = mode === "port-in-use" ? createServer() : null;
  try {
    const release = join(f.root, "release"), project = join(f.root, "中文 project"), events = join(f.root, "events.txt"), staged = join(f.root, "staged");
    const shared = join(f.root, "shared"), first = ["first", "wizard-cancel", "port-in-use"].includes(mode);
    await mkdir(join(release, "scripts"), { recursive: true }); await mkdir(join(release, "scripts/lib"));
    await writeFile(join(release, "scripts/deploy.ps1"), await readFile(join(source, "scripts/deploy.ps1")));
    await writeFile(join(release, "scripts/lib/common.ps1"), library);
    for (const file of ["package.json", "src/server/index.ts", "ops/config/configure.ts"]) {
      await mkdir(join(project, file, ".."), { recursive: true }); await writeFile(join(project, file), "");
    }
    await mkdir(join(project, "data/state"), { recursive: true }); await mkdir(shared);
    if (!first) {
      // A redeployment: complete configuration, saved port and scope, installed dependencies.
      await mkdir(join(project, "data/config")); await mkdir(join(project, "data/runtime/pi"), { recursive: true }); await mkdir(join(project, "node_modules"));
      for (const file of ["data/config/app-bot.json", "data/config/models.json", "data/runtime/pi/settings.json", "data/config/directory.json"]) await writeFile(join(project, file), "{}");
      await writeFile(join(project, "data/state/bot-port"), "1011");
    }
    if (mode === "pending") await writeFile(join(project, "data/state/deploy-transaction"), "deploy-fixture\n");
    // An abandoned stage from a killed deployment two days ago goes; a recent one may belong to another deployment and stays.
    await mkdir(join(project, "tmp/deploy-stage-0badf00d"), { recursive: true }); await mkdir(join(project, "tmp/deploy-stage-12345678"));
    const old = new Date(Date.now() - 2 * 86_400_000); utimesSync(join(project, "tmp/deploy-stage-0badf00d"), old, old);
    let port = first ? await free() : 1011;
    if (listener) { await new Promise<void>(done => listener.listen(0, "127.0.0.1", done)); port = (listener.address() as { port: number }).port; }
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(release, "scripts/deploy.ps1")], {
      cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, MIXIN_OPS_TASK_ID: undefined, MIXIN_OPS_RESULT_FILE: undefined, MIXIN_OPS_UI: undefined,
        MIXIN_OPS_CONSOLE: mode === "console" ? "1" : undefined, MIXIN_OPS_PROJECT: project, BOT_HOST: undefined,
        BOT_PORT: first ? String(port) : undefined, WORKSPACE_ROOT: mode === "reconfigure" ? shared : mode === "workspace-missing" ? join(f.root, "missing") : undefined,
        FIXTURE_MODE: mode, FIXTURE_EVENTS: events, FIXTURE_RELEASE: release, FIXTURE_PROJECT: project, FIXTURE_STAGE: staged, FIXTURE_WORKSPACE: "",
        FIXTURE_HEAD: mode === "redeploy" ? "" : head },
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const lines = existsSync(events) ? (await readFile(events, "utf8")).trim().split(/\r?\n/) : [];
    const own = `own=${first ? port : ""}|${mode === "reconfigure" ? shared : mode === "workspace-missing" ? join(f.root, "missing") : ""}|`;
    const stage = "<project>\\tmp\\deploy-stage-<id>", workspace = mode === "reconfigure" ? shared : "<project>\\data\\workspace";
    const preflight = `core deployment deploy --project <project> --preflight --git-path fixture-git ${own}`;
    const runtime = `runtime --prepare-values ${stage}\\runtime-values.json --deployment windows child=BOT_HOST=127.0.0.1,BOT_PORT=${port},WORKSPACE_ROOT=${workspace} ${own}`;
    const core = `core deployment deploy --project <project> --stage ${stage} --command deploy --git-path fixture-git ${own}`;
    const preview = `data preview --project <project> --plan ${stage}\\data-plan.json --workspace ${workspace}`;
    const before = ["lifecycle deploy", preflight];
    const expected: Record<Mode, { code: number; events: string[]; files?: string[] }> = {
      first: { code: 0, events: [...before, "install install --frozen-lockfile", `protect ${stage}`, "data check --project <project> --workspace <project>\\data\\workspace",
        "wizard configure.ts", `scope? app=${stage}\\configuration-app.json`, runtime, core],
        files: ["configuration-app.json", "configuration-models.json", "deployment.json", "directory-scope-plan.json", "runtime-values.json", "windows-tools"] },
      redeploy: { code: 0, events: [...before, `protect ${stage}`, preview, "reconfigure?", runtime, core],
        files: ["data-plan.json", "deployment.json", "runtime-values.json", "windows-tools"] },
      reconfigure: { code: 0, events: [...before, `protect ${stage}`, preview, "reconfigure?", "wizard configure.ts", runtime, core],
        files: ["configuration-models.json", "data-plan.json", "deployment.json", "runtime-values.json", "windows-tools"] },
      console: { code: 0, events: [...before, `protect ${stage}`, preview, runtime, core], files: ["data-plan.json", "deployment.json", "runtime-values.json", "windows-tools"] },
      pending: { code: 1, events: [] },
      preflight: { code: 1, events: before },
      preview: { code: 1, events: [...before, `protect ${stage}`, preview] },
      "workspace-missing": { code: 1, events: before },
      "port-in-use": { code: 1, events: [...before, "install install --frozen-lockfile"] },
      "wizard-cancel": { code: 1, events: [...before, "install install --frozen-lockfile", `protect ${stage}`, "data check --project <project> --workspace <project>\\data\\workspace",
        "wizard configure.ts"] },
      "core-failed": { code: 1, events: [...before, `protect ${stage}`, preview, "reconfigure?", runtime, core] },
      "not-admin": { code: 1, events: [] },
    };
    expect(code, out + err).toBe(expected[mode].code);
    expect(lines).toEqual(expected[mode].events);
    if (expected[mode].files) {
      expect(readdirSync(staged).sort()).toEqual(expected[mode].files);
      expect(JSON.parse(await readFile(join(staged, "deployment.json"), "utf8"))).toEqual({ format: 1, target: mode === "redeploy" ? "" : head, port,
        workspace: mode === "reconfigure" ? shared : "" });
      expect(await readFile(join(staged, "windows-tools"), "utf8")).toBe("format=1\nbun=fixture-bun\ngit=fixture-git\nuv=C:\\fixture\\uv\\uv.exe\nbash=C:\\fixture\\Git\\bin\\bash.exe\n");
    }
    if (mode === "pending") expect(out + err).toContain("ops resume");
    // Outside the console the entry keeps the system code page: compare the ASCII parts.
    if (mode === "port-in-use") expect(out + err).toContain(`${port} `);
    if (mode === "core-failed") { expect(out + err).toContain("ops resume"); expect(out + err).toContain("ops rollback"); }
    // This run's stage always goes; the abandoned one once the preflight passed.
    const left = readdirSync(join(project, "tmp")).filter(name => name.startsWith("deploy-stage-")).sort();
    expect(left).toEqual(["pending", "not-admin", "preflight"].includes(mode) ? ["deploy-stage-0badf00d", "deploy-stage-12345678"] : ["deploy-stage-12345678"]);
  } finally {
    listener?.close();
    await f.cleanup();
  }
}, 30_000);
