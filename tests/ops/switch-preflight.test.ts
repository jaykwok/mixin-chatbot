// The upgrader switches the code after the stop: checkout main, then fast-forward to the target. Git refuses to overwrite
// untracked files only at that point, and overwrites or deletes ignored ones without asking. The preflight before the stop
// walks the same route (current commit -> main -> target) against real repositories: local files on a path either step adds
// (the path itself or any parent) are listed; everything else must survive the real switch. The preflight writes nothing.
// The check is the shared core's (DeploymentGit.switchConflicts): both upgraders run it through the core's preflight before
// they build or ask, and the core repeats it under the lock before the stop. Windows runs with tracked links checked out as
// files (core.symlinks=false) and untracked links as directory junctions, and again with real symbolic links where they can be made.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { symlinkUnavailable } from "../helpers/links.ts";
import { tempFixture } from "../helpers/temp.ts";
import { DeploymentGit } from "../../scripts/ops/core/deployment-git.ts";
import { windowsUpgradeFixture } from "../helpers/windows-upgrade.ts";

type Files = Record<string, string>;
/** A commit's content: file contents, or symbolic links by their target. */
type Tree = Record<string, string | { link: string }>;
/** How an untracked link is made: a directory junction or a symbolic link on Windows; always a symbolic link elsewhere. */
type LinkType = "junction" | "dir";

interface Scenario {
  name: string;
  head: Tree;
  /** The commit main points to, between the checkout (detached here) and the target; main is the checkout when absent. */
  main?: Tree;
  target: Tree;
  /** Operator files in the checkout before the upgrade: untracked, ignored or links. */
  local?: (dir: string, link: LinkType) => Promise<void>;
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
  /** Involves links: tracked ones (committed as links) or an untracked one. */
  links?: "tracked" | "untracked";
}

/** One run of the check. On Windows core.symlinks is set explicitly: false checks tracked links out as files holding their
 * target; true needs a process that can create symbolic links and runs only the scenarios with links. */
interface Pass { symlinks?: boolean }

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
  // A link out of the checkout on a parent: git would replace it or write through it.
  { name: "linked-parent", head: {}, target: { "plugins/a.txt": "new" }, links: "untracked",
    local: async (dir, link) => { await mkdir(`${dir}-elsewhere`); await symlink(`${dir}-elsewhere`, join(dir, "plugins"), link); },
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
  // Tracked changes: the fast-forward refuses a file the target changes, and silently keeps a change to one it does not —
  // either way the switch does not reach the target version. The core checks them itself.
  { name: "tracked-change", head: { "a.txt": "old" }, target: { "a.txt": "new" },
    local: dir => writeFile(join(dir, "a.txt"), "notes"), blocked: ["未提交的改动： M a.txt"], after: { "a.txt": "notes" } },
  { name: "tracked-change-carried", head: { "a.txt": "old" }, target: { "a.txt": "old", "b.txt": "new" },
    local: dir => writeFile(join(dir, "a.txt"), "notes"), blocked: ["未提交的改动： M a.txt"], after: { "a.txt": "notes" } },
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
  { name: "tracked-link-became-directory", links: "tracked",
    head: { "source/child": "tracked", "source/sub": "tracked", item: { link: "source" } },
    main: { "source/child": "tracked", "source/sub": "tracked", "item/child": "main" },
    target: { "source/child": "tracked", "source/sub": "tracked", "item/child": "main", "item/sub/x": "new" },
    blocked: null, after: { "source/child": "tracked", "source/sub": "tracked" } },
  // The same with a link out of the checkout: the operator files it points to are neither conflicts nor touched.
  { name: "tracked-outside-link-became-directory", links: "tracked",
    head: { item: { link: "../tracked-outside-link-became-directory-elsewhere" } }, target: { "item/child": "new", "item/sub/x": "new" },
    local: async dir => { await mkdir(`${dir}-elsewhere`); await writeFile(`${dir}-elsewhere/child`, "operator"); await writeFile(`${dir}-elsewhere/sub`, "operator"); },
    blocked: null, after: {}, outside: { child: "operator", sub: "operator" } },
  { name: "index-locked", head: {}, main: { "mid.txt": "main" }, target: { "mid.txt": "main", "added.txt": "new" }, locked: true, blocked: null, after: {} },
  // Touched, same bytes: git status and the real switch call the file clean, so the dry run on the index copy must as well,
  // without refreshing the real index (the check below keeps its bytes and time).
  { name: "touched-tracked-file", head: { "a.txt": "same" }, target: { "a.txt": "new" }, blocked: null, after: {},
    local: async dir => { await writeFile(join(dir, "a.txt"), "same"); const later = new Date(Date.now() + 60_000); await utimes(join(dir, "a.txt"), later, later); } },
];

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, MSYS_NO_PATHCONV: "1", ...env }, stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out: out.trim(), stdout: out, output: `${out}${err}` };
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

// Links point at directories; Windows needs the type up front. Without real links (core.symlinks=false) a tracked link is
// committed as a link (mode 120000) and checked out as a file holding its target, as Git for Windows does.
async function commit(dir: string, files: Tree, message: string, realLinks: boolean): Promise<string> {
  await gitOk(dir, "rm", "-rq", "--ignore-unmatch", ".");
  const links: string[] = [];
  for (const [path, content] of Object.entries<Tree[string]>({ ...files, "version.txt": message })) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    if (typeof content === "string") await writeFile(join(dir, path), content);
    else if (realLinks) await symlink(content.link, join(dir, path), "dir");
    else { await writeFile(join(dir, path), content.link); links.push(path); }
  }
  // -f: a commit may track a path its own .gitignore ignores.
  await gitOk(dir, "add", "-Af");
  for (const path of links) await gitOk(dir, "update-index", "--cacheinfo", `120000,${await gitOk(dir, "hash-object", "-w", "--", path)},${path}`);
  await gitOk(dir, "commit", "-qm", message);
  return gitOk(dir, "rev-parse", "HEAD");
}

// head, then main and the target on top; the checkout is detached at head when main differs, then the local files.
async function repository(dir: string, scenario: Scenario, pass: Pass) {
  await mkdir(dir, { recursive: true });
  await gitOk(dir, "init", "-q", "-b", "main");
  if (pass.symlinks !== undefined) await gitOk(dir, "config", "core.symlinks", String(pass.symlinks));
  const realLinks = pass.symlinks !== false;
  const head = await commit(dir, scenario.head, "head", realLinks);
  const main = scenario.main ? await commit(dir, scenario.main, "main", realLinks) : head;
  const target = await commit(dir, scenario.target, "target", realLinks);
  await gitOk(dir, "update-ref", "refs/heads/main", main);
  await gitOk(dir, "checkout", "-qf", head === main ? "main" : head);
  await scenario.local?.(dir, pass.symlinks === false ? "junction" : "dir");
  return { head, main, target };
}

/** Every file under the checkout except .git, with its bytes (links by their target). */
function snapshot(dir: string, ignore: (key: string) => boolean = () => false): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name), key = relative(dir, path).replaceAll("\\", "/");
      if (key === ".git" || ignore(key)) continue;
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

interface Case { scenario: Scenario; dir: string; head: string; main: string; target: string }

// DeploymentGit.switchConflicts reads HEAD and main itself and also checks tracked changes; its dry run copies the index
// under <scratch>.
async function check(cases: Case[], scratch: string) {
  const lines: string[] = [];
  for (const { scenario, dir, target } of cases) {
    const core = new DeploymentGit(dir, async request => {
      const result = await run([request.command, ...request.args], request.cwd, request.env as Record<string, string>);
      return { code: result.code, stdout: result.stdout };
    }, scratch);
    // Keep the original fallback case: Git's own dry run must still reject with the path rules disabled.
    if (scenario.netOnly) core.pathConflicts = async () => [];
    const { conflicts } = await core.switchConflicts(target);
    lines.push("=== " + scenario.name, ...conflicts.map(value => "- " + value), conflicts.length ? "BLOCKED" : "SAFE");
  }
  return { code: 0, out: lines.join("\n"), output: lines.join("\n") };
}

const linkReason = process.platform === "win32" ? symlinkUnavailable() : null;
const passes: { pass: Pass; available: boolean; label: string }[] = [
  { pass: process.platform === "win32" ? { symlinks: false } : {}, available: true, label: "shared TypeScript core" },
  { pass: { symlinks: true }, available: process.platform === "win32" && !linkReason,
    label: `shared TypeScript core (symbolic links${linkReason ? `; 跳过：${linkReason}` : ""})` },
];

function selected(pass: Pass): Scenario[] {
  return scenarios.filter(scenario => pass.symlinks !== true || !!scenario.links);
}

for (const { pass, available, label } of passes) {
  test.skipIf(!available)(`${label} switch preflight lists local files on the route current -> main -> target without writing, and passes only switches that keep them`, async () => {
    const fixture = await tempFixture(`switch-preflight-${pass.symlinks ? "links-" : ""}`);
    try {
      const cases: Case[] = [];
      for (const scenario of selected(pass)) {
        const dir = join(fixture.root, scenario.name);
        cases.push({ scenario, dir, ...await repository(dir, scenario, pass) });
      }
      // The link cases really have links: symbolic links, or on Windows without them, files recorded as links.
      for (const { scenario, dir } of cases) {
        for (const [path, content] of Object.entries(scenario.head)) {
          if (typeof content === "string") continue;
          if (pass.symlinks === false) {
            expect({ path, link: lstatSync(join(dir, path)).isSymbolicLink(), mode: (await gitOk(dir, "ls-files", "-s", "--", path)).slice(0, 6) })
              .toEqual({ path, link: false, mode: "120000" });
          } else expect(lstatSync(join(dir, path)).isSymbolicLink(), `${scenario.name}: ${path}`).toBe(true);
        }
        if (scenario.link) expect(lstatSync(join(dir, scenario.link)).isSymbolicLink(), scenario.name).toBe(true);
      }
      const before = cases.map(({ dir }) => ({ index: readFileSync(join(dir, ".git/index")), mtime: statSync(join(dir, ".git/index")).mtimeMs, files: snapshot(dir) }));
      for (const { scenario, dir } of cases) if (scenario.locked) await writeFile(join(dir, ".git/index.lock"), "held elsewhere");
      const scratch = join(fixture.root, "scratch");
      await mkdir(scratch);
      const result = await check(cases, scratch);
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
        await expectRealSwitch(scenario, dir, target);
      }
    } finally { await fixture.cleanup(); }
  }, 120000);
}

// The upgrader's real switch. A safe one reaches the target with the index matching it and keeps every local file, also
// outside the checkout; each blocked case is real: git refuses after the stop, the switch destroys the local file, or it
// ends somewhere other than the target version (a carried change).
async function expectRealSwitch(scenario: Scenario, dir: string, target: string) {
  const outside = () => scenario.outside && snapshot(`${dir}-elsewhere`);
  const checkout = await git(dir, "checkout", "--quiet", "main");
  const merge = checkout.code === 0 ? await git(dir, "merge", "--ff-only", "--quiet", target) : checkout;
  const kept = Object.entries(scenario.after).every(([path, content]) => existsSync(join(dir, path)) &&
    !lstatSync(join(dir, path)).isDirectory() && readFileSync(join(dir, path), "utf8") === content);
  const linkKept = !scenario.link || (lstatSync(join(dir, scenario.link)).isSymbolicLink() && readdirSync(`${dir}-elsewhere`).length === 0);
  const status = merge.code === 0 ? await gitOk(dir, "status", "--porcelain", "--untracked-files=no") : "";
  if (!scenario.blocked) {
    expect({ name: scenario.name, code: merge.code, head: await gitOk(dir, "rev-parse", "HEAD"), status, kept, outside: outside() }, merge.output)
      .toEqual({ name: scenario.name, code: 0, head: target, status: "", kept: true, outside: scenario.outside });
  } else {
    expect({ name: scenario.name, harmed: merge.code !== 0 || !kept || !linkKept || status !== "" }, merge.output).toEqual({ name: scenario.name, harmed: true });
  }
}

// upgrade.ps1 itself against real repositories: the checks run before the stop in new upgrades and resumes, and again right
// before the stop after the preparation (snapshot, data decision). Only the service, the snapshot, Bun and the operation log
// are stand-ins; the stand-in stop reports failure, so a run that reaches it changes nothing either.
type UpgradeStage = "upgrade-preflight" | "switch-recheck";
// A resume keeps the revision cleanup choice its snapshot recorded, so only a new upgrade asks for one.
const upgradeCases: (Scenario & {
  /** An interrupted upgrade's transaction pointer is present. */
  resume?: boolean;
  /** HEAD and main already at the target: a same-version upgrade, or a resume after the code switch. */
  atTarget?: boolean;
  /** A local file [path, content] that appears while the upgrader prepares, between the first check and the recheck. */
  during?: [string, string];
  /** The stage that refuses, or null when both checks pass and the upgrader reaches the stop. */
  refusedAt: UpgradeStage | null;
})[] = [
  { name: "new-via-main", head: {}, main: { "mid.txt": "main" }, target: { "mid.txt": "main", "added.txt": "new" },
    local: dir => writeFile(join(dir, "mid.txt"), "notes"), blocked: [`${viaMain}mid.txt`], after: { "mid.txt": "notes" }, refusedAt: "upgrade-preflight" },
  { name: "new-tracked-change", head: { "a.txt": "old" }, target: { "a.txt": "new" }, local: dir => writeFile(join(dir, "a.txt"), "notes"),
    blocked: ["未提交的改动： M a.txt"], after: { "a.txt": "notes" }, refusedAt: "upgrade-preflight" },
  { name: "new-recheck", head: { "tool/a.txt": "old" }, target: { tool: "now a file" }, during: ["tool/notes.txt", "notes"],
    blocked: ["未跟踪的文件会随目录删除（目标版本在 tool 是文件）：tool/notes.txt"], after: { "tool/notes.txt": "notes" }, refusedAt: "switch-recheck" },
  { name: "new-safe", head: { ".gitignore": "*.log\n", "docs/a.md": "old" }, main: { ".gitignore": "*.log\n", "docs/a.md": "old", "mid.txt": "main" },
    target: { ".gitignore": "*.log\n", "docs/a.md": "old", "mid.txt": "main", "added.txt": "new" },
    local: async dir => { await writeFile(join(dir, "other.txt"), "notes"); await writeFile(join(dir, "run.log"), "log"); await writeFile(join(dir, "docs/notes.txt"), "notes"); },
    blocked: null, after: { "other.txt": "notes", "run.log": "log", "docs/notes.txt": "notes" }, refusedAt: null },
  { name: "resume-ignored", resume: true, head: { ".gitignore": "*.env\n" }, target: { ".gitignore": "*.env\n", "defaults.env": "new" },
    local: dir => writeFile(join(dir, "defaults.env"), "secret"), blocked: [`${toTarget}defaults.env`], after: { "defaults.env": "secret" }, refusedAt: "upgrade-preflight" },
  { name: "resume-junction", resume: true, head: {}, target: { "plugins/a.txt": "new" }, links: "untracked",
    local: async (dir, link) => { await mkdir(`${dir}-elsewhere`); await symlink(`${dir}-elsewhere`, join(dir, "plugins"), link); },
    blocked: [`${parentTaken}plugins`], after: {}, link: "plugins", refusedAt: "upgrade-preflight" },
  { name: "resume-recheck", resume: true, head: {}, main: { "mid.txt": "main" }, target: { "mid.txt": "main" }, during: ["mid.txt", "notes"],
    blocked: [`${viaMain}mid.txt`], after: { "mid.txt": "notes" }, refusedAt: "switch-recheck" },
  { name: "resume-safe", resume: true, head: { "docs/a.md": "old" }, target: { "docs/a.md": "old", "docs/b.md": "new" },
    local: dir => writeFile(join(dir, "docs/notes.txt"), "notes"), blocked: null, after: { "docs/notes.txt": "notes" }, refusedAt: null },
  // Nothing to switch, yet a tracked change made during the preparation survives the checkout and fast-forward of the same
  // commit: the service would run code that is not the target version. Clean, both go on to the stop.
  { name: "same-version-recheck", atTarget: true, head: { "a.txt": "old" }, target: { "a.txt": "old" }, during: ["a.txt", "notes"],
    blocked: ["未提交的改动： M a.txt"], after: { "a.txt": "notes" }, refusedAt: "switch-recheck" },
  { name: "same-version-safe", atTarget: true, head: { "a.txt": "old" }, target: { "a.txt": "old" }, blocked: null, after: {}, refusedAt: null },
  { name: "resume-at-target-recheck", resume: true, atTarget: true, head: { "a.txt": "old" }, target: { "a.txt": "old" }, during: ["a.txt", "notes"],
    blocked: ["未提交的改动： M a.txt"], after: { "a.txt": "notes" }, refusedAt: "switch-recheck" },
  { name: "resume-at-target-safe", resume: true, atTarget: true, head: { "a.txt": "old" }, target: { "a.txt": "old" }, blocked: null, after: {}, refusedAt: null },
];

for (const scenario of upgradeCases) test.skipIf(process.platform !== "win32")(`Windows shared upgrader before stop: ${scenario.name}`, async () => {
  const fixture = await tempFixture("upgrade-switch-");
  try {
    const pass: Pass = { symlinks: false };
    {
      const dir = join(fixture.root, scenario.name), refs = await repository(dir, scenario, pass);
      if (scenario.atTarget) {
        await gitOk(dir, "update-ref", "refs/heads/main", refs.target); await gitOk(dir, "checkout", "-qf", "main"); refs.head = refs.main = refs.target;
      }
      const host = await windowsUpgradeFixture(true, { refuseStop: true,
        checkout: { project: dir, original: refs.head, target: refs.target, branch: refs.head === refs.main ? "main" : "HEAD",
          run: async command => { const value = await run([command.command, ...command.args], command.cwd, command.env as Record<string, string>);
            return { code: value.code, stdout: value.stdout }; } },
        beforePreflight: async () => { if (scenario.during) await writeFile(join(dir, scenario.during[0]), scenario.during[1]); },
      });
      try {
        if (scenario.resume) await host.pending();
        const owned = (key: string) => key === ".console" || key === "backup" || ["data/state/deploy.lock", "data/state/ops-deployment.json", "data/state/upgrade-transaction"].includes(key);
        const before = { files: snapshot(dir, owned), index: readFileSync(join(dir, ".git/index")), mtime: statSync(join(dir, ".git/index")).mtimeMs };
        const result = await host.run(); expect(result.exitCode, scenario.name + result.message).toBe(1);
        expect(host.events.includes("effect:stop"), scenario.name + result.message).toBe(scenario.refusedAt === null);
        expect(host.events).not.toContain("git:effect"); expect(host.events.some(value => value.startsWith("data:"))).toBe(false);
        expect(host.events.includes("effect:capture"), scenario.name + result.message).toBe(!scenario.resume && scenario.refusedAt !== "upgrade-preflight");
        if (scenario.blocked) for (const conflict of scenario.blocked) expect(result.message, scenario.name).toContain(conflict);
        else expect(result.message).toContain("synthetic stop refused");
        expect(readFileSync(join(dir, ".git/index")), scenario.name).toEqual(before.index);
        expect(statSync(join(dir, ".git/index")).mtimeMs, scenario.name).toBe(before.mtime);
        expect(existsSync(join(dir, ".git/index.lock")), scenario.name).toBe(false);
        expect(snapshot(dir, owned), scenario.name).toEqual({ ...before.files, ...(scenario.during ? { [scenario.during[0]]: scenario.during[1] } : {}) });
        expect(await gitOk(dir, "rev-parse", "HEAD"), scenario.name).toBe(refs.head);
        expect(await gitOk(dir, "rev-parse", "main"), scenario.name).toBe(refs.main);
        await expectRealSwitch(scenario, dir, refs.target);
      } finally { await host.cleanup(); }
    }
  } finally { await fixture.cleanup(); }
}, 120000);
