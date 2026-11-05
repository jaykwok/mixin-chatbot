// CLI contract for a release's lifecycle entries. Prompts produce explicit plans; the host owns the lock and effects.
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { publishJson } from "../../lib/atomic-file.ts";
import { spaceName } from "../../../src/durable/read/protocol.ts";
import { loadDeploymentState, type DeploymentState } from "./deployment-state.ts";
import { MaintenanceRefused, refusing } from "./maintenance.ts";
import { preflightWindowsDeploy, preflightWindowsUpgrade, runWindowsLifecycle } from "./windows-lifecycle.ts";
import { preflightDockerDeploy, preflightDockerUpgrade, runDockerLifecycle, type DockerInput } from "./docker-lifecycle.ts";
import { readDeployStage } from "./deploy-stage.ts";
import type { DeploymentOptions } from "./deployment-host.ts";
import { checkTaskPlan } from "../console/check-plan.ts";
import { TaskStore, type TaskRequest } from "../console/tasks.ts";
import { consoleDir } from "../console/state.ts";
import type { OpsResult } from "./result.ts";
import { parseConfirmedTransaction } from "../../lib/confirmed-transaction.ts";

export interface UpgradeArgs {
  project: string;
  original: string;
  target: string;
  branch: string;
  rollback: boolean;
  /** Read-only start checks before the upgrader asks anything; no snapshot or result file. */
  preflight: boolean;
  json: boolean;
  plan?: string;
  directoryPlan?: string;
  cleanup?: "apply" | "skip";
  /** Docker only: the candidate-image record and the facts the upgrader prepared before the stop. */
  candidate?: string;
  facts?: string;
  confirmation?: string;
  gitPath?: string;
}
export interface DeployArgs {
  project: string;
  rollback: boolean;
  /** Read-only start checks before the entry builds or asks anything; no snapshot or result file. */
  preflight: boolean;
  json: boolean;
  /** A new deployment: what the entry staged before the stop, and the console operation it runs for. */
  stage?: string;
  command?: "deploy" | "repair";
  confirmation?: string;
  gitPath?: string;
}
export interface RestoreArgs { project: string; space: string; json: boolean; gitPath?: string }
const upgradeFields = { "--project": "project", "--original": "original", "--target": "target", "--branch": "branch",
  "--plan": "plan", "--directory-plan": "directoryPlan", "--cleanup": "cleanup", "--candidate": "candidate", "--facts": "facts",
  "--confirmation": "confirmation", "--git-path": "gitPath" } as const;
const deployFields = { "--project": "project", "--stage": "stage", "--command": "command", "--confirmation": "confirmation", "--git-path": "gitPath" } as const;
const upgradeUsage = () => new Error("用法：deployment upgrade --project <目录> --original <SHA> --target <SHA> --branch <分支> [--preflight | --plan <计划> --cleanup apply|skip --directory-plan <范围计划> --candidate <镜像记录> --facts <准备记录> | --rollback] [--confirmation <摘要>] [--json]");
const deployUsage = () => new Error("用法：deployment deploy --project <目录> [--preflight | --stage <暂存目录> --command deploy|repair | --rollback] [--confirmation <摘要>] [--json]");

const restoreUsage = () => new Error("用法：deployment restore --project <目录> --space <空间> [--json]");

function parseFields(argv: readonly string[], fields: Record<string, string>, switches: readonly string[], usage: () => Error): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = { json: false, rollback: false }, seen = new Set<string>();
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index]!;
    if (seen.has(name)) throw usage(); seen.add(name);
    if (name === "--json" || switches.includes(name)) { values[name.slice(2)] = true; continue; }
    const field = Object.hasOwn(fields, name) ? fields[name] : null;
    const value = argv[++index];
    if (!field || !value || value.startsWith("--") || /[\x00\r\n]/.test(value)) throw usage();
    values[field] = value;
  }
  return values;
}
function parseConfirmation(values: Record<string, string | boolean>, usage: () => Error): void {
  if (values.confirmation === undefined) return;
  try { parseConfirmedTransaction(values.rollback ? "rollback" : "continue", values.confirmation as string); }
  catch { throw usage(); }
}
export function parseUpgradeArgs(argv: readonly string[]): UpgradeArgs {
  if (argv[0] !== "upgrade") throw upgradeUsage();
  const values: Record<string, string | boolean> = { preflight: false, ...parseFields(argv, upgradeFields, ["--rollback", "--preflight"], upgradeUsage) };
  if (![values.original, values.target].every(value => typeof value === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))
    || typeof values.project !== "string" || typeof values.branch !== "string" || /[\x00-\x20\x7f]/.test(values.branch)
    || values.cleanup !== undefined && values.cleanup !== "apply" && values.cleanup !== "skip"
    || values.rollback && [values.plan, values.cleanup, values.directoryPlan, values.candidate, values.facts].some(value => value !== undefined)
    || values.preflight && (values.rollback || [values.plan, values.cleanup, values.directoryPlan, values.candidate, values.facts, values.confirmation].some(value => value !== undefined))) throw upgradeUsage();
  parseConfirmation(values, upgradeUsage);
  return values as unknown as UpgradeArgs;
}
export function parseDeployArgs(argv: readonly string[]): DeployArgs {
  if (argv[0] !== "deploy") throw deployUsage();
  const values: Record<string, string | boolean> = { preflight: false, ...parseFields(argv, deployFields, ["--rollback", "--preflight"], deployUsage) };
  if (typeof values.project !== "string" || (values.stage === undefined) !== (values.command === undefined)
    || values.command !== undefined && values.command !== "deploy" && values.command !== "repair"
    || values.stage !== undefined && (values.rollback || values.confirmation !== undefined)
    || values.preflight && (values.rollback || values.stage !== undefined || values.confirmation !== undefined)) throw deployUsage();
  parseConfirmation(values, deployUsage);
  return values as unknown as DeployArgs;
}

export function parseRestoreArgs(argv: readonly string[]): RestoreArgs {
  if (argv[0] !== "restore") throw restoreUsage();
  const values = parseFields(argv, { "--project": "project", "--space": "space", "--git-path": "gitPath" }, [], restoreUsage);
  if (typeof values.project !== "string" || typeof values.space !== "string") throw restoreUsage();
  spaceName(values.space);
  return values as unknown as RestoreArgs;
}

interface Dependencies {
  env?: NodeJS.ProcessEnv;
  source?: string;
  load?: (project: string) => DeploymentState | null;
  host?: typeof runDockerLifecycle;
  preflight?: typeof preflightWindowsUpgrade;
  preflightDeploy?: typeof preflightDockerDeploy;
  platform?: NodeJS.Platform;
  checkPlan?: typeof checkTaskPlan;
}
interface Invocation {
  noun: string;
  project: string;
  pending: DeploymentState | null;
  command: string;
  json: boolean;
  gitPath?: string;
  /** The accepted console task still asks for what this invocation carries. */
  matches(request: TaskRequest): boolean;
}

/** The same captured transaction must survive the pre-lock read, including the case where there was no transaction. */
function hostOptions(call: Invocation, dependencies: Dependencies, source: string): DeploymentOptions {
  const { noun, project, pending, command } = call, env = dependencies.env ?? process.env, load = dependencies.load ?? loadDeploymentState;
  return {
    project, source,
    ...(call.gitPath ? { gitPath: call.gitPath } : {}),
    // Under the lock and before any change: a task or plan that cannot be confirmed refuses the operation.
    verify: () => refusing(async () => {
      if ((load(project)?.confirmation.digest ?? null) !== (pending?.confirmation.digest ?? null)) throw new MaintenanceRefused("取得部署锁前事务已变化，请刷新预览");
      if (env.MIXIN_OPS_CONSOLE === "1" && !env.MIXIN_OPS_TASK_ID) throw new MaintenanceRefused(`控制台${noun}缺少接单记录`);
      if (!env.MIXIN_OPS_TASK_ID) return;
      const expected = env.MIXIN_OPS_EXPECT_CODE;
      if (!expected) throw new MaintenanceRefused(`控制台${noun}缺少确认版本`);
      const request = new TaskStore(consoleDir(project)).request(env.MIXIN_OPS_TASK_ID);
      if (request.operation !== command || !call.matches(request)) throw new MaintenanceRefused(`${noun}目标或选择与已接单任务不一致`);
      await (dependencies.checkPlan ?? checkTaskPlan)(project, request.id, expected);
    }),
    async finish(value) { if (env.MIXIN_OPS_RESULT_FILE) await publishJson(env.MIXIN_OPS_RESULT_FILE, value); },
    ...(call.json ? { output: (text: string) => { process.stderr.write(text); } } : {}),
  };
}

async function runUpgradeCli(args: UpgradeArgs, dependencies: Dependencies, signal?: AbortSignal): Promise<OpsResult> {
  const project = resolve(args.project), source = dependencies.source ?? resolve(import.meta.dir, "../../.."), windows = (dependencies.platform ?? process.platform) === "win32";
  // The real run repeats these checks under deploy.lock, so a passed preflight is not a result of the operation.
  if (args.preflight) return (dependencies.preflight ?? (windows ? preflightWindowsUpgrade : preflightDockerUpgrade))({ original: args.original, target: args.target, branch: args.branch,
    command: "update" }, { project, source, ...(args.gitPath ? { gitPath: args.gitPath } : {}) }, signal);
  const pending = (dependencies.load ?? loadDeploymentState)(project);
  if (pending && (pending.operation !== "upgrade" || pending.record.target_sha !== args.target)) throw new MaintenanceRefused("升级入口与原事务的目标不一致");
  if (!pending && (args.rollback || args.confirmation)) throw new MaintenanceRefused("确认过的升级事务不存在，请刷新预览");
  if (pending && [args.plan, args.cleanup, args.directoryPlan, args.candidate, args.facts].some(value => value !== undefined)) throw new MaintenanceRefused("续做和回滚只使用事务中记录的选择，不接受新计划或整理方式");
  if (!pending && (!args.plan || !args.cleanup)) throw new MaintenanceRefused("新升级必须提供停机前的数据计划和明确的整理方式");
  if (!pending && !windows && (!args.candidate || !args.facts)) throw new MaintenanceRefused("新升级必须提供停机前构建的候选镜像记录和准备记录");
  if (windows && (args.candidate || args.facts)) throw new MaintenanceRefused("Windows 升级不使用候选镜像记录和准备记录");
  const command = args.rollback ? "rollback" : pending ? "resume" : "update";
  // The caller may still be the released wrapper, which passes its current HEAD. Recovery takes the original checkout from disk.
  const input: DockerInput = { original: pending?.record.original_sha ?? args.original, target: args.target,
    branch: pending?.record.original_branch ?? args.branch, command, rollback: args.rollback,
    ...(args.plan ? { plan: resolve(args.plan) } : {}), ...(args.directoryPlan ? { directoryPlan: resolve(args.directoryPlan) } : {}),
    ...(args.cleanup ? { cleanup: args.cleanup } : {}), ...(args.candidate ? { candidate: resolve(args.candidate) } : {}), ...(args.facts ? { facts: resolve(args.facts) } : {}),
    ...(args.confirmation ? { confirmation: args.confirmation } : {}) };
  return (dependencies.host ?? (windows ? runWindowsLifecycle : runDockerLifecycle))(input, hostOptions({ noun: "升级", project, pending, command, json: args.json,
    ...(args.gitPath ? { gitPath: args.gitPath } : {}),
    matches: request => command !== "update" || request.params.target === args.target && request.params.cleanup === args.cleanup }, dependencies, source), signal);
}

async function runDeployCli(args: DeployArgs, dependencies: Dependencies, signal?: AbortSignal): Promise<OpsResult> {
  const project = resolve(args.project), source = dependencies.source ?? resolve(import.meta.dir, "../../.."), windows = (dependencies.platform ?? process.platform) === "win32";
  // The real run repeats these checks under deploy.lock, so a passed preflight is not a result of the operation.
  if (args.preflight) return (dependencies.preflightDeploy ?? (windows ? preflightWindowsDeploy : preflightDockerDeploy))({ operation: "deploy", command: "deploy" },
    { project, source, ...(args.gitPath ? { gitPath: args.gitPath } : {}) }, signal);
  const pending = (dependencies.load ?? loadDeploymentState)(project);
  if (pending && pending.operation !== "deploy") throw new MaintenanceRefused("未完成的是升级，部署入口不能继续或回滚它");
  if (pending && args.stage) throw new MaintenanceRefused("有未完成的部署：续做和回滚只使用事务中记录的选择，不接受新的部署暂存");
  if (!pending && !args.stage) throw new MaintenanceRefused("确认过的部署事务不存在，请刷新预览");
  const command = args.rollback ? "rollback" : pending ? "resume" : args.command!, stage = args.stage && resolve(args.stage);
  /** Compared through the file system: the entry and the console may spell one directory differently, and naming the default directory is choosing no external one. */
  const workspace = (value: unknown) => {
    if (!value) return "";
    try {
      const path = realpathSync(String(value));
      try { if (path === realpathSync(join(project, "data/workspace"))) return ""; } catch { /* No default directory yet. */ }
      return path;
    } catch { return null; }
  };
  return (dependencies.host ?? (windows ? runWindowsLifecycle : runDockerLifecycle))({ operation: "deploy", command, rollback: args.rollback, ...(stage ? { stage } : {}),
    ...(args.confirmation ? { confirmation: args.confirmation } : {}) }, hostOptions({ noun: "部署", project, pending, command, json: args.json,
    ...(args.gitPath ? { gitPath: args.gitPath } : {}),
    matches(request) {
      if (!stage) return true;
      const { choices } = readDeployStage(stage);
      return request.params.port === choices.port && request.params.cleanup === choices.cleanup && workspace(request.params.workspace) === workspace(choices.workspace);
    } }, dependencies, source), signal);
}

async function runRestoreCli(args: RestoreArgs, dependencies: Dependencies, signal?: AbortSignal): Promise<OpsResult> {
  const project = resolve(args.project), source = dependencies.source ?? resolve(import.meta.dir, "../../.."), windows = (dependencies.platform ?? process.platform) === "win32";
  const pending = (dependencies.load ?? loadDeploymentState)(project);
  if (!pending) throw new MaintenanceRefused("没有未完成的部署或升级，恢复不需要事务记录的版本");
  const command = "revision-cleanup", { record } = pending;
  const input: DockerInput = pending.operation === "deploy" ? { operation: "deploy", command, restore: args.space }
    : { original: record.original_sha, target: record.target_sha, branch: record.original_branch, command, restore: args.space };
  return (dependencies.host ?? (windows ? runWindowsLifecycle : runDockerLifecycle))(input, hostOptions({ noun: "恢复", project, pending, command, json: args.json,
    ...(args.gitPath ? { gitPath: args.gitPath } : {}), matches: () => true }, dependencies, source), signal);
}

export async function runDeploymentCli(argv: string[], dependencies: Dependencies = {}, signal?: AbortSignal): Promise<{ result: OpsResult; json: boolean }> {
  if (argv[0] === "restore") {
    const args = parseRestoreArgs(argv);
    return { result: await runRestoreCli(args, dependencies, signal), json: args.json };
  }
  if (argv[0] === "deploy") {
    const args = parseDeployArgs(argv);
    return { result: await runDeployCli(args, dependencies, signal), json: args.json };
  }
  const args = parseUpgradeArgs(argv);
  return { result: await runUpgradeCli(args, dependencies, signal), json: args.json };
}
