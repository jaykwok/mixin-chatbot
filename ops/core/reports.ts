import { chownSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { validateOpsReports, type OpsReports } from "../../src/contracts/ops-reports.ts";

export const reportsPath = (project: string) => join(project, "tmp/backup-cleanup");
function directory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("备份报告路径不是普通目录，未改变权限");
  return info;
}
export function inspectReports(project: string): OpsReports {
  directory(join(project, "tmp")); const info = directory(reportsPath(project));
  if (process.platform !== "win32" && info.mode & 0o022) throw new Error("备份报告目录允许其他身份写入，未改变权限");
  return { dev: String(info.dev), ino: String(info.ino), uid: info.uid, gid: info.gid };
}
export function checkReports(project: string, expected: OpsReports): void {
  validateOpsReports(expected);
  if (JSON.stringify(inspectReports(project)) !== JSON.stringify({ dev: expected.dev, ino: expected.ino, uid: expected.uid, gid: expected.gid }))
    throw new Error("备份报告目录被替换或属主变化，未执行");
}
export function prepareReports(project: string, owner: { uid: number; gid: number }): OpsReports {
  for (const path of [join(project, "tmp"), reportsPath(project)]) {
    let created = false;
    try { mkdirSync(path, { mode: path === reportsPath(project) ? 0o700 : 0o755 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    directory(path);
    if (created && path === reportsPath(project) && process.platform !== "win32") chownSync(path, owner.uid, owner.gid);
  }
  const found = inspectReports(project);
  if (process.platform !== "win32" && (found.uid !== owner.uid || found.gid !== owner.gid)) throw new Error("现有备份报告目录属主不符，未改变权限");
  return found;
}
