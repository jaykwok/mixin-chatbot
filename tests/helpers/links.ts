// Real symbolic links on Windows need Developer Mode or an elevated process; directory junctions need neither. Tests that
// must see real links run only where this process can create them, and name the reason otherwise.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { testTempDir } from "./temp.ts";

/** Why this process cannot create a directory symbolic link, or null when it can. */
export function symlinkUnavailable(): string | null {
  const dir = mkdtempSync(join(testTempDir(), "symlink-probe-"));
  try {
    mkdirSync(join(dir, "target"));
    symlinkSync(join(dir, "target"), join(dir, "link"), "dir");
    return null;
  } catch (error) {
    return `本进程不能创建符号链接（${(error as NodeJS.ErrnoException).code ?? String(error)}；Windows 需要开发者模式或管理员权限）`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
