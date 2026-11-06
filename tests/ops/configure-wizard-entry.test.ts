// relay-configure, model-configure and configure-app-bot in both entries: the wizard fills a private stage while the bot keeps
// running, then the shared core publishes it (maintenance configuration-apply --stage); the entry never stops or starts the bot
// itself. The real functions are extracted from ops.sh / ops.ps1 and run against stubbed Docker, Bun and core calls; the
// three commands are taken from the real dispatch lines.
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
const source = async (path: string) => (await readFile(join(project, path), "utf8")).replaceAll("\r\n", "\n");
const COMMANDS = ["relay-configure", "model-configure", "configure-app-bot"] as const;

/** label, wizard and kind of each command, read from the entry's dispatch. */
async function dispatch(shell: "bash" | "powershell"): Promise<Record<string, [string, string, string]>> {
  const text = await source(shell === "bash" ? "scripts/ops.sh" : "scripts/ops.ps1"), result: Record<string, [string, string, string]> = {};
  for (const command of COMMANDS) {
    const match = shell === "bash" ? new RegExp(`\\n    ${command}\\) configure_with_wizard (\\S+) (\\S+) (\\S+) ;;\\n`).exec(text)
      : new RegExp(`\\n    "${command}" \\{ if \\(-not \\(Invoke-ConfigureWizard '([^']+)' '([^']+)' '([^']+)'\\)\\) \\{ exit \\$script:OpsCoreExitCode \\} \\}\\n`).exec(text);
    if (!match) throw new Error(`no dispatch line for ${command} in ${shell}`);
    result[command] = shell === "bash" ? [match[1]!, match[2]!, match[3]!] : [match[2]!, match[1]!, match[3]!];
  }
  return result;
}

async function runner(shell: "bash" | "powershell", root: string): Promise<string> {
  const path = join(root, shell === "bash" ? "run.sh" : "run.ps1");
  if (shell === "bash") {
    const text = await source("scripts/ops.sh"), from = text.indexOf("configure_with_wizard() (\n"), until = text.indexOf("\n)\n", from);
    if (from < 0 || until < 0) throw new Error("configure_with_wizard not found");
    const body = text.slice(from, until + 3);
    if (!body.includes("[ -t 0 ] && [ -t 1 ] ||")) throw new Error("terminal check not found");
    await writeFile(path, [
      "#!/usr/bin/env bash", "set -uo pipefail",
      'PROJECT_DIR="$FIXTURE_ROOT"; STATE_DIR="$PROJECT_DIR/data/state"; CONTAINER=mixin-bot',
      'ER() { printf "ER %s\\n" "$*"; }; WA() { printf "WA %s\\n" "$*"; }',
      'ops_command_hint() { printf "%s" "$1"; }',
      'record() { printf "%s\\n" "$1" >> "$FIXTURE_EVENTS"; }',
      'service_container_user() { echo 1234:1234; }',
      'docker() {',
      '  case "$1 $2" in',
      '    "container inspect") [ "$FIXTURE_SCENARIO" != no-container ] || return 1; echo sha256:fixture-image ;;',
      '    "run --rm")',
      '      local stage="" previous="" arg',
      '      for arg in "$@"; do if [ "$previous" = -v ] && [[ "$arg" == *:/preview ]]; then stage="${arg%:/preview}"; fi; previous="$arg"; done',
      '      record "wizard $*"',
      '      case "$FIXTURE_SCENARIO" in cancel) return 0 ;; abort) return 2 ;; wizard-fail) return 1 ;; esac',
      '      printf staged > "$stage/configuration-$FIXTURE_KIND.json" ;;',
      '    *) record "FORBIDDEN docker $*"; return 99 ;;',
      '  esac',
      '}',
      'ops_core() { record "core $* content=$(cat "${@: -1}" 2>/dev/null)"; [ "$FIXTURE_SCENARIO" != core-fail ] || return 3; }',
      // Tests have no terminal: the check is decided by the scenario instead.
      body.replace("[ -t 0 ] && [ -t 1 ] ||", '[ "$FIXTURE_SCENARIO" != no-terminal ] ||'),
      'configure_with_wizard "$@"',
    ].join("\n") + "\n");
  } else {
    await writeFile(path, "\ufeff" + [
      "param([string]$Label, [string]$Wizard, [string]$Kind)",
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      ". " + psQuote(join(project, "scripts/lib/common.ps1")),
      "$Project=$env:FIXTURE_ROOT",
      "$pendingTransaction = $env:FIXTURE_SCENARIO -eq 'pending'",
      "function Record([string]$value){[IO.File]::AppendAllText($env:FIXTURE_EVENTS,$value+[Environment]::NewLine)}",
      // Like the real ones, these print to the host and never become part of a function's return value.
      "function Err($m){Write-Host \"ER $m\"}; function Warn($m){Write-Host \"WA $m\"}",
      "function Get-BunPath {if($env:FIXTURE_SCENARIO -ne 'no-bun'){'Invoke-FixtureBun'}}",
      "function Invoke-FixtureBun {",
      "  Record ('wizard ' + ($args -join ' ') + ' cwd=' + (Get-Location).ProviderPath)",
      "  $global:LASTEXITCODE = switch ($env:FIXTURE_SCENARIO) { 'cancel' {0} 'abort' {2} 'wizard-fail' {1} default {0} }",
      "  if($env:FIXTURE_SCENARIO -notin @('cancel','abort','wizard-fail')){[IO.File]::WriteAllText((Join-Path $args[-1] \"configuration-$env:FIXTURE_KIND.json\"),'staged')}",
      "}",
      "function Invoke-CoreMaintenance([string[]]$CoreArguments) {",
      "  Record ('core ' + ($CoreArguments -join ' ') + ' content=' + [IO.File]::ReadAllText($CoreArguments[-1]))",
      "  if($env:FIXTURE_SCENARIO -eq 'core-fail'){$script:OpsCoreExitCode=3; return $false}; $script:OpsCoreExitCode=0; return $true",
      "}",
      "$tokens=$null; $errors=$null",
      "$ast=[Management.Automation.Language.Parser]::ParseFile(" + psQuote(join(project, "scripts/ops.ps1")) + ",[ref]$tokens,[ref]$errors)",
      "if($errors){throw 'ops syntax error'}",
      "$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-ConfigureWizard'},$true)",
      "if(-not $fn -or -not $fn.Extent.Text.Contains('[Console]::IsInputRedirected')){throw 'missing configuration wizard entry'}",
      // Tests have no console: the check is decided by the scenario instead.
      ". ([scriptblock]::Create($fn.Extent.Text.Replace('[Console]::IsInputRedirected', \"(`$env:FIXTURE_SCENARIO -eq 'no-terminal')\")))",
      "$script:OpsCoreExitCode = 1",
      "if (-not (Invoke-ConfigureWizard $Wizard $Label $Kind)) { exit $script:OpsCoreExitCode }",
      "exit 0",
    ].join("\n"));
  }
  return path;
}

for (const shell of ["bash", "powershell"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    `${shell}：配置向导在服务运行时把回答写进私有暂存，确认后只交给核心发布；取消、失败和拒绝都不交给核心，暂存总被删除`, async () => {
      const commands = await dispatch(shell);
      expect(commands).toEqual(shell === "bash"
        ? { "relay-configure": ["外链配置", "configure-relay.ts", "relay"], "model-configure": ["模型配置", "configure.ts", "models"],
          "configure-app-bot": ["应用机器人配置", "configure-app-bot.ts", "app"] }
        : { "relay-configure": ["外链配置", "configure-relay.ts", "relay"], "model-configure": ["模型配置", "configure.ts", "models"],
          "configure-app-bot": ["应用机器人配置", "configure-app-bot.ts", "app"] });
      const scenarios = [...COMMANDS.map(command => ["success", command] as const),
        ...(["cancel", "abort", "wizard-fail", "core-fail", "pending", "no-terminal", shell === "bash" ? "no-container" : "no-bun"] as const)
          .map(scenario => [scenario, "model-configure"] as const)];
      for (const [scenario, command] of scenarios) {
        const fixture = await tempFixture("configure-entry-" + scenario + "-");
        try {
          const root = fixture.root, events = join(root, "events.txt"), [label, wizard, kind] = commands[command]!;
          await mkdir(join(root, "data/state"), { recursive: true }); await writeFile(events, "");
          if (scenario === "pending") await writeFile(join(root, "data/state/deploy-transaction"), "snapshot\n");
          const script = await runner(shell, root), forShell = shell === "bash" ? posixPath : (value: string) => value;
          const child = Bun.spawn(shell === "bash" ? [bash!, "--noprofile", "--norc", posixPath(script), label, wizard, kind]
            : ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, label, wizard, kind], {
            cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FIXTURE_ROOT: forShell(root), FIXTURE_EVENTS: forShell(events), FIXTURE_SCENARIO: scenario, FIXTURE_KIND: kind },
          });
          const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          const output = stdout + stderr, context = `${scenario} ${command}\n${output}`;
          const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/).filter(Boolean);
          const stagePath = (line: string) => /(\S*configure-stage-[A-Za-z0-9]{8})/.exec(line)?.[1];
          const handed = ["success", "core-fail"].includes(scenario), wizardRan = handed || ["cancel", "abort", "wizard-fail"].includes(scenario);
          expect(code, context).toBe(scenario === "core-fail" ? 3 : ["success", "cancel", "abort"].includes(scenario) ? 0 : 1);
          expect(recorded.length, context).toBe(handed ? 2 : wizardRan ? 1 : 0);
          if (wizardRan) {
            const line = recorded[0]!, stage = stagePath(line)!;
            expect(stage, line).toBeDefined();
            // The wizard writes only into a fresh stage under tmp/; Docker runs it in the bot's image by ID as the service identity,
            // with data/ read-only; Windows runs it with the project's dependencies from the project root.
            if (shell === "bash") expect(line).toBe(`wizard run --rm -it --user 1234:1234 -w /app -e HOME=/tmp -v ${forShell(root)}/data:/app/data:ro `
              + `-v ${stage}:/preview sha256:fixture-image bun run ops/config/${wizard} --stage /preview`);
            else expect(line).toBe(`wizard --no-env-file run ${join(root, "ops\\config", wizard)} --stage ${stage} cwd=${root}`);
            if (handed) expect(recorded[1]).toBe(`core maintenance configuration-apply --stage ${stage}${shell === "bash" ? "/" : "\\"}configuration-${kind}.json content=staged`);
          }
          if (["cancel", "abort"].includes(scenario)) expect(output).toContain(`WA ${label}已取消；配置和服务保持原状`);
          if (scenario === "wizard-fail") expect(output).toContain(`ER ${label}未完成（原因见上方）；配置和服务保持原状`);
          if (scenario === "pending") expect(output).toContain("ER 有未完成的部署或升级；请先用");
          if (scenario === "no-terminal") expect(output).toContain(`ER ${label}需要在终端里运行向导；配置和服务保持原状`);
          if (scenario === "no-container") expect(output).toContain("ER 机器人容器不存在，请先部署");
          expect(recorded.some(line => line.startsWith("FORBIDDEN")), context).toBe(false);
          // The stage holds credentials: nothing of it is left, whatever happened.
          expect(existsSync(join(root, "tmp")) ? await readdir(join(root, "tmp")) : [], context).toEqual([]);
        } finally { await fixture.cleanup(); }
      }
    }, 120_000,
  );
}
