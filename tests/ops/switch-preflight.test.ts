// The upgrader switches the code after the stop: checkout main, then fast-forward to the target. Git refuses to overwrite
// untracked files only at that point, and overwrites or deletes ignored ones without asking. The preflight before the stop
// walks the same route (current commit -> main -> target) against real repositories: local files on a path either step adds
// (the path itself or any parent) are listed; everything else must survive the real switch. The preflight writes nothing.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tempFixture } from "../helpers/temp.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : Bun.which("bash");
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => "/" + drive.toLowerCase());
type Files = Record<string, string>;
/** A commit's content: file contents, or symbolic links by their target. */
type Tree = Record<string, string | { link: string }>;

interface Scenario {
  name: string;
  head: Tree;
  /** The commit main points to, between the checkout (detached here) and the target; main is the checkout when absent. */
  main?: Tree;
  target: Tree;
  /** Operator files in the checkout before the upgrade: untracked, ignored or links. */
  local?: (dir: string) => Promise<void>;
  /** Exact conflict list, or null when the switch is safe. */
  blocked: string[] | null;
  /** Operator files that must be unchanged by the preflight, and by the real switch when it is safe. */
  after: Files;
  link?: string;
  /** Operator files in <dir>-elsewhere, outside the checkout, that neither the preflight nor the real switch may change. */
  outside?: Files;
  /** Disables the path rules: git's own dry run must still refuse. */
  netOnly?: boolean;
  /** Another git process holds the index lock meanwhile: the dry run works on its own copy and leaves the lock alone. */
  locked?: boolean;
  posixOnly?: boolean;
}

const toTarget = "未跟踪的文件会被目标版本覆盖：", viaMain = "未跟踪的文件会被切换途经的 main 分支覆盖：";
const parentTaken = "未跟踪的文件或链接占着目标版本的目录位置：";
const scenarios: Scenario[] = [
  { name: "file", head: {}, target: { "added.txt": "new" }, local: dir => writeFile(join(dir, "added.txt"), "notes"),
    blocked: [`${toTarget}added.txt`], after: { "added.txt": "notes" } },
  // Git overwrites an ignored file without asking.
  { name: "ignored-file", head: { ".gitignore": "*.env\n" }, target: { ".gitignore": "*.env\n", "defaults.env": "new" },
    local: dir => writeFile(join(dir, "defaults.env"), "secret"), blocked: [`${toTarget}defaults.env`], after: { "defaults.env": "secret" } },
  { name: "untracked-directory", head: {}, target: { cache: "now a file" },
    local: async dir => { await mkdir(join(dir, "cache")); await writeFile(join(dir, "cache/a.txt"), "notes"); },
    blocked: [`${toTarget}cache`], after: { "cache/a.txt": "notes" } },
  { name: "directory-became-file", head: { "tool/a.txt": "old" }, target: { tool: "now a file" },
    local: dir => writeFile(join(dir, "tool/notes.txt"), "notes"),
    blocked: ["未跟踪的文件会随目录删除（目标版本在 tool 是文件）：tool/notes.txt"], after: { "tool/notes.txt": "notes" } },
  // Git deletes the ignored file together with the directory.
  { name: "directory-with-ignored-file", head: { ".gitignore": "*.log\n", "tool/a.txt": "old" }, target: { ".gitignore": "*.log\n", tool: "now a file" },
    local: dir => writeFile(join(dir, "tool/run.log"), "log"),
    blocked: ["未跟踪的文件会随目录删除（目标版本在 tool 是文件）：tool/run.log"], after: { "tool/run.log": "log" } },
  { name: "parent-file", head: {}, target: { "notes/today.md": "new" }, local: dir => writeFile(join(dir, "notes"), "notes"),
    blocked: [`${parentTaken}notes`], after: { notes: "notes" } },
  { name: "deep-parent", head: { "a/keep.txt": "kept" }, target: { "a/keep.txt": "kept", "a/b/c.txt": "new" },
    local: dir => writeFile(join(dir, "a/b"), "notes"), blocked: [`${parentTaken}a/b`], after: { "a/b": "notes" } },
  { name: "linked-parent", head: {}, target: { "plugins/a.txt": "new" }, posixOnly: true,
    local: async dir => { await mkdir(`${dir}-elsewhere`); await symlink(`${dir}-elsewhere`, join(dir, "plugins")); },
    blocked: [`${parentTaken}plugins`], after: {}, link: "plugins" },
  // Only the intermediate main has the path: switching straight to the target would not touch it.
  { name: "main-only", head: {}, main: { "mid.txt": "main" }, target: {}, local: dir => writeFile(join(dir, "mid.txt"), "notes"),
    blocked: [`${viaMain}mid.txt`], after: { "mid.txt": "notes" } },
  // Checking out main overwrites the ignored file silently, and the target then deletes main's version.
  { name: "main-only-ignored", head: { ".gitignore": "*.env\n" }, main: { ".gitignore": "*.env\n", "mid.env": "main" }, target: { ".gitignore": "*.env\n" },
    local: dir => writeFile(join(dir, "mid.env"), "secret"), blocked: [`${viaMain}mid.env`], after: { "mid.env": "secret" } },
  { name: "both-steps", head: {}, main: { "mid.txt": "main" }, target: { "mid.txt": "main", "added.txt": "new" },
    local: async dir => { await writeFile(join(dir, "mid.txt"), "notes"); await writeFile(join(dir, "added.txt"), "notes"); },
    blocked: [`${viaMain}mid.txt`, `${toTarget}added.txt`], after: { "mid.txt": "notes", "added.txt": "notes" } },
  // Git's own dry run backs the rules up: with the rules disabled it still refuses.
  { name: "git-dry-run", head: {}, main: { "mid.txt": "main" }, target: { "mid.txt": "main" }, netOnly: true,
    local: dir => writeFile(join(dir, "mid.txt"), "notes"), blocked: ["git 试运行切换到 main 失败"], after: { "mid.txt": "notes" } },
  // Safe: tracked content only, local files inside directories that stay directories, and files elsewhere.
  { name: "re-added-after-main", head: { "x.txt": "head" }, main: {}, target: { "x.txt": "target" }, blocked: null, after: {} },
  { name: "local-files-in-kept-directory", head: { "docs/a.md": "old" }, target: { "docs/a.md": "old", "docs/b.md": "new" },
    local: dir => writeFile(join(dir, "docs/notes.txt"), "notes"), blocked: null, after: { "docs/notes.txt": "notes" } },
  { name: "untracked-elsewhere", head: { ".gitignore": "*.log\n" }, main: { ".gitignore": "*.log\n", "mid.txt": "main" },
    target: { ".gitignore": "*.log\n", "mid.txt": "main", "added.txt": "new" },
    local: async dir => { await writeFile(join(dir, "other.txt"), "notes"); await writeFile(join(dir, "run.log"), "log"); },
    blocked: null, after: { "other.txt": "notes", "run.log": "log" } },
  { name: "file-became-directory", head: { tool: "old file" }, target: { "tool/a.txt": "new" }, blocked: null, after: {} },
  // A tracked link becomes a directory: git deletes the link and creates the directory. What a test through the link finds
  // (a tracked file at item/child, a tracked file where item/sub becomes a directory) is not on the added paths and stays.
  { name: "tracked-link-became-directory", posixOnly: true,
    head: { "source/child": "tracked", "source/sub": "tracked", item: { link: "source" } },
    main: { "source/child": "tracked", "source/sub": "tracked", "item/child": "main" },
    target: { "source/child": "tracked", "source/sub": "tracked", "item/child": "main", "item/sub/x": "new" },
    blocked: null, after: { "source/child": "tracked", "source/sub": "tracked" } },
  // The same with a link out of the checkout: the operator files it points to are neither conflicts nor touched.
  { name: "tracked-outside-link-became-directory", posixOnly: true,
    head: { item: { link: "../tracked-outside-link-became-directory-elsewhere" } }, target: { "item/child": "new", "item/sub/x": "new" },
    local: async dir => { await mkdir(`${dir}-elsewhere`); await writeFile(`${dir}-elsewhere/child`, "operator"); await writeFile(`${dir}-elsewhere/sub`, "operator"); },
    blocked: null, after: {}, outside: { child: "operator", sub: "operator" } },
  { name: "index-locked", head: {}, main: { "mid.txt": "main" }, target: { "mid.txt": "main", "added.txt": "new" }, locked: true, blocked: null, after: {} },
];

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, MSYS_NO_PATHCONV: "1", ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out: out.trim(), output: `${out}${err}` };
}

async function git(dir: string, ...args: string[]) {
  return run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.autocrlf=false",
    "-c", "commit.gpgsign=false", ...args], dir);
}

async function gitOk(dir: string, ...args: string[]): Promise<string> {
  const result = await git(dir, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.output}`);
  return result.out;
}

async function commit(dir: string, files: Tree, message: string): Promise<string> {
  await gitOk(dir, "rm", "-rq", "--ignore-unmatch", ".");
  for (const [path, content] of Object.entries<Tree[string]>({ ...files, "version.txt": message })) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    if (typeof content === "string") await writeFile(join(dir, path), content);
    else await symlink(content.link, join(dir, path));
  }
  // -f: a commit may track a path its own .gitignore ignores.
  await gitOk(dir, "add", "-Af"); await gitOk(dir, "commit", "-qm", message);
  return gitOk(dir, "rev-parse", "HEAD");
}

// head, then main and the target on top; the checkout is detached at head when main differs, then the local files.
async function repository(dir: string, scenario: Scenario) {
  await mkdir(dir, { recursive: true });
  await gitOk(dir, "init", "-q", "-b", "main");
  const head = await commit(dir, scenario.head, "head");
  const main = scenario.main ? await commit(dir, scenario.main, "main") : head;
  const target = await commit(dir, scenario.target, "target");
  await gitOk(dir, "update-ref", "refs/heads/main", main);
  await gitOk(dir, "checkout", "-qf", head === main ? "main" : head);
  await scenario.local?.(dir);
  return { head, main, target };
}

/** Every file under the checkout except .git, with its bytes (links by their target). */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name), key = relative(dir, path).replaceAll("\\", "/");
      if (key === ".git") continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) files[key] = "link";
      else if (info.isDirectory()) { files[`${key}/`] = "dir"; walk(path); }
      else files[key] = readFileSync(path, "latin1");
    }
  };
  walk(dir);
  return files;
}

// Each case prints "=== <name>", its conflicts as "- <line>", then SAFE or BLOCKED.
function outcomes(output: string): Map<string, { status: string; conflicts: string[] }> {
  const result = new Map<string, { status: string; conflicts: string[] }>();
  let current: { status: string; conflicts: string[] } | undefined;
  for (const line of output.split(/\r?\n/).map(value => value.trim())) {
    if (line.startsWith("=== ")) result.set(line.slice(4), current = { status: "", conflicts: [] });
    else if (current && /^(SAFE|BLOCKED)$/.test(line)) current.status += current.status ? ` ${line}` : line;
    else if (current && line.startsWith("- ")) current.conflicts.push(line.slice(2));
  }
  return result;
}

test.skipIf(!bash || !existsSync(bash))("the switch preflight lists local files on the route current -> main -> target without writing, and passes only switches that keep them", async () => {
  const fixture = await tempFixture("switch-preflight-");
  try {
    const selected = scenarios.filter(scenario => !scenario.posixOnly || process.platform !== "win32");
    const cases = [];
    for (const scenario of selected) {
      const dir = join(fixture.root, scenario.name);
      cases.push({ scenario, dir, ...await repository(dir, scenario) });
    }
    const before = cases.map(({ dir }) => ({ index: readFileSync(join(dir, ".git/index")), mtime: statSync(join(dir, ".git/index")).mtimeMs, files: snapshot(dir) }));
    for (const { scenario, dir } of cases) if (scenario.locked) await writeFile(join(dir, ".git/index.lock"), "held elsewhere");
    const scratch = join(fixture.root, "scratch");
    await mkdir(scratch);
    const script = join(fixture.root, "check.sh");
    await writeFile(script, `set -u
. '${posix(join(project, "scripts/lib/common.sh"))}'
operation_event() { :; }
rules="$(declare -f untracked_switch_conflicts)"
while [ "$#" -gt 0 ]; do
    name="$1" PROJECT_DIR="$2" head="$3" main="$4" target="$5" net="$6"; shift 6
    eval "$rules"
    [ "$net" = 0 ] || untracked_switch_conflicts() { :; }
    echo "=== $name"
    if switch_preflight "$head" "$main" "$target" '${scratch.replaceAll("\\", "/")}' 2>&1; then echo SAFE; else echo BLOCKED; fi
done
`);
    // PROJECT_DIR as D:/... on Windows: the checks hand it to the native git.exe.
    const result = await run([bash!, posix(script), ...cases.flatMap(({ scenario, dir, head, main, target }) =>
      [scenario.name, dir.replaceAll("\\", "/"), head, main, target, scenario.netOnly ? "1" : "0"])], fixture.root);
    expect(result.code, result.output).toBe(0);
    const seen = outcomes(result.output);
    expect(readdirSync(scratch)).toEqual([]);
    for (const [index, { scenario, dir, head, main, target }] of cases.entries()) {
      const outcome = seen.get(scenario.name);
      const outside = () => scenario.outside && snapshot(`${dir}-elsewhere`);
      expect({ name: scenario.name, status: outcome?.status }, result.output).toEqual({ name: scenario.name, status: scenario.blocked ? "BLOCKED" : "SAFE" });
      if (scenario.netOnly) expect(outcome!.conflicts.map(line => line.slice(0, scenario.blocked![0]!.length)), result.output).toEqual(scenario.blocked!);
      else expect({ name: scenario.name, conflicts: outcome!.conflicts }, result.output).toEqual({ name: scenario.name, conflicts: scenario.blocked ?? [] });
      // The preflight wrote nothing: the index keeps its bytes and time, no lock, the checkout and every local file as they were.
      expect(readFileSync(join(dir, ".git/index")).equals(before[index]!.index), scenario.name).toBe(true);
      expect(statSync(join(dir, ".git/index")).mtimeMs, scenario.name).toBe(before[index]!.mtime);
      if (scenario.locked) {
        expect(readFileSync(join(dir, ".git/index.lock"), "utf8"), scenario.name).toBe("held elsewhere");
        await rm(join(dir, ".git/index.lock"));
      } else expect(existsSync(join(dir, ".git/index.lock")), scenario.name).toBe(false);
      expect(snapshot(dir), scenario.name).toEqual(before[index]!.files);
      expect(outside(), scenario.name).toEqual(scenario.outside);
      expect(await gitOk(dir, "rev-parse", "HEAD"), scenario.name).toBe(head);
      expect(await gitOk(dir, "rev-parse", "main"), scenario.name).toBe(main);
      // The upgrader's real switch.
      const checkout = await git(dir, "checkout", "--quiet", "main");
      const merge = checkout.code === 0 ? await git(dir, "merge", "--ff-only", "--quiet", target) : checkout;
      const kept = Object.entries(scenario.after).every(([path, content]) => existsSync(join(dir, path)) &&
        !lstatSync(join(dir, path)).isDirectory() && readFileSync(join(dir, path), "utf8") === content);
      const linkKept = !scenario.link || (lstatSync(join(dir, scenario.link)).isSymbolicLink() && readdirSync(`${dir}-elsewhere`).length === 0);
      if (!scenario.blocked) {
        // A safe switch reaches the target with the index matching it and keeps every local file, also outside the checkout.
        const status = await gitOk(dir, "status", "--porcelain", "--untracked-files=no");
        expect({ name: scenario.name, code: merge.code, head: await gitOk(dir, "rev-parse", "HEAD"), status, kept, outside: outside() }, merge.output)
          .toEqual({ name: scenario.name, code: 0, head: target, status: "", kept: true, outside: scenario.outside });
      } else {
        // Each blocked case is real: git refuses after the stop, or the switch destroys the local file.
        expect({ name: scenario.name, harmed: merge.code !== 0 || !kept || !linkKept }, merge.output).toEqual({ name: scenario.name, harmed: true });
      }
    }
  } finally { await fixture.cleanup(); }
}, 120000);
