// Non-secret deployment execution metadata. No native process or database modules are loaded here.
import { validateOpsWriter, type DockerTaskRecord, type WindowsTaskRecord } from "./ops-writer.ts";
import { readOpsResult, type OpsResult } from "./ops-result.ts";
import { validateHostProcess, type LinuxTaskRecord } from "./ops-host-process.ts";
const TRANSACTION_NAME = /^deploy-[A-Za-z0-9]+$/;

export const DEPLOYMENT_STEPS = ["stop", "switch-code", "prepare-dependencies", "configure-runtime", "configure-app", "configure-models",
  "configure-directory", "prepare-data", "enable-verification", "install-candidate", "start-verification",
  "commit-data", "retire-previous-writers", "disable-verification", "start-candidate", "publish-target",
  "restore-data", "restore-code", "restore-dependencies", "restore-configuration", "restore-service", "start-original"] as const;
export type DeploymentStep = typeof DEPLOYMENT_STEPS[number];
export type DeploymentDirection = "forward" | "rollback";
export interface DeploymentCheckpoint {
  version: 1;
  snapshot: string;
  runtime: string;
  direction: DeploymentDirection;
  step: DeploymentStep;
}
export interface DeploymentExecution {
  version: 1;
  checkpoint: DeploymentCheckpoint;
  writer?: DockerTaskRecord | WindowsTaskRecord | LinuxTaskRecord;
  result?: OpsResult;
  completion?: DeploymentDirection;
}

export function validateDeploymentCheckpoint(value: unknown): asserts value is DeploymentCheckpoint {
  const entry = value as DeploymentCheckpoint | null;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || Object.keys(entry).sort().join(",") !== "direction,runtime,snapshot,step,version" || entry.version !== 1
    || typeof entry.snapshot !== "string" || !TRANSACTION_NAME.test(entry.snapshot)
    || typeof entry.runtime !== "string" || !/^[a-f0-9]{64}$/.test(entry.runtime)
    || !["forward", "rollback"].includes(entry.direction) || !DEPLOYMENT_STEPS.includes(entry.step))
    throw new Error("部署执行记录格式不匹配，保留事务；请使用对应版本恢复");
}

export function parseDeploymentExecution(text: string | null, snapshot?: string, wasRunning?: boolean): DeploymentExecution | null {
  if (text === null) return null;
  try {
    if (Buffer.byteLength(text) > 32 * 1024) throw new Error();
    const value = JSON.parse(text) as DeploymentExecution;
    if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
      || Object.keys(value).some(key => !["version", "checkpoint", "writer", "result", "completion"].includes(key))) throw new Error();
    validateDeploymentCheckpoint(value.checkpoint);
    if (snapshot !== undefined && value.checkpoint.snapshot !== snapshot) throw new Error();
    if (Object.hasOwn(value, "writer")) {
      if (value.writer?.kind === "linux-supervisor") validateHostProcess(value.writer);
      else validateOpsWriter(value.writer, value.checkpoint.runtime);
    }
    if (Object.hasOwn(value, "result")) {
      const result = value.result;
      if (!result || !["deploy", "repair", "update", "resume", "rollback"].includes(result.command)
        || !readOpsResult(result, result.command, result.exitCode) || result.exitCode > 255
        || wasRunning !== undefined && result.wasRunning !== wasRunning || result.message.length > 8192
        || (result.outcome === "success") !== (result.exitCode === 0)) throw new Error();
    }
    if (Object.hasOwn(value, "completion") && (!value.result || value.completion !== value.checkpoint.direction
      || !["forward", "rollback"].includes(value.completion!) || value.writer && value.writer.phase !== "reaped"
      || !["running", "stopped"].includes(value.result.finalState)
      || value.completion === "forward" && value.result.outcome !== "success")) throw new Error();
    if (value.result?.outcome === "success" && !value.completion) throw new Error();
    return value;
  } catch { throw new Error("部署执行记录无法读取或格式不支持，保留事务；请使用对应版本恢复"); }
}
