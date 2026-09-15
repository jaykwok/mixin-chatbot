import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLogTail, loadTunnelLogging } from "../../scripts/ops/tui/data.ts";
import { opsCommand } from "../../scripts/ops/tui/platform.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const sh = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

for (const shell of ["powershell", "bash"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " 隧道日志切换保留凭据、日志和原运行状态，失败恢复，拒绝未托管或自定义连接器",
    async () => {
      for (const scenario of ["running-on", "running-off", "stopped", "absent", "unchanged", "default-off",
        "unowned", "custom", "stop-fail", "stop-partial", "start-fail", "save-fail", "lock", ...(shell === "powershell" ? ["no-admin", "write-fail"] : [])]) {
        const fixture = await tempFixture("tunnel logging-");
        try {
          const config = join(fixture.root, "data/config");
          const preference = join(config, "cloudflared-logging");
          await mkdir(config, { recursive: true });
          await mkdir(join(fixture.root, "data/state"), { recursive: true });
          await mkdir(join(fixture.root, "logs"));
          const token = join(config, "cloudflared-token");
          const log = join(fixture.root, "logs/cloudflared.log");
          await writeFile(token, "unchanged-fixture-credential");
          await writeFile(log, "previous diagnostic record\n");
          if (scenario !== "unowned") await writeFile(join(fixture.root, "data/state/cloudflared-managed"), "Cloudflared");
          const old = ["running-off", "unchanged"].includes(scenario) ? "on" : "off";
          const mode = ["running-off", "default-off"].includes(scenario) ? "off" : "on";
          const original = old === "on" ? "on\r\n" : null;
          if (original) await writeFile(preference, original);
          const running = !["stopped", "absent"].includes(scenario);
          const events = join(fixture.root, "events");
          const state = join(fixture.root, "state");
          await writeFile(events, "");
          await writeFile(state, running ? "101" : "0");
          const executable = join(fixture.root, shell === "powershell" ? "cloudflared.exe" : "cloudflared");
          await writeFile(executable, shell === "bash" ? "#!/usr/bin/env bash\nexit 0\n" : "fixture");
          await chmod(executable, 0o755);
          const runner = join(fixture.root, shell === "powershell" ? "run.ps1" : "run.sh");
          if (shell === "powershell") {
            await writeFile(runner, "\ufeff" + [
              "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
              ". " + ps(join(project, "scripts/lib/tunnel-logging.ps1")),
              "$root=$env:FIXTURE_ROOT; $script:running=([IO.File]::ReadAllText($env:FIXTURE_STATE) -ne '0')",
              "$script:command=Get-CloudflaredServiceCommand $root (Join-Path $root 'cloudflared.exe') (Join-Path $root 'data/config/cloudflared-token') $env:FIXTURE_OLD",
              "if($env:FIXTURE_SCENARIO -eq 'custom'){$script:command+=' --protocol http2'}",
              "function Record([string]$text){[IO.File]::AppendAllText($env:FIXTURE_EVENTS,$text+[Environment]::NewLine)}",
              "function Test-CloudflaredAdministrator {$env:FIXTURE_SCENARIO -ne 'no-admin'}",
              "function Get-Service {param($Name,$ErrorAction); if($env:FIXTURE_SCENARIO -ne 'absent'){[pscustomobject]@{Status=$(if($script:running){'Running'}else{'Stopped'})}}}",
              "function Get-CimInstance {param($ClassName,$Filter,$ErrorAction); [pscustomobject]@{PathName=$script:command}}",
              "function Stop-Service {param($Name,$ErrorAction); Record 'stop'; if($env:FIXTURE_SCENARIO -eq 'stop-fail'){throw 'injected stop failure'}; $script:running=$false; if($env:FIXTURE_SCENARIO -eq 'stop-partial'){throw 'injected partial stop'}}",
              "function Set-ItemProperty {param($LiteralPath,$Name,$Value,$ErrorAction); $script:command=$Value; Record $(if($Value -match '--loglevel debug'){'write:on'}else{'write:off'}); if($env:FIXTURE_SCENARIO -eq 'write-fail' -and -not $script:wrote){$script:wrote=$true; throw 'injected registration failure'}}",
              "function Start-Service {param($Name,$ErrorAction); Record $(if($script:command -match '--loglevel debug'){'start:on'}else{'start:off'}); if($env:FIXTURE_SCENARIO -eq 'start-fail' -and -not $script:started){$script:started=$true; throw 'injected start failure'}; $script:running=$true}",
              "function Start-Sleep {param($Milliseconds)}",
              "function Set-Service {throw 'must not change startup policy'}",
              "if($env:FIXTURE_SCENARIO -eq 'save-fail'){function Set-CloudflaredLogPreference {throw 'injected save failure'}}",
              "$held=$null; if($env:FIXTURE_SCENARIO -eq 'lock'){$held=[IO.File]::Open((Join-Path $root 'data/state/deploy.lock'),'OpenOrCreate','ReadWrite','None')}",
              "$result=0; try {Set-CloudflaredLogging $root $env:FIXTURE_MODE} catch {Write-Output $_.Exception.Message; $result=1} finally {if($held){$held.Dispose()}}",
              "[IO.File]::WriteAllText($env:FIXTURE_STATE,$(if($script:running){'101'}else{'0'}))",
              "[IO.File]::WriteAllText((Join-Path $root 'command'),$script:command)",
              "exit $result",
            ].join("\n"));
          } else {
            await writeFile(runner, [
              "#!/usr/bin/env bash", "set -uo pipefail", 'PROJECT_DIR="$FIXTURE_ROOT"; TUNNEL_PID_FILE="$PROJECT_DIR/data/state/cloudflared.pid"',
              ". " + sh(posix(join(project, "scripts/lib/common.sh"))),
              'record() { printf "%s\\n" "$1" >> "$FIXTURE_EVENTS"; }',
              'acquire_deploy_lock() { [ "$FIXTURE_SCENARIO" != lock ]; }',
              'managed_cloudflared_pid() { local value; value="$(cat "$FIXTURE_STATE")"; [ "$value" != 0 ] || return 1; printf "%s" "$value"; }',
              'pgrep() { [ "$FIXTURE_SCENARIO" = unowned ]; }',
              'read_cloudflared_command() { cloudflared_command "$FIXTURE_OLD"; CLOUDFLARED_PREVIOUS_COMMAND=("${CLOUDFLARED_COMMAND[@]}"); if [ "$FIXTURE_SCENARIO" = custom ]; then CLOUDFLARED_PREVIOUS_COMMAND+=(--protocol http2); fi; }',
              'stop_managed_cloudflared() { record stop; [ "$FIXTURE_SCENARIO" != stop-fail ] || return 1; printf 0 > "$FIXTURE_STATE"; [ "$FIXTURE_SCENARIO" != stop-partial ]; }',
              'start_managed_cloudflared_command() {',
              '  local mode=off; [[ " $* " != *" --loglevel debug "* ]] || mode=on',
              '  record "start:$mode"; printf "%s\\n" "$@" > "$PROJECT_DIR/command"; printf 202 > "$FIXTURE_STATE"',
              '  if [ "$FIXTURE_SCENARIO" = start-fail ] && [ ! -f "$PROJECT_DIR/started" ]; then touch "$PROJECT_DIR/started"; return 1; fi',
              '}',
              'if [ "$FIXTURE_SCENARIO" = unowned ]; then printf 0 > "$FIXTURE_STATE"; fi',
              'if [ "$FIXTURE_SCENARIO" = save-fail ]; then save_cloudflared_logging() { return 1; }; fi',
              'configure_tunnel_logging "$FIXTURE_MODE"',
            ].join("\n") + "\n");
          }
          const pathForShell = shell === "powershell" ? (value: string) => value : posix;
          const child = Bun.spawn(shell === "powershell"
            ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, "--noprofile", "--norc", posix(runner)], {
            cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FIXTURE_ROOT: pathForShell(fixture.root), FIXTURE_EVENTS: pathForShell(events),
              FIXTURE_STATE: pathForShell(state), FIXTURE_SCENARIO: scenario, FIXTURE_MODE: mode, FIXTURE_OLD: old },
          });
          const timeout = setTimeout(() => child.kill(), 15000);
          let code: number, output: string;
          try {
            const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            code = result[0]; output = result[1] + result[2];
          } finally { clearTimeout(timeout); child.kill(); await child.exited; }
          const success = ["running-on", "running-off", "stopped", "absent", "unchanged", "default-off"].includes(scenario);
          expect(code === 0, scenario + "\n" + output).toBe(success);
          const unchanged = ["unchanged", "default-off"].includes(scenario);
          const expected = success && !unchanged ? mode : original;
          expect(existsSync(preference), scenario).toBe(expected !== null);
          if (expected !== null) expect(await readFile(preference, "utf8"), scenario).toBe(expected);
          expect(await readFile(token, "utf8"), scenario).toBe("unchanged-fixture-credential");
          expect(await readFile(log, "utf8"), scenario).toBe("previous diagnostic record\n");
          expect((await readdir(config)).filter(name => name.includes(".backup-") || name.includes(".tmp"))).toEqual([]);
          const recorded = (await readFile(events, "utf8")).trim().split(/\r?\n/).filter(Boolean);
          if (["unchanged", "default-off", "unowned", "custom", "lock", "no-admin"].includes(scenario)) expect(recorded, scenario).toEqual([]);
          if (!running) expect(recorded.some(event => event === "stop" || event.startsWith("start:")), scenario).toBe(false);
          if (scenario === "start-fail" || scenario === "stop-partial" || scenario === "save-fail" || scenario === "write-fail") {
            expect(recorded.at(-1), scenario).toBe("start:off");
          }
          if (scenario !== "unowned") expect((await readFile(state, "utf8")) !== "0", scenario).toBe(running);
          if (success && scenario.startsWith("running")) expect(recorded.at(-1), scenario).toBe("start:" + mode);
          if (existsSync(join(fixture.root, "command"))) {
            const command = await readFile(join(fixture.root, "command"), "utf8");
            expect(command).not.toContain("unchanged-fixture-credential");
            if (scenario !== "custom" && scenario !== "absent") expect(command.includes("--loglevel"), scenario).toBe((success ? mode : old) === "on");
          }
        } finally { await fixture.cleanup(); }
      }
    }, 60000,
  );
}

test("隧道日志默认关闭，界面与平台命令只传开关，拒绝损坏的配置", async () => {
  const fixture = await tempFixture("tunnel-logging-data-");
  try {
    expect(await loadTunnelLogging(fixture.root)).toBe("off");
    const config = join(fixture.root, "data/config");
    await mkdir(config, { recursive: true });
    for (const value of ["off", "on"] as const) {
      await writeFile(join(config, "cloudflared-logging"), value + "\r\n");
      expect(await loadTunnelLogging(fixture.root)).toBe(value);
      const encoded = opsCommand("windows", ["tunnel-logging", value]).args.at(-1)!;
      expect(JSON.parse(Buffer.from(encoded, "base64").toString())).toEqual({ Command: "tunnel-logging", Target: value });
      expect(opsCommand("linux", ["tunnel-logging", value]).args.slice(1)).toEqual(["tunnel-logging", value]);
    }
    await writeFile(join(config, "cloudflared-logging"), "invalid");
    await expect(loadTunnelLogging(fixture.root)).rejects.toThrow("只接受");
  } finally { await fixture.cleanup(); }
});

test("隧道 JSON 日志显示本机时间、请求与 cfRay，正确识别级别并转义控制字符", async () => {
  const fixture = await tempFixture("tunnel-log-tail-");
  try {
    const path = join(fixture.root, "cloudflared.log");
    expect(await loadLogTail(400, 256 * 1024, path)).toEqual([]);
    await writeFile(path, [
      JSON.stringify({ level: "debug", time: "2026-09-14T13:29:40Z", cfRay: "fixture-ray", message: "POST https://bot.example.test/webhook/fixture HTTP/1.1" }),
      JSON.stringify({ level: "info", message: "Registered tunnel connection" }),
      JSON.stringify({ level: "warn", message: "Retrying" }),
      JSON.stringify({ level: "error", message: "origin unavailable\n\u001b[2J", error: "connection refused" }),
      "2026-09-14 21:29:40 - INFO - old text log",
      '{"level":',
    ].join("\n") + "\n");
    const lines = await loadLogTail(400, 256 * 1024, path);
    expect(lines.map(line => line.level)).toEqual(["debug", "info", "warn", "error", "info", "other"]);
    expect(lines[0]!.text).toContain("POST https://bot.example.test/webhook/fixture");
    expect(lines[0]!.text).toContain('cfRay="fixture-ray"');
    expect(lines[0]!.text).toStartWith(new Date("2026-09-14T13:29:40Z").toLocaleString("sv-SE").replace(",", ""));
    expect(lines[3]!.text).toContain("\\u000a\\u001b");
    expect(lines[3]!.text).not.toContain("\u001b");
    await writeFile(path, JSON.stringify({ level: "debug", message: "after rotation" }) + "\n");
    expect((await loadLogTail(400, 256 * 1024, path)).map(line => line.text)).toEqual([" - DEBUG - after rotation"]);
  } finally { await fixture.cleanup(); }
});
