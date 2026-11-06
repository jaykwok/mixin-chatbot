// Bounded reads of the small host-side files a deployment consumes. Links and oversized files are never followed.
import { lstatSync } from "node:fs";
import { readBoundedText } from "../lib/bounded-text.ts";
import { MaintenanceRefused } from "./maintenance.ts";

export function readText(path: string): string | null {
  try { return readBoundedText(path, 8 * 1024 * 1024); }
  catch { throw new Error("部署输入文件无法完整读取，保留现场"); }
}
/** The saved shared-files root must be an existing real directory, never a link. */
export function directory(path: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new MaintenanceRefused(`共享资料目录不存在或是链接：${path}；请恢复原挂载后重试`);
}
