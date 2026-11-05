import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { opsCommand, type Platform } from "../../scripts/ops/shared/platform.ts";
import { upgradeRoutes } from "../../scripts/ops/console/upgrade-routes.ts";
import { operationArgs } from "../../scripts/ops/console/operations.ts";
import { operationPreparer } from "../../scripts/ops/console/prepare-operation.ts";
import { Views } from "../../scripts/ops/console/views.ts";
import type { RouteContext } from "../../scripts/ops/console/routes.ts";
import { tempFixture } from "../helpers/temp.ts";
import { opsShellFunctions } from "../helpers/ops-shell.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const posix = (value: string) => value.replaceAll(String.fromCharCode(92), "/");
const quote = (value: string) => "'" + posix(value).replaceAll("'", "'\\''") + "'";
const quotePS = (value: string) => "'" + value.replaceAll("'", "''") + "'";
async function execute(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: stdout + stderr };
}

for (const platform of ["linux", "windows"] as Platform[]) test.skipIf(platform === "windows" ? process.platform !== "win32" : process.platform !== "linux")(
  `${platform}: console dispatch retains confirmed SHA after origin/main changes; plain CLI still fetches latest`, async () => {
    const fixture = await tempFixture("upgrade-target-");
    try {
      const repo = join(fixture.root, "repo"), marker = join(fixture.root, "target"), fetches = join(fixture.root, "fetches");
      await mkdir(repo);
      const git = async (...args: string[]) => {
        const result = await execute(["git", "-c", "core.autocrlf=false", ...args], repo);
        if (result.code) throw new Error(result.output);
        return result.output.trim();
      };
      await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
      await mkdir(join(repo, "scripts/lib"), { recursive: true });
      await writeFile(join(repo, "scripts/lib/console-lifecycle.json"), '{"protocol":"mixin-console-lifecycle","version":1}');
      const commits: string[] = [];
      for (const value of ["original", "confirmed", "later"]) {
        await writeFile(join(repo, "version.txt"), value); await git("add", "."); await git("commit", "--quiet", "-m", value);
        commits.push(await git("rev-parse", "HEAD"));
      }
      const [original, confirmed, later] = commits as [string, string, string];
      await git("checkout", "--detach", original); await git("update-ref", "refs/remotes/origin/main", confirmed);
      const stateDir = join(repo, "data/state"); await mkdir(stateDir, { recursive: true });
      const sourcePath = platform === "windows" ? "scripts/ops/ops.ps1" : "scripts/ops/ops.sh";
      const source = (await readFile(join(project, sourcePath), "utf8")).replaceAll("\r\n", "\n");
      const script = join(fixture.root, platform === "windows" ? "dispatch.ps1" : "dispatch.sh");
      if (platform === "linux") {
        const start = source.indexOf("\nupdate() {") + 1, end = source.indexOf("\n}\n", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR=${quote(repo)}; STATE_DIR=${quote(stateDir)}
git_here() {
    if [ "\${1:-}" = fetch ]; then
        printf fetch >> ${quote(fetches)}
        git -C "$PROJECT_DIR" update-ref refs/remotes/origin/main ${quote(later)}
    else git -C "$PROJECT_DIR" "$@"; fi
}
operation_start() { :; }; operation_finish() { :; }; operation_stage() { :; }; operation_event() { :; }
operation_capture() { "$@"; }
remove_upgrade_stage() { :; }; acquire_deploy_lock() { :; }; require_git_checkout() { :; }
P() { :; }; ER() { printf '%s\\n' "$*" >&2; }; WA() { :; }; OK() { :; }; after_upgrade() { :; }
run_target_upgrader() { printf '%s' "$1" > ${quote(marker)}; }
docker() { printf '%s\\n' 'real Docker forbidden' >&2; return 97; }
${await opsShellFunctions("core_reported", "finish_update", "finish_lifecycle_result")}
${source.slice(start, end + 3)}
shift
update "$@"
`);
      } else {
        const definition = source.match(/^function Invoke-Update\([^\n]+[\s\S]*?^\}/m)?.[0];
        expect(definition).toBeDefined();
        await writeFile(script, String.fromCharCode(0xfeff) + `param([string]$RequestBase64)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$Project = ${quotePS(repo)}
function Start-OperationLog {}; function Stop-OperationLog {}; function Set-OperationStage {}; function Write-OperationEvent {}
function Write-OperationFailure {}; function Test-Administrator { $true }; function Get-GitPath { 'git' }; function Get-BunPath { 'synthetic-bun' }
function Err($text) { Write-Host $text }; function Done {}; function Warn {}; function Remove-UpgradeStage {}
function Invoke-GitCapture([string[]]$Arguments) {
    if ($Arguments[0] -eq 'archive') {
        [IO.File]::WriteAllText(${quotePS(marker)}, $Arguments[3])
        # Stop at the target-upgrader handoff; no deployment or external process runs.
        return [pscustomobject]@{ ExitCode = 91; Text = 'synthetic handoff' }
    }
    if ($Arguments[0] -eq 'fetch') {
        [IO.File]::AppendAllText(${quotePS(fetches)}, 'fetch')
        & git -C $Project update-ref refs/remotes/origin/main ${quotePS(later)}
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = '' }
    }
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        $text = (& git -C $Project @Arguments 2>&1) -join [Environment]::NewLine
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = "$text".Trim() }
    } finally { $ErrorActionPreference = $previous }
}
${definition}
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64)) | ConvertFrom-Json
Invoke-Update -ConfirmedTarget $request.Target | Out-Null
`);
      }
      const dispatch = async (args: string[]) => {
        await writeFile(marker, ""); await writeFile(fetches, "");
        const command = opsCommand(platform, args);
        const cmd = platform === "windows"
          ? ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-RequestBase64", command.args.at(-1)!]
          : [process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash", posix(script), ...command.args.slice(1)];
        return execute(cmd, fixture.root);
      };
      let checkedFetches = 0;
      const routes = upgradeRoutes(repo, async argv => {
        // The remote response is local synthetic Git data; every other check uses the actual repository.
        if (argv[3] === "fetch") { checkedFetches++; return { code: 0, stdout: "", stderr: "" }; }
        const result = await execute(argv, repo);
        return { code: result.code, stdout: result.output, stderr: "" };
      });
      const context: RouteContext = { body: {}, signal: new AbortController().signal, session: {} as RouteContext["session"] };
      const checked = await routes["POST /api/lifecycle/check-update"]!.run(context) as { target: string };
      expect(checked.target).toBe(confirmed); expect(checkedFetches).toBe(1);
      const params = await operationPreparer(repo, new Views())("update", {
        target: checked.target, switchMain: true, cleanup: "apply", directory: "all",
      }, "fixture");
      await git("update-ref", "refs/remotes/origin/main", later);
      const args = operationArgs("update", params);
      expect(args).toEqual(["update", confirmed]);
      const result = await dispatch(args); expect(result.code, result.output).toBe(0);
      expect(await readFile(marker, "utf8"), result.output).toBe(confirmed); expect(await readFile(fetches, "utf8")).toBe("");
      expect(checkedFetches).toBe(1);
      const ordinary = await dispatch(["update"]);
      expect(ordinary.code, ordinary.output).toBe(0); expect(await readFile(marker, "utf8")).toBe(later);
      expect(await readFile(fetches, "utf8")).toBe("fetch");
      for (const invalid of ["main", "0".repeat(40)]) {
        await dispatch(["update", invalid]); expect(await readFile(marker, "utf8")).toBe("");
        expect(await readFile(fetches, "utf8")).toBe("");
      }
      await writeFile(join(stateDir, platform === "windows" ? "upgrade-transaction" : "deploy-transaction"), "new pending transaction");
      const pending = await dispatch(["update", confirmed]);
      expect(pending.output).toContain("预览后出现未完成的事务"); expect(await readFile(marker, "utf8")).toBe("");
      expect(await git("rev-parse", "HEAD")).toBe(original); expect(await readFile(join(repo, "version.txt"), "utf8")).toBe("original");
    } finally { await fixture.cleanup(); }
  }, 120000,
);
