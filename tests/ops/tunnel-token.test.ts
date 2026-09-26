import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const shQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const posixPath = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const tokens = [0, 1, 2].map(padding => Buffer.from(JSON.stringify({
  a: "fixture-account", t: "fixture-tunnel", s: "fixture-secret-" + "x".repeat(240 + padding),
})).toString("base64"));

async function execute(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(args, { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: out + err };
  } finally { clearTimeout(timer); child.kill(); await child.exited; }
}

for (const shell of ["powershell", "bash"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    shell + " tunnel credentials support one default file, pasted tokens and explicit paths without disclosure", async () => {
      const fixture = await tempFixture("tunnel-token-");
      const windows = shell === "powershell";
      const pathForShell = windows ? (value: string) => value : posixPath;
      const runner = join(fixture.root, windows ? "resolve.ps1" : "resolve.sh");
      try {
        await writeFile(runner, windows ? "\ufeff" + [
          "$ErrorActionPreference='Stop'",
          ". " + psQuote(join(project, "scripts/lib/common.ps1")),
          "try {",
          "  $source=Resolve-TunnelToken $env:FIXTURE_ROOT $env:FIXTURE_INPUT",
          "  $path=Save-ProjectTunnelToken $env:FIXTURE_ROOT $source.Token",
          "  [Console]::WriteLine('source='+$source.Display)",
          "  [IO.File]::WriteAllText($env:FIXTURE_RESULT,$path)",
          "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
        ].join("\n") : [
          "#!/usr/bin/env bash", "set -euo pipefail",
          ". " + shQuote(posixPath(join(project, "scripts/lib/common.sh"))),
          'PROJECT_DIR="$FIXTURE_ROOT"',
          'load_tunnel_token "$FIXTURE_INPUT"',
          'save_project_tunnel_token "$TUNNEL_TOKEN_VALUE" > "$FIXTURE_RESULT"',
          'printf "source=%s\\n" "$TUNNEL_TOKEN_SOURCE"',
        ].join("\n") + "\n");

        const scenarios: Array<{
          name: string; current?: string; legacy?: string; input?: string; file?: string;
          envFile?: string; envToken?: string; expected?: string; reuse?: boolean;
        }> = [
          ...tokens.map((token, index) => ({ name: "default-padding-" + index, current: token, expected: token, reuse: true })),
          { name: "formatted-default", current: "\ufeff" + tokens[0] + "\r\n", expected: tokens[0] },
          { name: "old-name-ignored", legacy: tokens[0] },
          { name: "prefer-current", current: tokens[0], legacy: tokens[1], expected: tokens[0], reuse: true },
          { name: "pasted", current: tokens[0], input: ' "' + tokens[1] + '" ', envFile: "missing.env", envToken: tokens[2], expected: tokens[1] },
          { name: "relative-file", current: tokens[0], input: '"token source.env"', file: "TUNNEL_TOKEN='" + tokens[1] + "'\r\nOTHER=value", envFile: "missing.env", expected: tokens[1] },
          { name: "env-file", current: tokens[0], envFile: "token source.env", file: "\ufeffexport TUNNEL_TOKEN=\"" + tokens[1] + "\"\r\n", envToken: tokens[2], expected: tokens[1] },
          { name: "env-token", current: tokens[0], envToken: tokens[2], expected: tokens[2] },
          { name: "invalid-current", current: "invalid-token", legacy: tokens[0] },
          { name: "missing-env-file", current: tokens[0], envFile: "missing.env", envToken: tokens[1] },
          { name: "empty-assignment", current: tokens[0], input: "token source.env", file: "TUNNEL_TOKEN=''\r\nOTHER=must-not-be-a-token" },
          { name: "unrelated-env", current: tokens[0], input: "token source.env", file: "OTHER=must-not-be-a-token" },
          { name: "invalid-paste", current: tokens[0], input: tokens[1] + "!invalid" },
          { name: "missing-input-file", current: tokens[0], input: "missing token file with a very long name.env" },
          { name: "missing-default" },
        ];
        for (const scenario of scenarios) {
          const root = join(fixture.root, scenario.name), config = join(root, "data/config");
          const current = join(config, "cloudflared-token"), legacy = join(config, "tunnel-token");
          await mkdir(config, { recursive: true });
          if (scenario.current !== undefined) await writeFile(current, scenario.current);
          if (scenario.legacy !== undefined) await writeFile(legacy, scenario.legacy);
          if (scenario.file !== undefined) await writeFile(join(root, "token source.env"), scenario.file);
          const before = scenario.reuse ? (await stat(current)).mtimeMs : undefined;
          const result = await execute(windows
            ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, posixPath(runner)], fixture.root, {
              FIXTURE_ROOT: pathForShell(root), FIXTURE_RESULT: pathForShell(join(root, "result")),
              FIXTURE_INPUT: scenario.input ?? "", TUNNEL_TOKEN: scenario.envToken ?? "", TUNNEL_TOKEN_FILE: scenario.envFile ?? "",
            });
          expect(result.code === 0, scenario.name + ": " + result.output).toBe(scenario.expected !== undefined);
          for (const token of tokens) expect(result.output, scenario.name).not.toContain(token);
          if (scenario.expected !== undefined) {
            expect(await readFile(current, "utf8"), scenario.name).toBe(scenario.expected);
            expect(await readFile(join(root, "result"), "utf8"), scenario.name).toBe(pathForShell(current));
            if (before !== undefined) expect((await stat(current)).mtimeMs, scenario.name).toBe(before);
            if (process.platform !== "win32") expect((await stat(current)).mode & 0o777).toBe(0o600);
          } else {
            expect(existsSync(current), scenario.name).toBe(scenario.current !== undefined);
            if (scenario.current !== undefined) expect(await readFile(current, "utf8"), scenario.name).toBe(scenario.current);
          }
          expect(existsSync(legacy), scenario.name).toBe(scenario.legacy !== undefined);
          if (scenario.legacy !== undefined) expect(await readFile(legacy, "utf8"), scenario.name).toBe(scenario.legacy);
        }
      } finally { await fixture.cleanup(); }
    }, 60000,
  );
}

test.skipIf(process.platform !== "win32")("Windows deployment hides pasted credentials, passes them outside argv and restores its environment", async () => {
  const fixture = await tempFixture("tunnel-input-"), runner = join(fixture.root, "deploy.ps1");
  try {
    await writeFile(runner, "\ufeff" + [
      "$ErrorActionPreference='Stop'",
      ". " + psQuote(join(project, "scripts/lib/common.ps1")),
      "$Project=$env:FIXTURE_ROOT; $Port='1011'; $mode='cloudflare'; $preflightTunnelService=$null",
      "$WindowsPowerShell='Invoke-FixtureInstaller'",
      "$TunnelManagedFile=Join-Path $Project 'data/state/cloudflared-managed'",
      "function Read-Host { param($Prompt,[switch]$AsSecureString); if(-not $AsSecureString){throw 'token input was not hidden'}; if($script:stopped){throw 'token requested after stop'}; $secure=[Security.SecureString]::new(); foreach($char in $env:FIXTURE_INPUT.ToCharArray()){$secure.AppendChar($char)}; return $secure }",
      "function Get-Service { if($script:installed){@{Status='Running'}} }",
      "function Step($message){}; function Done($message){}; function Warn($message){}; function Fail($message){}",
      "function Invoke-FixtureInstaller {",
      "  if(($args -join ' ') -like ('*'+$env:FIXTURE_INPUT+'*')){throw 'token leaked to argv'}",
      "  if($env:MIXIN_TUNNEL_TOKEN_INPUT -cne $env:FIXTURE_INPUT){throw 'token did not reach child'}",
      "  if($env:MIXIN_TUNNEL_ALLOW_VERIFICATION -ne '1'){throw 'verification instance not allowed for the installer'}",
      "  $script:installed=$true; $global:LASTEXITCODE=0",
      "}",
      "$tokenAst=$null; $errors=$null",
      "$ast=[Management.Automation.Language.Parser]::ParseFile(" + psQuote(join(project, "scripts/deploy/deploy.ps1")) + ",[ref]$tokenAst,[ref]$errors)",
      "if($errors){throw 'deployment script has syntax errors'}",
      "function Find-Block([string]$condition,[string]$marker) { $found=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq $condition -and $node.Extent.Text.Contains($marker)}.GetNewClosure(), $true)); if($found.Count -ne 1){throw ('missing block: '+$condition)}; $found[0].Extent.Text }",
      "$collect=Find-Block '$mode -eq \"cloudflare\" -and -not $preflightTunnelService' 'Read-TunnelTokenInput'",
      "$install=Find-Block '$mode -eq \"cloudflare\"' 'start-tunnel.ps1'",
      "$env:MIXIN_TUNNEL_TOKEN_INPUT='original-environment'; $env:MIXIN_TUNNEL_ALLOW_VERIFICATION='original-policy'",
      ". ([scriptblock]::Create($collect))",
      "$script:stopped=$true",
      ". ([scriptblock]::Create($install))",
      "if($env:MIXIN_TUNNEL_TOKEN_INPUT -cne 'original-environment' -or $env:MIXIN_TUNNEL_ALLOW_VERIFICATION -cne 'original-policy'){throw 'environment not restored'}",
      "if(-not $script:installed){throw 'installer not called'}",
      "Write-Output 'TUNNEL_INPUT_PASSED'",
    ].join("\n"));
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner], fixture.root, {
      FIXTURE_ROOT: fixture.root, FIXTURE_INPUT: tokens[0], TUNNEL_TOKEN: "", TUNNEL_TOKEN_FILE: "",
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("TUNNEL_INPUT_PASSED");
    expect(result.output).not.toContain(tokens[0]!);
  } finally { await fixture.cleanup(); }
});

test.skipIf(!bash || !existsSync(bash))("the original shell launcher consumes pasted input and runs cloudflared with only the canonical token path", async () => {
  const fixture = await tempFixture("tunnel-launch-input-");
  try {
    await mkdir(join(fixture.root, "scripts/tunnel"), { recursive: true });
    await mkdir(join(fixture.root, "scripts/lib"), { recursive: true });
    await copyFile(join(project, "scripts/tunnel/start-tunnel.sh"), join(fixture.root, "scripts/tunnel/start-tunnel.sh"));
    await writeFile(join(fixture.root, "scripts/lib/common.sh"), [
      ". " + shQuote(posixPath(join(project, "scripts/lib/common.sh"))),
      "managed_cloudflared_pid() { return 1; }",
      "bot_local_ready() { return 0; }",
      "record_cloudflared_pid() { :; }",
    ].join("\n") + "\n");
    const binary = join(fixture.root, "cloudflared");
    await writeFile(binary, [
      "#!/usr/bin/env bash", "set -euo pipefail",
      'if [ "${1:-}" = --version ]; then echo "cloudflared version fixture"; exit 0; fi',
      'printf "%s\\n" "$@" > "$FIXTURE_ROOT/args"',
      'printf "fixture-native-output\\n"',
      'test -z "${MIXIN_TUNNEL_TOKEN_INPUT:-}"',
      'test -z "${TUNNEL_TOKEN:-}"',
      'test -z "${TUNNEL_TOKEN_VALUE:-}"',
    ].join("\n") + "\n");
    await chmod(binary, 0o755);
    for (const mode of ["default", "on", "off", "background"]) {
      const protocol = mode === "on" ? "http2" : mode === "off" ? "quic" : "auto";
      if (mode !== "default") await writeFile(join(fixture.root, "data/config/cloudflared-logging"), mode === "background" ? "on" : mode);
      if (mode !== "default") await writeFile(join(fixture.root, "data/config/cloudflared-protocol"), protocol);
      const result = await execute([bash!, posixPath(join(fixture.root, "scripts/tunnel/start-tunnel.sh"))], fixture.root, {
        FIXTURE_ROOT: posixPath(fixture.root), MIXIN_TUNNEL_TOKEN_INPUT: tokens[1], TUNNEL_TOKEN: tokens[0], TUNNEL_TOKEN_FILE: "",
        CLOUDFLARED_BACKGROUND: mode === "background" ? "1" : "0", TUNNEL_TRANSPORT_PROTOCOL: "conflicting-environment",
      });
      expect(result.code, result.output).toBe(0);
      expect(result.output).not.toContain(tokens[1]!);
      expect(result.output.includes("fixture-native-output"), mode).toBe(mode !== "background");
      const args = await readFile(join(fixture.root, "args"), "utf8");
      expect(args).toContain("--protocol\n" + protocol + "\n");
      expect(args.includes("--loglevel\ndebug\n--log-directory\n" + posixPath(join(fixture.root, "logs"))), mode).toBe(mode === "on" || mode === "background");
      expect(args).not.toContain("--logfile");
      expect(args).toContain("--token-file\n" + posixPath(join(fixture.root, "data/config/cloudflared-token")));
      for (const token of tokens) expect(args).not.toContain(token);
      expect(await readFile(join(fixture.root, "data/config/cloudflared-token"), "utf8")).toBe(tokens[1]!);
      expect(existsSync(join(fixture.root, "data/config/tunnel-token"))).toBe(false);
    }
  } finally { await fixture.cleanup(); }
}, 30000);

test.skipIf(!bash || !existsSync(bash))("the shell launcher accepts a verification-only instance only when deployment allows it", async () => {
  const fixture = await tempFixture("tunnel-verification-");
  const identity = { instanceId: crypto.randomUUID(), pid: 42, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({
    service: "mixin-chatbot", version: 1, status: "ready", verificationOnly: true, ...identity,
  }) });
  try {
    for (const dir of ["scripts/tunnel", "scripts/lib", "scripts/ops", "src/core", "data/state"]) await mkdir(join(fixture.root, dir), { recursive: true });
    for (const path of ["scripts/tunnel/start-tunnel.sh", "scripts/ops/health-check.ts", "src/core/health.ts"]) await copyFile(join(project, path), join(fixture.root, path));
    // The real health gate runs; only process bookkeeping is stubbed.
    await writeFile(join(fixture.root, "scripts/lib/common.sh"), [
      ". " + shQuote(posixPath(join(project, "scripts/lib/common.sh"))),
      "managed_cloudflared_pid() { return 1; }",
      "record_cloudflared_pid() { :; }",
    ].join("\n") + "\n");
    await writeFile(join(fixture.root, "data/state/instance.json"), JSON.stringify({ ...identity, port: server.port }));
    const binary = join(fixture.root, "cloudflared");
    await writeFile(binary, [
      "#!/usr/bin/env bash",
      'if [ "${1:-}" = --version ]; then echo "cloudflared version fixture"; exit 0; fi',
      'printf "%s\n" "$@" > "$FIXTURE_ROOT/args"',
    ].join("\n") + "\n");
    await chmod(binary, 0o755);
    for (const allowed of [false, true]) {
      const result = await execute([bash!, posixPath(join(fixture.root, "scripts/tunnel/start-tunnel.sh"))], fixture.root, {
        FIXTURE_ROOT: posixPath(fixture.root), BOT_PORT: String(server.port), TUNNEL_TOKEN: tokens[0], TUNNEL_TOKEN_FILE: "",
        MIXIN_TUNNEL_TOKEN_INPUT: "", CLOUDFLARED_BACKGROUND: "0", TUNNEL_ALLOW_NO_BOT: "", MIXIN_TUNNEL_ALLOW_VERIFICATION: allowed ? "1" : "",
      });
      expect(result.code, result.output).toBe(allowed ? 0 : 1);
      expect(result.output).toContain(allowed ? "部署验证实例已就绪" : "已中止");
      expect(existsSync(join(fixture.root, "args")), result.output).toBe(allowed);
    }
    // Docker deployment starts the connector before commit, so it must opt in explicitly.
    const deploy = await readFile(join(project, "scripts/deploy/deploy.sh"), "utf8");
    expect(deploy).toMatch(/MIXIN_TUNNEL_ALLOW_VERIFICATION=1 [^\n]*start-tunnel\.sh/);
  } finally { await server.stop(true); await fixture.cleanup(); }
}, 30000);
