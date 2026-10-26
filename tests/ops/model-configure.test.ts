import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const posixPath = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

for (const shell of ["powershell", "bash"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " 模型配置向导在停机后运行，成功、取消或失败均恢复原运行状态", async () => {
      // The wizard itself commits atomically and exits 0 on cancel; the wrapper only owns stop and restore.
      for (const scenario of ["running", "stopped", "wizard-fail", "stop-fail", "restart-fail", ...(shell === "powershell" ? ["foreground", "foreground-task", "pending"] : ["guarded"])]) {
        const fixture = await tempFixture("model-ops-" + scenario + "-");
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
              "$pendingTransaction = $env:FIXTURE_SCENARIO -eq 'pending'",
              "function Record([string]$value){[IO.File]::AppendAllText($env:FIXTURE_EVENTS,$value+[Environment]::NewLine)}",
              "function Fixture-State {[IO.File]::ReadAllText($env:FIXTURE_STATE)}",
              "function Get-BunPath {'Invoke-FixtureBun'}",
              "function Invoke-FixtureBun {",
              "  $global:LASTEXITCODE=0",
              "  if($args[0] -ne 'run' -or $args[1] -ne 'scripts\\config\\configure.ts' -or $args.Count -ne 2){throw 'unexpected fixture command'}",
              "  Record ('configure:'+(Fixture-State))",
              "  if($env:FIXTURE_SCENARIO -eq 'wizard-fail'){$global:LASTEXITCODE=1}",
              "}",
              "function Get-ScheduledTask {if($env:FIXTURE_SCENARIO -ne 'foreground'){@{State=$(if((Fixture-State) -eq 'running' -and $env:FIXTURE_SCENARIO -ne 'foreground-task'){'Running'}else{'Ready'})}}}",
              "function Get-BotPids {if((Fixture-State) -eq 'running'){12345}}",
              "function Stop-Bot { Record 'stop'; if($env:FIXTURE_SCENARIO -eq 'stop-fail'){return $false}; [IO.File]::WriteAllText($env:FIXTURE_STATE,'exited'); return $true }",
              "function Start-Bot { Record 'start'; if($env:FIXTURE_SCENARIO -eq 'restart-fail'){return $false}; [IO.File]::WriteAllText($env:FIXTURE_STATE,'running'); return $true }",
              "function Wait-Local {200}",
              "function Step($value){}; function Done($value){}",
              "$tokens=$null; $errors=$null",
              "$ast=[Management.Automation.Language.Parser]::ParseFile(" + psQuote(join(project, "scripts/ops/ops.ps1")) + ",[ref]$tokens,[ref]$errors)",
              "if($errors){throw 'ops syntax error'}",
              "$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-ConfigureWizard'},$true)",
              "if(-not $fn){throw 'missing model configuration entry'}",
              ". ([scriptblock]::Create($fn.Extent.Text))",
              "$helper=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-BotRunState'},$true)",
              ". ([scriptblock]::Create($helper.Extent.Text))",
              // The deployment lock is held for the whole wizard and released afterwards.
              "try { Invoke-ConfigureWizard 'scripts\\config\\configure.ts' '模型配置' } catch { Write-Output $_.Exception.Message; $code=1 }",
              "$lock=[IO.File]::Open((Join-Path $Project 'data\\state\\deploy.lock'),'OpenOrCreate','ReadWrite','None'); $lock.Dispose()",
              "exit $(if($code){$code}else{0})",
            ].join("\n"));
          } else {
            const source = (await readFile(join(project, "scripts/ops/ops.sh"), "utf8")).replaceAll("\r\n", "\n");
            const from = source.indexOf("wizard_configure() (\n"), until = source.indexOf("\n)\n", from);
            expect(from).toBeGreaterThan(0); expect(until).toBeGreaterThan(from);
            await writeFile(runner, [
              "#!/usr/bin/env bash", "set -uo pipefail",
              'PROJECT_DIR="$FIXTURE_ROOT"; DATA_DIR="$PROJECT_DIR/data"; CONFIG_DIR="$DATA_DIR/config"; CONTAINER=fixture',
              'P() { :; }; OK() { :; }; ER() { :; }',
              'record() { printf "%s\\n" "$1" >> "$FIXTURE_EVENTS"; }',
              'guard_one_off_container() { record guard; [ "$FIXTURE_SCENARIO" != guarded ]; }',
              'service_container_user() { echo 1234:1234; }',
              'docker() {',
              '  case "$1" in',
              '    ps) cat "$FIXTURE_STATE" ;;',
              // The wizard runs in the deployment image as the service identity with the container HOME.
              '    run) [[ " $* " == *" --user 1234:1234 -e HOME=/app/data/runtime/home "* && " $* " == *" mixin-chatbot bun run configure " ]] || return 98',
              '      record "configure:$(cat "$FIXTURE_STATE")"; [ "$FIXTURE_SCENARIO" != wizard-fail ] ;;',
              '    stop) record stop; [ "$FIXTURE_SCENARIO" != stop-fail ] || return 1; printf exited > "$FIXTURE_STATE" ;;',
              '    *) return 99 ;;',
              '  esac',
              '}',
              'start_bot() { record start; [ "$FIXTURE_SCENARIO" != restart-fail ] || return 1; printf running > "$FIXTURE_STATE"; }',
              source.slice(from, until + 3),
              "wizard_configure configure 模型配置",
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
          expect(code, scenario + "\n" + stdout + stderr).toBe(["running", "stopped"].includes(scenario) ? 0 : 1);
          const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/).filter(Boolean);
          const expected = scenario === "stopped" ? ["configure:exited"]
            : scenario === "stop-fail" ? ["stop", "start"]
              : ["foreground", "foreground-task", "pending", "guarded"].includes(scenario) ? []
                : ["stop", "configure:exited", "start"];
          expect(recorded).toEqual(shell === "bash" ? ["guard", ...expected] : expected);
          expect(await readFile(state, "utf8")).toBe(["stopped", "restart-fail"].includes(scenario) ? "exited" : "running");
        } finally { await fixture.cleanup(); }
      }
    }, 30000,
  );
}
