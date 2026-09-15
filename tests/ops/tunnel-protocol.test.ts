import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTunnelProtocol } from "../../scripts/ops/tui/data.ts";
import { opsCommand } from "../../scripts/ops/tui/platform.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const sh = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

test("连接模式默认 auto，三个值正确传给各平台，损坏配置被拒绝", async () => {
  const fixture = await tempFixture("tunnel-protocol-data-");
  try {
    expect(await loadTunnelProtocol(fixture.root)).toBe("auto");
    const config = join(fixture.root, "data/config");
    await mkdir(config, { recursive: true });
    for (const mode of ["auto", "http2", "quic"] as const) {
      await writeFile(join(config, "cloudflared-protocol"), mode + "\r\n");
      expect(await loadTunnelProtocol(fixture.root)).toBe(mode);
      const encoded = opsCommand("windows", ["tunnel-protocol", mode]).args.at(-1)!;
      expect(JSON.parse(Buffer.from(encoded, "base64").toString())).toEqual({ Command: "tunnel-protocol", Target: mode });
      expect(opsCommand("linux", ["tunnel-protocol", mode]).args.slice(1)).toEqual(["tunnel-protocol", mode]);
    }
    for (const invalid of ["", "AUTO", "h2", "http2\nquic"]) {
      await writeFile(join(config, "cloudflared-protocol"), invalid);
      await expect(loadTunnelProtocol(fixture.root)).rejects.toThrow("只接受");
    }
  } finally { await fixture.cleanup(); }
});

for (const shell of ["powershell", "bash"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " 切换三种连接模式保留日志与凭据，停止时不启动，失败恢复原参数和配置",
    async () => {
      for (const scenario of ["http2", "quic", "auto", "stopped", "absent", "unchanged", "invalid", "legacy", "start-fail", "default-fail"]) {
        const fixture = await tempFixture("tunnel protocol-");
        try {
          const config = join(fixture.root, "data/config");
          await mkdir(config, { recursive: true });
          await mkdir(join(fixture.root, "data/state"), { recursive: true });
          await mkdir(join(fixture.root, "logs"));
          const preference = join(config, "cloudflared-protocol");
          const old = ["quic", "auto", "start-fail", "unchanged"].includes(scenario) ? "http2" : "auto";
          const mode = scenario === "auto" ? "auto" : scenario === "quic" || scenario === "start-fail" ? "quic"
            : scenario === "invalid" ? "not-a-protocol" : "http2";
          const original = old === "auto" ? null : old + "\r\n";
          if (original !== null) await writeFile(preference, original);
          await writeFile(join(config, "cloudflared-logging"), "on\r\n");
          await writeFile(join(config, "cloudflared-token"), "fixture-credential");
          await writeFile(join(fixture.root, "logs/cloudflared.log"), "existing-log\n");
          await writeFile(join(fixture.root, "data/state/cloudflared-managed"), "Cloudflared");
          const running = !["stopped", "absent"].includes(scenario);
          const executable = join(fixture.root, shell === "powershell" ? "cloudflared.exe" : "cloudflared");
          await writeFile(executable, "#!/usr/bin/env bash\nexit 0\n");
          await chmod(executable, 0o755);
          await writeFile(join(fixture.root, "events"), "");
          await writeFile(join(fixture.root, "state"), running ? "101" : "0");
          const runner = join(fixture.root, shell === "powershell" ? "run.ps1" : "run.sh");
          if (shell === "powershell") {
            await writeFile(runner, "\ufeff" + [
              "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
              ". " + ps(join(project, "scripts/lib/tunnel-logging.ps1")),
              "$root=$env:FIXTURE_ROOT; $script:running=([IO.File]::ReadAllText((Join-Path $root 'state')) -ne '0')",
              "$script:command=Get-CloudflaredServiceCommand $root (Join-Path $root 'cloudflared.exe') (Join-Path $root 'data/config/cloudflared-token') 'on'",
              "if($env:FIXTURE_SCENARIO -eq 'legacy'){$script:command=$script:command.Replace(' --protocol auto','')}",
              "$originalCommand=$script:command",
              "function Record([string]$text){[IO.File]::AppendAllText((Join-Path $root 'events'),$text+[Environment]::NewLine)}",
              "function Test-CloudflaredAdministrator {$true}",
              "function Get-Service {param($Name,$ErrorAction); if($env:FIXTURE_SCENARIO -ne 'absent'){[pscustomobject]@{Status=$(if($script:running){'Running'}else{'Stopped'})}}}",
              "function Get-CimInstance {param($ClassName,$Filter,$ErrorAction); [pscustomobject]@{PathName=$script:command}}",
              "function Stop-Service {param($Name,$ErrorAction); Record 'stop'; $script:running=$false}",
              "function Set-ItemProperty {param($LiteralPath,$Name,$Value,$ErrorAction); $script:command=$Value; Record 'write'}",
              "function Start-Service {param($Name,$ErrorAction); Record 'start'; if($env:FIXTURE_SCENARIO -in @('start-fail','default-fail') -and -not $script:started){$script:started=$true; throw 'injected start failure'}; $script:running=$true}",
              "function Start-Sleep {param($Milliseconds)}",
              "$result=0; try {Set-CloudflaredProtocol $root $env:FIXTURE_MODE} catch {Write-Output $_.Exception.Message; $result=1}",
              "if($result -ne 0 -and $script:command -cne $originalCommand){throw 'original command not restored'}",
              "[IO.File]::WriteAllText((Join-Path $root 'command'),$script:command)",
              "[IO.File]::WriteAllText((Join-Path $root 'state'),$(if($script:running){'101'}else{'0'}))",
              "exit $result",
            ].join("\n"));
          } else {
            await writeFile(runner, [
              "#!/usr/bin/env bash", "set -uo pipefail", 'PROJECT_DIR="$FIXTURE_ROOT"',
              ". " + sh(posix(join(project, "scripts/lib/common.sh"))),
              'record() { printf "%s\\n" "$1" >> "$PROJECT_DIR/events"; }',
              'acquire_deploy_lock() { return 0; }',
              'managed_cloudflared_pid() { local value; value="$(cat "$PROJECT_DIR/state")"; [ "$value" != 0 ] || return 1; printf "%s" "$value"; }',
              'pgrep() { return 1; }',
              'read_cloudflared_command() {',
              '  cloudflared_command on "$FIXTURE_OLD" || return 1',
              '  CLOUDFLARED_PREVIOUS_COMMAND=("${CLOUDFLARED_COMMAND[@]}")',
              '  if [ "$FIXTURE_SCENARIO" = legacy ]; then CLOUDFLARED_PREVIOUS_COMMAND=("${CLOUDFLARED_COMMAND[@]:0:3}" "${CLOUDFLARED_COMMAND[@]:5}"); fi',
              '}',
              'stop_managed_cloudflared() { record stop; printf 0 > "$PROJECT_DIR/state"; }',
              'start_managed_cloudflared_command() {',
              '  record start; printf "%s\\n" "$@" > "$PROJECT_DIR/command"; printf 202 > "$PROJECT_DIR/state"',
              '  if [[ "$FIXTURE_SCENARIO" = *fail ]] && [ ! -f "$PROJECT_DIR/started" ]; then touch "$PROJECT_DIR/started"; return 1; fi',
              '}',
              'configure_tunnel_protocol "$FIXTURE_MODE"',
            ].join("\n") + "\n");
          }
          const child = Bun.spawn(shell === "powershell"
            ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, "--noprofile", "--norc", posix(runner)], {
            cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FIXTURE_ROOT: shell === "powershell" ? fixture.root : posix(fixture.root),
              FIXTURE_SCENARIO: scenario, FIXTURE_MODE: mode, FIXTURE_OLD: old },
          });
          const timeout = setTimeout(() => child.kill(), 15000);
          let code: number, output: string;
          try {
            const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            code = result[0]; output = result[1] + result[2];
          } finally { clearTimeout(timeout); child.kill(); await child.exited; }
          const success = !["invalid", "legacy", "start-fail", "default-fail"].includes(scenario);
          expect(code === 0, scenario + "\n" + output).toBe(success);
          const expected = success && scenario !== "unchanged" ? mode : original;
          expect(existsSync(preference), scenario).toBe(expected !== null);
          if (expected !== null) expect(await readFile(preference, "utf8"), scenario).toBe(expected);
          expect(await readFile(join(config, "cloudflared-logging"), "utf8")).toBe("on\r\n");
          expect(await readFile(join(config, "cloudflared-token"), "utf8")).toBe("fixture-credential");
          expect(await readFile(join(fixture.root, "logs/cloudflared.log"), "utf8")).toBe("existing-log\n");
          expect((await readFile(join(fixture.root, "state"), "utf8")) !== "0", scenario).toBe(running);
          const events = await readFile(join(fixture.root, "events"), "utf8");
          if (!running) expect(events).not.toMatch(/start|stop/);
          if (["invalid", "legacy", "unchanged"].includes(scenario)) expect(events).toBe("");
          if (["start-fail", "default-fail"].includes(scenario)) expect(events.trim()).toEndWith("start");
          const commandPath = join(fixture.root, "command");
          if (existsSync(commandPath) && scenario !== "legacy" && scenario !== "absent") {
            const command = (await readFile(commandPath, "utf8")).replaceAll("\n", " ");
            expect(command).toContain("--protocol " + (success ? mode : old));
            expect(command).toContain("--loglevel debug");
            expect(command).toContain("--token-file");
            expect(command).not.toContain("fixture-credential");
          }
        } finally { await fixture.cleanup(); }
      }
    }, 60000,
  );
}
