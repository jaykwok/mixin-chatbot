// Rolling back an upgrade restores the old commit with reset --hard / checkout --force, which deletes whatever sits where
// the old version needs a file or a directory. Both platform checks run against real repositories and must agree:
// local work anywhere on such a path (the path itself or any parent) blocks the restore; tracked content does not.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
const quotePS = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Engine = "bash" | "powershell";
type Files = Record<string, string>;

interface Scenario {
  name: string;
  old: Files;
  target: Files;
  /** Changes made after the upgrade, on top of the target checkout. */
  local?: (dir: string) => Promise<void>;
  /** Exact conflict list, or null when the restore is safe. */
  blocked: string[] | null;
  /** File contents expected afterwards: local work kept when blocked, the old version when restored. */
  after: Files;
  /** A link that must still be a link afterwards. */
  link?: string;
  only?: Engine;
}

const parentTaken = "未跟踪的文件或链接占着升级前版本的目录位置：";
const scenarios: Scenario[] = [
  { name: "leaf", old: { "retired.txt": "old" }, target: {}, local: dir => writeFile(join(dir, "retired.txt"), "notes"),
    blocked: ["未跟踪的文件会被升级前的版本覆盖：retired.txt"], after: { "retired.txt": "notes" } },
  { name: "parent-file", old: { "retired/seed.txt": "old" }, target: {}, local: dir => writeFile(join(dir, "retired"), "notes"),
    blocked: [`${parentTaken}retired`], after: { retired: "notes" } },
  { name: "deep-parent", old: { "a/b/c.txt": "old", "a/keep.txt": "kept" }, target: { "a/keep.txt": "kept" },
    local: dir => writeFile(join(dir, "a/b"), "notes"), blocked: [`${parentTaken}a/b`], after: { "a/b": "notes" } },
  { name: "ignored-parent", old: { "cache/seed.txt": "old" }, target: { ".gitignore": "cache\n" },
    local: dir => writeFile(join(dir, "cache"), "notes"), blocked: [`${parentTaken}cache`], after: { cache: "notes" } },
  // A directory junction on Windows, a symbolic link elsewhere; the Linux (Docker) restore runs the bash check.
  { name: "linked-parent", old: { "retired/seed.txt": "old" }, target: {}, only: process.platform === "win32" ? "powershell" : "bash",
    local: async dir => { await mkdir(`${dir}-elsewhere`); await symlink(`${dir}-elsewhere`, join(dir, "retired"), "junction"); },
    blocked: [`${parentTaken}retired`], after: {}, link: "retired" },
  { name: "file-became-directory-with-local-files", old: { retired: "old file" }, target: { "retired/seed.txt": "new" },
    local: dir => writeFile(join(dir, "retired/notes.txt"), "notes"),
    blocked: ["未跟踪的文件会随目录删除（升级前的版本在 retired 是文件）：retired/notes.txt"], after: { "retired/notes.txt": "notes" } },
  // Safe: local files inside a directory the old version also has, and type changes that only involve tracked content.
  { name: "parent-directory-with-local-files", old: { "retired/seed.txt": "old" }, target: {},
    local: async dir => { await mkdir(join(dir, "retired")); await writeFile(join(dir, "retired/notes.txt"), "notes"); },
    blocked: null, after: { "retired/seed.txt": "old", "retired/notes.txt": "notes" } },
  { name: "directory-became-tracked-file", old: { "docs/x.md": "old" }, target: { docs: "now a file" }, blocked: null, after: { "docs/x.md": "old" } },
  { name: "file-became-tracked-directory", old: { retired: "old file" }, target: { "retired/seed.txt": "new" }, blocked: null, after: { retired: "old file" } },
];

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, MSYS_NO_PATHCONV: "1", ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out: out.trim(), output: `${out}${err}` };
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.autocrlf=false",
    "-c", "commit.gpgsign=false", ...args], dir);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.output}`);
  return result.out;
}

async function write(dir: string, files: Files): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

// The old commit, the upgrade to the target on main, then the local changes.
async function repository(dir: string, scenario: Scenario) {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await write(dir, { ...scenario.old, "version.txt": "old" });
  await git(dir, "add", "-A"); await git(dir, "commit", "-qm", "old");
  const original = await git(dir, "rev-parse", "HEAD");
  await git(dir, "rm", "-rq", ".");
  await write(dir, { ...scenario.target, "version.txt": "new" });
  await git(dir, "add", "-A"); await git(dir, "commit", "-qm", "target");
  const target = await git(dir, "rev-parse", "HEAD");
  await scenario.local?.(dir);
  return { original, target };
}

// Each case prints "=== <name>", its conflicts as "- <line>", then SAFE (and restores the old commit) or BLOCKED.
function outcomes(output: string): Map<string, { status: string; conflicts: string[] }> {
  const result = new Map<string, { status: string; conflicts: string[] }>();
  let current: { status: string; conflicts: string[] } | undefined;
  for (const line of output.split(/\r?\n/).map(value => value.trim())) {
    if (line.startsWith("=== ")) result.set(line.slice(4), current = { status: "", conflicts: [] });
    else if (current && /^(SAFE|BLOCKED|RESTORE-FAILED)$/.test(line)) current.status += current.status ? ` ${line}` : line;
    else if (current && line.startsWith("- ")) current.conflicts.push(line.slice(2));
  }
  return result;
}

async function check(engine: Engine, cases: { name: string; dir: string; original: string; target: string }[], cwd: string) {
  if (engine === "bash") {
    const script = join(cwd, "check.sh");
    await writeFile(script, `set -u
. '${posix(join(project, "scripts/lib/common.sh"))}'
operation_event() { :; }
while [ "$#" -gt 0 ]; do
    name="$1" PROJECT_DIR="$2" original="$3" target="$4"; shift 4
    echo "=== $name"
    if code_restore_safe main "$original" "$target" 2>&1; then
        echo SAFE; restore_checkout main "$original" >/dev/null 2>&1 || echo RESTORE-FAILED
    else echo BLOCKED; fi
done
`);
    // PROJECT_DIR as D:/... on Windows: the checks hand it to the native git.exe.
    return run([bash!, posix(script), ...cases.flatMap(item => [item.name, item.dir.replaceAll("\\", "/"), item.original, item.target])], cwd);
  }
  const script = join(cwd, "check.ps1");
  await writeFile(script, `\ufeff$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. ${quotePS(join(project, "scripts/lib/deployment.ps1"))}
$cases=New-Object System.Collections.ArrayList
${cases.map(item => `[void]$cases.Add(@(${[item.name, item.dir, item.original, item.target].map(quotePS).join(",")}))`).join("\n")}
foreach($case in $cases){
    '=== ' + $case[0]
    $conflicts=@(Get-CodeRestoreConflicts 'git' $case[1] 'main' $case[2] $case[3])
    foreach($conflict in $conflicts){ '- ' + $conflict }
    if($conflicts.Count){ 'BLOCKED' } else {
        'SAFE'; & git -C $case[1] checkout -q main; & git -C $case[1] reset -q --hard $case[2]; if($LASTEXITCODE){ 'RESTORE-FAILED' }
    }
}
`);
  return run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], cwd);
}

for (const engine of ["bash", "powershell"] as const) {
  const available = engine === "bash" ? !!bash && existsSync(bash) : process.platform === "win32";
  test.skipIf(!available)(`${engine} code restore check blocks local work on the old version's paths and their parents`, async () => {
    const fixture = await tempFixture(`code-restore-${engine}-`);
    try {
      const selected = scenarios.filter(scenario => !scenario.only || scenario.only === engine);
      const cases = [];
      for (const scenario of selected) {
        const dir = join(fixture.root, scenario.name);
        cases.push({ name: scenario.name, dir, ...await repository(dir, scenario) });
      }
      const result = await check(engine, cases, fixture.root);
      expect(result.code, result.output).toBe(0);
      const seen = outcomes(result.output);
      for (const [index, scenario] of selected.entries()) {
        const { dir, original, target } = cases[index]!;
        expect({ name: scenario.name, ...seen.get(scenario.name) }, result.output).toEqual({ name: scenario.name,
          status: scenario.blocked ? "BLOCKED" : "SAFE", conflicts: scenario.blocked ?? [] });
        expect(await git(dir, "rev-parse", "HEAD"), scenario.name).toBe(scenario.blocked ? target : original);
        for (const [path, content] of Object.entries(scenario.after)) expect(readFileSync(join(dir, path), "utf8"), `${scenario.name}: ${path}`).toBe(content);
        if (scenario.link) expect(lstatSync(join(dir, scenario.link)).isSymbolicLink(), scenario.name).toBe(true);
        if (!scenario.blocked) continue;
        // Each blocked case is a real loss: the unchecked restore destroys the local work the check protected. A linked
        // parent is either replaced by a directory or (Git for Windows follows junctions) written through to the link target.
        await git(dir, "reset", "-q", "--hard", original);
        const lost = Object.entries(scenario.after).some(([path, content]) => !existsSync(join(dir, path)) ||
          lstatSync(join(dir, path)).isDirectory() || readFileSync(join(dir, path), "utf8") !== content);
        const linkHit = !!scenario.link && (!lstatSync(join(dir, scenario.link)).isSymbolicLink() || readdirSync(`${dir}-elsewhere`).length > 0);
        expect(lost || linkHit, scenario.name).toBe(true);
      }
    } finally { await fixture.cleanup(); }
  }, 120000);
}
