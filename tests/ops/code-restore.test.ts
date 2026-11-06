// Rolling back an upgrade restores the old commit with reset --hard / checkout --force, which deletes whatever sits where
// the old version needs a file or a directory. The shared core's check (DeploymentGit.restoreConflicts, used by both
// platforms' rollbacks) runs against real repositories: local work anywhere on such a path (the path itself or any parent),
// tracked edits and commits after the upgrade block the restore; tracked content does not. Windows runs with tracked links checked out as files (core.symlinks=false) and untracked links as
// directory junctions, and again with real symbolic links where this process can create them.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { symlinkUnavailable } from "../helpers/links.ts";
import { tempFixture } from "../helpers/temp.ts";
import { DeploymentGit } from "../../ops/core/deployment-git.ts";

type Files = Record<string, string>;
/** A commit's content: file contents, or symbolic links by their target. */
type Tree = Record<string, string | { link: string }>;
/** How an untracked link is made: a directory junction or a symbolic link on Windows; always a symbolic link elsewhere. */
type LinkType = "junction" | "dir";

interface Scenario {
  name: string;
  old: Tree;
  target: Tree;
  /** Changes made after the upgrade, on top of the target checkout. */
  local?: (dir: string, link: LinkType) => Promise<void>;
  /** Exact conflict list (from the commits when it names them), or null when the restore is safe. */
  blocked: string[] | ((ids: Ids) => string[]) | null;
  /** File contents expected afterwards: local work kept when blocked, the old version when restored. */
  after: Files;
  /** A link that must still be a link afterwards. */
  link?: string;
  /** Operator files in <dir>-elsewhere, outside the checkout, that neither the check nor the restore may change. */
  outside?: Files;
  /** Involves links: tracked ones (committed as links) or an untracked one. */
  links?: "tracked" | "untracked";
}

/** The old commit, the target and HEAD after the local changes. */
interface Ids { original: string; target: string; head: string }
const short = (sha: string) => sha.slice(0, 7);
const expected = (scenario: Scenario, ids: Ids) => typeof scenario.blocked === "function" ? scenario.blocked(ids) : scenario.blocked ?? [];

/** One run of the check. On Windows core.symlinks is set explicitly: false checks tracked links out as files holding their
 * target; true needs a process that can create symbolic links and runs only the scenarios with links. */
interface Pass { symlinks?: boolean }

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
  // A directory junction on Windows, a symbolic link elsewhere.
  { name: "linked-parent", old: { "retired/seed.txt": "old" }, target: {}, links: "untracked",
    local: async (dir, link) => { await mkdir(`${dir}-elsewhere`); await symlink(`${dir}-elsewhere`, join(dir, "retired"), link); },
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
  // The upgrade made a directory a tracked link: the restore deletes the link and recreates the directory. What the link
  // points to (tracked files, or operator files outside the checkout) is not in the way and stays.
  { name: "directory-became-tracked-link", old: { "kept/seed.txt": "kept", "retired/seed.txt": "old" },
    target: { "kept/seed.txt": "kept", retired: { link: "kept" } }, links: "tracked", blocked: null,
    after: { "kept/seed.txt": "kept", "retired/seed.txt": "old" } },
  { name: "directory-became-outside-link", old: { "retired/seed.txt": "old" },
    target: { retired: { link: "../directory-became-outside-link-elsewhere" } }, links: "tracked",
    local: async dir => { await mkdir(`${dir}-elsewhere`); await writeFile(`${dir}-elsewhere/seed.txt`, "operator"); },
    blocked: null, after: { "retired/seed.txt": "old" }, outside: { "seed.txt": "operator" } },
  // Work done after the upgrade on tracked content: an edit, and a commit on the branch the restore resets.
  { name: "tracked-edit", old: { "a.txt": "old" }, target: { "a.txt": "new" }, local: dir => writeFile(join(dir, "a.txt"), "edited"),
    blocked: ["未提交的改动： M a.txt"], after: { "a.txt": "edited" } },
  { name: "commit-after-upgrade", old: { "a.txt": "old" }, target: { "a.txt": "new" },
    local: async dir => { await writeFile(join(dir, "a.txt"), "after"); await git(dir, "commit", "-qam", "after the upgrade"); },
    blocked: ({ original, target, head }) => [`当前提交 ${short(head)} 既不是升级前的 ${short(original)}，也不是目标 ${short(target)}：升级后有新的提交或切换`,
      `分支 main 指向 ${short(head)}，不是升级前或目标提交：回滚会把它重置到 ${short(original)}`], after: { "a.txt": "after" } },
];

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, MSYS_NO_PATHCONV: "1", ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out: out.trim(), stdout: out, output: `${out}${err}` };
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.autocrlf=false",
    "-c", "commit.gpgsign=false", ...args], dir);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.output}`);
  return result.out;
}

// Links point at directories; Windows needs the type up front. Without real links (core.symlinks=false) a tracked link is
// committed as a link (mode 120000) and checked out as a file holding its target, as Git for Windows does.
async function commit(dir: string, files: Tree, message: string, realLinks: boolean): Promise<void> {
  const links: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    if (typeof content === "string") await writeFile(join(dir, path), content);
    else if (realLinks) await symlink(content.link, join(dir, path), "dir");
    else { await writeFile(join(dir, path), content.link); links.push(path); }
  }
  await git(dir, "add", "-A");
  for (const path of links) await git(dir, "update-index", "--cacheinfo", `120000,${await git(dir, "hash-object", "-w", "--", path)},${path}`);
  await git(dir, "commit", "-qm", message);
}

/** The files directly in <dir>-elsewhere with their contents. */
function outsideFiles(dir: string): Files {
  return Object.fromEntries(readdirSync(`${dir}-elsewhere`).map(name => [name, readFileSync(join(`${dir}-elsewhere`, name), "utf8")]));
}

// The old commit, the upgrade to the target on main, then the local changes.
async function repository(dir: string, scenario: Scenario, pass: Pass) {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  if (pass.symlinks !== undefined) await git(dir, "config", "core.symlinks", String(pass.symlinks));
  const realLinks = pass.symlinks !== false;
  await commit(dir, { ...scenario.old, "version.txt": "old" }, "old", realLinks);
  const original = await git(dir, "rev-parse", "HEAD");
  await git(dir, "rm", "-rq", ".");
  await commit(dir, { ...scenario.target, "version.txt": "new" }, "target", realLinks);
  const target = await git(dir, "rev-parse", "HEAD");
  await scenario.local?.(dir, pass.symlinks === false ? "junction" : "dir");
  return { original, target, head: await git(dir, "rev-parse", "HEAD") };
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

async function check(cases: ({ name: string; dir: string } & Ids)[], scratch: string) {
  const lines: string[] = [];
  for (const item of cases) {
    const core = new DeploymentGit(item.dir, async request => {
      const result = await run([request.command, ...request.args], request.cwd, request.env as Record<string, string>);
      return { code: result.code, stdout: result.stdout };
    }, scratch);
    const conflicts = await core.restoreConflicts(item.original, item.target, "main");
    lines.push("=== " + item.name, ...conflicts.map(value => "- " + value), conflicts.length ? "BLOCKED" : "SAFE");
    if (!conflicts.length) await core.restore(item.original, item.target, "main").catch(() => lines.push("RESTORE-FAILED"));
  }
  return lines.join("\n");
}

const linkReason = process.platform === "win32" ? symlinkUnavailable() : null;
const passes: { pass: Pass; available: boolean; label: string }[] = [
  { pass: process.platform === "win32" ? { symlinks: false } : {}, available: true, label: "shared TypeScript core" },
  { pass: { symlinks: true }, available: process.platform === "win32" && !linkReason,
    label: `shared TypeScript core (symbolic links${linkReason ? `; 跳过：${linkReason}` : ""})` },
];

for (const { pass, available, label } of passes) {
  test.skipIf(!available)(`${label} code restore check blocks local work on the old version's paths and their parents`, async () => {
    const fixture = await tempFixture(`code-restore-${pass.symlinks ? "links" : "core"}-`);
    try {
      const selected = scenarios.filter(scenario => pass.symlinks !== true || !!scenario.links);
      const cases = [];
      for (const scenario of selected) {
        const dir = join(fixture.root, scenario.name);
        cases.push({ name: scenario.name, dir, ...await repository(dir, scenario, pass) });
        // The link cases really have links: symbolic links, or on Windows without them, files recorded as links.
        for (const [path, content] of Object.entries(scenario.target)) {
          if (typeof content === "string") continue;
          if (pass.symlinks === false) {
            expect({ path, link: lstatSync(join(dir, path)).isSymbolicLink(), mode: (await git(dir, "ls-files", "-s", "--", path)).slice(0, 6) })
              .toEqual({ path, link: false, mode: "120000" });
          } else expect(lstatSync(join(dir, path)).isSymbolicLink(), `${scenario.name}: ${path}`).toBe(true);
        }
        if (scenario.link) expect(lstatSync(join(dir, scenario.link)).isSymbolicLink(), scenario.name).toBe(true);
      }
      const scratch = join(fixture.root, "scratch");
      await mkdir(scratch);
      const output = await check(cases, scratch);
      expect(readdirSync(scratch)).toEqual([]);
      const seen = outcomes(output);
      for (const [index, scenario] of selected.entries()) {
        const { dir, original, head } = cases[index]!;
        expect({ name: scenario.name, ...seen.get(scenario.name) }, output).toEqual({ name: scenario.name,
          status: scenario.blocked ? "BLOCKED" : "SAFE", conflicts: expected(scenario, cases[index]!) });
        expect(await git(dir, "rev-parse", "HEAD"), scenario.name).toBe(scenario.blocked ? head : original);
        for (const [path, content] of Object.entries(scenario.after)) expect(readFileSync(join(dir, path), "utf8"), `${scenario.name}: ${path}`).toBe(content);
        if (scenario.link) expect(lstatSync(join(dir, scenario.link)).isSymbolicLink(), scenario.name).toBe(true);
        if (scenario.outside) expect(outsideFiles(dir), scenario.name).toEqual(scenario.outside);
        // A restore leaves the index matching the old commit.
        if (!scenario.blocked) { expect(await git(dir, "status", "--porcelain", "--untracked-files=no"), scenario.name).toBe(""); continue; }
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

// The branch the upgrade left (recorded as the original branch) is reset by the rollback: if it moved on or was deleted
// since, the core lists it and resets, checks out and recreates nothing.
test("shared TypeScript core code restore check lists a moved or deleted original branch and leaves every ref as it was", async () => {
  const fixture = await tempFixture("code-restore-branch-");
  try {
    const dir = join(fixture.root, "repo"), scratch = join(fixture.root, "scratch");
    await mkdir(scratch);
    const { original, target } = await repository(dir, { name: "branch", old: { "a.txt": "old" }, target: { "a.txt": "new" }, blocked: null, after: {} }, {});
    const core = new DeploymentGit(dir, async request => {
      const result = await run([request.command, ...request.args], request.cwd, request.env as Record<string, string>);
      return { code: result.code, stdout: result.stdout };
    }, scratch);
    await git(dir, "branch", "feature", original);
    expect(await core.restoreConflicts(original, target, "feature")).toEqual([]);
    const other = await git(dir, "commit-tree", "-p", original, "-m", "moved on", `${original}^{tree}`);
    await git(dir, "branch", "-f", "feature", other);
    const moved = [`分支 feature 指向 ${short(other)}，不是升级前或目标提交：回滚会把它重置到 ${short(original)}`];
    expect(await core.restoreConflicts(original, target, "feature")).toEqual(moved);
    await expect(core.restore(original, target, "feature")).rejects.toThrow("代码回滚存在冲突");
    expect([await git(dir, "rev-parse", "HEAD"), await git(dir, "rev-parse", "feature"), await git(dir, "rev-parse", "--abbrev-ref", "HEAD")]).toEqual([target, other, "main"]);
    await git(dir, "branch", "-D", "feature");
    expect(await core.restoreConflicts(original, target, "feature")).toEqual(["分支 feature 已不存在：回滚不会重新创建它"]);
    await expect(core.restore(original, target, "feature")).rejects.toThrow("代码回滚存在冲突");
    expect(await git(dir, "branch", "--list", "feature")).toBe("");
    expect([await git(dir, "rev-parse", "HEAD"), await git(dir, "status", "--porcelain")]).toEqual([target, ""]);
    expect(readdirSync(scratch)).toEqual([]);
  } finally { await fixture.cleanup(); }
}, 60000);
