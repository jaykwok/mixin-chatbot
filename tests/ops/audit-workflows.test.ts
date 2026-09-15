import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, stream, shutdownTui, startQueries } from "../../scripts/ops/tui/exec.ts";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const quotePS = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const functionLoader = (file: string, names: string[]) => [
  "$tokens=$null; $errors=$null",
  "$ast=[Management.Automation.Language.Parser]::ParseFile(" + quotePS(file) + ",[ref]$tokens,[ref]$errors)",
  "if($errors.Count){throw ($errors | Out-String)}",
  ...names.map(name => "$definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq " + quotePS(name) + "},$true); if(-not $definition){throw 'missing function'}; Invoke-Expression $definition.Extent.Text"),
].join("\n");

test("deployment health requires a ready matching instance, including UUID with reused PID", async () => {
  startQueries();
  const fixture = await tempFixture("health-protocol-");
  let status = 200;
  const identity = { service: "mixin-chatbot", version: 1, instanceId: crypto.randomUUID(), pid: 42, startedAt: Date.now() };
  let body: unknown = { ...identity, status: "ready" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body, { status }) });
  const port = server.port!;
  await mkdir(join(fixture.root, "data/state"), { recursive: true });
  const instance = join(fixture.root, "data/state/instance.json");
  await writeFile(instance, JSON.stringify({ ...identity, port }));
  const ps = join(fixture.root, "health.ps1");
  await writeFile(ps, "\ufeff" + [
    "$ErrorActionPreference='Stop'",
    ". " + quotePS(join(project, "scripts/lib/common.ps1")),
    functionLoader(join(project, "scripts/deploy/deploy.ps1"), ["Wait-BotHealth"]),
    "$Project=$env:FIXTURE_PROJECT",
    "if(Wait-BotHealth $env:BOT_PORT 1){exit 0}else{exit 1}",
  ].join("\n"));
  try {
    for (const variant of ["ready", "stopping", "wrong-service", "wrong-instance", "wrong-pid", "wrong-port", "503"]) {
      body = { ...identity, status: variant === "stopping" ? "stopping" : "ready",
        ...(variant === "wrong-service" && { service: "other" }),
        ...(variant === "wrong-instance" && { instanceId: crypto.randomUUID() }),
        ...(variant === "wrong-pid" && { pid: 43 }) };
      status = variant === "503" ? 503 : 200;
      await writeFile(instance, JSON.stringify({ ...identity, port: variant === "wrong-port" ? port + 1 : port }));
      const child = Bun.spawn([process.execPath, join(project, "scripts/ops/health-check.ts")], {
        cwd: fixture.root, env: { ...process.env, BOT_PORT: String(port) }, stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, variant + out + err).toBe(variant === "ready" ? 0 : 1);
      if (process.platform === "win32") {
        const result = await capture("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps],
          { env: { FIXTURE_PROJECT: fixture.root, BOT_PORT: String(port) } });
        expect(result.code, variant + result.stderr).toBe(variant === "ready" ? 0 : 1);
      }
    }
  } finally { await server.stop(true); await fixture.cleanup(); }
}, 20000);

test.skipIf(process.platform !== "win32")("TUI cancellation waits for real history maintenance to restore scheduled and foreground bots", async () => {
  const fixture = await tempFixture("protected-maintenance-"), ps = join(fixture.root, "operation.ps1");
  await writeFile(ps, "\ufeff" + [
    "$ErrorActionPreference='Stop'; $TaskName='fixture-only'",
    functionLoader(join(project, "scripts/ops/ops.ps1"), ["Clear-GroupHistory"]),
    "function Step($text){}; function Err($text){throw $text}",
    "function Get-ScheduledTask { if($env:FIXTURE_MODE -eq 'scheduled'){@{State='Running'}} }",
    "function Get-BotPids { if($env:FIXTURE_MODE -eq 'foreground'){@(123)}else{@()} }",
    "function Stop-Bot { [IO.File]::WriteAllText((Join-Path $env:FIXTURE_MARKERS 'stopped'),'yes'); $true }",
    "function Start-Bot { [IO.File]::WriteAllText((Join-Path $env:FIXTURE_MARKERS 'restored'),'yes'); $true }",
    "function Invoke-GroupDataAdmin { [Console]::WriteLine('CLEAR_STARTED'); Start-Sleep -Milliseconds 350; $true }",
    "if(-not (Clear-GroupHistory 'fixture-group')){exit 1}",
  ].join("\n"));
  try {
    for (const mode of ["scheduled", "foreground", "stopped"]) {
      const markers = join(fixture.root, mode); await mkdir(markers);
      let cancelled = false;
      let handle: ReturnType<typeof stream>;
      handle = stream("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps], line => {
        if (line === "CLEAR_STARTED") { cancelled = true; handle.cancel(); handle.cancel(); }
      }, { cancelMode: "finish", env: { FIXTURE_MARKERS: markers, FIXTURE_MODE: mode } });
      await shutdownTui();
      startQueries();
      expect(await handle.done).toBe(0); expect(cancelled).toBe(true);
      expect(await Bun.file(join(markers, "stopped")).exists()).toBe(true);
      expect(await Bun.file(join(markers, "restored")).exists()).toBe(mode !== "stopped");
    }
  } finally { await fixture.cleanup(); }
}, 15000);

test.skipIf(process.platform !== "win32")("Windows service registration uses only a token-file path and verifies the stored command", async () => {
  const fixture = await tempFixture("service-argv-"), ps = join(fixture.root, "service.ps1");
  await writeFile(ps, "\ufeff" + [
    "$ErrorActionPreference='Stop'",
    functionLoader(join(project, "scripts/tunnel/start-tunnel.ps1"), ["Register-ProjectCloudflared"]),
    functionLoader(join(project, "scripts/lib/tunnel-logging.ps1"), ["Get-CloudflaredLogArguments", "Get-CloudflaredServiceCommand"]),
    "function New-EventLog {}",
    "function Get-Service { if($script:exists){@{Status='Running'}} }",
    "function Stop-Service {}",
    "function Set-Service {}",
    "function Set-ItemProperty { param($LiteralPath,$Name,$Value); $script:command=$Value }",
    "function New-Service { param($Name,$DisplayName,$BinaryPathName,$StartupType,$ErrorAction); $script:command=$BinaryPathName }",
    "function Get-CimInstance { @{PathName=$(if($script:bad){'wrong command'}else{$script:command})} }",
    "$executable='C:\\Project With Spaces\\cloudflared.exe'; $tokenFile='C:\\Project With Spaces\\data\\cloudflared-token'",
    "foreach($script:exists in @($true,$false)) { Register-ProjectCloudflared $executable $tokenFile; if($script:command -cne ('\"'+$executable+'\" tunnel --no-autoupdate run --token-file \"'+$tokenFile+'\"')){throw 'wrong command'} }",
    "$script:bad=$true; $rejected=$false; try{Register-ProjectCloudflared $executable $tokenFile}catch{$rejected=$true}; if(-not $rejected){throw 'accepted mismatched service'}",
    "Write-Output 'SERVICE_ARGV_PASSED'",
  ].join("\n"));
  try {
    const result = await capture("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("SERVICE_ARGV_PASSED");
  } finally { await fixture.cleanup(); }
});

test.skipIf(process.platform !== "linux")("original Linux tunnel launcher records the exec process birth identity and removes token from argv", async () => {
  const fixture = await tempFixture("tunnel-launch-");
  const identity = { service: "mixin-chatbot", version: 1, status: "ready", instanceId: crypto.randomUUID(), pid: 42, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(identity) });
  try {
    for (const dir of ["scripts/tunnel", "scripts/lib", "scripts/ops", "src/core", "data/state"]) await mkdir(join(fixture.root, dir), { recursive: true });
    for (const path of ["scripts/tunnel/start-tunnel.sh", "scripts/lib/common.sh", "scripts/lib/lifecycle.sh", "scripts/lib/tunnel-logging.sh", "scripts/ops/health-check.ts", "src/core/health.ts"]) {
      await copyFile(join(project, path), join(fixture.root, path));
    }
    await writeFile(join(fixture.root, "data/state/instance.json"), JSON.stringify({ ...identity, port: server.port }));
    const executable = join(fixture.root, "cloudflared");
    await writeFile(executable, [
      "#!/usr/bin/env bash",
      'if [ "${1:-}" = "--version" ]; then echo "cloudflared version fixture"; exit 0; fi',
      'printf "%s\\n" "$$" > "$FIXTURE_ROOT/exec-pid"',
      'cat "/proc/$$/stat" > "$FIXTURE_ROOT/exec-stat"',
      'printf "%s\\n" "$@" > "$FIXTURE_ROOT/exec-args"',
      'test -z "$TUNNEL_TOKEN"',
    ].join("\n") + "\n");
    await chmod(executable, 0o755);
    const child = Bun.spawn(["bash", join(fixture.root, "scripts/tunnel/start-tunnel.sh")], {
      cwd: fixture.root, env: { ...process.env,
        BOT_PORT: String(server.port), TUNNEL_TOKEN: "eyJ0IjoiZml4dHVyZSIsInMiOiJ0ZXN0In0=", TUNNEL_TOKEN_FILE: "", FIXTURE_ROOT: fixture.root },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
    const [pid, birth] = (await readFile(join(fixture.root, "data/state/cloudflared.pid"), "utf8")).trim().split(" ");
    expect(pid).toBe((await readFile(join(fixture.root, "exec-pid"), "utf8")).trim());
    const stat = await readFile(join(fixture.root, "exec-stat"), "utf8");
    expect(birth).toBe(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]);
    const args = await readFile(join(fixture.root, "exec-args"), "utf8");
    expect(args).toContain("--token-file\n"); expect(args).not.toContain("eyJ0");
  } finally { await server.stop(true); await fixture.cleanup(); }
}, 15000);
