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
      "$Project=$env:FIXTURE_ROOT; $Port='1011'; $mode='cloudflare'",
      "$WindowsPowerShell='Invoke-FixtureInstaller'",
      "$TunnelManagedFile=Join-Path $Project 'data/state/cloudflared-managed'",
      "function Read-Host { param($Prompt,[switch]$AsSecureString); if(-not $AsSecureString){throw 'token input was not hidden'}; $secure=[Security.SecureString]::new(); foreach($char in $env:FIXTURE_INPUT.ToCharArray()){$secure.AppendChar($char)}; return $secure }",
      "function Get-Service { if($script:installed){@{Status='Running'}} }",
      "function Step($message){}; function Done($message){}; function Warn($message){}",
      "function Invoke-FixtureInstaller {",
      "  if(($args -join ' ') -like ('*'+$env:FIXTURE_INPUT+'*')){throw 'token leaked to argv'}",
      "  if($env:MIXIN_TUNNEL_TOKEN_INPUT -cne $env:FIXTURE_INPUT){throw 'token did not reach child'}",
      "  $script:installed=$true; $global:LASTEXITCODE=0",
      "}",
      "$tokenAst=$null; $errors=$null",
      "$ast=[Management.Automation.Language.Parser]::ParseFile(" + psQuote(join(project, "scripts/deploy/deploy.ps1")) + ",[ref]$tokenAst,[ref]$errors)",
      "if($errors){throw 'deployment script has syntax errors'}",
      "$block=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Clauses[0].Item1.Extent.Text -eq '$mode -eq \"cloudflare\"' -and $node.Extent.Text.Contains('Read-TunnelTokenInput')}, $true))",
      "if($block.Count -ne 1){throw 'missing deployment tunnel flow'}",
      "$env:MIXIN_TUNNEL_TOKEN_INPUT='original-environment'",
      ". ([scriptblock]::Create($block[0].Extent.Text))",
      "if($env:MIXIN_TUNNEL_TOKEN_INPUT -cne 'original-environment'){throw 'environment not restored'}",
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
      'test -z "${MIXIN_TUNNEL_TOKEN_INPUT:-}"',
      'test -z "${TUNNEL_TOKEN:-}"',
      'test -z "${TUNNEL_TOKEN_VALUE:-}"',
    ].join("\n") + "\n");
    await chmod(binary, 0o755);
    const result = await execute([bash!, posixPath(join(fixture.root, "scripts/tunnel/start-tunnel.sh"))], fixture.root, {
      FIXTURE_ROOT: posixPath(fixture.root), MIXIN_TUNNEL_TOKEN_INPUT: tokens[1], TUNNEL_TOKEN: tokens[0], TUNNEL_TOKEN_FILE: "",
    });
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain(tokens[1]!);
    const args = await readFile(join(fixture.root, "args"), "utf8");
    expect(args).toContain("--token-file\n" + posixPath(join(fixture.root, "data/config/cloudflared-token")));
    for (const token of tokens) expect(args).not.toContain(token);
    expect(await readFile(join(fixture.root, "data/config/cloudflared-token"), "utf8")).toBe(tokens[1]!);
    expect(existsSync(join(fixture.root, "data/config/tunnel-token"))).toBe(false);
  } finally { await fixture.cleanup(); }
});
