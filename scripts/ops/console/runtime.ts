// An immutable source package: all lazy workers and read helpers stay on the version which opened this console.
// This deliberately copies no data/, .env, node_modules, logs or exports. Bun and the browser bundle are separate.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const TREES = ["scripts", "src", "ui"];
const FILES = ["package.json", "bun.lock", "Dockerfile", "pyproject.toml", "uv.lock", ".python-version"];
const CODE = new Set([".ts", ".tsx", ".js", ".mjs", ".sh", ".ps1", ".py", ".json", ".css", ".svg", ".md", ".txt"]);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Source = { name: string; bytes: Buffer; digest: string };
function sources(project: string): Source[] {
  const rows: Source[] = []; let size = 0;
  const visit = (name: string) => {
    const path = join(project, name), info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("控制台运行包的源码包含链接，拒绝固定版本");
    if (info.isDirectory()) {
      for (const child of readdirSync(path).sort()) if (!child.startsWith(".") && child !== "node_modules") visit(name + "/" + child);
      return;
    }
    if (!FILES.includes(name) && !CODE.has(extname(name)) && !name.endsWith("/LICENSE")) return;
    if (!info.isFile() || info.size > 32 * 1024 * 1024 || (size += info.size) > 128 * 1024 * 1024) throw new Error("控制台源码文件类型或大小异常");
    const bytes = readFileSync(path); rows.push({ name, bytes, digest: hash(bytes) });
  };
  for (const name of [...TREES, ...FILES]) {
    try { visit(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && FILES.includes(name)) continue; throw error; }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
}
const digestOf = (rows: Source[]) => hash(JSON.stringify(rows.map(row => [row.name, row.digest])));
export function codeDigest(project: string): string { return digestOf(sources(project)); }

export function freezeRuntime(consoleDir: string, project: string): { root: string; digest: string } {
  const rows = sources(project), digest = digestOf(rows), parent = join(consoleDir, "runtime"), root = join(parent, "source-" + digest);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  let exists = false;
  try { const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("固定版本运行包路径异常"); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!exists) {
    // The enclosing runtime directory stays private. Only these non-secret code trees may be bind-mounted read-only
    // into the service image, whose numeric user can differ from the host operator (rootful Docker).
    const stage = join(parent, ".source-" + randomUUID()); mkdirSync(stage, { mode: 0o755 });
    try {
      const directories = new Set([stage]);
      for (const row of rows) {
        const path = join(stage, row.name); mkdirSync(dirname(path), { recursive: true, mode: 0o755 }); writeFileSync(path, row.bytes, { mode: 0o644, flag: "wx" });
        if (process.platform !== "win32") chmodSync(path, 0o644);
        for (let dir = dirname(path); dir !== stage; dir = dirname(dir)) directories.add(dir);
      }
      if (process.platform !== "win32") for (const dir of directories) chmodSync(dir, 0o755);
      if (codeDigest(stage) !== digest || codeDigest(project) !== digest) throw new Error("固定运行包期间源码变化，请重新启动控制台");
      try { renameSync(stage, root); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "") || codeDigest(root) !== digest) throw error;
      }
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  if (codeDigest(root) !== digest) throw new Error("固定版本运行包摘要不符，已保留现场");
  // Reuse is use: pruneRuntimes keeps what was frozen or reused within its window.
  if (exists) try { const now = new Date(); utimesSync(root, now, now); } catch { /* another identity's package: its age counts from creation */ }
  return { root: resolve(root), digest };
}

const UNUSED_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Removes frozen versions (source-<digest>, executor bundles <digest>/ and stages left by an interrupted freeze) that are not
 * in `keep` and were not frozen or reused within 7 days. The caller holds deploy.lock and has found no unfinished task, open
 * transaction or unfinished maintenance, so nothing else can still name one. Each is first renamed aside, so a removal that
 * stops part-way never leaves a damaged package under its digest; what is left aside goes at the next prune.
 */
export function pruneRuntimes(consoleDir: string, keep: ReadonlySet<string>, now = Date.now()): string[] {
  const parent = join(consoleDir, "runtime"), removed: string[] = [];
  let names: string[];
  try { names = readdirSync(parent); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return removed; throw error; }
  for (const name of names) {
    const path = join(parent, name);
    if (/^\.removed-[a-f0-9-]{36}$/.test(name)) { try { rmSync(path, { recursive: true, force: true }); } catch { /* next prune */ } continue; }
    const match = /^(?:source-)?([a-f0-9]{64})$|^\.source-[a-f0-9-]{36}$/.exec(name);
    if (!match || match[1] && keep.has(match[1])) continue;
    const info = lstatSync(path);
    if (!info.isDirectory() || now - info.mtimeMs < UNUSED_MS) continue;
    const aside = join(parent, ".removed-" + randomUUID());
    try { renameSync(path, aside); } catch { continue; }
    removed.push(name);
    try { rmSync(aside, { recursive: true, force: true }); } catch { /* next prune */ }
  }
  return removed;
}

/** Once changed (including unreadable), never unlock an old session even if a rollback restores identical bytes. */
export class CodeFence {
  private stale = false;
  constructor(readonly project: string, readonly expected: string, readonly changed: () => void = () => {}) {}
  current(): boolean {
    if (this.stale) return false;
    try { if (codeDigest(this.project) === this.expected) return true; } catch { /* unreadable fails closed */ }
    this.stale = true; this.changed(); return false;
  }
}
