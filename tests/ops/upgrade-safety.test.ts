import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

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
async function repository(root: string) {
  await mkdir(root);
  const git = async (...args: string[]) => {
    const result = await execute(["git", "-c", "core.autocrlf=false", ...args], root);
    if (result.code) throw new Error(result.output);
    return result.output.trim();
  };
  await git("init", "-b", "main"); await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.invalid");
  const commit = async (name: string) => { await git("add", "."); await git("commit", "--quiet", "-m", name); return git("rev-parse", "HEAD"); };
  return { git, commit };
}

test.skipIf(process.platform !== "win32")("Windows recheck refuses independent HEAD, branch and main changes before stopping", async () => {
  const fixture = await tempFixture("upgrade-identity-");
  try {
    const repo = join(fixture.root, "repo"), { commit } = await repository(repo);
    await writeFile(join(repo, "version.txt"), "original"); const original = await commit("original");
    await writeFile(join(repo, "version.txt"), "concurrent"); const concurrent = await commit("concurrent");
    await writeFile(join(repo, "version.txt"), "target"); const target = await commit("target");
    const source = (await readFile(join(project, "scripts/deploy/upgrade.ps1"), "utf8")).replaceAll("\r\n", "\n");
    const definition = source.match(/^function Assert-SwitchReady \{[\s\S]*?^\}/m)?.[0];
    const start = source.indexOf("    Set-OperationStage 'switch-recheck'"), end = source.indexOf("    if (Test-DeploymentDependenciesReusable", start);
    expect(definition).toBeDefined(); expect(end).toBeGreaterThan(start);
    const script = join(fixture.root, "recheck.ps1");
    await writeFile(script, String.fromCharCode(0xfeff) + `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
$Project = ${quotePS(repo)}; $git = 'git'; $TaskName = 'synthetic'
$OriginalSha = ${quotePS(original)}; $OriginalBranch = 'operator-work'; $TargetSha = ${quotePS(target)}
$snapshot = [pscustomobject]@{ WasRunning = $false }; $pendingPath = $null
function Set-OperationStage {}
function Stop-ProjectBot { $script:stopped = $true; return $true }
${definition}
foreach ($change in @('head', 'branch', 'main', 'none')) {
    & $git -C $Project checkout --quiet --detach $OriginalSha
    & $git -C $Project branch --force main $OriginalSha
    & $git -C $Project checkout --quiet -B operator-work $OriginalSha
    $switchIdentity = Assert-SwitchReady
    switch ($change) {
        'head' { & $git -C $Project reset --quiet --hard ${quotePS(concurrent)} }
        'branch' { & $git -C $Project checkout --quiet -B other-work $OriginalSha }
        'main' { & $git -C $Project branch --force main ${quotePS(concurrent)} }
    }
    if ($LASTEXITCODE -ne 0) { throw 'fixture mutation failed' }
    $before = Get-UpgradeCheckoutIdentity $git $Project
    $index = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $Project '.git/index')))
    $script:stopped = $false; $message = ''
    try {
${source.slice(start, end)}
    } catch { $message = $_.Exception.Message }
    if ($change -eq 'none') {
        if (-not $script:stopped -or $message) { throw ('clean checkout refused: ' + $message) }
        if ((& $git -C $Project rev-parse HEAD).Trim() -ne $TargetSha) { throw 'wrong target' }
    } else {
        if ($script:stopped -or $message -notmatch '检出发生了变化') { throw ('change not refused: ' + $change + ' ' + $message) }
        if ((Get-UpgradeCheckoutIdentity $git $Project).Key -cne $before.Key) { throw 'recheck changed refs' }
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $Project '.git/index'))) -cne $index) { throw 'recheck changed index' }
    }
    Write-Output ('VERIFIED ' + $change)
}
`);
    const result = await execute(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], fixture.root);
    expect(result.code, result.output).toBe(0); expect(result.output.match(/VERIFIED /g)).toHaveLength(4);
  } finally { await fixture.cleanup(); }
}, 120000);

test("Bash resume at target rejects unstaged/staged deployment changes; clean resume still runs", async () => {
  const fixture = await tempFixture("upgrade-resume-clean-");
  try {
    const repo = join(fixture.root, "repo"), { git, commit } = await repository(repo);
    const deploy = join(repo, "scripts/deploy/deploy.sh"), marker = join(fixture.root, "ran");
    await mkdir(join(repo, "scripts/deploy"), { recursive: true });
    await writeFile(deploy, `#!/usr/bin/env bash\nprintf expected > ${quote(marker)}\n`); const original = await commit("original");
    await writeFile(join(repo, "target.txt"), "target"); const target = await commit("target");
    const source = (await readFile(join(project, "scripts/deploy/upgrade.sh"), "utf8")).replaceAll("\r\n", "\n");
    const definition = (name: string) => {
      const start = source.indexOf(name + "() {"), end = source.indexOf("\n}\n", start);
      if (start < 0 || end < 0) throw new Error("Missing function: " + name);
      return source.slice(start, end + 3);
    };
    const script = join(fixture.root, "resume.sh");
    await writeFile(script, `#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR=${quote(repo)}
TARGET_SHA=${quote(target)}; ORIGINAL_SHA=${quote(original)}; ORIGINAL_BRANCH=main; ACTION=continue
declare -A TRANSACTION=([target_sha]="$TARGET_SHA" [original_sha]="$ORIGINAL_SHA" [original_branch]=main)
DEPLOY_RECEIPT=${quote(join(fixture.root, "receipt"))}
TUNNEL_INPUT=''; DEPLOY_PID=''; INTERRUPTED=0
git_here() { git -C "$PROJECT_DIR" "$@"; }
transaction_code_restore_pending() { return 1; }
load_transaction_runtime() { CANDIDATE_PRESENT=1; }
operation_stage() { :; }; operation_finish() { :; }
print_status() { :; }; print_error() { printf '%s\\n' "$*" >&2; }
finish_after_deploy() { return "$DEPLOY_STATUS"; }
docker() { printf '%s\\n' 'real Docker forbidden' >&2; return 97; }
${["tracked_files_clean", "switch_ready", "checkout_target", "forward_signal", "run_deploy", "resume_upgrade"].map(definition).join("\n")}
resume_upgrade
`);
    await writeFile(deploy, `#!/usr/bin/env bash\nprintf unexpected > ${quote(marker)}\n`);
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    for (const staged of [false, true]) {
      if (staged) await git("add", "scripts/deploy/deploy.sh");
      const index = await readFile(join(repo, ".git/index")), content = await readFile(deploy);
      const result = await execute([bash, posix(script)], fixture.root);
      expect(result.code, result.output).toBe(1); expect(result.output).toContain("已跟踪文件有未提交的改动");
      expect(existsSync(marker)).toBe(false); expect(await readFile(deploy)).toEqual(content);
      expect(await readFile(join(repo, ".git/index"))).toEqual(index);
    }
    await git("reset", "--hard", target); await writeFile(join(repo, "notes.txt"), "untracked notes");
    const result = await execute([bash, posix(script)], fixture.root);
    expect(result.code, result.output).toBe(0); expect(await readFile(marker, "utf8")).toBe("expected");
    expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe("untracked notes");
  } finally { await fixture.cleanup(); }
}, 120000);
