import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const quotePS = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const quoteSH = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const posixPath = (value: string) => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());

async function execute(args: string[], cwd: string, env = process.env) {
  const child = Bun.spawn(args, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, output: out + "\n" + err };
  } finally { clearTimeout(timeout); child.kill(); await child.exited; }
}

for (const shell of ["bash", "powershell"] as const) {
  test.skipIf(shell === "powershell" ? process.platform !== "win32" : !bash || !existsSync(bash))(
    `${shell} tunnel installer uses the project binary and verifies downloads before execution or replacement`, async () => {
      const fixture = await tempFixture("tunnel-install-");
      const windows = shell === "powershell";
      const executableName = windows ? "cloudflared.exe" : "cloudflared";
      const pathForShell = windows ? (value: string) => value : posixPath;
      const payload = join(fixture.root, windows ? "payload.exe" : "payload.sh");
      const runner = join(fixture.root, windows ? "install.ps1" : "install.sh");
      const bin = join(fixture.root, "system bin");
      try {
        if (windows) {
          // A harmless real executable exercises PowerShell's native invocation and SHA-256 checks.
          const compile = join(fixture.root, "compile.ps1");
          await writeFile(compile, `\ufeff$ErrorActionPreference='Stop'
Add-Type -OutputAssembly ${quotePS(payload)} -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
public static class Fixture {
    public static int Main(string[] args) {
        if (args.Length != 1 || args[0] != "--version") return 12;
        File.AppendAllText(Environment.GetEnvironmentVariable("FIXTURE_PROBES"), Assembly.GetExecutingAssembly().Location + "\\n");
        Console.WriteLine(Environment.GetEnvironmentVariable("FIXTURE_REJECT_PROBE") == "1" ? "another program" : "cloudflared version fixture");
        return 0;
    }
}
'@
`);
          const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", compile], fixture.root);
          expect(result.code, result.output).toBe(0);
          await writeFile(runner, `\ufeff$ErrorActionPreference='Stop'
. ${quotePS(join(project, "scripts/lib/common.ps1"))}
function Invoke-WebRequest {
    [CmdletBinding()]param([string]$Uri,[string]$OutFile,[switch]$UseBasicParsing,[int]$TimeoutSec)
    [IO.File]::WriteAllText($env:FIXTURE_REQUEST, $Uri)
    if ($env:FIXTURE_DOWNLOAD_FAIL -eq '1') {
        [IO.File]::WriteAllText($OutFile, 'partial download')
        throw 'injected download failure'
    }
    [IO.File]::Copy($env:FIXTURE_PAYLOAD, $OutFile, $true)
}
$env:PATH=$env:FIXTURE_BIN+';'+$env:PATH
$path=Ensure-ProjectCloudflared $env:FIXTURE_ROOT
if ($path -isnot [string]) { throw 'installer did not return one executable path' }
[IO.File]::WriteAllText($env:FIXTURE_RESULT, $path)
`);
        } else {
          await writeFile(payload, `#!/usr/bin/env bash
[ "$#" -eq 1 ] && [ "$1" = '--version' ] || exit 12
printf '%s\\n' "$0" >> "$FIXTURE_PROBES"
if [ "$FIXTURE_REJECT_PROBE" = 1 ]; then echo 'another program'; else echo 'cloudflared version fixture'; fi
`);
          await chmod(payload, 0o755);
          await writeFile(runner, `#!/usr/bin/env bash
set -euo pipefail
. ${quoteSH(posixPath(join(project, "scripts/lib/common.sh")))}
uname() { echo x86_64; }
curl() {
    local output='' url=''
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --output) output="$2"; shift 2 ;;
            *) url="$1"; shift ;;
        esac
    done
    printf '%s' "$url" > "$FIXTURE_REQUEST"
    if [ "$FIXTURE_DOWNLOAD_FAIL" = 1 ]; then
        printf 'partial download' > "$output"
        return 22
    fi
    cp -- "$FIXTURE_PAYLOAD" "$output"
}
export PATH="$FIXTURE_BIN:$PATH"
# The installer's cleanup trap must not replace its caller's deployment rollback trap.
trap 'printf called > "$FIXTURE_PARENT_CLEANUP"' EXIT
ensure_cloudflared "$FIXTURE_ROOT" > "$FIXTURE_RESULT"
`);
        }
        await mkdir(bin);
        await copyFile(payload, join(bin, executableName));
        if (!windows) await chmod(join(bin, executableName), 0o755);
        const bytes = await readFile(payload);
        const checksum = createHash("sha256").update(bytes).digest("hex");
        const oldBytes = Buffer.from("previous invalid cloudflared\n");

        for (const scenario of ["reuse", "install", "replace", "bad-checksum", "download-error", "bad-executable", "bad-manifest"]) {
          const root = join(fixture.root, "repo " + scenario);
          const executable = join(root, executableName);
          const request = join(root, "request-url");
          const probes = join(root, "version-probes");
          const resultPath = join(root, "result");
          await mkdir(join(root, "scripts/tunnel"), { recursive: true });
          // Reusing a root binary must not need a manifest or look for a system install.
          if (scenario !== "reuse") {
            const hash = scenario === "bad-checksum" ? "0".repeat(64) : scenario === "bad-manifest" ? "invalid" : checksum;
            const assets = ["linux-amd64", "windows-amd64.exe", "windows-386.exe"];
            await writeFile(join(root, "scripts/tunnel/cloudflared-release.txt"),
              assets.map(asset => `2026.9.1 cloudflared-${asset} ${hash}\r\n`).join(""));
          }
          if (scenario === "reuse") {
            await copyFile(payload, executable);
            if (!windows) await chmod(executable, 0o755);
          } else if (scenario !== "install") {
            await writeFile(executable, oldBytes);
          }

          const result = await execute(windows
            ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runner]
            : [bash!, posixPath(runner)], fixture.root, {
            ...process.env, BOT_DEPLOY_BACKUP_ID: "",
            FIXTURE_ROOT: pathForShell(root), FIXTURE_PAYLOAD: pathForShell(payload), FIXTURE_BIN: pathForShell(bin),
            FIXTURE_REQUEST: pathForShell(request), FIXTURE_PROBES: pathForShell(probes), FIXTURE_RESULT: pathForShell(resultPath),
            FIXTURE_PARENT_CLEANUP: pathForShell(join(root, "parent-cleanup")),
            FIXTURE_DOWNLOAD_FAIL: scenario === "download-error" ? "1" : "0",
            FIXTURE_REJECT_PROBE: scenario === "bad-executable" ? "1" : "0",
          });
          const succeeded = ["reuse", "install", "replace"].includes(scenario);
          expect(result.code === 0, scenario + result.output).toBe(succeeded);
          expect(await readFile(executable), scenario).toEqual(succeeded ? bytes : oldBytes);
          expect((await readdir(root)).filter(name => name.startsWith(executableName + ".download-")), scenario).toEqual([]);
          if (succeeded) expect((await readFile(resultPath, "utf8")).trim()).toBe(pathForShell(executable));
          if (!windows) expect(await readFile(join(root, "parent-cleanup"), "utf8")).toBe("called");

          const downloaded = !["reuse", "bad-manifest"].includes(scenario);
          expect(existsSync(request), scenario).toBe(downloaded);
          if (downloaded) {
            const url = await readFile(request, "utf8");
            expect(url).toStartWith("https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/");
            expect(url).toMatch(windows ? /\/cloudflared-windows-(amd64|386)\.exe$/ : /\/cloudflared-linux-amd64$/);
          }
          // Hash mismatch and download failure must never execute the downloaded bytes.
          const executed = existsSync(probes) ? (await readFile(probes, "utf8")).trim().split(/\r?\n/) : [];
          expect(executed, scenario).toHaveLength(succeeded || scenario === "bad-executable" ? 1 : 0);
          if (executed.length) {
            expect(executed[0]).not.toContain("system bin");
            if (scenario !== "reuse") expect(executed[0]).toContain(executableName + ".download-");
          }
          if (scenario === "replace") {
            const archive = join(root, "backup/rm");
            const files = await readdir(archive);
            expect(files).toHaveLength(1);
            expect(await readFile(join(archive, files[0]!))).toEqual(oldBytes);
          } else {
            expect(existsSync(join(root, "backup/rm")), scenario).toBe(false);
          }
        }
      } finally { await fixture.cleanup(); }
    }, 60000,
  );
}
