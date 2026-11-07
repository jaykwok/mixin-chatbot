// File effects every deployment platform shares that runs a POSIX host: the snapshot's copies of the settings, the
// archive of what a rollback replaces, and the removal of a completed transaction's material. Owner, mode and links
// are preserved by the platform's own cp; nothing here touches a conversation database.
import { randomBytes } from "node:crypto";
import { existsSync, lchownSync, lstatSync, mkdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { NativeRunner } from "./native-process.ts";

export type Owner = { uid: number; gid: number };
/** The file tools of the platform: GNU cp/mv in the Linux host's PATH, the system's own on macOS. */
export interface FileCommands { cp: string; mv: string }

/** realpath that also accepts a missing tail (`realpath -m`): the backup and log directories may not exist yet. */
export function resolvedPath(path: string): string {
  const rest: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try { return join(realpathSync(at), ...rest.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw error;
      // A dangling link is no missing tail: it would hide where the directory gets created later.
      try { lstatSync(at); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === "ENOENT") { rest.push(basename(at)); continue; } throw missing; }
      throw new Error("路径含有失效的链接：" + at);
    }
  }
}

/** Only directories this run creates go to the service; existing ones and their data keep their owner. */
export function serviceDirectories(project: string, paths: readonly string[], owner?: Owner): void {
  for (const relative of paths) {
    const path = join(project, relative), created: string[] = [];
    if (existsSync(path)) { if (!lstatSync(path).isDirectory()) throw new Error(`${relative} 不是目录`); continue; }
    for (let at = path; !existsSync(at) && dirname(at) !== at; at = dirname(at)) created.push(at);
    mkdirSync(path, { recursive: true });
    if (owner) for (const directory of created) lchownSync(directory, owner.uid, owner.gid);
  }
}

async function copy(project: string, run: NativeRunner, tools: FileCommands, source: string, destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  const result = await run({ command: tools.cp, args: ["-a", "--", source, destination], cwd: project, protocol: true, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(`无法复制 ${source}（退出码 ${result.code}）`);
}
export async function captureFiles(project: string, snapshot: string, files: readonly string[], run: NativeRunner, tools: FileCommands): Promise<void> {
  for (const relative of files) {
    const source = join(project, relative);
    if (existsSync(source)) await copy(project, run, tools, source, join(snapshot, relative));
  }
}
/**
 * Moved aside under the transaction's name, never deleted. A rerun archives what it restored and copies it again. The
 * archive directory goes to `owner`, who may clean it up later.
 */
export async function archiveEntry(project: string, path: string, name: string, run: NativeRunner, tools: FileCommands, owner?: Owner): Promise<void> {
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const root = realpathSync(project), parent = realpathSync(dirname(path));
  if (parent !== root && !parent.startsWith(root + "/")) throw new Error("归档父目录越界");
  const archive = join(project, "backup/rm", name);
  if (!existsSync(archive)) { mkdirSync(archive, { recursive: true }); if (owner) lchownSync(archive, owner.uid, owner.gid); }
  const result = await run({ command: tools.mv, args: ["--", path, join(archive, `${Math.floor(Date.now() / 1000)}-${randomBytes(4).toString("hex")}-${basename(path)}`)],
    cwd: project, protocol: true, timeoutMs: 10 * 60_000 });
  if (result.code !== 0) throw new Error(`无法归档 ${path}（退出码 ${result.code}）`);
}
export async function restoreFiles(project: string, snapshot: string, name: string, files: readonly string[], run: NativeRunner, tools: FileCommands, owner?: Owner): Promise<void> {
  for (const relative of files) {
    const current = join(project, relative), saved = join(snapshot, relative);
    await archiveEntry(project, current, name, run, tools, owner);
    if (existsSync(saved)) await copy(project, run, tools, saved, current);
  }
}
/** A successful operation discards only what it owns: its snapshot and the archive under its name. */
export function removeCompleted(project: string, name: string): void {
  const root = realpathSync(project), backup = join(root, "backup"), targets = [join(backup, "snapshots", name), join(backup, "rm", name)];
  // Refuse a redirected path before removing anything; rm unlinks links inside without following them.
  for (const target of targets) if (resolvedPath(target) !== target) throw new Error("快照路径含有链接");
  for (const target of targets) rmSync(target, { recursive: true, force: true });
  // The service may hold backup/ itself (a Docker bind mount), so only these empty parents may go.
  for (const parent of ["snapshots", "rm"]) {
    try { rmdirSync(join(backup, parent)); } catch { /* Other snapshots or archives remain. */ }
  }
}
