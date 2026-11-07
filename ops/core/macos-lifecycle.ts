// macOS platform of the shared lifecycle host: the LaunchDaemon, the supervised writers and the snapshot effects. The core
// runs as root. Git and dependency effects run as the operator who owns the checkout, data tools as the service account.
// No rollback/startup policy here: runDeployment owns that order and deployment-host.ts the transaction around it.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { publish } from "../../src/lib/atomic-file.ts";
import { codeDigest } from "./source-runtime.ts";
import { STAGE_UNCHANGED } from "./deploy-stage.ts";
import type { DeploymentGit } from "./deployment-git.ts";
import { accountIdentity, LaunchdPlatform, SERVICE_ACCOUNT, serviceEnvironment, type Identity, type LaunchdService } from "./launchd-host.ts";
import { MacosDeployment, parseMacosTools, serializeMacosTools, type MacosTools } from "./macos-deployment.ts";
import { newMacosTask, recoverMacosTask, runMacosTask } from "./macos-task.ts";
import type { NativeCommand, NativeRunner } from "./native-process.ts";
import { runCommand, type Runner } from "./hosting.ts";
import { serviceReady } from "./readiness.ts";
import { latestStartupError } from "../../src/lib/operation-log.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import type { OpsResult } from "./result.ts";
import { preflightHost, runDeploymentHost, switchRefusal, validDeployInput, validUpgradeInput, type DeployInput, type DeploymentContext, type DeploymentInput,
  type DeploymentOptions, type DeploymentPlatform, type DeploymentSession, type UpgradeInput } from "./deployment-host.ts";

function serviceRefusal(facts: LaunchdService): string | null {
  if (facts.state === "absent") return "未安装 LaunchDaemon，请先部署";
  if (!facts.owned) return "LaunchDaemon 属于其他目录或其他账户";
  if (facts.state === "unsupported") return `LaunchDaemon 的状态（${facts.rawState}）或服务账户不支持升级`;
  if (facts.state !== "running" && facts.leftovers > 0) return `服务账户 ${SERVICE_ACCOUNT} 有进程在运行（前台运行的机器人或残留进程），不支持升级`;
  return null;
}
/** A deployment may start without a definition, but never takes over another directory's service or a bot it did not start. */
function deployRefusal(facts: LaunchdService): string | null {
  if (!facts.owned) return "LaunchDaemon 属于其他目录或其他账户；请先在那个目录卸载它";
  if (facts.state === "unsupported") return `LaunchDaemon 的状态（${facts.rawState}）或服务账户不支持部署`;
  if (facts.state !== "running" && facts.leftovers > 0) return `服务账户 ${SERVICE_ACCOUNT} 有进程在运行（前台运行的机器人或残留进程）；请先停止它`;
  return null;
}
/** Start rules of a fresh upgrade: the upgrader runs them before asking anything, the host again under deploy.lock. */
async function startChecks(git: DeploymentGit, service: LaunchdPlatform, input: UpgradeInput, signal?: AbortSignal) {
  if (!await git.mainExists(signal)) throw new MaintenanceRefused("本地 main 分支不存在；旧服务尚未停止");
  const facts = await service.inspect(), refusal = serviceRefusal(facts);
  if (refusal) throw new MaintenanceRefused(refusal + "；旧服务尚未停止");
  const checked = await git.switchConflicts(input.target, signal);
  if (checked.identity.head !== input.original || checked.identity.branch !== input.branch)
    throw new MaintenanceRefused("升级开始后检出发生了变化（提交或分支）；旧服务尚未停止，请处理后重新运行升级");
  if (checked.conflicts.length) throw new MaintenanceRefused(switchRefusal(input.target, checked.conflicts, true, "LaunchDaemon"));
  return { service: facts, checkout: checked.identity };
}

/** The operator: the owner of the checkout, whose Git and dependency effects keep it theirs. Root keeps root. */
export async function checkoutOperator(project: string, run: Runner = runCommand): Promise<{ identity?: Identity; env: NodeJS.ProcessEnv }> {
  const uid = lstatSync(project).uid;
  if (uid === 0) return { env: {} };
  const entry = await run(["/usr/bin/id", "-P", String(uid)]), fields = entry.stdout.trim().split(":");
  const gid = Number(fields[3]);
  if (entry.code !== 0 || fields.length < 10 || Number(fields[2]) !== uid || !Number.isSafeInteger(gid) || !fields[8]?.startsWith("/"))
    throw new MaintenanceRefused(`无法读取项目目录属主（UID ${uid}）的账户信息`);
  return { identity: { uid, gid }, env: { HOME: fields[8], USER: fields[0], LOGNAME: fields[0] } };
}
const withoutSudo = (env: NodeJS.ProcessEnv = {}) => {
  const { SUDO_USER: _user, SUDO_UID: _uid, SUDO_GID: _gid, SUDO_COMMAND: _command, ...rest } = env;
  return rest;
};

async function macosSession(context: DeploymentContext): Promise<DeploymentSession> {
  const { project, native, output, name } = context, service = new LaunchdPlatform(project), deploying = context.operation === "deploy";
  const account = await accountIdentity(SERVICE_ACCOUNT);
  if (!account) throw new MaintenanceRefused(`服务账户 ${SERVICE_ACCOUNT} 不存在；请用部署入口部署，它会创建这个账户`);
  const operator = await checkoutOperator(project);
  let started: LaunchdService | undefined, initial: LaunchdService | undefined, effects: MacosDeployment | undefined, git: DeploymentGit | undefined;
  // A deployment only: the definition's tools, and the build its instances report. Empty without Git: nothing to compare.
  let tools: MacosTools | undefined, build = "", startRequested = 0;
  const save = (value: Parameters<ReturnType<typeof context.store>["writer"]>[0]) => context.store().writer(value);
  const sweep = () => service.sweep();
  /** Git and dependency effects, as the operator; the supervisor alone reaps them. */
  const writer: NativeRunner = async (command, report) => {
    const operated: NativeCommand = { ...command, env: { ...withoutSudo(command.env ?? process.env), ...operator.env }, ...(operator.identity ? { identity: operator.identity } : {}) };
    return runMacosTask(operated, newMacosTask(operated, false), save, sweep, c => native(c, report));
  };
  const install = async (cancellation?: AbortSignal) => {
    const result = await writer({ command: process.execPath, args: ["install", "--frozen-lockfile"], cwd: project, env: { ...process.env }, signal: cancellation, timeoutMs: 30 * 60_000 });
    if (result.code !== 0) throw new Error("依赖安装失败");
  };
  return {
    writer,
    tools: { project, file: file => join(context.snapshot, file), workspace: record => record.target_workspace_root || join(project, "data/workspace") },
    owner: account,
    async recover(previous) {
      if (previous.kind !== "macos-session") throw new Error("此事务需要原平台恢复写入者");
      await recoverMacosTask(previous, save, sweep);
    },
    async start(checkGit, signal) {
      if (deploying) {
        const facts = await service.inspect(), refusal = deployRefusal(facts), recorded = context.stage().platform["macos-tools"];
        if (refusal) throw new MaintenanceRefused(refusal + STAGE_UNCHANGED);
        if (!recorded) throw new MaintenanceRefused("部署暂存缺少工具路径记录" + STAGE_UNCHANGED);
        try { tools = parseMacosTools(recorded); }
        catch (error) { throw new MaintenanceRefused((error instanceof Error ? error.message : "部署工具记录无效") + STAGE_UNCHANGED); }
        return { wasRunning: facts.state === "running" };
      }
      const checked = await startChecks(checkGit, service, context.input as UpgradeInput, signal);
      started = checked.service;
      return { wasRunning: checked.service.state === "running", checkout: checked.checkout };
    },
    async prepare(checkGit) {
      git = checkGit;
      if (deploying) {
        build = await checkGit.checkoutBuild();
        effects = new MacosDeployment(project, name, service, native, account, "deploy");
        return;
      }
      initial = started ?? await service.inspect();
      if (serviceRefusal(initial)) throw new MaintenanceRefused("升级需要本项目已有的正常 LaunchDaemon");
      effects = new MacosDeployment(project, name, service, native, account, "upgrade", initial.identity);
    },
    // Copying private settings and the service definition does not stop the bot.
    async capture() {
      const captured = await effects!.capture();
      if (deploying) await publish(join(context.snapshot, "macos-tools"), serializeMacosTools(tools!), { createOnly: true });
      return captured;
    },
    async confirm(record) {
      const metadata = effects!.read();
      if (metadata.wasRunning !== (record.was_running === "1")) throw new Error("快照与原运行状态不一致");
      if (deploying) {
        const recorded = context.state().confirmation.text(`backup/snapshots/${name}/macos-tools`);
        if (recorded === null) throw new Error("事务缺少工具路径记录");
        tools = parseMacosTools(recorded);
      }
    },
    async tool(path, args, cancellation) {
      if (codeDigest(context.source) !== context.runtime) throw new Error("固定运行包摘要变化");
      const command: NativeCommand = { command: process.execPath, args: ["--no-env-file", "run", join(context.source, path), ...args], cwd: project,
        env: { ...serviceEnvironment(project), APP_BUILD: deploying ? build : context.record().target_sha.slice(0, 12) }, signal: cancellation, protocol: true,
        timeoutMs: 60 * 60_000, identity: account };
      return runMacosTask(command, newMacosTask(command, true), save, sweep, c => native(c, output));
    },
    available: () => true,
    async inspect() {
      const facts = await service.inspect(), current = context.state(), state = facts.state === "running" ? "running" : facts.state === "absent" ? "absent" : "stopped";
      if (deploying) {
        // Reinstalling with the same tools gives the same definition: how far the transaction got tells the instances apart.
        const reached = current.execution?.checkpoint, candidate = current.committed
          || reached?.direction === "forward" && (reached.step === "install-candidate" || reached.step === "start-verification");
        return { owned: facts.owned && facts.state !== "unsupported", role: facts.state === "absent" ? "absent" : candidate ? "candidate" : "original", state,
          ready: facts.state === "running" && await serviceReady(project, 2500, candidate && build ? { build } : {}) };
      }
      const record = context.record(), head = (await git!.identity()).head;
      const candidate = head === record.target_sha && (head !== record.original_sha || current.dataPhase !== "unprepared");
      return { owned: facts.owned && ["running", "stopped"].includes(facts.state) && facts.identity === initial!.identity && [record.original_sha, record.target_sha].includes(head),
        role: facts.state === "absent" ? "absent" : candidate ? "candidate" : "original", state,
        ready: facts.state === "running" && await serviceReady(project, 2500, { build: head.slice(0, 12) }) };
    },
    async effect(step, cancellation) {
      switch (step) {
        case "stop": await effects!.stop(); return;
        case "prepare-dependencies": {
          if (deploying) { await effects!.prepareDirectories(); await effects!.saveDependencies(); await install(cancellation); return; }
          const record = context.record();
          if (!await git!.dependenciesReusable(record.original_sha, record.target_sha, cancellation)) { await effects!.saveDependencies(); await install(cancellation); }
          return;
        }
        // An upgrade's existing definition already points at this checkout, whose code and dependencies are in place.
        case "install-candidate": if (deploying) await effects!.installService(tools!); return;
        case "start-verification": case "start-candidate": case "start-original":
          // A loaded job may be the supervisor waiting to retry a failed start: start it fresh now instead.
          if ((await service.inspect()).state === "running") await effects!.stop();
          startRequested = Date.now();
          if (deploying) await effects!.start();
          else await service.start(initial!.identity);
          return;
        case "retire-previous-writers": return; // The stop already ended every process of the service account.
        case "disable-verification": return; // An upgrade never changes the definition, and a stopped one stays disabled.
        case "publish-target": return;
        case "restore-dependencies": await effects!.restoreDependencies(); return;
        case "restore-configuration": await effects!.restoreConfiguration(); return;
        case "restore-service": await effects!.restoreService(); return;
      }
    },
    async ready(role, deadlineMs) {
      const facts = await service.inspect(); if (!facts.owned || !deploying && facts.identity !== initial!.identity) throw new Error("等待就绪时实例归属变化");
      const record = context.record(), expected = !deploying ? (role === "original" ? record.original_sha : record.target_sha).slice(0, 12) : role === "original" ? "" : build;
      return facts.state === "running" && await serviceReady(project, deadlineMs, { verification: role === "verification", ...(expected ? { build: expected } : {}) });
    },
    async unready() {
      try { output(`实例未就绪；launchd 记录的最后退出码：${await service.lastResult() ?? "没有已加载的 LaunchDaemon"}\n`, "stderr"); }
      catch { /* The readiness failure itself is reported. */ }
      // Only this run's start: an older log may hold a cause the operator has since removed.
      const startup = startRequested ? latestStartupError(project, startRequested - 2000) : null;
      if (startup) output(`新实例启动失败：${startup.error}\n启动日志：${startup.path}\n`, "stderr");
    },
    async cleanup(completion) {
      if (completion !== "forward") return;
      try { effects!.cleanup(); }
      catch { output(`${deploying ? "部署" : "升级"}已完成，快照清理未完成；已保留备份。\n`, "stderr"); }
    },
  };
}

const macos: DeploymentPlatform = {
  label: "macOS ", noun: "LaunchDaemon", upgradePointer: "upgrade-transaction", module: "ops/core/macos-lifecycle.ts", entry: "runMacosLifecycle",
  valid: input => process.platform === "darwin" && (input.operation === "deploy" ? validDeployInput(input) : validUpgradeInput(input)),
  open: async context => macosSession(context),
};

/** Read-only, before the upgrader asks anything: no snapshot, record or result file. The real run repeats every check. */
export function preflightMacosUpgrade(input: UpgradeInput, options: Pick<DeploymentOptions, "project" | "source" | "native" | "gitPath">,
  signal?: AbortSignal): Promise<OpsResult> {
  return preflightHost(input, options, macos, async ({ project, git }, cancellation) => {
    const { service } = await startChecks(git, new LaunchdPlatform(project), input, cancellation);
    return { wasRunning: service.state === "running", message: "停机前检查通过：main、LaunchDaemon 和代码切换均可进行" };
  }, signal);
}

/** Read-only, before the deploy entry asks anything: lock, unfinished transaction or maintenance, and the service. */
export function preflightMacosDeploy(input: DeployInput, options: Pick<DeploymentOptions, "project" | "source" | "native" | "gitPath">, signal?: AbortSignal): Promise<OpsResult> {
  return preflightHost(input, options, macos, async ({ project }) => {
    const facts = await new LaunchdPlatform(project).inspect(), refusal = deployRefusal(facts);
    if (refusal) throw new MaintenanceRefused(refusal + "；旧服务尚未停止");
    return { wasRunning: facts.state === "running", message: "停机前检查通过：没有进行中的部署、事务或运维任务，LaunchDaemon 可以由本次部署接管" };
  }, signal);
}

export function runMacosLifecycle(input: DeploymentInput, options: DeploymentOptions, signal?: AbortSignal): Promise<OpsResult> {
  return runDeploymentHost(input, options, macos, signal);
}
