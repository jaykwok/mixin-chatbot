// The writer of a maintenance or deployment data step, as recorded before it starts: a Docker container (daemon-side
// lifetime) or a Windows job object. Ordinary maintenance and deployment recovery share these records and their checks.
import { validateDockerDataAccess, type DockerDataAccess } from "./ops-task-access.ts";
import { validateOpsTaskInput, type OpsTaskInput } from "./ops-task-input.ts";
import { validateOpsReports, type OpsReports } from "./ops-reports.ts";
import { validOpsNetwork, type OpsNetwork } from "./ops-network.ts";
import { validOpsDeploymentTask, type OpsDeploymentTask } from "./ops-deployment-task.ts";

export interface DockerTaskRecord {
  kind: "docker";
  version: 1;
  id: string;
  daemon: string;
  endpoint: string;
  image: string;
  user: string;
  data: string;
  backup: string;
  commandDigest: string;
  network: OpsNetwork;
  access?: DockerDataAccess;
  input?: OpsTaskInput;
  /** Fixed host code over the image's ops/src; dependencies still come from the deployed image. */
  runtime?: string;
  runtimeEnvironment?: string;
  reports?: OpsReports;
  /** A deployment transaction's data step: a logs/ mount and the operation log it appends to. */
  deployment?: OpsDeploymentTask;
  phase: "prepared" | "created" | "starting" | "reaped";
  container?: string;
}
export interface WindowsTaskRecord {
  kind: "windows-job";
  version: 1;
  id: string;
  job: string;
  commandDigest: string;
  phase: "prepared" | "reaped";
}

const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const text = (value: unknown, max = 1024): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);

export function validateOpsWriter(value: unknown, runtime: string): asserts value is DockerTaskRecord | WindowsTaskRecord {
  const writer = value as DockerTaskRecord | WindowsTaskRecord;
  if (!writer || typeof writer !== "object" || Array.isArray(writer) || writer.version !== 1 || !id(writer.id)
    || !hash(writer.commandDigest) || !["docker", "windows-job"].includes(writer.kind)) throw new Error("运维写入者类型不支持");
  if (writer.kind === "windows-job" && (!/^Global\\mixin-process-[a-f0-9-]{36}$/.test(writer.job)
    || writer.job.slice("Global\\mixin-process-".length).replaceAll("-", "") !== writer.id || !["prepared", "reaped"].includes(writer.phase))) throw new Error("Windows 写入者记录不完整");
  if (writer.kind === "docker") {
    if (!text(writer.daemon, 128) || !/^unix:\/\/\/[^\x00-\x1f,]+$/.test(writer.endpoint)
      || !/^sha256:[a-f0-9]{64}$/.test(writer.image) || !/^\d+(?::\d+)?$/.test(writer.user)
      || !text(writer.data) || !text(writer.backup) || !hash(writer.commandDigest) || !validOpsNetwork(writer.network)
      || !["prepared", "created", "starting", "reaped"].includes(writer.phase)
      || writer.container !== undefined && !hash(writer.container)
      || ["created", "starting"].includes(writer.phase) && !writer.container) throw new Error("运维写入者记录格式不支持或不完整");
    if (Object.hasOwn(writer, "access")) validateDockerDataAccess(writer.access);
    if (Object.hasOwn(writer, "input")) validateOpsTaskInput(writer.input);
    if (Object.hasOwn(writer, "reports")) validateOpsReports(writer.reports);
    if (Object.hasOwn(writer, "deployment") && !validOpsDeploymentTask(writer.deployment)) throw new Error("部署数据步骤记录无效");
    if (writer.runtime !== undefined && (!hash(writer.runtime) || writer.runtime !== runtime)) throw new Error("数据步骤运行包与维护请求不符");
    if (writer.runtimeEnvironment !== undefined && !hash(writer.runtimeEnvironment)) throw new Error("运行参数环境摘要无效");
  }
}
