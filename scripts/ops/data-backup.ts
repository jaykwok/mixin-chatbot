// Offline snapshot under both maintenance leases. DB checkpoint/close precedes every external-file copy.
import { Database } from "bun:sqlite";
import { lstat, mkdir, readdir, realpath, readFile, copyFile, open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GROUP_DATA_ROOT } from "../../src/core/config.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { isPathInside } from "../../src/agent/paths.ts";
import { hashFile } from "../../src/core/file-hash.ts";

type FileRecord = { area: "state" | "groups"; path: string; bytes: number; sha256: string };
type Manifest = { format: 1; at: string; files: FileRecord[] };
async function files(root: string, prefix = ""): Promise<string[]> {
  let names;
  try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const found: string[] = [];
  for (const name of names.sort()) {
    const relative = prefix ? `${prefix}/${name}` : name, path = join(root, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`备份拒绝链接：${path}`);
    if (info.isDirectory()) found.push(...await files(path, relative));
    else if (info.isFile()) found.push(relative);
    else throw new Error(`备份拒绝特殊文件：${path}`);
  }
  return found;
}
async function checkedRoot(root: string) {
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== resolve(root)) throw new Error("备份数据根不是普通目录");
}
async function ordinaryAncestors(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("备份或恢复目标的父路径是链接"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(current) === current) return;
  }
}
async function syncFile(path: string) { const file = await open(path, "r+"); try { await file.sync(); } finally { await file.close(); } }
/** Caller holds maintenance leases. Includes every member tmp, index, attachment and their ownership journals. */
export async function createDataBackup(project: string, groups: string, destination: string): Promise<Manifest> {
  const roots = { state: resolve(project, "data/state"), groups: resolve(groups) };
  destination = resolve(destination);
  await ordinaryAncestors(destination);
  for (const root of Object.values(roots)) {
    if (isPathInside(destination, root) || isPathInside(root, destination)) throw new Error("备份目录与数据目录不能包含彼此");
    await checkedRoot(root);
  }
  const entries = await Promise.all(Object.entries(roots).map(async ([area, root]) => ({ area: area as FileRecord["area"], root, names: await files(root) })));
  for (const { root, names } of entries) for (const name of names.filter(name => name.endsWith(".sqlite"))) {
    const db = new Database(join(root, name), { strict: true });
    try {
      if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("备份前数据库校验失败");
      const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
      if (checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) throw new Error("备份前 checkpoint 未完成，拒绝制作不一致快照");
    } finally { db.close(); }
  }
  await mkdir(dirname(destination), { recursive: true });
  await mkdir(destination, { mode: 0o700 }); // Never overwrite another backup.
  const manifest: Manifest = { format: 1, at: new Date().toISOString(), files: [] };
  for (const { area, root } of entries) for (const name of await files(root)) {
    if (/\.sqlite-(wal|shm|journal)$/.test(name)) continue;
    const source = join(root, name), target = join(destination, area, name), prior = await hashFile(source);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await syncFile(target);
    const hash = await hashFile(target);
    if (prior !== hash || hash !== await hashFile(source)) throw new Error("停写边界内文件仍在变化，备份未完成");
    manifest.files.push({ area, path: name, bytes: (await lstat(target)).size, sha256: hash });
  }
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await syncFile(join(destination, "manifest.json"));
  return manifest;
}
/** Restore into empty staging roots. Validate the complete list before creating any data file. */
export async function restoreDataBackup(source: string, project: string, groups: string): Promise<void> {
  source = resolve(source); await checkedRoot(source);
  const manifest: Manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error("备份清单格式无效");
  const roots = { state: resolve(project, "data/state"), groups: resolve(groups) }, seen = new Set<string>();
  if (roots.state === roots.groups || isPathInside(roots.state, roots.groups) || isPathInside(roots.groups, roots.state)) throw new Error("恢复的状态目录与群数据根不能重叠");
  for (const file of manifest.files) {
    if (!["state", "groups"].includes(file.area) || typeof file.path !== "string" || file.path.split("/").some(part => !part || part === "." || part === "..")
      || /[\\:\x00]/.test(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("备份清单路径或摘要无效");
    const key = file.area + "/" + file.path;
    if (seen.has(key.toLowerCase())) throw new Error("备份清单路径重复"); seen.add(key.toLowerCase());
    const path = join(source, key);
    if (await realpath(path) !== path || !(await lstat(path)).isFile() || (await lstat(path)).size !== file.bytes || await hashFile(path) !== file.sha256) throw new Error("备份文件缺失、损坏或被重定向");
  }
  for (const root of Object.values(roots)) {
    await ordinaryAncestors(root);
    try { if ((await readdir(root)).length) throw new Error("恢复目标必须为空；不覆盖现有数据"); await checkedRoot(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const file of manifest.files) {
    const target = join(roots[file.area], file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(source, file.area, file.path), target, constants.COPYFILE_EXCL);
    await syncFile(target);
    if ((await lstat(target)).size !== file.bytes || await hashFile(target) !== file.sha256) throw new Error("恢复复制时备份发生变化，保留暂存目录供检查");
  }
  for (const file of manifest.files.filter(file => file.path.endsWith(".sqlite"))) {
    const db = new Database(join(roots[file.area], file.path), { readonly: true });
    try { if ((db.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check !== "ok") throw new Error("恢复的数据库完整性检查失败"); }
    finally { db.close(); }
  }
}
if (import.meta.main) {
  const [command, path, project, groups] = process.argv.slice(2);
  if (!path || !["backup", "restore"].includes(command!)) throw new Error("用法：bun scripts/ops/data-backup.ts backup <新备份目录> | restore <备份目录> <空暂存项目> [空群数据根]");
  if (command === "backup") await withMaintenance(() => createDataBackup(process.cwd(), GROUP_DATA_ROOT, path), GROUP_DATA_ROOT);
  else {
    if (!project) throw new Error("restore 需要空暂存项目路径");
    await withMaintenance(() => restoreDataBackup(path, project, groups ?? join(project, "data/groups")), GROUP_DATA_ROOT);
  }
  console.log("完成；恢复到暂存目录后，请配置模型并运行 scripts/migrations/validate.ts，再开放调度。");
}
