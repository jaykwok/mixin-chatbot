// Whether an action may run on the project's data now: the service, the verification instance, a release commit,
// maintenance that writes the conversation databases, and configuration changes. `readMaintenanceState` reads only the
// state files these depend on (an unfinished configuration change, and the ops core's maintenance and deployment
// records): it scans no conversation database and starts nothing. `assessMaintenanceAction` decides from that alone. A
// file that cannot be read, or is of a format this version does not know, refuses everything it guards. Every action asks
// again once it holds the maintenance lease; the ops core (ops/core) and the console ask in process.
import { readConfigurationState, type ConfigurationState } from "./configuration-state.ts";
import { opsBlocksStartup, readOpsMaintenanceRecord } from "./ops-maintenance-state.ts";
import { deploymentAllows, readOpsDeploymentRecord } from "./ops-deployment-state.ts";

export type MaintenanceState = {
  deployment?: { status: "unreadable"; reason: string } | { status: "present"; id: string; service: boolean; verify: boolean; release: boolean; pending: boolean };
  orchestration?: { status: "unreadable"; reason: string } | { status: "present"; id: string; blocksStartup: boolean; pending: boolean };
  configuration?: { status: "absent" } | { status: "unreadable"; reason: string } | { status: "present"; id: string; phase: ConfigurationState["phase"] } };

/**
 * `service` the bot; `verify` the verification instance; `release` a release commit; `conversation-write` maintenance
 * that writes the conversation databases (history clear and compaction); `configuration` a configuration change and
 * `configuration-restore` the restore of an unfinished one.
 */
export const MAINTENANCE_INTENTS = ["service", "verify", "release", "conversation-write", "configuration", "configuration-restore"] as const;
export type MaintenanceIntent = typeof MAINTENANCE_INTENTS[number];
export type Assessment = { allowed: true } | { allowed: false; reasons: string[] };

const message = (error: unknown) => (error as Error)?.message ?? String(error);

export function readMaintenanceState(project: string): MaintenanceState {
  let configuration: MaintenanceState["configuration"];
  try { const state = readConfigurationState(project); configuration = state ? { status: "present", id: state.id, phase: state.phase } : { status: "absent" }; }
  catch (error) { configuration = { status: "unreadable", reason: message(error) }; }
  let orchestration: MaintenanceState["orchestration"];
  try {
    const record = readOpsMaintenanceRecord(project);
    if (record) orchestration = { status: "present", id: record.checkpoint.request.id, blocksStartup: opsBlocksStartup(record), pending: !record.result };
  } catch (error) { orchestration = { status: "unreadable", reason: message(error) }; }
  let deployment: MaintenanceState["deployment"];
  try {
    const record = readOpsDeploymentRecord(project);
    if (record) deployment = { status: "present", id: record.checkpoint.snapshot, pending: !record.completion,
      service: deploymentAllows(record, "service"), verify: deploymentAllows(record, "verify"), release: deploymentAllows(record, "release") };
  } catch (error) { deployment = { status: "unreadable", reason: message(error) }; }
  return { configuration, ...(orchestration ? { orchestration } : {}), ...(deployment ? { deployment } : {}) };
}

export function assessMaintenanceAction(state: MaintenanceState, intent: MaintenanceIntent): Assessment {
  const reasons: string[] = [];
  if (state.deployment?.status === "unreadable") reasons.push(state.deployment.reason);
  else if (state.deployment?.status === "present" && ["service", "verify", "release"].includes(intent)
    && !state.deployment[intent as "service" | "verify" | "release"]) {
    reasons.push(`部署事务 ${state.deployment.id} 尚未确认此步骤可以执行；请先继续或回滚原部署`);
  }
  // The deployment's own configuration steps go through its stage; any other writer would change files it compares on resume.
  if (state.deployment?.status === "present" && state.deployment.pending && intent === "configuration") {
    reasons.push(`部署事务 ${state.deployment.id} 尚未完成；请先继续或回滚原部署，再修改配置`);
  }
  if (state.orchestration?.status === "unreadable") reasons.push(state.orchestration.reason);
  else if (state.orchestration?.status === "present" && state.orchestration.blocksStartup && ["service", "verify", "release"].includes(intent)) {
    reasons.push(`运维任务 ${state.orchestration.id} 尚未收尾；先运行 ops maintenance-recover，确认写入者停止并恢复运行状态`);
  }
  const configuration = state.configuration;
  if (configuration?.status === "unreadable") reasons.push(configuration.reason);
  if (configuration?.status === "present") {
    if (intent === "configuration" || (["publishing", "restoring"].includes(configuration.phase) && intent !== "configuration-restore")) {
      reasons.push(`配置事务 ${configuration.id} 尚未结束（${configuration.phase}），请先恢复或完成配置事务`);
    }
  } else if (intent === "configuration-restore" && configuration?.status !== "unreadable") reasons.push("没有需要恢复的配置事务");
  return reasons.length ? { allowed: false, reasons } : { allowed: true };
}

/** A refusal of `assessMaintenanceAction`. */
export class MaintenanceRefused extends Error {
  override name = "MaintenanceRefused";
  constructor(readonly intent: MaintenanceIntent, readonly reasons: string[]) { super(reasons.join("；")); }
}

/**
 * A terminal tool writing configuration in place, outside the ops core (`bun run configure`, `configure-runtime`): the
 * configuration intent, and no unfinished ops task either (the core's own configuration step runs inside one).
 */
export function assertLocalConfigurationWrite(project: string): void {
  const state = readMaintenanceState(project), assessment = assessMaintenanceAction(state, "configuration");
  const reasons = assessment.allowed ? [] : [...assessment.reasons];
  if (state.orchestration?.status === "present" && state.orchestration.pending) reasons.push(`运维任务 ${state.orchestration.id} 尚未收尾；先运行 ops maintenance-recover`);
  if (reasons.length) throw new MaintenanceRefused("configuration", reasons);
}

/** Reads the state and throws MaintenanceRefused unless `intent` is allowed. */
export function assertMaintenanceAction(project: string, intent: MaintenanceIntent): void {
  const assessment = assessMaintenanceAction(readMaintenanceState(project), intent);
  if (!assessment.allowed) throw new MaintenanceRefused(intent, assessment.reasons);
}
