import { chownSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServiceHost, type ServiceHostOptions, type Platform } from "./service-host.ts";
import { MaintenanceRecord } from "./maintenance-record.ts";
import { DockerPlatform, type DockerService } from "./docker-host.ts";
import { newDockerTask, runDockerTask, taskInput } from "./docker-task.ts";
import { newWindowsTask, runWindowsTask } from "./windows-task.ts";
import { runNative, type NativeOutput, type NativeRunner, type NativeResult } from "./native-process.ts";
import type { MaintenanceHost, MaintenanceRequest } from "./maintenance.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import { codeDigest, freezeRuntime } from "../console/runtime.ts";
import { consoleDir, prepareConsoleDir } from "../console/state.ts";
import type { DeploymentLock } from "./deployment-lock.ts";
import { prepareStatsStage, removeStatsStage, validateStatsSource, type StatsStageRecord } from "./stats-stage.ts";
import { tmpOptions } from "../../lib/tmp-options.ts";
import type { DockerDataAccess } from "../../../src/contracts/ops-task-access.ts";
import { captureRuntimeInput, removeRuntimeInput } from "./runtime-input.ts";
import { runtimeEnvironmentDigest } from "./runtime-environment.ts";
import { checkReports, prepareReports } from "./reports.ts";
import type { OpsReports } from "../../../src/contracts/ops-reports.ts";
import { backupOptions } from "../../lib/backup-options.ts";
import { relayOptions } from "../../lib/relay-options.ts";
import { deploymentDataPath } from "./deployment-data.ts";

export interface DataStep {
  script: string;
  args: string[];
  network?: "none" | "bridge" | "service";
  protocol?: boolean;
  timeoutMs?: number;
  readOnly?: boolean;
  input?: Uint8Array;
  currentCode?: true;
  online?: true;
  runtimeEnvironment?: true;
  reports?: true;
}
export interface MaintenanceHostOptions extends ServiceHostOptions {
  /** Explicit boundary injection for synthetic integration tests, never a CLI option. */
  native?: NativeRunner;
  output?: NativeOutput;
  /** Only explicit recovery may bypass assertAvailable, after comparing the checkpoint inside the same lock. */
  resuming?: true;
  /** How long new app credentials get to connect the event Stream after the restart (tests shorten it). */
  streamTimeoutMs?: number;
}

/** One native host, lock, record and immutable runtime for all data steps of one maintenance action. */
export function createMaintenanceHost(options: MaintenanceHostOptions, request: MaintenanceRequest): {
  host: MaintenanceHost; prepare(): Promise<void>; prepareCleanupBackups(): Promise<void>; prepareTaskAccess(): Promise<void>; prepareReports(): Promise<void>; dataProject(): string;
  prepareImport(source: string, expected?: string, signal?: AbortSignal): Promise<{ path: string; digest: string }>;
  finalizeImport(): Promise<void>;
  prepareRuntimeInput(name: string): Promise<{ input: Uint8Array; digest: string }>;
  finalizeRuntimeInput(): Promise<void>;
  data(step: DataStep, signal?: AbortSignal): Promise<NativeResult>;
} {
  let lock: DeploymentLock | undefined, platform: Platform | undefined, store: MaintenanceRecord | undefined;
  let source: string | undefined, deployment: Awaited<ReturnType<Platform["inspect"]>> | undefined;
  let dataAccess: DockerDataAccess | undefined;
  let reports: OpsReports | undefined;
  const current = () => { if (!lock || !store || !platform) throw new Error("维护宿主未持有部署锁"); lock.assertHeld(); return store; };
  const output: NativeOutput = options.output ?? ((text, stream) => { process[stream].write(text); });
  const dataOwner = () => {
    current(); if (!deployment) throw new Error("尚未核对部署身份");
    if (platform instanceof DockerPlatform && !platform.rootless) {
      const [uid, gid] = (deployment as DockerService).user!.split(":").map(Number);
      if (gid === undefined) throw new MaintenanceRefused("缺少服务的数值 GID，不能准备备份目录");
      return { uid: uid!, gid };
    }
    return { uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0 };
  };
  const service = createServiceHost({ ...options, maintenanceId: request.id,
    async locked(acquired, adapter) {
      lock = acquired; platform = adapter; store = new MaintenanceRecord(options.project, request.id, () => acquired.assertHeld());
      await options.locked?.(acquired, adapter);
    },
    async verify() { if (!options.resuming) current().assertAvailable(); await options.verify(); },
    async finish(result) {
      // Publish the caller's result before clearing the startup blocker. A missing result must retain recovery evidence.
      await options.finish(result); await current().finish(result);
    },
  });
  const host: MaintenanceHost = { ...service,
    async locked(body) { try { return await service.locked(body); } finally { lock = undefined; store = undefined; platform = undefined; source = undefined; deployment = undefined; dataAccess = undefined; } },
    save: checkpoint => current().checkpoint(checkpoint),
  };
  return {
    host,
    dataProject() { current(); return platform instanceof DockerPlatform ? "/app" : options.project; },
    async prepareReports() { reports = prepareReports(options.project, dataOwner()); },
    async prepareRuntimeInput(name) { const record = current(); return captureRuntimeInput(options.project, name, value => record.runtimeDraft(value)); },
    async finalizeRuntimeInput() {
      const record = current(), state = record.read(); if (!state?.runtimeDraft) return;
      if (state.writer && state.writer.phase !== "reaped") throw new Error("数据写入者未回收，运行参数草稿已保留");
      await removeRuntimeInput(options.project, state.runtimeDraft, request.configuration!, value => record.runtimeDraft(value));
    },
    async prepareTaskAccess() {
      current(); if (!deployment) throw new Error("尚未准备维护运行包");
      if (platform instanceof DockerPlatform) dataAccess = await platform.dataAccess(deployment.identity);
    },
    async prepareImport(source, expected, signal) {
      const record = current(), digest = validateStatsSource(options.project, source, expected);
      const input: StatsStageRecord = { version: 1, kind: "stats-import", id: request.id, owner: dataOwner(), phase: "prepared" };
      const staged = await prepareStatsStage(options.project, input, source, digest, value => record.staging(value), signal);
      return { path: (platform instanceof DockerPlatform ? "/app" : options.project) + "/backup/.stat-import-" + request.id + "/stats.sqlite", digest: staged.digest! };
    },
    async finalizeImport() {
      const record = current(), state = record.read();
      if (state?.checkpoint.request.id !== request.id || !state.staging) return;
      if (state.writer && state.writer.phase !== "reaped") throw new Error("数据写入者尚未回收，统计副本已保留");
      await removeStatsStage(options.project, state.staging, value => record.staging(value));
    },
    async prepareCleanupBackups() {
      current(); if (!deployment) throw new Error("先核对部署身份再准备备份目录");
      const path = join(options.project, "backup/revision-cleanup");
      let created = false;
      try { mkdirSync(path, { mode: 0o700 }); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new MaintenanceRefused("修订备份目录不是普通目录");
      if (platform instanceof DockerPlatform && !platform.rootless) {
        const { uid, gid } = dataOwner();
        if (created) chownSync(path, uid, gid);
        else if (info.uid !== uid) throw new MaintenanceRefused("现有修订备份目录属主不符，未改变其权限");
      }
    },
    async prepare() {
      current(); deployment = await platform!.inspect();
      if (!deployment.owned || !["running", "stopped", "absent"].includes(deployment.state)) throw new MaintenanceRefused("部署身份或运行方式不支持维护");
      if (platform instanceof DockerPlatform && deployment.state === "absent") throw new MaintenanceRefused("机器人容器不存在，无法确定数据步骤的版本，请先部署");
      if (codeDigest(options.source) !== request.runtime) throw new MaintenanceRefused("维护运行包已经变化，请重新预览");
      prepareConsoleDir(consoleDir(options.project));
      const pinned = freezeRuntime(consoleDir(options.project), options.source);
      if (pinned.digest !== request.runtime) throw new MaintenanceRefused("固定维护运行包时版本变化");
      source = pinned.root;
      const backup = join(options.project, "backup");
      mkdirSync(backup, { recursive: true });
      const stat = lstatSync(backup);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MaintenanceRefused("备份路径不是普通目录");
    },
    async data(step, signal) {
      const record = current();
      if (!source || !deployment) throw new Error("数据步骤尚未固定版本");
      if (!/^scripts\/[a-zA-Z0-9/-]+\.ts$/.test(step.script) || step.script.includes("..")) throw new Error("数据脚本路径无效");
      const facts = await platform!.inspect();
      const tmp = step.readOnly && step.script === "scripts/ops/tmp-admin.ts" ? tmpOptions(step.args, true) : undefined;
      const preview = step.readOnly && (step.script === "scripts/runtime/revision-cleanup.ts" && ["preview", "space", "shrink-preview"].includes(step.args[0]!)
        || tmp && !tmp.mutating && ["list", "preview", "reclaim", "discard"].includes(tmp.command!)
        || step.script === "scripts/config/configuration-apply.ts" && ["check", "restore-check"].includes(step.args[0]!)
        || step.script === "scripts/config/runtime-apply.ts" && step.args[0] === "check")
        || step.readOnly && step.script === "scripts/ops/relay-admin.ts" && step.args[0] === "check" && ["list", "test", "purge"].includes(relayOptions(step.args.slice(1)).command)
        || step.online && step.script === "scripts/config/configuration-apply.ts" && step.args[0] === "finish"
        || step.online && step.script === "scripts/ops/backup-cleanup.ts" && ["scan", "apply"].includes(backupOptions(step.args).command)
        || step.online && step.script === "scripts/ops/relay-admin.ts" && ["list", "test"].includes(relayOptions(step.args).command);
      if ((step.readOnly || step.online) && !preview) throw new Error("此脚本不是允许的在线步骤");
      if (!facts.owned || facts.identity !== deployment.identity || (!preview && !["stopped", "absent"].includes(facts.state))
        || preview && facts.state === "unsupported") throw new MaintenanceRefused("数据步骤之前部署身份或停机状态已变化");
      if (codeDigest(source) !== request.runtime) throw new MaintenanceRefused("维护运行包摘要不符");
      if (step.reports) { if (!reports) throw new Error("尚未准备备份报告目录"); checkReports(options.project, reports); }
      if (platform instanceof DockerPlatform) {
        const docker = facts as DockerService;
        if (!docker.image || !docker.user) throw new Error("缺少部署镜像或运行身份");
        // The image supplies the deployed dependency/runtime version. Host coordination never imports its data libraries.
        const args = ["--no-env-file", "run", step.script, ...step.args];
        const environment = step.runtimeEnvironment ? await platform.runtimeEnvironment(deployment.identity) : undefined;
        const writer = newDockerTask({ daemon: platform.daemon, endpoint: platform.endpoint, image: docker.image, user: docker.user,
          data: deploymentDataPath(options.project), backup: resolve(options.project, "backup"),
          network: step.network === "service" ? facts.state === "running" ? `container:${docker.container}` : "host" : step.network ?? "none",
          ...(dataAccess ? { access: dataAccess } : {}), ...(step.input !== undefined ? { input: taskInput(step.input) } : {}),
          ...(step.reports ? { reports } : {}),
          ...(step.currentCode ? { runtime: request.runtime } : {}), ...(environment ? { runtimeEnvironment: runtimeEnvironmentDigest(environment) } : {}) }, args);
        return runDockerTask(platform.taskDriver(step.timeoutMs, !!step.protocol, output, step.input, environment), writer, args, value => record.writer(value), signal);
      }
      const command = { command: process.execPath, args: ["--no-env-file", "run", join(source, step.script), ...step.args], cwd: options.project,
        env: { ...process.env }, signal, protocol: !!step.protocol, timeoutMs: step.timeoutMs ?? 60 * 60_000, input: step.input };
      // Work data is selected by cwd. The fixed package owns script imports while project/node_modules supplies the
      // installed dependencies; dependency-changing deploy/update operations are excluded by this same lock.
      return runWindowsTask(command, newWindowsTask(command), value => record.writer(value), command => (options.native ?? runNative)(command, output));
    },
  };
}

export const maintenanceRequest = (source: string, fields: Pick<MaintenanceRequest, "command" | "intent" | "label" | "online">): MaintenanceRequest =>
  ({ id: randomUUID().replaceAll("-", ""), runtime: codeDigest(source), ...fields });
