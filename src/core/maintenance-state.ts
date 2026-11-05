// Whether an action may run on the project's data now (revision-chain plan §8.4): the service, the verification instance,
// a release commit, the revision cleanup and its restore, the shrink, other maintenance that writes the conversation
// databases, and configuration changes. `readMaintenanceState` reads only the top of the state files these depend on (the
// revision cleanup journal, the shrink record, an unfinished configuration change, and the ops core's maintenance and
// deployment records): it scans no conversation database and starts nothing. `assessMaintenanceAction` decides from that
// alone. A file that cannot be read, or is of a format this version does not know, refuses everything it guards. Every
// action asks again once it holds the maintenance lease; the ops core (scripts/ops/core) and the console ask in process.
import { join, resolve } from "node:path";
import { readJournal, type Journal } from "../durable/revision-cleanup/journal.ts";
import { readShrinkRecord } from "../durable/revision-cleanup/shrink-record.ts";
import { readConfigurationState, type ConfigurationState } from "./configuration-state.ts";
import { opsBlocksStartup, readOpsMaintenanceRecord } from "./ops-maintenance-state.ts";
import { deploymentAllows, readOpsDeploymentRecord } from "./ops-deployment-state.ts";

export type CleanupView =
  | { status: "absent" }
  | { status: "unreadable"; reason: string }
  | {
      status: "present";
      run: string;
      state: Journal["state"];
      stop?: string;
      /** A document is journaled and maybe committed: only the cleanup (resume, skip, rollback) settles it. */
      inFlight?: { space: string };
      /** A database to restore from its backup (`required`), or a restore that is under way (`replacing`). */
      restore?: { space: string; state: "required" | "replacing" | "done" };
    };
export type ShrinkView =
  | { status: "absent" }
  | { status: "unreadable"; reason: string }
  | { status: "present"; run: string; unfinished?: { space: string; state: string } };
export type MaintenanceState = { cleanup: CleanupView; shrink: ShrinkView;
  deployment?: { status: "unreadable"; reason: string } | { status: "present"; id: string; service: boolean; verify: boolean; release: boolean; pending: boolean };
  orchestration?: { status: "unreadable"; reason: string } | { status: "present"; id: string; blocksStartup: boolean; pending: boolean };
  configuration?: { status: "absent" } | { status: "unreadable"; reason: string } | { status: "present"; id: string; phase: ConfigurationState["phase"] } };

/**
 * `service` the bot; `verify` the verification instance; `release` a release commit; `resume` the revision cleanup going
 * on with its open run; `cleanup` a new run; `skip` ending the run without cleaning the rest; `rollback` ending it before
 * a rollback; `shrink` the offline shrink; `restore` restoring a database from its cleanup backup; `conversation-write`
 * other maintenance that writes the conversation databases (history clear and compaction).
 */
export const MAINTENANCE_INTENTS = ["service", "verify", "release", "resume", "cleanup", "skip", "rollback", "shrink", "restore", "conversation-write", "configuration", "configuration-restore"] as const;
export type MaintenanceIntent = typeof MAINTENANCE_INTENTS[number];
export type Assessment = { allowed: true } | { allowed: false; reasons: string[] };

const message = (error: unknown) => (error as Error)?.message ?? String(error);

export function readMaintenanceState(project: string): MaintenanceState {
  const data = join(resolve(project), "data");
  let cleanup: CleanupView;
  try {
    const journal = readJournal(data);
    cleanup = !journal ? { status: "absent" } : {
      status: "present", run: journal.run, state: journal.state,
      ...(journal.stop ? { stop: journal.stop.reason } : {}),
      ...(journal.current ? { inFlight: { space: journal.current.space } } : {}),
      ...(journal.restore ? { restore: { space: journal.restore.space, state: journal.restore.state } } : {}),
    };
  } catch (error) { cleanup = { status: "unreadable", reason: message(error) }; }
  let shrink: ShrinkView;
  try {
    const record = readShrinkRecord(data);
    shrink = !record ? { status: "absent" }
      : { status: "present", run: record.run, ...(record.current ? { unfinished: { space: record.current.space, state: record.current.state } } : {}) };
  } catch (error) { shrink = { status: "unreadable", reason: message(error) }; }
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
  return { cleanup, shrink, configuration, ...(orchestration ? { orchestration } : {}), ...(deployment ? { deployment } : {}) };
}

export function assessMaintenanceAction(state: MaintenanceState, intent: MaintenanceIntent): Assessment {
  const reasons: string[] = [];
  const { cleanup, shrink } = state;
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
  if (cleanup.status === "unreadable") reasons.push(`${cleanup.reason}；在它处理之前不能继续`);
  if (shrink.status === "unreadable") reasons.push(`${shrink.reason}；在它处理之前不能继续`);
  if (cleanup.status === "present") {
    const restore = cleanup.restore && cleanup.restore.state !== "done" ? cleanup.restore : undefined;
    if (restore && intent !== "restore") {
      reasons.push(restore.state === "required"
        ? `修订整理（运行 ${cleanup.run}）发现 ${restore.space} 的文档整理后与记录不同，这个库需要从备份恢复（revision-cleanup restore --space ${restore.space}）`
        : `修订整理（运行 ${cleanup.run}）从备份恢复 ${restore.space} 尚未完成，请再次运行 revision-cleanup restore --space ${restore.space}`);
    }
    if (cleanup.inFlight && ["service", "verify", "release", "shrink", "conversation-write", "configuration", "configuration-restore"].includes(intent)) {
      reasons.push(`修订整理（运行 ${cleanup.run}）有一份文档尚未收尾（${cleanup.inFlight.space}）。请先继续整理、跳过剩余整理或回滚`);
    }
    if (cleanup.state === "stopped" && (intent === "resume" || intent === "cleanup")) {
      reasons.push(`上次整理（运行 ${cleanup.run}）已停止：${cleanup.stop ?? "原因未记录"}。只能跳过剩余整理或回滚`);
    }
  }
  if (intent === "restore" && !(cleanup.status === "present" && cleanup.restore && cleanup.restore.state !== "done")) {
    if (cleanup.status !== "unreadable") reasons.push("没有需要从备份恢复的会话库");
  }
  if (shrink.status === "present" && shrink.unfinished && intent !== "shrink") {
    reasons.push(`会话库收缩（运行 ${shrink.run}）有一个库尚未替换完成（${shrink.unfinished.space}，阶段 ${shrink.unfinished.state}）。请先再次运行收缩命令完成恢复`);
  }
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
