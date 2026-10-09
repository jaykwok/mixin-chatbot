import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCloudflaredUpdate } from "../../scripts/ops/cloudflared-download.ts";
import { opsCommand } from "../../scripts/ops/tui/platform.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const ps = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const sh = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const posix = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const binary = Buffer.from("synthetic cloudflared candidate");
const metadata = () => ({ shouldUpdate: true, version: "2026.10.0", compressed: false,
  url: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-linux-amd64",
  checksum: createHash("sha256").update(binary).digest("hex") });

test("cloudflared 官方下载先验证元数据、平台和 SHA-256，仅发布完整候选文件", async () => {
  for (const scenario of ["success", "redirect", "no-update", "checksum", "http", "downgrade", "same-version", "bad-version", "compressed", "missing-hash",
    "wrong-platform", "foreign-url", "http-url", "foreign-redirect", "many-redirects", "oversize", "truncated", "metadata-size", "malformed", "aborted", "existing"]) {
    const fixture = await tempFixture("tunnel-download-");
    try {
      const output = join(fixture.root, "candidate");
      const value: Record<string, unknown> = metadata();
      if (scenario === "existing") await writeFile(output, "belongs-to-another-operation");
      if (scenario === "no-update") value.shouldUpdate = false;
      if (scenario === "checksum") value.checksum = "0".repeat(64);
      if (scenario === "downgrade") value.version = "2026.8.0";
      if (scenario === "same-version") value.version = "2026.9.1";
      if (scenario === "bad-version") value.version = "2026.10.0-preview";
      if (scenario === "compressed") value.compressed = true;
      if (scenario === "missing-hash") delete value.checksum;
      if (scenario === "wrong-platform") value.url = String(value.url) + ".exe";
      if (scenario === "foreign-url") value.url = "https://example.com/cloudflared";
      if (scenario === "http-url") value.url = String(value.url).replace("https:", "http:");
      let calls = 0;
      const request = (async (url: string | URL | Request, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        calls++;
        if (calls === 1) {
          const endpoint = new URL(String(url));
          expect(endpoint.origin).toBe("https://update.argotunnel.com");
          expect(Object.fromEntries(endpoint.searchParams)).toEqual({ os: "linux", arch: "amd64", clientVersion: "2026.9.1" });
          expect(init?.redirect).toBe("error");
          return new Response(scenario === "malformed" ? "[" : scenario === "metadata-size" ? "x".repeat(65537) : JSON.stringify(value), { status: scenario === "http" ? 503 : 200 });
        }
        expect(init?.redirect).toBe("manual");
        if (scenario === "many-redirects" || scenario === "foreign-redirect" || (scenario === "redirect" && calls === 2)) {
          return new Response(null, { status: 302, headers: { location: scenario === "foreign-redirect" ? "https://example.com/file" : "https://release-assets.githubusercontent.com/asset" } });
        }
        return new Response(binary, { headers: { "content-length": scenario === "oversize" ? String(129 * 1024 * 1024) : String(binary.length + (scenario === "truncated" ? 1 : 0)) } });
      }) as typeof fetch;
      const signal = scenario === "aborted" ? AbortSignal.abort(new Error("injected abort")) : undefined;
      const work = prepareCloudflaredUpdate({ currentVersion: "2026.9.1", os: "linux", arch: "amd64", output, fetch: request, signal });
      if (["success", "redirect", "no-update"].includes(scenario)) {
        const result = await work;
        expect(result).toEqual(scenario === "no-update" ? { updated: false, version: "2026.9.1" } : { updated: true, version: "2026.10.0" });
        if (result.updated) expect(await readFile(output)).toEqual(binary);
        else { expect(calls).toBe(1); expect(existsSync(output)).toBe(false); }
      } else {
        await expect(work, scenario).rejects.toThrow();
        if (scenario === "existing") expect(await readFile(output, "utf8")).toBe("belongs-to-another-operation");
        else expect(existsSync(output), scenario).toBe(false);
      }
    } finally { await fixture.cleanup(); }
  }
});

test("cloudflared 更新命令在两平台通过已有 TUI 运维协议传递", () => {
  const encoded = opsCommand("windows", ["tunnel-update"]).args.at(-1)!;
  expect(JSON.parse(Buffer.from(encoded, "base64").toString())).toEqual({ Command: "tunnel-update" });
  expect(opsCommand("linux", ["tunnel-update"]).args.slice(1)).toEqual(["tunnel-update"]);
});

const scenarios = ["running", "stopped", "absent", "no-update", "download-fail", "bad-candidate", "custom", "unowned", "pending", "locked",
  "changed-binary", "changed-command", "changed-state", "stop-fail", "replace-fail", "start-fail", "rollback-fail"];
for (const shell of ["powershell", "bash"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " 下载子命令真实传参并保留进度，区分已更新、无更新与失败",
    async () => {
      const fixture = await tempFixture("tunnel download cli-");
      try {
        const scriptDir = join(fixture.root, "scripts/ops"); await mkdir(scriptDir, { recursive: true });
        const candidate = join(fixture.root, "candidate");
        // Run Bun against a synthetic downloader, never query or download an actual release.
        await writeFile(join(scriptDir, "cloudflared-download.ts"), [
          'console.error("SYNTHETIC_DOWNLOAD_PROGRESS");',
          'const args = process.argv.slice(2);',
          'if (args[0] !== "--version" || args[1] !== "2026.9.1" || args[2] !== "--os" || args[4] !== "--arch" || args[5] !== "amd64" || args[6] !== "--output") process.exit(19);',
          'if (process.env.FIXTURE_RESULT === "success") { await Bun.write(args[7]!, "candidate"); console.log("2026.10.0"); }',
          'else process.exitCode = process.env.FIXTURE_RESULT === "none" ? 3 : 1;',
        ].join("\n"));
        for (const result of ["success", "none", "failure"]) {
          const runner = join(fixture.root, shell === "powershell" ? "run.ps1" : "run.sh");
          await writeFile(runner, shell === "powershell" ? "\ufeff" + [
            "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
            ". " + ps(join(project, "scripts/lib/cloudflared-update.ps1")),
            "try {$download=Invoke-CloudflaredDownload $env:FIXTURE_ROOT $env:FIXTURE_BUN '2026.9.1' 'amd64' $env:FIXTURE_CANDIDATE; Write-Output ($download | ConvertTo-Json -Compress)} catch {Write-Output $_.Exception.Message; exit 1}",
          ].join("\n") : [
            "#!/usr/bin/env bash", 'PROJECT_DIR="$FIXTURE_ROOT"', ". " + sh(posix(join(project, "scripts/lib/cloudflared-update.sh"))),
            'download_cloudflared_update 2026.9.1 amd64 "$FIXTURE_CANDIDATE"',
          ].join("\n"));
          const child = Bun.spawn(shell === "powershell" ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, "--noprofile", "--norc", posix(runner)], {
            cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FIXTURE_RESULT: result, FIXTURE_ROOT: shell === "powershell" ? fixture.root : posix(fixture.root),
              FIXTURE_BUN: process.execPath, FIXTURE_CANDIDATE: shell === "powershell" ? candidate : posix(candidate) },
          });
          const timeout = setTimeout(() => child.kill(), 20000);
          try {
            const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            expect(code, stdout + stderr).toBe(result === "success" || (shell === "powershell" && result === "none") ? 0 : result === "none" ? 3 : 1);
            expect(stderr).toContain("SYNTHETIC_DOWNLOAD_PROGRESS");
            if (result === "success") {
              expect(stdout).toContain("2026.10.0"); expect(await readFile(candidate, "utf8")).toBe("candidate");
            }
            if (shell === "powershell" && result === "none") expect(JSON.parse(stdout)).toEqual({ Updated: false, Version: "2026.9.1" });
          } finally { clearTimeout(timeout); child.kill(); await child.exited; }
        }
      } finally { await fixture.cleanup(); }
    }, 90000,
  );
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " cloudflared 更新不提前停机，保留凭据和参数，失败恢复旧程序及运行状态",
    async () => {
      for (const scenario of [...scenarios, ...(shell === "powershell" ? ["permission", "transition", "foreground"] : ["interrupted"])]) {
        const fixture = await tempFixture("tunnel update-");
        try {
          const config = join(fixture.root, "data/config"), state = join(fixture.root, "data/state");
          await mkdir(config, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(join(fixture.root, "logs"));
          for (const [name, text] of [["cloudflared-token", "fixture-credential"], ["cloudflared-logging", "on\r\n"], ["cloudflared-protocol", "http2\r\n"]]) {
            await writeFile(join(config, name!), text!);
          }
          await writeFile(join(fixture.root, "logs/cloudflared.log"), "existing-log\n");
          if (scenario !== "unowned") await writeFile(join(state, "cloudflared-managed"), "Cloudflared");
          if (scenario === "pending") await writeFile(join(state, "deploy-transaction"), "unfinished-fixture");
          const executable = join(fixture.root, shell === "powershell" ? "cloudflared.exe" : "cloudflared");
          const oldBinary = shell === "bash" ? "#!/usr/bin/env bash\n# old-binary\n" : "old-binary";
          const newBinary = shell === "bash" ? "#!/usr/bin/env bash\n# new-binary\n" : "new-binary";
          await writeFile(executable, oldBinary); await chmod(executable, 0o755);
          await writeFile(join(fixture.root, "events"), "");
          await writeFile(join(fixture.root, "state"), ["stopped", "absent", "foreground"].includes(scenario) ? "0" : "101");
          const runner = join(fixture.root, shell === "powershell" ? "run.ps1" : "run.sh");
          if (shell === "powershell") {
            await writeFile(runner, "\ufeff" + [
              "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
              ". " + ps(join(project, "scripts/lib/cloudflared-update.ps1")),
              "$root=$env:FIXTURE_ROOT; $scenario=$env:FIXTURE_SCENARIO; $script:running=([IO.File]::ReadAllText((Join-Path $root 'state')) -ne '0')",
              "$script:command=Get-CloudflaredServiceCommand $root (Join-Path $root 'cloudflared.exe') (Join-Path $root 'data/config/cloudflared-token') 'on' 'http2'",
              "if($scenario -eq 'custom'){$script:command+=' --custom'}; $originalCommand=$script:command",
              "function Record([string]$text){[IO.File]::AppendAllText((Join-Path $root 'events'),$text+[Environment]::NewLine)}",
              "function Test-CloudflaredAdministrator {$scenario -ne 'permission'}",
              "function Get-Service {param($Name,$ErrorAction); if($scenario -ne 'absent'){[pscustomobject]@{Status=$(if($scenario -eq 'transition'){'StopPending'}elseif($script:running){'Running'}else{'Stopped'})}}}",
              "function Get-CimInstance {param($ClassName,$Filter,$ErrorAction); if($ClassName -eq 'Win32_Service'){[pscustomobject]@{PathName=$script:command}}elseif($scenario -eq 'foreground'){[pscustomobject]@{ExecutablePath=(Join-Path $root 'cloudflared.exe')}}}",
              "function Get-CloudflaredUpdateVersion {param($Executable); if($Executable -like '*candidate*'){Record 'verify'; if($scenario -eq 'bad-candidate'){return '2026.8.0'}; return '2026.10.0'}; return '2026.9.1'}",
              "function Invoke-CloudflaredDownload {param($ProjectRoot,$BunPath,$Version,$Arch,$Candidate); Record 'download';",
              "  if($scenario -eq 'no-update'){return [pscustomobject]@{Updated=$false;Version=$Version}}; [IO.File]::WriteAllText($Candidate,'new-binary');",
              "  if($scenario -eq 'download-fail'){throw 'injected checksum failure'}; if($scenario -eq 'changed-binary'){[IO.File]::WriteAllText((Join-Path $root 'cloudflared.exe'),'external-change')};",
              "  if($scenario -eq 'changed-command'){$script:command+=' --external'}; if($scenario -eq 'changed-state'){$script:running=$false}; [pscustomobject]@{Updated=$true;Version='2026.10.0'} }",
              "function Stop-Service {param($Name,$ErrorAction); Record 'stop'; if($scenario -eq 'stop-fail'){throw 'injected stop failure'}; $script:running=$false}",
              "function Start-Service {param($Name,$ErrorAction); Record 'start'; if(($scenario -eq 'start-fail' -and -not $script:started) -or $scenario -eq 'rollback-fail'){$script:started=$true; throw 'injected start failure'}; $script:running=$true}",
              "function Start-Sleep {param($Milliseconds)}",
              "$originalMove=${function:Move-FileOverTarget}",
              "function Move-FileOverTarget {param($Temporary,$Path,[switch]$CreateOnly); Record 'replace'; if($scenario -eq 'replace-fail' -and -not $script:replaced){$script:replaced=$true; throw 'injected replace failure'}; & $originalMove $Temporary $Path -CreateOnly:$CreateOnly}",
              "$held=$null; if($scenario -eq 'locked'){$held=[IO.File]::Open((Join-Path $root 'data/state/deploy.lock'),'OpenOrCreate','ReadWrite','None')}",
              "$result=0; try {Update-ProjectCloudflared $root 'fixture-bun'} catch {Write-Output $_.Exception.Message; $result=1} finally {if($held){$held.Dispose()}}",
              "[IO.File]::WriteAllText((Join-Path $root 'command'),$script:command)",
              "[IO.File]::WriteAllText((Join-Path $root 'original-command'),$originalCommand)",
              "[IO.File]::WriteAllText((Join-Path $root 'state'),$(if($script:running){'101'}else{'0'}))", "exit $result",
            ].join("\n"));
          } else {
            await writeFile(runner, [
              "#!/usr/bin/env bash", "set -uo pipefail", 'PROJECT_DIR="$FIXTURE_ROOT"',
              ". " + sh(posix(join(project, "scripts/lib/common.sh"))),
              ". " + sh(posix(join(project, "scripts/lib/cloudflared-update.sh"))),
              'record() { printf "%s\\n" "$1" >> "$PROJECT_DIR/events"; }',
              'acquire_deploy_lock() { [ "$FIXTURE_SCENARIO" != locked ]; }',
              'managed_cloudflared_pid() { local value; value="$(cat "$PROJECT_DIR/state")"; [ "$value" != 0 ] || return 1; printf "%s" "$value"; }',
              'pgrep() { [ "$FIXTURE_SCENARIO" = unowned ]; }',
              'cloudflared_version() { if [[ "$1" = *candidate ]]; then record verify; [ "$FIXTURE_SCENARIO" != bad-candidate ] && printf 2026.10.0 || printf 2026.8.0; else printf 2026.9.1; fi; }',
              'read_cloudflared_command() { cloudflared_command on http2; CLOUDFLARED_PREVIOUS_COMMAND=("${CLOUDFLARED_COMMAND[@]}"); if [ "$FIXTURE_SCENARIO" = custom ] || [ -f "$PROJECT_DIR/changed-command" ]; then CLOUDFLARED_PREVIOUS_COMMAND+=(--custom); fi; }',
              'download_cloudflared_update() {',
              '  record download; [ "$FIXTURE_SCENARIO" != no-update ] || return 3; printf "%s" "$FIXTURE_NEW_BINARY" > "$3"',
              '  [ "$FIXTURE_SCENARIO" != download-fail ] || return 1',
              '  [ "$FIXTURE_SCENARIO" != changed-binary ] || printf external-change > "$PROJECT_DIR/cloudflared"',
              '  [ "$FIXTURE_SCENARIO" != changed-command ] || touch "$PROJECT_DIR/changed-command"',
              '  [ "$FIXTURE_SCENARIO" != changed-state ] || printf 0 > "$PROJECT_DIR/state"',
              '  printf 2026.10.0', '}',
              'stop_managed_cloudflared() { record stop; [ "$FIXTURE_SCENARIO" != stop-fail ] || return 1; printf 0 > "$PROJECT_DIR/state"; }',
              'start_managed_cloudflared_command() {',
              '  record start; printf "%s\\n" "$@" > "$PROJECT_DIR/command"',
              '  if [ "$FIXTURE_SCENARIO" = interrupted ] && [ ! -f "$PROJECT_DIR/started" ]; then touch "$PROJECT_DIR/started"; kill -TERM "$BASHPID"; fi',
              '  if [ "$FIXTURE_SCENARIO" = rollback-fail ] || { [ "$FIXTURE_SCENARIO" = start-fail ] && [ ! -f "$PROJECT_DIR/started" ]; }; then touch "$PROJECT_DIR/started"; return 1; fi',
              '  printf 202 > "$PROJECT_DIR/state"', '}',
              'mv() { if [ "$FIXTURE_SCENARIO" = replace-fail ] && [[ "$*" = *candidate* ]]; then record replace; return 1; fi; command mv "$@"; }',
              'if [ "$FIXTURE_SCENARIO" = unowned ]; then printf 0 > "$PROJECT_DIR/state"; fi',
              'cloudflared_command on http2; printf "%s\\n" "${CLOUDFLARED_COMMAND[@]}" > "$PROJECT_DIR/original-command"',
              'update_cloudflared',
            ].join("\n") + "\n");
          }
          const child = Bun.spawn(shell === "powershell" ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, "--noprofile", "--norc", posix(runner)], {
            cwd: fixture.root, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
            env: { ...process.env, FIXTURE_ROOT: shell === "powershell" ? fixture.root : posix(fixture.root), FIXTURE_SCENARIO: scenario, FIXTURE_NEW_BINARY: newBinary },
          });
          const timeout = setTimeout(() => child.kill(), 20000);
          let code: number, output: string;
          try {
            const result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            code = result[0]; output = result[1] + result[2];
          } finally { clearTimeout(timeout); child.kill(); await child.exited; }
          const success = ["running", "stopped", "absent", "no-update"].includes(scenario);
          expect(code === 0, shell + " " + scenario + "\n" + output).toBe(success);
          const events = (await readFile(join(fixture.root, "events"), "utf8")).trim().split(/\r?\n/).filter(Boolean);
          const original = await readFile(executable, "utf8");
          expect(original, scenario).toBe(scenario === "changed-binary" ? "external-change" : success && scenario !== "no-update" ? newBinary : oldBinary);
          if (events.includes("stop")) { expect(events.indexOf("verify")).toBeLessThan(events.indexOf("stop")); }
          if (["stopped", "absent", "no-update", "download-fail", "bad-candidate", "custom", "unowned", "pending", "locked", "changed-binary", "changed-command", "changed-state", "permission", "transition", "foreground"].includes(scenario)) {
            expect(events.includes("stop"), scenario).toBe(false); expect(events.includes("start"), scenario).toBe(false);
          }
          if (["custom", "unowned", "pending", "locked", "permission", "transition", "foreground"].includes(scenario)) expect(events).toEqual([]);
          if (scenario === "running") expect(events.filter(value => value === "start")).toHaveLength(1);
          if (["start-fail", "rollback-fail", "interrupted"].includes(scenario)) expect(events.filter(value => value === "start")).toHaveLength(2);
          const running = (await readFile(join(fixture.root, "state"), "utf8")) !== "0";
          expect(running, scenario).toBe(!["stopped", "absent", "foreground", "changed-state", "rollback-fail", ...(shell === "bash" ? ["unowned"] : [])].includes(scenario));
          if (existsSync(join(fixture.root, "command")) && scenario !== "changed-command") {
            expect(await readFile(join(fixture.root, "command"), "utf8")).toBe(await readFile(join(fixture.root, "original-command"), "utf8"));
          }
          for (const [name, text] of [["cloudflared-token", "fixture-credential"], ["cloudflared-logging", "on\r\n"], ["cloudflared-protocol", "http2\r\n"]]) {
            expect(await readFile(join(config, name!), "utf8")).toBe(text!);
          }
          expect(await readFile(join(fixture.root, "logs/cloudflared.log"), "utf8")).toBe("existing-log\n");
          const stages = (await readdir(fixture.root)).filter(name => name.startsWith(".cloudflared-update-"));
          expect(stages.length, scenario).toBe(scenario === "rollback-fail" ? 1 : 0);
          if (scenario === "rollback-fail") {
            expect(output).toContain("恢复也失败");
            expect(await readFile(join(fixture.root, stages[0]!, shell === "powershell" ? "previous.exe" : "previous"), "utf8")).toBe(oldBinary);
          }
        } finally { await fixture.cleanup(); }
      }
    }, 240000,
  );
}
