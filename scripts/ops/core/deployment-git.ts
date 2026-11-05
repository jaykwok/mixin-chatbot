// Shared, read-only switch preflight and explicit Git effects. The deployment host holds deploy.lock and journals each
// effect before calling switch/restore; native process ownership stays with the host's supervised runner.
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runNative, type NativeRunner } from "./native-process.ts";

const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export interface CheckoutIdentity { head: string; branch: string; main: string }
const equal = (a: CheckoutIdentity, b: CheckoutIdentity) => a.head === b.head && a.branch === b.branch && a.main === b.main;
const entries = (value: string) => value.split("\0").filter(Boolean);
const kind = (path: string) => {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
};

export class DeploymentGit {
  constructor(readonly project: string, private readonly runner: NativeRunner = runNative, private readonly scratch = tmpdir(), private readonly effects = runner,
    private readonly executable = "git") {}
  private async git(args: string[], signal?: AbortSignal, extra: NodeJS.ProcessEnv = {}, effect = false) {
    const env = { ...process.env };
    // A caller's alternate checkout/index must not redirect checks or writes away from the locked project.
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
    return (effect ? this.effects : this.runner)({ command: this.executable, args: ["--no-optional-locks", "-c", "core.quotePath=false", "-C", this.project, ...args],
      cwd: this.project, env: { ...env, GIT_TERMINAL_PROMPT: "0", ...extra }, signal, protocol: true }, () => {});
  }
  private async effect(args: string[], signal?: AbortSignal): Promise<void> {
    if ((await this.git(args, signal, {}, true)).code !== 0) throw new Error("Git 代码切换失败，保留事务等待恢复");
  }
  private async text(args: string[], signal?: AbortSignal, extra?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.git(args, signal, extra);
    if (result.code !== 0) throw new Error("无法完整读取 Git 状态，未继续切换代码");
    return result.stdout;
  }
  private async commit(ref: string, signal?: AbortSignal): Promise<string> {
    const value = (await this.text(["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"], signal)).trim();
    if (!sha.test(value)) throw new Error("Git 提交身份无效");
    return value;
  }
  async identity(signal?: AbortSignal): Promise<CheckoutIdentity> {
    const head = await this.commit("HEAD", signal), main = await this.commit("refs/heads/main", signal);
    const branch = (await this.text(["rev-parse", "--abbrev-ref", "HEAD"], signal)).trim();
    if (!branch || /[\x00-\x20\x7f]/.test(branch)) throw new Error("无法读取当前分支");
    return { head, main, branch };
  }
  /** A deployment needs neither main nor a branch. Empty without a commit to read: an unpacked release has no checkout. */
  async head(signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], signal), value = result.stdout.trim();
      return result.code === 0 && sha.test(value) ? value : "";
    } catch (error) { if (signal?.aborted) throw error; return ""; }
  }
  /** The build the checkout's launcher reports (Get-CheckoutBuild in bot-supervisor.ps1): the commit, -dirty with tracked changes; empty without Git. */
  async checkoutBuild(signal?: AbortSignal): Promise<string> {
    const head = await this.head(signal);
    if (!head) return "";
    const status = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=no"], signal);
    return head.slice(0, 12) + (status.code === 0 && status.stdout ? "-dirty" : "");
  }
  /** show-ref tells a missing main (1) apart from a repository it cannot read. */
  async mainExists(signal?: AbortSignal): Promise<boolean> {
    const result = await this.git(["show-ref", "--verify", "--quiet", "refs/heads/main"], signal);
    if (result.code !== 0 && result.code !== 1) throw new Error("无法完整读取 Git 状态，未继续切换代码");
    return result.code === 0;
  }
  private async tracked(signal?: AbortSignal): Promise<string[]> {
    // -z retains paths containing line breaks. Rename entries have a second path, but any tracked change refuses.
    return entries(await this.text(["status", "--porcelain=v1", "-z", "--untracked-files=no"], signal)).map(line => "未提交的改动：" + line);
  }
  private async trackedType(basis: string, path: string, signal?: AbortSignal): Promise<string | null> {
    // ls-tree distinguishes absent paths from command errors; cat-file's nonzero status cannot do that safely.
    const rows = entries(await this.text(["--literal-pathspecs", "ls-tree", "-z", basis, "--", path], signal));
    if (!rows.length) return null;
    if (rows.length !== 1 || !rows[0]!.endsWith("\t" + path)) throw new Error("Git 路径状态不完整");
    const type = rows[0]!.split(" ")[1];
    if (!["tree", "blob", "commit"].includes(type!)) throw new Error("Git 路径类型不支持");
    return type!;
  }
  private safePath(path: string): string {
    if (!path || path.split("/").some(part => !part || part === "." || part === "..") || path.includes("\\") || isAbsolute(path))
      throw new Error("Git 路径无法安全核对，未继续切换代码");
    return join(this.project, path);
  }
  async pathConflicts(basis: string, from: string, to: string, label: string, owner = label, signal?: AbortSignal): Promise<string[]> {
    if (![basis, from, to].every(value => sha.test(value))) throw new Error("切换提交身份无效");
    const conflicts: string[] = [], occupied = new Map<string, boolean>();
    const added = entries(await this.text(["diff", "--name-only", "--no-renames", "-z", "--diff-filter=A", from, to, "--"], signal));
    for (const path of added) {
      this.safePath(path); const parts = path.split("/"); let covered = false;
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join("/");
        if (!occupied.has(parent)) {
          const stat = kind(this.safePath(parent)), taken = !!stat && (!stat.isDirectory() || stat.isSymbolicLink());
          occupied.set(parent, taken);
          if (taken && await this.trackedType(basis, parent, signal) !== "blob") conflicts.push(`未跟踪的文件或链接占着${owner}的目录位置：${parent}`);
        }
        if (occupied.get(parent)) { covered = true; break; } // Never inspect another directory through a link.
      }
      if (covered) continue;
      const stat = kind(this.safePath(path)); if (!stat) continue;
      const type = await this.trackedType(basis, path, signal);
      if (stat.isDirectory() && !stat.isSymbolicLink() && type === "tree") {
        for (const other of entries(await this.text(["--literal-pathspecs", "ls-files", "-z", "--others", "--", path], signal)))
          conflicts.push(`未跟踪的文件会随目录删除（${label}在 ${path} 是文件）：${other}`);
      } else if (type !== "blob") conflicts.push(`未跟踪的文件会被${label}覆盖：${path}`);
    }
    return conflicts;
  }
  async dryRun(from: string, to: string, signal?: AbortSignal): Promise<boolean> {
    if (![from, to].every(value => sha.test(value))) throw new Error("切换提交身份无效");
    const path = (await this.text(["rev-parse", "--git-path", "index"], signal)).trim(), source = isAbsolute(path) ? path : resolve(this.project, path);
    const stat = kind(source);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error("无法复制普通 Git 索引，未继续切换代码");
    const scratch = resolve(this.scratch), directory = mkdtempSync(join(scratch, "mixin-switch-"));
    try {
      const copy = join(directory, "index"); copyFileSync(source, copy);
      // read-tree -m trusts the index's stat data: a file that was only touched would count as changed. Refresh the copy, never
      // the real index; real changes are refused before this and still fail here. A failed refresh only leaves the check stricter.
      await this.git(["update-index", "-q", "--refresh"], signal, { GIT_INDEX_FILE: copy });
      return (await this.git(["read-tree", "-n", "-m", "-u", from, to], signal, { GIT_INDEX_FILE: copy })).code === 0;
    } finally {
      if (dirname(resolve(directory)) !== scratch) throw new Error("试运行目录越界，未清理");
      rmSync(directory, { recursive: true, force: true });
    }
  }
  async switchConflicts(target: string, signal?: AbortSignal): Promise<{ identity: CheckoutIdentity; conflicts: string[] }> {
    if (!sha.test(target)) throw new Error("目标提交身份无效");
    const identity = await this.identity(signal), conflicts = await this.tracked(signal);
    const ancestor = await this.git(["merge-base", "--is-ancestor", identity.main, target], signal);
    if (ancestor.code !== 0 && ancestor.code !== 1) throw new Error("无法核对目标提交与 main 的关系");
    if (ancestor.code !== 0) conflicts.push(`本地 main（${identity.main.slice(0, 7)}）无法快进到目标提交 ${target.slice(0, 7)}`);
    if (!conflicts.length) {
      if (identity.head !== identity.main) conflicts.push(...await this.pathConflicts(identity.head, identity.head, identity.main, "切换途经的 main 分支", undefined, signal));
      if (identity.main !== target) conflicts.push(...await this.pathConflicts(identity.head, identity.main, target, "目标版本", undefined, signal));
      if (!conflicts.length) {
        if (identity.head !== identity.main && !await this.dryRun(identity.head, identity.main, signal)) conflicts.push("git 试运行切换到 main 失败");
        else if (identity.head !== target && !await this.dryRun(identity.head, target, signal)) conflicts.push("git 试运行切换到目标提交失败");
      }
    }
    if (!equal(identity, await this.identity(signal))) throw new Error("预检期间代码身份变化，请重新预览");
    return { identity, conflicts };
  }
  async restoreConflicts(original: string, target: string, branch: string, signal?: AbortSignal): Promise<string[]> {
    if (![original, target].every(value => sha.test(value))) throw new Error("原提交或目标提交身份无效");
    const head = await this.commit("HEAD", signal), conflicts = await this.tracked(signal);
    if (head !== original && head !== target)
      conflicts.push(`当前提交 ${head.slice(0, 7)} 既不是升级前的 ${original.slice(0, 7)}，也不是目标 ${target.slice(0, 7)}：升级后有新的提交或切换`);
    if (branch !== "HEAD") {
      if (!branch || (await this.git(["check-ref-format", "--branch", branch], signal)).code !== 0) throw new Error("原分支名称无效");
      const exists = await this.git(["show-ref", "--verify", "--quiet", "refs/heads/" + branch], signal);
      if (exists.code !== 0 && exists.code !== 1) throw new Error("无法完整读取 Git 状态，未继续切换代码");
      if (exists.code === 1) conflicts.push(`分支 ${branch} 已不存在：回滚不会重新创建它`);
      else {
        const ref = await this.commit("refs/heads/" + branch, signal);
        if (ref !== original && ref !== target) conflicts.push(`分支 ${branch} 指向 ${ref.slice(0, 7)}，不是升级前或目标提交：回滚会把它重置到 ${original.slice(0, 7)}`);
      }
    }
    conflicts.push(...await this.pathConflicts(head, head, original, "升级前的版本", "升级前版本", signal));
    if (!conflicts.length && head !== original && !await this.dryRun(head, original, signal)) conflicts.push("git 试运行恢复原提交失败");
    return conflicts;
  }
  async switch(target: string, expected: CheckoutIdentity, signal?: AbortSignal): Promise<void> {
    const checked = await this.switchConflicts(target, signal);
    if (!equal(checked.identity, expected) || checked.conflicts.length) throw new Error("代码状态或切换检查已变化；未切换代码");
    await this.effect(["checkout", "--quiet", "main"], signal);
    await this.effect(["merge", "--ff-only", "--quiet", target], signal);
    if (await this.commit("HEAD", signal) !== target || (await this.tracked(signal)).length) throw new Error("切换后的代码不等于目标提交");
  }
  async restore(original: string, target: string, branch: string): Promise<void> {
    if ((await this.restoreConflicts(original, target, branch)).length) throw new Error("代码回滚存在冲突，保留事务等待处理");
    if (branch === "HEAD") await this.effect(["checkout", "--detach", "--quiet", original]);
    else {
      await this.effect(["checkout", "--quiet", branch]);
      await this.effect(["reset", "--hard", original]);
    }
    if (await this.commit("HEAD") !== original || (await this.tracked()).length) throw new Error("回滚后的代码不等于原提交");
  }
  async dependenciesReusable(original: string, target: string, signal?: AbortSignal): Promise<boolean> {
    if (![original, target].every(value => sha.test(value))) throw new Error("依赖比较提交无效");
    try {
      if (!kind(join(this.project, "node_modules"))?.isDirectory()) return false;
      const manifest = JSON.parse(readFileSync(join(this.project, "package.json"), "utf8"));
      if (manifest.workspaces) return false;
      const inputs = ["package.json", "bun.lock", "bun.lockb", "bunfig.toml", ".npmrc", "scripts/patches", "patches"];
      for (const path of Object.values(manifest.patchedDependencies ?? {})) {
        if (typeof path !== "string") return false; this.safePath(path); inputs.push(path);
      }
      if ((await this.git(["--literal-pathspecs", "diff", "--quiet", original, target, "--", ...inputs], signal)).code !== 0) return false;
      for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
        for (const [name, version] of Object.entries(manifest[section] ?? {})) {
          if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || name.split("/").some(part => part === "." || part === "..")
            || typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return false;
          const root = join(this.project, "node_modules", name), installed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
          if (installed.name !== name || installed.version !== version) return false;
          for (const bin of typeof installed.bin === "string" ? [installed.bin] : Object.values(installed.bin ?? {})) {
            if (typeof bin !== "string" || isAbsolute(bin) || !resolve(root, bin).startsWith(resolve(root) + (process.platform === "win32" ? "\\" : "/"))
              || !kind(join(root, bin))?.isFile()) return false;
          }
        }
      }
      return true;
    } catch { signal?.throwIfAborted(); return false; }
  }
}
