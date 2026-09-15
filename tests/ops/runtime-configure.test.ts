import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const draftName = ".runtime-draft-11111111-1111-1111-1111-111111111111.json";

for (const shell of ["powershell", "bash"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " 运行参数预检后停机，保留停止状态，应用或健康检查失败恢复原配置和服务", async () => {
      for (const scenario of ["running", "stopped", "missing", "precheck-fail", "apply-fail", "stop-fail", "health-fail", "rollback-fail", "foreign",
        ...(shell === "powershell" ? ["foreground"] : ["paused"])]) {
        const fixture = await tempFixture("runtime-ops-" + scenario + "-");
        try {
          const events = join(fixture.root, "events.txt"), state = join(fixture.root, "state.txt");
          const configDir = join(fixture.root, "data/config"), config = join(configDir, "runtime.json");
          await mkdir(configDir, { recursive: true });
          await writeFile(events, "");
          const initial = scenario === "stopped" ? "exited" : scenario === "missing" ? "" : scenario === "paused" ? "paused" : "running";
          await writeFile(state, initial); await writeFile(config, "old"); await writeFile(join(configDir, draftName), "{}");
          const runner = join(fixture.root, shell === "powershell" ? "run.ps1" : "run.sh");
          if (shell === "powershell") {
            await writeFile(runner, "\ufeff" + [
              "$ErrorActionPreference='Stop'",
              ". " + quote(join(project, "scripts/lib/common.ps1")),
              "$Project=$env:FIXTURE_ROOT; $ConfigDir=Join-Path $Project 'data/config'; $TaskName='fixture'",
              "function Record([string]$value){[IO.File]::AppendAllText($env:FIXTURE_EVENTS,$value+[Environment]::NewLine)}",
              "function Fixture-State {[IO.File]::ReadAllText($env:FIXTURE_STATE)}",
              "function Get-BunPath {'Invoke-FixtureBun'}",
              "function Invoke-FixtureBun {",
              "  $mode=$args[2]; $path=Join-Path $ConfigDir $args[3]; $receipt=$path+'.rollback'; $global:LASTEXITCODE=0",
              "  switch($mode){",
              "    '--check' {Record ('check:'+(Fixture-State)); if($env:FIXTURE_SCENARIO -eq 'precheck-fail'){$global:LASTEXITCODE=1}}",
              "    '--apply' {",
              "      Record ('apply:'+(Fixture-State)); [IO.File]::WriteAllText($receipt,'old')",
              "      if($env:FIXTURE_SCENARIO -eq 'apply-fail'){$global:LASTEXITCODE=1}else{[IO.File]::WriteAllText($env:FIXTURE_CONFIG,'new')}",
              "    }",
              "    '--rollback' {",
              "      Record ('rollback:'+(Fixture-State))",
              "      if($env:FIXTURE_SCENARIO -eq 'rollback-fail'){$global:LASTEXITCODE=1}else{",
              "        [IO.File]::WriteAllText($env:FIXTURE_CONFIG,'old'); Remove-Item -LiteralPath $receipt -Force",
              "      }",
              "    }",
              "    default {throw 'unexpected fixture command'}",
              "  }",
              "}",
              "function Get-ScheduledTask {if($env:FIXTURE_SCENARIO -notin @('foreground','missing')){@{State=$(if((Fixture-State) -eq 'running'){'Running'}else{'Ready'}); Actions=@(@{WorkingDirectory=$(if($env:FIXTURE_SCENARIO -eq 'foreign'){Join-Path $Project 'other'}else{$Project})})}}}",
              "function Get-BotPids {if((Fixture-State) -eq 'running'){12345}}",
              "function Stop-Bot {Record 'stop'; if($env:FIXTURE_SCENARIO -eq 'stop-fail'){return $false}; [IO.File]::WriteAllText($env:FIXTURE_STATE,'exited'); return $true}",
              "function Start-Bot {Record 'start'; [IO.File]::WriteAllText($env:FIXTURE_STATE,'running'); return $true}",
              "function Wait-Local {if($env:FIXTURE_SCENARIO -in @('health-fail','rollback-fail') -and [IO.File]::ReadAllText($env:FIXTURE_CONFIG) -eq 'new'){0}else{200}}",
              "function Step($value){}; function Done($value){}",
              "$tokens=$null; $errors=$null",
              "$ast=[Management.Automation.Language.Parser]::ParseFile(" + quote(join(project, "scripts/ops/ops.ps1")) + ",[ref]$tokens,[ref]$errors)",
              "if($errors){throw 'ops syntax error'}",
              "$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-RuntimeConfiguration'},$true)",
              "if(-not $fn){throw 'missing runtime configuration entry'}",
              ". ([scriptblock]::Create($fn.Extent.Text))",
              "try { Invoke-RuntimeConfiguration " + quote(draftName) + " } catch { Write-Output $_.Exception.Message; exit 1 }",
            ].join("\r\n"));
          } else {
            const source = (await readFile(join(project, "scripts/ops/ops.sh"), "utf8")).replaceAll("\r\n", "\n");
            const from = source.indexOf("runtime_configure() (\n"), until = source.indexOf("\n)\n", from);
            expect(from).toBeGreaterThan(0); expect(until).toBeGreaterThan(from);
            await writeFile(runner, [
              "#!/usr/bin/env bash", "set -uo pipefail",
              'PROJECT_DIR="$FIXTURE_ROOT"; DATA_DIR="$PROJECT_DIR/data"; CONFIG_DIR="$DATA_DIR/config"; CONTAINER=fixture',
              'P() { :; }; OK() { :; }; ER() { printf "%s\\n" "$1"; }; acquire_deploy_lock() { :; }',
              'record() { printf "%s\\n" "$1" >> "$FIXTURE_EVENTS"; }',
              'fixture_config() {',
              '  local mode="§{@: -2:1}" name="§{@: -1}"',
              '  local path="$CONFIG_DIR/$name" arg',
              '  for arg in "$@"; do if [[ "$arg" == *private-credential* ]]; then return 99; fi; done',
              '  if [ "$mode" = "--check" ]; then',
              '    record "check:$(cat "$FIXTURE_STATE")"',
              '    [ "$FIXTURE_SCENARIO" != precheck-fail ] || return 1',
              '  elif [ "$mode" = "--apply" ]; then',
              '    record "apply:$(cat "$FIXTURE_STATE")"; printf old > "$path.rollback"',
              '    [ "$FIXTURE_SCENARIO" != apply-fail ] || return 1',
              '    printf new > "$FIXTURE_CONFIG"',
              '  elif [ "$mode" = "--rollback" ]; then',
              '    record "rollback:$(cat "$FIXTURE_STATE")"',
              '    [ "$FIXTURE_SCENARIO" != rollback-fail ] || return 1',
              '    printf old > "$FIXTURE_CONFIG"; rm -f -- "$path.rollback"',
              '  else return 99; fi',
              '}',
              'docker() {',
              '  case "$1" in',
              '    ps) cat "$FIXTURE_STATE" ;;',
              '    inspect) if [[ "$3" == *Config.Env* ]]; then printf "BOT_DEBUG=0\\nAPI_KEY=private-credential\\n";',
              '      elif [[ "$3" == *Mounts* ]]; then if [ "$FIXTURE_SCENARIO" = foreign ]; then printf "%s/other" "$DATA_DIR"; else printf "%s" "$DATA_DIR"; fi;',
              '      else printf fixture-image; fi ;;',
              '    run) fixture_config "$@" ;;',
              '    stop) record stop; [ "$FIXTURE_SCENARIO" != stop-fail ] || return 1; printf exited > "$FIXTURE_STATE" ;;',
              '    *) return 99 ;;',
              '  esac',
              '}',
              'start_bot() {',
              '  record start; printf running > "$FIXTURE_STATE"',
              '  if [[ "$FIXTURE_SCENARIO" == health-fail || "$FIXTURE_SCENARIO" == rollback-fail ]] && [ "$(cat "$FIXTURE_CONFIG")" = new ]; then return 1; fi',
              '}',
              source.slice(from, until + 3),
              'runtime_configure "' + draftName + '"',
            ].join("\n").replaceAll("§{", "$" + "{") + "\n");
          }
          const pathForShell = shell === "powershell" ? (value: string) => value : posix;
          const child = Bun.spawn(shell === "powershell"
            ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, "--noprofile", "--norc", posix(runner)], {
            cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FIXTURE_ROOT: pathForShell(fixture.root), FIXTURE_EVENTS: pathForShell(events),
              FIXTURE_STATE: pathForShell(state), FIXTURE_CONFIG: pathForShell(config), FIXTURE_SCENARIO: scenario },
          });
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          const success = ["running", "stopped", "missing"].includes(scenario);
          expect(code, scenario + "\n" + stdout + stderr).toBe(success ? 0 : 1);
          const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/).filter(Boolean);
          const expected = scenario === "paused" || (scenario === "foreign" && shell === "bash") ? []
            : ["precheck-fail", "foreground", "foreign"].includes(scenario) ? ["check:running"]
            : ["stopped", "missing"].includes(scenario) ? ["check:" + initial, "apply:" + initial]
            : scenario === "stop-fail" ? ["check:running", "stop", "start"]
            : scenario === "apply-fail" ? ["check:running", "stop", "apply:exited", "stop", "rollback:exited", "start"]
            : ["health-fail", "rollback-fail"].includes(scenario) ? ["check:running", "stop", "apply:exited", "start", "stop", "rollback:exited",
              ...(scenario === "health-fail" ? ["start"] : [])]
            : ["check:running", "stop", "apply:exited", "start"];
          expect(recorded, scenario).toEqual(expected);
          expect(await readFile(state, "utf8"), scenario).toBe(scenario === "rollback-fail" ? "exited" : initial);
          expect(await readFile(config, "utf8"), scenario).toBe(success || scenario === "rollback-fail" ? "new" : "old");
          expect(existsSync(join(configDir, draftName)), scenario).toBe(scenario === "rollback-fail");
          expect(existsSync(join(configDir, draftName + ".rollback")), scenario).toBe(scenario === "rollback-fail");
        } finally { await fixture.cleanup(); }
      }
    }, 60000,
  );
}
