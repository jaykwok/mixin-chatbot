// Ordinary revision mutation policy now lives in core-revision.test.ts with the real common host, lock and disk
// assessment; a restore inside a transaction is routed by the core itself (core-deployment-cli.test.ts). This file retains
// the read-only wrappers and the option checks of both scripts. Thin mutation forwarding and exit-code
// preservation are checked through both real public dispatchers in core-wrapper.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { opsShellFunctions } from "../helpers/ops-shell.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const posixPath = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

type Scenario = { name: string; args: string[]; running: boolean; code: number; events: string[]; after: "running" | "stopped"; message?: string[] };
const SCENARIOS: Scenario[] = [
  { name: "preview", args: ["preview", "--json"], running: true, code: 0, events: ["admin:preview --project /app --json:fixture"], after: "running" },
  { name: "status", args: ["status"], running: false, code: 0, events: ["admin:status --project /app:"], after: "stopped" },
  { name: "shrink-preview", args: ["shrink-preview", "--space", "groups/g1"], running: true, code: 0,
    events: ["admin:shrink-preview --project /app --space groups/g1:fixture"], after: "running" },
  { name: "shrink-remove-old", args: ["shrink-remove-old", "--yes"], running: true, code: 0, events: ["admin:shrink-remove-old --project /app --yes:fixture"], after: "running" },
  { name: "usage", args: ["shrunk"], running: true, code: 1, events: [], after: "running", message: ["用法：ops.sh revision-cleanup"] },
];

test.skipIf(!bash || !existsSync(bash))("ops.sh revision read-only actions keep their existing command boundaries", async () => {
  const functions = await opsShellFunctions("revision_cleanup");
  for (const scenario of SCENARIOS) {
    const fixture = await tempFixture("revision-cleanup-wrapper-" + scenario.name + "-");
    try {
      const root = join(fixture.root, "project"), events = join(fixture.root, "events.txt"), state = join(fixture.root, "state.txt");
      await mkdir(join(root, "data/state"), { recursive: true });
      await writeFile(events, "");
      await writeFile(state, scenario.running ? "fixture" : "");
      const runner = join(fixture.root, "run.sh");
      await writeFile(runner, [
        "#!/usr/bin/env bash", "set -uo pipefail",
        'PROJECT_DIR="$FIXTURE_ROOT/project"; STATE_DIR="$PROJECT_DIR/data/state"; CONTAINER=fixture',
        'ER() { printf "%s\\n" "$1" >&2; }; WA() { printf "%s\\n" "$1" >&2; }; P() { printf "%s\\n" "$1" >&2; }; OK() { printf "%s\\n" "$1" >&2; }',
        'ops_command_hint() { printf "ops.sh %s" "$1"; }; wait_for_local() { :; }',
        'record() { printf "%s\\n" "$1" >> "$FIXTURE_EVENTS"; }',
        // The one-off container (or docker exec while the bot runs) with the project mounted at /app.
        'data_admin() {',
        '  case "$1" in',
        '    scripts/runtime/revision-cleanup.ts)',
        '      shift; record "admin:$*:$(cat "$FIXTURE_STATE")"',
        '      ;;',
        '    *) return 97 ;;',
        '  esac',
        '}',
        functions,
        'revision_cleanup "$@"',
      ].join("\n") + "\n");
      const child = Bun.spawn([bash!, "--noprofile", "--norc", posixPath(runner), ...scenario.args], {
        cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, PWD: fixture.root, FIXTURE_ROOT: posixPath(fixture.root), FIXTURE_EVENTS: posixPath(events), FIXTURE_STATE: posixPath(state) },
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, scenario.name + "\n" + stdout + stderr).toBe(scenario.code);
      expect((await readFile(events, "utf8")).trim().split(/\r?\n/).filter(Boolean), scenario.name).toEqual(scenario.events);
      expect(await readFile(state, "utf8"), scenario.name).toBe(scenario.after === "running" ? "fixture" : "");
      for (const message of scenario.message ?? []) expect(stderr, scenario.name).toContain(message);
      // Reading actions create nothing.
      expect(existsSync(join(root, "backup")), scenario.name).toBe(false);
    } finally { await fixture.cleanup(); }
  }
}, 120_000);

type WindowsScenario = { name: string; action: string; options?: { space?: string; yes?: true }; running: boolean;
  code: number; events: string[]; after: "running" | "stopped"; message?: string[] };
const WINDOWS: WindowsScenario[] = [
  { name: "preview", action: "preview", running: true, code: 0, events: ["admin:preview --project <P>:running"], after: "running" },
  { name: "shrink-preview", action: "shrink-preview", options: { space: "direct, groups/g1" }, running: true, code: 0,
    events: ["admin:shrink-preview --project <P> --space direct --space groups/g1:running"], after: "running" },
  { name: "shrink-status", action: "shrink-status", running: false, code: 0, events: ["admin:shrink-status --project <P>:exited"], after: "stopped" },
  { name: "shrink-remove-old", action: "shrink-remove-old", options: { yes: true }, running: true, code: 0,
    events: ["admin:shrink-remove-old --project <P> --yes:running"], after: "running" },
  { name: "restore-no-space", action: "restore", running: false, code: 1, events: [], after: "stopped", message: ["revision-cleanup restore 需要 -Space <空间>，一次一个"] },
  { name: "restore-two-spaces", action: "restore", options: { space: "direct, groups/g1" }, running: false, code: 1, events: [], after: "stopped",
    message: ["revision-cleanup restore 需要 -Space <空间>，一次一个"] },
  { name: "space-misused", action: "apply", options: { space: "direct" }, running: true, code: 1, events: [], after: "running", message: ["-Space 只用于"] },
  { name: "yes-misused", action: "shrink", options: { yes: true }, running: true, code: 1, events: [], after: "running", message: ["-Yes 只用于"] },
  { name: "usage", action: "shrunk", running: true, code: 1, events: [], after: "running", message: ["用法：ops.ps1 revision-cleanup"] },
];

test.skipIf(process.platform !== "win32")("ops.ps1 revision read-only actions and strict options keep their existing boundaries", async () => {
  for (const scenario of WINDOWS) {
    const fixture = await tempFixture("revision-cleanup-ps-" + scenario.name + "-");
    try {
      const root = join(fixture.root, "project"), events = join(fixture.root, "events.txt"), state = join(fixture.root, "state.txt");
      await mkdir(join(root, "data/state"), { recursive: true });
      await writeFile(events, "");
      await writeFile(state, scenario.running ? "running" : "exited");
      const runner = join(fixture.root, "run.ps1");
      await writeFile(runner, "\ufeff" + [
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
        "$Project=$env:FIXTURE_PROJECT; $StateDir=Join-Path $Project 'data\\state'; $TaskName='fixture'; $Port=11011",
        "$Space=$env:FIXTURE_SPACE; $Yes=[bool]$env:FIXTURE_YES",
        "$script:OpsInputNames=@('Command','Target'); if($Space){$script:OpsInputNames+='Space'}; if($Yes){$script:OpsInputNames+='Yes'}",
        "function Record([string]$value){[IO.File]::AppendAllText($env:FIXTURE_EVENTS,$value+[Environment]::NewLine)}",
        "function Fixture-State {[IO.File]::ReadAllText($env:FIXTURE_STATE)}",
        "function Err($m){[Console]::Error.WriteLine($m)}; function Warn($m){[Console]::Error.WriteLine($m)}",
        "function Done($m){[Console]::Out.WriteLine($m)}; function Step($m){[Console]::Out.WriteLine($m)}",
        "function Get-OpsCommandHint([string]$Command){ 'ops:' + $Command }",
        // The service's own bun, run in the project with the project's path.
        "function Invoke-DataAdmin([string]$Script, [string[]]$TmpArgs) {",
        "  if($Script -ne 'scripts\\runtime\\revision-cleanup.ts'){throw 'unexpected script'}",
        "  Record ('admin:'+(($TmpArgs | ForEach-Object { if($_ -eq $Project){'<P>'}else{$_} }) -join ' ')+':'+(Fixture-State))",
        "  return $true",
        "}",
        // Mutating actions go to the shared core (core-wrapper.test.ts); none of these scenarios may reach it.
        "function Invoke-CoreMaintenance { throw 'unexpected core call' }",
        "$tokens=$null; $errors=$null",
        "$ast=[Management.Automation.Language.Parser]::ParseFile(" + psQuote(join(project, "scripts/ops/ops.ps1")) + ",[ref]$tokens,[ref]$errors)",
        "if($errors){throw 'syntax error in ops.ps1'}",
        "foreach($name in @('Invoke-RevisionCleanupAdmin')){",
        "  $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)",
        "  if(-not $fn){throw \"missing $name\"}",
        "  . ([scriptblock]::Create($fn.Extent.Text))",
        "}",
        "try { if(Invoke-RevisionCleanupAdmin $env:FIXTURE_ACTION){exit 0}else{exit 1} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
      ].join("\r\n"));
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner], {
        cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
        env: { ...process.env, FIXTURE_PROJECT: root, FIXTURE_EVENTS: events, FIXTURE_STATE: state, FIXTURE_ACTION: scenario.action,
          FIXTURE_SPACE: scenario.options?.space ?? "", FIXTURE_YES: scenario.options?.yes ? "1" : "" },
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, scenario.name + "\n" + stdout + stderr).toBe(scenario.code);
      expect((await readFile(events, "utf8")).trim().split(/\r?\n/).filter(Boolean), scenario.name).toEqual(scenario.events);
      expect(await readFile(state, "utf8"), scenario.name).toBe(scenario.after === "running" ? "running" : "exited");
      for (const message of scenario.message ?? []) expect(stdout + stderr, scenario.name).toContain(message);
    } finally { await fixture.cleanup(); }
  }
}, 180_000);

test.skipIf(process.platform !== "win32")("ops.ps1 has no -NoBackup: PowerShell refuses it before the script runs", async () => {
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(project, "scripts/ops/ops.ps1"),
    "-Command", "revision-cleanup", "-Target", "apply", "-NoBackup"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(stdout + stderr).toContain("NoBackup");
  expect(stdout).not.toContain("修订整理");
}, 30_000);
