import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const posixPath = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

for (const shell of ["powershell", "bash"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " 外链配置仅确认后停机，成功或失败均恢复原运行状态，取消时无服务变更", async () => {
      for (const scenario of ["running", "stopped", "cancel", "apply-fail", "stop-fail", "restart-fail", ...(shell === "powershell" ? ["foreground"] : [])]) {
        const fixture = await tempFixture("relay-ops-" + scenario + "-");
        try {
          const events = join(fixture.root, "events.txt"), state = join(fixture.root, "state.txt");
          await mkdir(join(fixture.root, "data/config"), { recursive: true });
          await writeFile(events, "");
          await writeFile(state, scenario === "stopped" ? "exited" : "running");
          const runner = join(fixture.root, shell === "powershell" ? "run.ps1" : "run.sh");
          if (shell === "powershell") {
            await writeFile(runner, "\ufeff" + [
              "$ErrorActionPreference='Stop'",
              ". " + psQuote(join(project, "scripts/lib/common.ps1")),
              "$Project=$env:FIXTURE_ROOT; $ConfigDir=Join-Path $Project 'data/config'; $TaskName='fixture'",
              "function Record([string]$value){[IO.File]::AppendAllText($env:FIXTURE_EVENTS,$value+[Environment]::NewLine)}",
              "function Fixture-State {[IO.File]::ReadAllText($env:FIXTURE_STATE)}",
              "function Get-BunPath {'Invoke-FixtureBun'}",
              "function Invoke-FixtureBun {",
              "  $mode=$args[2]; $path=$args[3]; $global:LASTEXITCODE=0",
              "  if($mode -eq '--draft'){",
              "    Record ('draft:'+(Fixture-State))",
              "    if($env:FIXTURE_SCENARIO -ne 'cancel'){[IO.File]::WriteAllText($path,'{}')}",
              "  } elseif($mode -eq '--apply'){",
              "    Record ('apply:'+(Fixture-State))",
              "    if($env:FIXTURE_SCENARIO -eq 'apply-fail'){$global:LASTEXITCODE=1}",
              "  } else {throw 'unexpected fixture command'}",
              "}",
              "function Get-ScheduledTask {if($env:FIXTURE_SCENARIO -ne 'foreground'){@{State=$(if((Fixture-State) -eq 'running'){'Running'}else{'Ready'})}}}",
              "function Get-BotPids {if((Fixture-State) -eq 'running'){12345}}",
              "function Stop-Bot { Record 'stop'; if($env:FIXTURE_SCENARIO -eq 'stop-fail'){return $false}; [IO.File]::WriteAllText($env:FIXTURE_STATE,'exited'); return $true }",
              "function Start-Bot { Record 'start'; if($env:FIXTURE_SCENARIO -eq 'restart-fail'){return $false}; [IO.File]::WriteAllText($env:FIXTURE_STATE,'running'); return $true }",
              "function Wait-Local {200}",
              "function Step($value){}; function Done($value){}",
              "$tokens=$null; $errors=$null",
              "$ast=[Management.Automation.Language.Parser]::ParseFile(" + psQuote(join(project, "scripts/ops/ops.ps1")) + ",[ref]$tokens,[ref]$errors)",
              "if($errors){throw 'ops syntax error'}",
              "$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-RelayConfiguration'},$true)",
              "if(-not $fn){throw 'missing relay configuration entry'}",
              ". ([scriptblock]::Create($fn.Extent.Text))",
              "try { Invoke-RelayConfiguration } catch { Write-Output $_.Exception.Message; exit 1 }",
            ].join("\n"));
          } else {
            const source = (await readFile(join(project, "scripts/ops/ops.sh"), "utf8")).replaceAll("\r\n", "\n");
            const from = source.indexOf("relay_configure() (\n"), until = source.indexOf("\n)\n", from);
            expect(from).toBeGreaterThan(0); expect(until).toBeGreaterThan(from);
            await writeFile(runner, [
              "#!/usr/bin/env bash", "set -uo pipefail",
              'PROJECT_DIR="$FIXTURE_ROOT"; DATA_DIR="$PROJECT_DIR/data"; CONFIG_DIR="$DATA_DIR/config"; CONTAINER=fixture',
              'P() { :; }; OK() { :; }; ER() { :; }',
              'record() { printf "%s\\n" "$1" >> "$FIXTURE_EVENTS"; }',
              'fixture_config() {',
              '  local mode="${@: -2:1}" path="${@: -1}"',
              '  path="$PROJECT_DIR${path#/app}"',
              '  if [ "$mode" = "--draft" ]; then',
              '    record "draft:$(cat "$FIXTURE_STATE")"',
              '    if [ "$FIXTURE_SCENARIO" != cancel ]; then printf "{}" > "$path"; fi',
              '  elif [ "$mode" = "--apply" ]; then',
              '    record "apply:$(cat "$FIXTURE_STATE")"',
              '    [ "$FIXTURE_SCENARIO" != apply-fail ] || return 1',
              '  else return 99; fi',
              '}',
              'docker() {',
              '  case "$1" in',
              '    ps) cat "$FIXTURE_STATE" ;;',
              '    run) fixture_config "$@" ;;',
              '    stop) record stop; [ "$FIXTURE_SCENARIO" != stop-fail ] || return 1; printf exited > "$FIXTURE_STATE" ;;',
              '    *) return 99 ;;',
              '  esac',
              '}',
              'start_bot() { record start; [ "$FIXTURE_SCENARIO" != restart-fail ] || return 1; printf running > "$FIXTURE_STATE"; }',
              source.slice(from, until + 3),
              "relay_configure",
            ].join("\n") + "\n");
          }
          const pathForShell = shell === "powershell" ? (value: string) => value : posixPath;
          const child = Bun.spawn(shell === "powershell"
            ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, "--noprofile", "--norc", posixPath(runner)], {
            cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FIXTURE_ROOT: pathForShell(fixture.root), FIXTURE_EVENTS: pathForShell(events),
              FIXTURE_STATE: pathForShell(state), FIXTURE_SCENARIO: scenario },
          });
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          expect(code, scenario + "\n" + stdout + stderr).toBe(["running", "stopped", "cancel"].includes(scenario) ? 0 : 1);
          const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/);
          const expected = scenario === "cancel" || scenario === "foreground" ? ["draft:running"]
            : scenario === "stopped" ? ["draft:exited", "apply:exited"]
              : scenario === "stop-fail" ? ["draft:running", "stop", "start"]
                : ["draft:running", "stop", "apply:exited", "start"];
          expect(recorded).toEqual(expected);
          expect(await readFile(state, "utf8")).toBe(["stopped", "restart-fail"].includes(scenario) ? "exited" : "running");
          expect(await readdir(join(fixture.root, "data/config"))).toEqual([]);
        } finally { await fixture.cleanup(); }
      }
    }, 30000,
  );
}
