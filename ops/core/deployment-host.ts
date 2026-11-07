// Shared lifecycle host for every platform: lock, confirmation, snapshot publication, journal, configuration and data steps
// and their order around runDeployment, for an upgrade and for a deployment of the current checkout. A platform session only
// performs its native effects; it never chooses rollback or startup order.
import { randomUUID } from "node:crypto";
import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publish } from "../../src/lib/atomic-file.ts";
import { assertConfirmedTransaction } from "../lib/confirmed-transaction.ts";
import { decodeReleaseData, type ReleaseDataCommand } from "../lib/release-data-protocol.ts";
import { configurationSnapshot } from "../config/configuration-form.ts";
import { sameConfiguration, stageName, STAGED_KINDS, type StagedKind } from "../config/configuration-stage.ts";
import { RUNTIME_VALUES_FILE, runtimeDigest } from "../config/runtime-values.ts";
import { assessMaintenanceAction, readMaintenanceState } from "../../src/core/maintenance-state.ts";
import { readConfigurationState } from "../../src/core/configuration-state.ts";
import { readOpsMaintenanceRecord } from "../../src/core/ops-maintenance-state.ts";
import { codeDigest } from "./source-runtime.ts";
import { readDeployStage, STAGE_UNCHANGED, type DeployStage } from "./deploy-stage.ts";
import { withDeploymentLock, type DeploymentLock } from "./deployment-lock.ts";
import { DeploymentGit, type CheckoutIdentity } from "./deployment-git.ts";
import { DeploymentRecord } from "./deployment-record.ts";
import { loadDeploymentState, type DeploymentState } from "./deployment-state.ts";
import { runDeployment, type DeploymentHost, type DeploymentRequest, type DeploymentService, type DeploymentStep } from "./deployment.ts";
import type { DeploymentDirection, DeploymentExecution } from "./deployment-contract.ts";
import { directory, readText } from "./host-files.ts";
import { serializeTransactionRecord, type TransactionRecord } from "./transaction-record.ts";
import { runNative, type NativeOutput, type NativeResult, type NativeRunner } from "./native-process.ts";
import { maintenanceResult } from "./data-result.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import type { OpsResult } from "./result.ts";
import { deploymentRuntime } from "./deployment-runtime.ts";

interface LifecycleInput {
  rollback?: boolean;
  confirmation?: string;
}
export interface UpgradeInput extends LifecycleInput {
  operation?: "upgrade";
  original: string;
  target: string;
  branch: string;
  plan?: string;
  directoryPlan?: string;
  command?: "update" | "resume" | "rollback";
}
export interface DeployInput extends LifecycleInput {
  operation: "deploy";
  /** A new deployment only: the private directory the entry filled before the stop (deploy-stage.ts). */
  stage?: string;
  command?: "deploy" | "repair" | "resume" | "rollback";
}
export type DeploymentInput = UpgradeInput | DeployInput;
export interface DeploymentOptions {
  project: string;
  source: string;
  /** Console confirmation is rechecked under deploy.lock before preparation or recovery writes. */
  verify(): Promise<void>;
  finish(result: OpsResult): Promise<void>;
  native?: NativeRunner;
  output?: NativeOutput;
  readyTimeoutMs?: number;
  gitPath?: string;
}
export type DeploymentWriter = NonNullable<DeploymentExecution["writer"]>;
/** Steps whose effect belongs to the platform; the configuration, data, Git and verification-flag steps are shared below. */
export type PlatformStep = Exclude<DeploymentStep, "switch-code" | "configure-runtime" | "configure-app" | "configure-models" | "configure-directory"
  | "prepare-data" | "enable-verification" | "commit-data" | "restore-data" | "restore-code">;

/** One lock-held run. Getters throw until the transaction they describe exists. */
export interface DeploymentContext<I extends DeploymentInput = DeploymentInput> {
  readonly project: string;
  /** The pinned host runtime this transaction executes. */
  readonly source: string;
  readonly runtime: string;
  readonly name: string;
  readonly snapshot: string;
  readonly fresh: boolean;
  readonly operation: "deploy" | "upgrade";
  readonly input: I;
  readonly lock: DeploymentLock;
  readonly native: NativeRunner;
  readonly output: NativeOutput;
  record(): TransactionRecord;
  store(): DeploymentRecord;
  state(): DeploymentState;
  /** The answers of a new deployment. */
  stage(): DeployStage;
}
export interface DeploymentSession {
  /** Supervised, journaled native runner for Git and dependency effects. */
  readonly writer: NativeRunner;
  /** Project, snapshot files and workspace as the target release's data tools see them. */
  readonly tools: { project: string; file(name: string): string; workspace(record: TransactionRecord): string | undefined };
  /** Owner of the files the data tools read (plans, verification flag); undefined keeps the operator's. */
  readonly owner?: { uid: number; gid: number };
  /** Reap a writer recorded by an earlier, possibly killed host. Another platform's writer is refused. */
  recover(writer: DeploymentWriter): Promise<void>;
  /** Fresh only, read-only: the service, and for an upgrade main, the code identity and the switch conflicts. */
  start(git: DeploymentGit, signal?: AbortSignal): Promise<{ wasRunning: boolean; checkout?: CheckoutIdentity }>;
  /** Bind the recorded or freshly checked service. Read-only. */
  prepare(git: DeploymentGit): Promise<void>;
  /** Fresh, before the pointer exists: the platform's own snapshot material. Never stops the bot. */
  capture(record: TransactionRecord): Promise<{ wasRunning: boolean }>;
  /** After publication and on every recovery: the snapshot's platform facts agree with the record. */
  confirm(record: TransactionRecord): Promise<void>;
  /** A data tool of the target release, run as the deployment writer. */
  tool(path: string, args: string[], cancellation?: AbortSignal): Promise<NativeResult>;
  /** False only when the recorded release can no longer run (Docker: the pinned candidate image is gone). */
  available(): boolean;
  inspect(): Promise<DeploymentService>;
  preflight?(direction: DeploymentDirection, signal?: AbortSignal): Promise<void>;
  effect(step: PlatformStep, signal?: AbortSignal): Promise<void>;
  /** Checks shared by the commit step, run before the data commit (Docker: layout recheck and state files). */
  beforeCommit?(signal?: AbortSignal): Promise<void>;
  /** One readiness probe: true ready, false not yet, null definitely failed (Docker: the container exited). */
  ready(role: "verification" | "candidate" | "original", deadlineMs: number): Promise<boolean | null>;
  /** Diagnostics only, once a readiness wait has timed out (Docker: the instance's last log lines). Never throws. */
  unready?(role: "verification" | "candidate" | "original"): Promise<void>;
  /** Best effort after the completion is durable and the pointers are gone. */
  cleanup(completion: DeploymentDirection): Promise<void>;
}
export interface DeploymentPlatform<I extends DeploymentInput = DeploymentInput, O extends DeploymentOptions = DeploymentOptions> {
  /** Prefix of the parameter refusal, e.g. "Windows ". */
  readonly label: string;
  /** The service in refusals: 计划任务 or 容器. */
  readonly noun: string;
  /** Docker upgrades share the deployment pointer; a deployment always uses it. */
  readonly upgradePointer: "upgrade-transaction" | "deploy-transaction";
  /** Module and export of the same entry inside the pinned runtime. */
  readonly module: string;
  readonly entry: string;
  valid(input: I): boolean;
  open(context: DeploymentContext<I>, options: O): Promise<DeploymentSession>;
}

// Every path on its own line: the operator moves or commits them and retries; the upgrade never touches them.
export function switchRefusal(target: string, conflicts: string[], fresh: boolean, service: string): string {
  return (fresh ? `本次升级没有停止服务，代码、数据和${service}都未改动：` : "没有继续升级，代码和数据保持现状：")
    + `切换代码（当前提交 -> main -> 目标 ${target.slice(0, 7)}）会覆盖或删除以下内容（包括被 .gitignore 忽略的文件），或因它们失败：\n  - `
    + conflicts.join("\n  - ") + "\n升级不移动、不删除这些文件；请把它们移出工作区（或提交到其他分支）、撤销已跟踪文件的改动后重试。";
}
export function restoreRefusal(conflicts: string[], explicit: boolean, service: string): string {
  return (explicit ? `没有回滚：恢复升级前的代码会覆盖升级后的工作区改动，数据、代码和${service}保持现状：\n  - `
    : "代码没有恢复：升级后的工作区改动会被覆盖；服务保持停止，事务保留：\n  - ") + conflicts.join("\n  - ")
    + "\n把改动提交到其他分支、备份或撤销后再回滚" + (explicit ? "。" : `，继续恢复代码和${service}。`);
}
const validCommand = (input: UpgradeInput | DeployInput, commands: string[]) => !input.command
  || commands.includes(input.command) && (input.command === "rollback") === !!input.rollback;
export const validUpgradeInput = (input: UpgradeInput) => [input.original, input.target].every(value => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))
  && !!input.branch && !/[\x00-\x20\x7f]/.test(input.branch) && validCommand(input, ["update", "resume", "rollback"]);
export const validDeployInput = (input: DeployInput) => validCommand(input, ["deploy", "repair", "resume", "rollback"]);

export interface PreflightContext<I extends DeploymentInput> { project: string; source: string; lock: DeploymentLock; native: NativeRunner; input: I; git: DeploymentGit }
/** Read-only, before the entry builds or asks anything: no snapshot, record or result file. The real run repeats every check. */
export async function preflightHost<I extends DeploymentInput>(input: I, options: Pick<DeploymentOptions, "project" | "source" | "native" | "gitPath">,
  platform: Pick<DeploymentPlatform<I>, "label" | "valid">, check: (context: PreflightContext<I>, signal?: AbortSignal) => Promise<{ wasRunning: boolean; message: string }>,
  signal?: AbortSignal): Promise<OpsResult> {
  const noun = input.operation === "deploy" ? "部署" : "升级";
  const base: OpsResult = { protocol: "mixin-ops", version: 1, command: input.command ?? "update", outcome: "failed", exitCode: 1, wasRunning: false, finalState: "unknown", message: "" };
  const project = resolve(options.project), native = options.native ?? runNative;
  try {
    if (!platform.valid(input) || input.rollback) throw new MaintenanceRefused(`${platform.label}${noun}参数不完整`);
    return await withDeploymentLock(project, async lock => {
      if (loadDeploymentState(project)) throw new MaintenanceRefused("有未完成的部署或升级，请先继续或回滚；旧服务尚未停止");
      const maintenance = readOpsMaintenanceRecord(project);
      if (maintenance && !maintenance.result) throw new MaintenanceRefused("先用 maintenance-recover 收尾原运维任务；旧服务尚未停止");
      const git = new DeploymentGit(project, native, undefined, native, options.gitPath);
      const checked = await check({ project, source: options.source, lock, native, input, git }, signal);
      return { ...base, outcome: "success", exitCode: 0, wasRunning: checked.wasRunning, message: checked.message };
    });
  } catch (error) {
    return { ...base, outcome: error instanceof MaintenanceRefused ? "refused" : "failed", exitCode: error instanceof MaintenanceRefused ? error.exitCode : 1,
      message: error instanceof Error ? error.message : `${noun}预检失败` };
  }
}

const STAGED_LABELS: Record<StagedKind, string> = { app: "应用机器人配置", models: "模型配置" };

/**
 * Until a pointer names it, a new snapshot is no transaction's recovery material (the captures copy, never move): a failed
 * publication removes it. A pointer that names it, or one that cannot be read, keeps it.
 */
function discardUnpublished(project: string, snapshot: string, name: string): void {
  try {
    for (const pointer of ["deploy-transaction", "upgrade-transaction"]) if (readText(join(project, "data/state", pointer))?.trim() === name) return;
    const stat = lstatSync(snapshot);
    if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(snapshot, { recursive: true, force: true });
  } catch { /* Left for the backup cleanup; the publication failure is what the operator needs. */ }
}
/** Under the lock, before the stop: what the entry staged still fits this project. */
function checkDeployStage(project: string, stage: DeployStage): void {
  // An unfinished configuration transaction owns these files: installing over it would leave a restore that can only refuse.
  const transaction = STAGED_KINDS.some(kind => stage.configuration[kind]) ? readConfigurationState(project) : null;
  if (transaction) throw new MaintenanceRefused(`配置事务 ${transaction.id} 尚未结束（${transaction.phase}），请先在控制台恢复或收尾，再重新部署${STAGE_UNCHANGED}`);
  for (const kind of STAGED_KINDS) {
    const staged = stage.configuration[kind], current = configurationSnapshot(project, kind);
    if (staged ? !sameConfiguration(current, staged.stage.base)
      : (kind === "app" ? [current.files.app] : [current.files.models, current.files.settings]).some(text => text === null))
      throw new MaintenanceRefused((staged ? `${STAGED_LABELS[kind]}在确认之后被改动，请重新部署` : `缺少${STAGED_LABELS[kind]}，也没有停机前完成的配置`) + STAGE_UNCHANGED);
  }
  if (runtimeDigest(readText(join(project, "data/config/runtime.json"))) !== stage.runtime.value.base)
    throw new MaintenanceRefused(`运行参数在确认之后被改动，请重新部署${STAGE_UNCHANGED}`);
  // With a complete configuration the data preview belongs before the stop; only a first deployment (or a missing file the
  // wizard is filling in) has nothing to preview yet.
  const { models, settings } = configurationSnapshot(project, "models").files, { app } = configurationSnapshot(project, "app").files;
  if (!stage.plan && models !== null && settings !== null && app !== null) throw new MaintenanceRefused(`停机前的数据准备计划缺失${STAGE_UNCHANGED}`);
}

export async function runDeploymentHost<I extends DeploymentInput, O extends DeploymentOptions>(input: I, options: O, platform: DeploymentPlatform<I, O>,
  signal?: AbortSignal): Promise<OpsResult> {
  const deploy = input.operation === "deploy" ? input as DeployInput : null, upgrade = deploy ? null : input as UpgradeInput;
  const noun = deploy ? "部署" : "升级";
  const base: OpsResult = { protocol: "mixin-ops", version: 1, command: input.command ?? (input.rollback ? "rollback" : deploy ? "deploy" : "update"), outcome: "failed",
    exitCode: 1, wasRunning: false, finalState: "unknown", message: "" };
  // Progress only: a vanished terminal must not interrupt the effects; the operation log and result keep the record.
  const output: NativeOutput = options.output ?? ((text, stream) => { try { process[stream].write(text); } catch { /* Terminal gone. */ } });
  const native: NativeRunner = (command, report) => (options.native ?? runNative)(command, report ?? output);
  const project = resolve(options.project);
  try {
    if (!platform.valid(input)) throw new MaintenanceRefused(`${platform.label}${noun}参数不完整`);
    const before = loadDeploymentState(project), fixed = deploymentRuntime(project, options.source, before);
    if (resolve(options.source) !== fixed.root) {
      const original = await import(pathToFileURL(join(fixed.root, platform.module)).href);
      if (typeof original[platform.entry] !== "function") throw new MaintenanceRefused(`原固定运行包不支持此${noun}协议`);
      return await original[platform.entry](input, { ...options, source: fixed.root }, signal);
    }
    return await withDeploymentLock(project, async lock => {
      signal?.throwIfAborted(); await options.verify(); lock.assertHeld();
      const maintenance = readOpsMaintenanceRecord(project);
      if (maintenance && !maintenance.result) throw new MaintenanceRefused("先用 maintenance-recover 收尾原运维任务");
      let pending = loadDeploymentState(project);
      if ((pending?.confirmation.digest ?? null) !== (before?.confirmation.digest ?? null)) throw new MaintenanceRefused("取得部署锁前事务已变化，请刷新后重试");
      // A changed or mismatched confirmation is a refusal: nothing ran.
      if (input.confirmation) {
        try { assertConfirmedTransaction(project, input.rollback ? "rollback" : "continue", input.confirmation); }
        catch (error) { throw new MaintenanceRefused(error instanceof Error ? error.message : "事务确认无效"); }
      }
      if (input.rollback && !pending) throw new MaintenanceRefused(`没有需要回滚的${noun}事务`);
      if (pending && upgrade && (pending.operation !== "upgrade" || pending.record.original_sha !== upgrade.original || pending.record.target_sha !== upgrade.target
        || pending.record.original_branch !== upgrade.branch)) throw new MaintenanceRefused("续做必须使用原事务记录的提交和分支");
      if (pending && deploy && (pending.operation !== "deploy" || deploy.stage)) throw new MaintenanceRefused("有未完成的部署或升级，续做和回滚只使用事务中记录的选择");
      if (!pending && deploy && !deploy.stage) throw new MaintenanceRefused("没有未完成的部署事务");
      const fresh = !pending, name = pending?.snapshot ?? "deploy-" + randomUUID().replaceAll("-", "");
      const stage = !pending && deploy ? readDeployStage(deploy.stage!) : undefined;
      const snapshot = join(project, "backup/snapshots", name), pointer = join(project, "data/state", deploy ? "deploy-transaction" : platform.upgradePointer);
      const pinned = deploymentRuntime(project, options.source, pending);
      if (pinned.root !== fixed.root || pinned.digest !== fixed.digest || codeDigest(options.source) !== pinned.digest)
        throw new MaintenanceRefused("取得部署锁后固定运维运行包变化，保留现场");
      let store: DeploymentRecord | undefined, record = pending?.record;
      const state = () => { lock.assertHeld(); const current = loadDeploymentState(project); if (!current || current.snapshot !== name) throw new Error(`${noun}事务指针变化`); return current; };
      const session = await platform.open({ project, source: pinned.root, runtime: pinned.digest, name, snapshot, fresh, operation: deploy ? "deploy" : "upgrade", input, lock, native, output,
        record: () => { if (!record) throw new Error(`${noun}事务尚未记录`); return record; },
        store: () => { lock.assertHeld(); if (!store) throw new Error("部署写入者尚未绑定事务"); return store; },
        state, stage: () => { if (!stage) throw new Error("没有本次部署的暂存"); return stage; } }, options);
      if (record) {
        store = new DeploymentRecord(project, record, pinned.digest, () => lock.assertHeld());
        const previous = store.read()?.writer;
        if (previous && previous.phase !== "reaped") await session.recover(previous);
      }
      const git = new DeploymentGit(project, native, undefined, session.writer, options.gitPath);
      if (stage && await git.head(signal) !== stage.choices.target) throw new MaintenanceRefused(`代码的提交在部署选择确认之后已变化，请重新部署${STAGE_UNCHANGED}`);
      // A fresh operation repeats its entry's start checks under the lock; recovery only needs its own service.
      const start = fresh ? await session.start(git, signal) : null;
      await session.prepare(git);
      let expectedCheckout: CheckoutIdentity | undefined = start?.checkout;
      if (fresh) {
        const publication: { name: string; text: string; tool?: boolean }[] = [];
        let chosen: TransactionRecord;
        if (stage) {
          checkDeployStage(project, stage);
          if (stage.choices.workspace) directory(stage.choices.workspace);
          chosen = { format: "2", operation: "deploy", snapshot: name, target_sha: stage.choices.target, original_sha: "", original_branch: "",
            original_workspace_root: readText(join(project, "data/state/workspace-root"))?.trim() ?? "", target_workspace_root: stage.choices.workspace,
            was_running: start!.wasRunning ? "1" : "0", bot_port: String(stage.choices.port), reconfigure_ai: stage.configuration.models ? "1" : "0" };
          publication.push({ name: RUNTIME_VALUES_FILE, text: stage.runtime.text, tool: true });
          if (stage.plan !== null) publication.push({ name: "data-plan.json", text: stage.plan, tool: true });
          if (stage.directoryPlan !== null) publication.push({ name: "directory-scope-plan.json", text: stage.directoryPlan, tool: true });
          for (const kind of STAGED_KINDS) {
            const staged = stage.configuration[kind];
            if (staged) publication.push({ name: stageName(kind), text: staged.text, tool: true });
          }
        } else {
          const plan = upgrade!.plan && readText(resolve(upgrade!.plan));
          if (!plan) throw new MaintenanceRefused("停机前的数据准备计划缺失");
          const directoryPlan = upgrade!.directoryPlan ? readText(resolve(upgrade!.directoryPlan)) : null;
          if (upgrade!.directoryPlan && directoryPlan === null) throw new MaintenanceRefused("通讯录范围计划缺失");
          const workspace = readText(join(project, "data/state/workspace-root"))?.trim() ?? "";
          if (workspace) directory(workspace);
          const port = readText(join(project, "data/state/bot-port"))?.trim() || "10000";
          chosen = { format: "2", operation: "upgrade", snapshot: name, target_sha: upgrade!.target, original_sha: upgrade!.original,
            original_branch: upgrade!.branch, original_workspace_root: workspace, target_workspace_root: workspace, was_running: start!.wasRunning ? "1" : "0",
            bot_port: port, reconfigure_ai: "0" };
          publication.push({ name: "data-plan.json", text: plan, tool: true });
          if (directoryPlan !== null) publication.push({ name: "directory-scope-plan.json", text: directoryPlan, tool: true });
        }
        // The scope is chosen before the stop: without a scope file or a plan, configure-directory could only fail after it.
        if (!publication.some(file => file.name === "directory-scope-plan.json") && readText(join(project, "data/config/directory.json")) === null)
          throw new MaintenanceRefused(`缺少通讯录同步范围，也没有停机前选定的范围${stage ? STAGE_UNCHANGED : "；旧服务尚未停止"}`);
        // A random name already in use is someone else's material: refuse before writing anything under it.
        for (const [taken, what] of [[join(project, "backup/rm", name), "归档"], [snapshot, "快照"]] as const) {
          try { lstatSync(taken); throw new MaintenanceRefused(`事务名称已有${what}，未采用此快照名称`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        serializeTransactionRecord(chosen);
        try {
          // Capturing private config/service metadata does not stop the bot. No conversation database is copied.
          const captured = await session.capture(chosen);
          record = { ...chosen, was_running: captured.wasRunning ? "1" : "0" };
          await publish(join(snapshot, "transaction"), serializeTransactionRecord(record), { createOnly: true });
          for (const file of publication) await publish(join(snapshot, file.name), file.text, { createOnly: true, ...(file.tool ? { owner: session.owner } : {}) });
          await publish(join(snapshot, "host-runtime"), pinned.digest + "\n", { createOnly: true });
          lock.assertHeld();
          if (loadDeploymentState(project)) throw new MaintenanceRefused("准备期间出现另一事务，未发布本次快照");
          await publish(pointer, name + "\n", { createOnly: true });
        } catch (error) { discardUnpublished(project, snapshot, name); throw error; }
        pending = loadDeploymentState(project);
      }
      if (!pending || !record) throw new Error(`${noun}事务未完整发布`);
      await session.confirm(record);
      store = new DeploymentRecord(project, record, pinned.digest, () => lock.assertHeld());
      const request: DeploymentRequest = { command: input.rollback ? "rollback" : !fresh ? "resume" : deploy ? deploy.command === "repair" ? "repair" : "deploy" : "update",
        action: input.rollback ? "rollback" : "continue", snapshot: name, runtime: pinned.digest };
      const tools = session.tools, workspace = tools.workspace(record), saved = (file: string) => state().confirmation.text("backup/snapshots/" + name + "/" + file);
      const data = async (action: ReleaseDataCommand, cancellation?: AbortSignal) => {
        const result = await session.tool("ops/tools/data-current.ts", [action, "--project", tools.project, "--deployment", name,
          "--plan", tools.file("data-plan.json"), ...(workspace === undefined ? [] : ["--workspace", workspace]), "--json"], cancellation);
        if (!decodeReleaseData(result.stdout, action, result.code).success) throw new Error(`数据准备 ${action} 未完成（${result.code}），保留事务`);
      };
      /** A configuration tool of the target release: its result counts only as a complete success of this action. */
      const configure = async (tool: string, args: string[], action: string, failure: string, cancellation?: AbortSignal) => {
        if (maintenanceResult(await session.tool(tool, args, cancellation), action).code !== 0) throw new Error(failure);
      };
      const storageAllows = (intent: "service" | "verify" | "release") => {
        const current = state(), status = readMaintenanceState(project);
        if (current.execution?.writer && current.execution.writer.phase !== "reaped") throw new Error("写入者尚未回收");
        // Only this lock-held transaction can plan its next startup. The service sees the persisted startup step itself.
        if (status.deployment?.status === "present" && status.deployment.id === name) delete status.deployment;
        const check = assessMaintenanceAction(status, intent); if (!check.allowed) throw new Error(check.reasons.join("；"));
      };
      // Without the recorded release no tool can read this transaction's data journal: only a rollback that never
      // reached the data may proceed.
      const dataStarted = () => state().dataPhase !== "unprepared";
      const host: DeploymentHost = {
        async locked(body) { lock.assertHeld(); return body(); },
        async verify() { lock.assertHeld(); if (codeDigest(pinned.root) !== pinned.digest) throw new Error(`${noun}运行包变化`); },
        async state() { return state(); }, async checkpoint() { return store!.read()?.checkpoint ?? null; },
        async save(checkpoint) { await store!.checkpoint(checkpoint); output(`部署阶段：${checkpoint.direction}/${checkpoint.step}\n`, "stderr"); },
        async reap() {
          const recorded = store!.read()?.writer;
          if (recorded && recorded.phase !== "reaped") await session.recover(recorded);
        },
        inspect: () => session.inspect(),
        async preflight(direction, cancellation) {
          if (record!.target_workspace_root) directory(record!.target_workspace_root);
          await session.preflight?.(direction, cancellation);
          if (direction === "rollback") {
            // Without the recorded release nothing can read this transaction's journal: refuse before any effect, not half way.
            if (!session.available() && dataStarted()) throw new MaintenanceRefused("上次操作的数据迁移已经开始，查看或撤销它需要记录的版本，但它已不能运行；请恢复完全相同的版本后重试；服务和数据保持现状");
            // A deployment never moved the checkout.
            if (deploy) return;
            const conflicts = await git.restoreConflicts(record!.original_sha, record!.target_sha, record!.original_branch);
            if (conflicts.length) throw new MaintenanceRefused(restoreRefusal(conflicts, !!input.rollback, platform.noun));
          } else if (!state().committed) {
            if (deploy) {
              if (record!.target_sha && await git.head(cancellation) !== record!.target_sha)
                throw new MaintenanceRefused(`当前代码不是上次部署的目标提交 ${record!.target_sha.slice(0, 7)}；请切回该提交后继续，或回滚`);
              return;
            }
            const checked = await git.switchConflicts(record!.target_sha, cancellation);
            if (checked.conflicts.length) throw new MaintenanceRefused(switchRefusal(record!.target_sha, checked.conflicts, fresh, platform.noun));
            if (fresh && expectedCheckout && JSON.stringify(checked.identity) !== JSON.stringify(expectedCheckout))
              throw new MaintenanceRefused("停机前代码身份已变化（提交、分支或 main）；服务尚未停止，事务已保留，请核对后继续或回滚");
            expectedCheckout = checked.identity;
          }
        },
        async perform(step, cancellation) {
          switch (step) {
            case "switch-code": if (!deploy) await git.switch(record!.target_sha, expectedCheckout!, cancellation); return;
            case "configure-runtime":
              if (saved(RUNTIME_VALUES_FILE) !== null) await configure("ops/config/runtime-settings.ts", ["--values", tools.file(RUNTIME_VALUES_FILE), "--json"], "values", "运行参数写入未完成", cancellation);
              return;
            case "configure-app": case "configure-models": {
              const kind = step === "configure-app" ? "app" : "models";
              if (saved(stageName(kind)) !== null) await configure("ops/config/configuration-install.ts", ["--kind", kind, "--stage", tools.file(stageName(kind)), "--json"], "install", `${STAGED_LABELS[kind]}写入未完成`, cancellation);
              return;
            }
            case "configure-directory":
              if (saved("directory-scope-plan.json") !== null) await configure("ops/config/directory-scope.ts", ["install", "--project", tools.project, "--plan", tools.file("directory-scope-plan.json"), "--json"], "install", "通讯录范围写入未完成", cancellation);
              else if (readText(join(project, "data/config/directory.json")) === null) throw new Error("缺少停机前选定的通讯录同步范围");
              return;
            case "prepare-data":
              // A first deployment had no configuration to preview before the stop. A resume keeps the plan of its first attempt.
              if (saved("data-plan.json") === null) await data("preview", cancellation);
              await data("apply", cancellation); return;
            case "enable-verification": await publish(join(project, "data/state/verify-only"), "verify\n", { owner: session.owner }); return;
            case "commit-data":
              await session.beforeCommit?.(cancellation);
              if (deploy) {
                // Inside the snapshot's restore range. Readiness has passed; the ops entries read these from now on.
                await publish(join(project, "data/state/bot-port"), record!.bot_port, { owner: session.owner });
                await publish(join(project, "data/state/workspace-root"), record!.target_workspace_root, { owner: session.owner });
              }
              await data("commit", cancellation); return;
            case "disable-verification":
              if (state().confirmation.text("data/state/verify-only") !== null) unlinkSync(join(project, "data/state/verify-only"));
              await session.effect(step, cancellation); return;
            case "restore-data":
              if (!session.available()) {
                if (dataStarted()) throw new Error("数据迁移已经开始，撤销它需要记录的版本，但它已不能运行；请恢复完全相同的版本后重试");
                return;
              }
              await data("rollback"); return;
            case "restore-code": if (!deploy) await git.restore(record!.original_sha, record!.target_sha, record!.original_branch); return;
            default: await session.effect(step, cancellation); return;
          }
        },
        async assess(intent) {
          const current = state(); storageAllows(intent === "verification" ? "verify" : intent === "commit" ? "release" : "service");
          if (intent === "verification" || intent === "commit" ? current.dataPhase !== "prepared" : intent === "candidate" ? !current.committed : current.dataPhase !== "unprepared")
            throw new Error("磁盘数据阶段不允许启动或提交");
        },
        async waitReady(role, cancellation) {
          const until = performance.now() + (options.readyTimeoutMs ?? 90_000);
          do {
            cancellation?.throwIfAborted(); lock.assertHeld();
            const ready = await session.ready(role, Math.min(2500, Math.max(1, until - performance.now())));
            if (ready) return true;
            if (ready === null) return false;
            if (performance.now() >= until) { await session.unready?.(role); return false; }
            await Bun.sleep(Math.min(500, until - performance.now()));
          } while (true);
        },
        notice(message) { output(message + "\n", "stderr"); },
        async finish(result, completion) {
          await options.finish(result); await store!.finish(result, completion);
          if (!completion) return;
          const current = state(); if (current.execution?.completion !== completion) throw new Error("事务完成结果未落盘");
          for (const relative of ["data/state/upgrade-transaction", "data/state/deploy-transaction"]) {
            if (current.confirmation.text(relative)?.trim() === name) unlinkSync(join(project, relative));
          }
          await session.cleanup(completion);
        },
      };
      return runDeployment(request, host, signal);
    });
  } catch (error) {
    const result: OpsResult = { ...base, outcome: error instanceof MaintenanceRefused ? "refused" : "failed", message: error instanceof Error ? error.message : `${noun}入口失败` };
    await options.finish(result); return result;
  }
}

