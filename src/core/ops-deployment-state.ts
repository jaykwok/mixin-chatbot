import { join } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { parseDeploymentExecution, type DeploymentExecution } from "../contracts/ops-deployment.ts";

export const OPS_DEPLOYMENT_FILE = "data/state/ops-deployment.json";

/** The bot mounts data/, not host backup/. This single control file is shared with the lock-held host. */
export function readOpsDeploymentRecord(project: string): DeploymentExecution | null {
  let observed = false;
  try {
    for (const name of ["data", "data/state"]) {
      const directory = lstatSync(join(project, name));
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error();
    }
    const path = join(project, OPS_DEPLOYMENT_FILE), before = lstatSync(path, { bigint: true }); observed = true;
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32768n) throw new Error();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error();
      const bytes = Buffer.alloc(Number(opened.size) + 1); let length = 0, count: number;
      do { count = readSync(fd, bytes, length, bytes.length - length, length); length += count; } while (count && length < bytes.length);
      const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
      if (length !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error();
      return parseDeploymentExecution(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } finally { closeSync(fd); }
  } catch (error) {
    if (!observed && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("部署执行记录无法读取或格式不支持；保留现场，先继续或回滚原部署");
  }
}

export function deploymentAllows(record: DeploymentExecution, intent: "service" | "verify" | "release"): boolean {
  if (record.completion) return true;
  // The commit child itself holds the maintenance lease. It sees the commit intent while its writer is active.
  if (intent === "release") return record.checkpoint.direction === "forward" && record.checkpoint.step === "commit-data";
  if (record.writer && record.writer.phase !== "reaped") return false;
  if (intent === "verify") return record.checkpoint.direction === "forward" && record.checkpoint.step === "start-verification";
  return record.checkpoint.direction === "forward" ? ["start-candidate", "publish-target"].includes(record.checkpoint.step)
    : record.checkpoint.step === "start-original";
}
