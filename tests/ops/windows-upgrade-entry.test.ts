// The unmodified upgrade.ps1 runs through powershell.exe -File from an exported release whose lib\common.ps1 is a recording
// stub library: real argument binding, $PSScriptRoot and exit codes; the core handoff is the only substituted process, and any
// service or scheduler call throws. Stop, data, commit, rollback and manual-change order run in core-windows-upgrade*.test.ts.
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempFixture } from "../helpers/temp.ts";

const source = resolve(import.meta.dir, "../.."), quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const original = "a".repeat(40), target = "b".repeat(40);
const library = "\ufeff" + `. ${quote(join(source, "scripts/lib/operation-log.ps1"))}
. ${quote(join(source, "scripts/lib/console-plan.ps1"))}
function Add-FixtureEvent([string]$Text) {
    $line = $env:BOT_OPERATION_STAGE + ':' + ($Text.Replace($env:FIXTURE_PROJECT, '<project>') -replace '-[0-9a-f]{32}\\.json', '-<id>.json')
    [IO.File]::AppendAllText($env:FIXTURE_EVENTS, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
function Stop-ProjectBot { throw 'terminal adapter stopped the bot' }
function Start-ScheduledTask { throw 'terminal adapter started the bot' }
function Enable-ScheduledTask { throw 'terminal adapter changed the scheduler' }
function Register-ScheduledTask { throw 'terminal adapter changed the scheduler' }
function Get-SavedWorkspaceRoot { $env:FIXTURE_WORKSPACE }
function fixture-bun {
    $global:LASTEXITCODE = 0
    if ($args -contains '--version') { if ($env:FIXTURE_MODE -ceq 'old-bun') { '1.4.3' } else { '1.4.4' }; return }
    if ($args[3] -cne 'preview' -or $args[2] -ne (Join-Path $env:FIXTURE_RELEASE 'scripts\\runtime\\data-current.ts')) { throw ('unexpected Bun call: ' + ($args -join ' ')) }
    $plan = $args[[Array]::IndexOf($args, '--plan') + 1]
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($plan)) | Out-Null; [IO.File]::WriteAllText($plan, '{}')
    Add-FixtureEvent ('preview ' + (@($args | Select-Object -Skip 4) -join ' '))
    if ($env:FIXTURE_MODE -ceq 'preview') { $global:LASTEXITCODE = 2 }
}
function Select-RevisionCleanup([string]$Bun, [string]$Tool, [string]$Root) {
    if ($Tool -ne (Join-Path $env:FIXTURE_RELEASE 'scripts\\runtime\\revision-cleanup.ts')) { throw ('cleanup not previewed by the exported release: ' + $Tool) }
    Add-FixtureEvent 'cleanup-choice'
    if ($env:FIXTURE_MODE -ceq 'cleanup-choice') { throw 'synthetic cleanup choice refusal' }
    'skip'
}
function Select-DirectoryScope([string]$Bun, [string]$Tool, [string]$Root, [string]$Plan) {
    if ($Tool -ne (Join-Path $env:FIXTURE_RELEASE 'scripts\\config\\directory-scope.ts')) { throw ('scope not chosen with the exported release: ' + $Tool) }
    Add-FixtureEvent 'scope-choice'
    if ($env:FIXTURE_MODE -ceq 'scope-choice') { throw 'synthetic directory choice cancellation' }
    [IO.File]::WriteAllText($Plan, '{"format":1,"all":true}')
}
function Invoke-ConsoleProcess([string]$FilePath, [string[]]$Arguments, [switch]$Screen) {
    if ($FilePath -cne 'fixture-bun' -or $Arguments[2] -ne (Join-Path $env:FIXTURE_RELEASE 'scripts\\ops\\core\\cli.ts')) { throw 'core not run from the exported release' }
    # Every input file the core reads must still exist when it starts.
    foreach ($flag in @('--plan', '--directory-plan')) {
        $index = [Array]::IndexOf($Arguments, $flag)
        if ($index -ge 0 -and -not (Test-Path -LiteralPath $Arguments[$index + 1] -PathType Leaf)) { throw ($flag + ' missing when the core started') }
    }
    Add-FixtureEvent (@($Arguments | Select-Object -Skip 3) -join ' ')
    if ($Arguments -contains '--preflight') { return [int]($env:FIXTURE_MODE -ceq 'preflight') }
    if ($env:FIXTURE_MODE -ceq 'core-failed') { return 3 }
    return 0
}
`.replace(/\r?\n/g, "\r\n");

const core = `deployment upgrade --project <project> --original ${original} --target ${target} --branch main --git-path fixture-git`;
const preview = "data-preparation-preview:preview --project <project> --plan <project>\\tmp\\data-plan-<id>.json --upgrade --workspace <project>\\data\\workspace";
const preflight = `upgrade-preflight:${core} --preflight`, cleanup = "revision-cleanup-preview:cleanup-choice", scope = "directory-scope:scope-choice";
const handoff = `shared-deployment-core:${core}`, plan = " --plan <project>\\tmp\\data-plan-<id>.json --cleanup skip";
const full = [preview, preflight, cleanup, scope, `${handoff}${plan} --directory-plan <project>\\tmp\\directory-scope-plan-<id>.json`];
// The preview, the read-only preflight and both questions come before the core, in this order, and a refusal ends the upgrade
// before anything else is asked. Resume and rollback take every choice from the transaction: no preview, preflight or question.
const expected = {
  success: { code: 0, events: full },
  "saved-scope": { code: 0, events: [preview, preflight, cleanup, handoff + plan] },
  "old-bun": { code: 1, events: [] }, "app-missing": { code: 1, events: [] }, "workspace-missing": { code: 1, events: [] },
  preview: { code: 1, events: [preview] },
  preflight: { code: 1, events: [preview, preflight] },
  "cleanup-choice": { code: 1, events: [preview, preflight, cleanup] },
  "scope-choice": { code: 1, events: [preview, preflight, cleanup, scope] },
  "core-failed": { code: 3, events: full },
  resume: { code: 0, events: [`${handoff} --confirmation fixed-preview-token`] },
  rollback: { code: 0, events: [`${handoff} --rollback --confirmation fixed-preview-token`] },
} as const;

for (const mode of Object.keys(expected) as (keyof typeof expected)[]) test.skipIf(process.platform !== "win32")(`Windows target upgrade terminal adapter: ${mode}`, async () => {
  const f = await tempFixture("upgrade-terminal-");
  try {
    const release = join(f.root, "release"), project = join(f.root, "中文 project"), events = join(f.root, "events.txt");
    await mkdir(join(release, "scripts/deploy"), { recursive: true }); await mkdir(join(release, "scripts/lib"));
    await mkdir(join(project, "data/state"), { recursive: true }); await mkdir(join(project, "data/config"));
    await writeFile(join(release, "scripts/deploy/upgrade.ps1"), await readFile(join(source, "scripts/deploy/upgrade.ps1")));
    await writeFile(join(release, "scripts/lib/common.ps1"), library);
    if (mode !== "app-missing") await writeFile(join(project, "data/config/app-bot.json"), "{}");
    if (mode === "saved-scope") await writeFile(join(project, "data/config/directory.json"), '{"format":1,"all":true}');
    const recovering = mode === "resume" || mode === "rollback";
    if (recovering) await writeFile(join(project, "data/state/upgrade-transaction"), "deploy-fixture\n");
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(release, "scripts/deploy/upgrade.ps1"),
      "-Project", project, "-OriginalSha", original, "-TargetSha", target, "-BunPath", "fixture-bun", "-GitPath", "fixture-git",
      ...(mode === "rollback" ? ["-Rollback"] : []), ...(recovering ? ["-ConfirmedTransaction", "fixed-preview-token"] : [])], {
      cwd: f.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, MIXIN_OPS_TASK_ID: undefined, MIXIN_OPS_CONSOLE: undefined, MIXIN_OPS_RESULT_FILE: undefined, FIXTURE_MODE: mode,
        FIXTURE_EVENTS: events, FIXTURE_RELEASE: release, FIXTURE_PROJECT: project,
        FIXTURE_WORKSPACE: mode === "workspace-missing" ? join(project, "missing workspace") : "" },
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(expected[mode].code);
    expect(existsSync(events) ? (await readFile(events, "utf8")).trim().split(/\r?\n/) : []).toEqual([...expected[mode].events]);
    if (mode === "app-missing") expect(out + err).toContain("app-bot.json");
    // Temporary plans are removed whatever happens: the published snapshot keeps its own copies.
    expect(existsSync(join(project, "tmp")) ? readdirSync(join(project, "tmp")).filter(name => name.includes("-plan-")) : []).toEqual([]);
  } finally { await f.cleanup(); }
}, 20_000);
