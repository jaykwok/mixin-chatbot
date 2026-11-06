// A recovery must execute the same host policy as the interrupted transaction, not just its data tools.
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { codeDigest, freezeRuntime } from "./source-runtime.ts";
import { consoleDir, prepareConsoleDir } from "./console-state.ts";
import type { DeploymentState } from "./deployment-state.ts";
import { MaintenanceRefused } from "./maintenance.ts";

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export function deploymentRuntime(project: string, source: string, pending: DeploymentState | null) {
  prepareConsoleDir(consoleDir(project));
  if (!pending) return freezeRuntime(consoleDir(project), source);
  const digest = pending.confirmation.text(`backup/snapshots/${pending.snapshot}/host-runtime`)?.trim();
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new MaintenanceRefused("此事务缺少受支持的固定运维运行包记录，请用原版本恢复");
  const root = resolve(join(consoleDir(project), "runtime/source-" + digest));
  // A removed .console is rebuilt only from byte-identical code (the recorded target's own export), never from another release.
  if (!present(root) && codeDigest(source) === digest) freezeRuntime(consoleDir(project), source);
  try { if (codeDigest(root) !== digest) throw new Error(); }
  catch { throw new MaintenanceRefused("此事务的固定运维运行包缺失或变化，请使用对应版本恢复"); }
  if (pending.execution && pending.execution.checkpoint.runtime !== digest) throw new MaintenanceRefused("事务与部署执行记录的运行包不一致，保留现场");
  return { root, digest };
}
