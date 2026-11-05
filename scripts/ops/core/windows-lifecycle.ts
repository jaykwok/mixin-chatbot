// Windows platform of the shared lifecycle host: the scheduled task, its job-object writer and the Windows snapshot effects.
// No rollback/startup policy here: runDeployment owns that order and deployment-host.ts the transaction around it.
import { join } from "node:path";
import { publish } from "../../lib/atomic-file.ts";
import { codeDigest } from "../console/runtime.ts";
import { STAGE_UNCHANGED } from "./deploy-stage.ts";
import type { DeploymentGit } from "./deployment-git.ts";
import { WindowsPlatform, type WindowsService } from "./windows-host.ts";
import { parseWindowsTools, serializeWindowsTools, WindowsDeployment, type WindowsTools } from "./windows-deployment.ts";
import { newWindowsTask, recoverWindowsTask, runWindowsTask } from "./windows-task.ts";
import type { NativeCommand, NativeRunner } from "./native-process.ts";
import { serviceReady } from "./readiness.ts";
import { latestStartupError } from "../../lib/operation-log.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import type { OpsResult } from "./result.ts";
import { preflightHost, runDeploymentHost, switchRefusal, validDeployInput, validUpgradeInput, type DeployInput, type DeploymentContext, type DeploymentInput,
  type DeploymentOptions, type DeploymentPlatform, type DeploymentSession, type UpgradeInput } from "./deployment-host.ts";

export type WindowsUpgradeInput = UpgradeInput;
export type WindowsUpgradeOptions = DeploymentOptions;

function serviceRefusal(facts: WindowsService): string | null {
  if (facts.state === "absent") return "未安装计划任务，请先部署";
  if (!facts.owned) return "计划任务 mixin-chatbot 属于其他目录";
  if (facts.state === "unsupported") return `计划任务状态（${facts.rawState}）或前台运行的机器人不支持升级`;
  return null;
}
/** A deployment may start without a task, but never takes over another directory's task or a bot it did not start. */
function deployRefusal(facts: WindowsService): string | null {
  if (!facts.owned) return "计划任务 mixin-chatbot 属于其他目录；请先在那个目录卸载它，或确认后手动注销";
  if (facts.state === "unsupported") return `计划任务状态（${facts.rawState}）或前台运行的机器人不支持部署；请先停止前台实例`;
  return null;
}
/** Start rules of a fresh upgrade: the upgrader runs them before asking anything, the host again under deploy.lock. */
async function startChecks(git: DeploymentGit, service: WindowsPlatform, input: WindowsUpgradeInput, signal?: AbortSignal) {
  if (!await git.mainExists(signal)) throw new MaintenanceRefused("本地 main 分支不存在；旧服务尚未停止");
  const facts = await service.inspect(), refusal = serviceRefusal(facts);
  if (refusal) throw new MaintenanceRefused(refusal + "；旧服务尚未停止");
  const checked = await git.switchConflicts(input.target, signal);
  if (checked.identity.head !== input.original || checked.identity.branch !== input.branch)
    throw new MaintenanceRefused("升级开始后检出发生了变化（提交或分支）；旧服务尚未停止，请处理后重新运行升级");
  if (checked.conflicts.length) throw new MaintenanceRefused(switchRefusal(input.target, checked.conflicts, true, "计划任务"));
  return { service: facts, checkout: checked.identity };
}

function windowsSession(context: DeploymentContext): DeploymentSession {
  const { project, native, output, name } = context, service = new WindowsPlatform(project, context.source, native), deploying = context.operation === "deploy";
  let started: WindowsService | undefined, initial: WindowsService | undefined, effects: WindowsDeployment | undefined, git: DeploymentGit | undefined;
  // A deployment only: the launcher's tools, and the build its instances report. Empty without Git: nothing to compare.
  let tools: WindowsTools | undefined, build = "", startRequested = 0;
  const writer: NativeRunner = async (command, report) => {
    const store = context.store();
    return runWindowsTask(command, newWindowsTask(command), value => store.writer(value), c => native(c, report));
  };
  const install = async (cancellation?: AbortSignal) => {
    const result = await writer({ command: process.execPath, args: ["install", "--frozen-lockfile"], cwd: project, env: { ...process.env }, signal: cancellation, timeoutMs: 30 * 60_000 });
    if (result.code !== 0) throw new Error("依赖安装失败");
  };
  return {
    writer,
    tools: { project, file: file => join(context.snapshot, file), workspace: record => record.target_workspace_root || join(project, "data/workspace") },
    async recover(previous) {
      if (previous.kind !== "windows-job") throw new Error("此事务需要原平台恢复写入者");
      const store = context.store();
      await recoverWindowsTask(previous, value => store.writer(value));
    },
    async start(checkGit, signal) {
      if (deploying) {
        const facts = await service.inspect(), refusal = deployRefusal(facts), recorded = context.stage().platform["windows-tools"];
        if (refusal) throw new MaintenanceRefused(refusal + STAGE_UNCHANGED);
        if (!recorded) throw new MaintenanceRefused("部署暂存缺少工具路径记录" + STAGE_UNCHANGED);
        try { tools = parseWindowsTools(recorded); }
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
        effects = new WindowsDeployment(project, context.source, name, "", native, writer, "deploy");
        return;
      }
      initial = started ?? await service.inspect();
      if (serviceRefusal(initial)) throw new MaintenanceRefused("升级需要本项目已有的正常计划任务");
      effects = new WindowsDeployment(project, context.source, name, initial.identity, native, writer);
    },
    // Capturing only private config/service metadata does not stop the bot.
    async capture(record) {
      if (!deploying) return effects!.capture(record.original_sha, record.target_sha, record.original_branch);
      const captured = await effects!.capture("", record.target_sha, "");
      await publish(join(context.snapshot, "windows-tools"), serializeWindowsTools(tools!), { createOnly: true });
      return captured;
    },
    async confirm(record) {
      const metadata = await effects!.read();
      if (metadata.wasRunning !== (record.was_running === "1")) throw new Error("快照与原运行状态不一致");
      if (deploying) {
        const recorded = context.state().confirmation.text(`backup/snapshots/${name}/windows-tools`);
        if (recorded === null) throw new Error("事务缺少工具路径记录");
        tools = parseWindowsTools(recorded);
      }
    },
    async tool(path, args, cancellation) {
      if (codeDigest(context.source) !== context.runtime) throw new Error("固定运行包摘要变化");
      const command: NativeCommand = { command: process.execPath, args: ["--no-env-file", "run", join(context.source, path), ...args], cwd: project,
        env: { ...process.env, APP_BUILD: deploying ? build : context.record().target_sha.slice(0, 12) }, signal: cancellation, protocol: true,
        timeoutMs: 60 * 60_000 };
      return writer(command, output);
    },
    available: () => true,
    async inspect() {
      const facts = await service.inspect(), current = context.state(), state = facts.state === "running" ? "running" : facts.state === "absent" ? "absent" : "stopped";
      if (deploying) {
        // Re-registering with the same settings gives the same task definition: how far the transaction got tells the instances apart.
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
        case "stop": await effects!.effect("stop"); return;
        case "prepare-dependencies": {
          if (deploying) {
            await effects!.effect("prepare-directories"); await effects!.effect("save-dependencies"); await install(cancellation);
            return;
          }
          const record = context.record();
          if (!await git!.dependenciesReusable(record.original_sha, record.target_sha, cancellation)) {
            await effects!.effect("save-dependencies"); await install(cancellation);
          } return;
        }
        // An upgrade's existing task already points at this checkout, whose code and dependencies are in place.
        case "install-candidate": if (deploying) await effects!.effect("install-task", { tools: { bun: tools!.bun, git: tools!.git, uv: tools!.uv, bash: tools!.bash } }); return;
        case "start-verification": case "start-candidate": case "start-original":
          // A Running task is the supervisor retrying a failed start every minute: start it fresh now instead.
          if ((await service.inspect()).state === "running") await effects!.effect("stop");
          startRequested = Date.now();
          if (deploying) await effects!.effect("start-task", { fallback: step === "start-verification" });
          else await service.start(initial!.identity);
          return;
        case "retire-previous-writers": return; // Windows has one stopped task/process tree, already proved before commit.
        // A deployment's start enables the task it registered; an upgrade puts back the definition it stopped.
        case "disable-verification": if (!deploying && context.state().committed && (await service.inspect()).state !== "running") await effects!.effect("restore-task"); return;
        case "publish-target": return;
        case "restore-dependencies": await effects!.effect("restore-dependencies"); return;
        case "restore-configuration": await effects!.effect("restore-configuration"); return;
        case "restore-service": await effects!.effect("restore-task"); return;
      }
    },
    async ready(role, deadlineMs) {
      const facts = await service.inspect(); if (!facts.owned || !deploying && facts.identity !== initial!.identity) throw new Error("等待就绪时实例归属变化");
      const record = context.record(), expected = !deploying ? (role === "original" ? record.original_sha : record.target_sha).slice(0, 12) : role === "original" ? "" : build;
      return facts.state === "running" && await serviceReady(project, deadlineMs, { verification: role === "verification", ...(expected ? { build: expected } : {}) });
    },
    async unready() {
      try { output(`实例未就绪；计划任务的最后结果：${await service.lastResult() ?? "没有计划任务"}\n`, "stderr"); }
      catch { /* The readiness failure itself is reported. */ }
      // The service's own reason, as Docker shows the container log: the task result code alone says nothing.
      // Only this run's start: an older log may hold a cause the operator has since removed.
      const startup = startRequested ? latestStartupError(project, startRequested - 2000) : null;
      if (startup) output(`新实例启动失败：${startup.error}\n启动日志：${startup.path}\n`, "stderr");
    },
    async cleanup(completion) {
      if (completion !== "forward") return;
      try { await effects!.effect("cleanup"); }
      catch { output(`${deploying ? "部署" : "升级"}已完成，快照清理未完成；已保留备份。\n`, "stderr"); }
    },
  };
}

const windows: DeploymentPlatform = {
  label: "Windows ", noun: "计划任务", upgradePointer: "upgrade-transaction", module: "scripts/ops/core/windows-lifecycle.ts", entry: "runWindowsLifecycle",
  valid: input => process.platform === "win32" && (input.operation === "deploy" ? validDeployInput(input) : validUpgradeInput(input)),
  open: async context => windowsSession(context),
};

/** Read-only, before the upgrader asks anything: no snapshot, record or result file. The real run repeats every check. */
export function preflightWindowsUpgrade(input: WindowsUpgradeInput, options: Pick<WindowsUpgradeOptions, "project" | "source" | "native" | "gitPath">,
  signal?: AbortSignal): Promise<OpsResult> {
  return preflightHost(input, options, windows, async ({ project, source, native, git }, cancellation) => {
    const { service } = await startChecks(git, new WindowsPlatform(project, source, native), input, cancellation);
    return { wasRunning: service.state === "running", message: "停机前检查通过：main、计划任务和代码切换均可进行" };
  }, signal);
}

/** Read-only, before the deploy entry asks anything: lock, unfinished transaction or maintenance, and the task. */
export function preflightWindowsDeploy(input: DeployInput, options: Pick<WindowsUpgradeOptions, "project" | "source" | "native" | "gitPath">, signal?: AbortSignal): Promise<OpsResult> {
  return preflightHost(input, options, windows, async ({ project, source, native }) => {
    const facts = await new WindowsPlatform(project, source, native).inspect(), refusal = deployRefusal(facts);
    if (refusal) throw new MaintenanceRefused(refusal + "；旧服务尚未停止");
    return { wasRunning: facts.state === "running", message: "停机前检查通过：没有进行中的部署、事务或运维任务，计划任务可以由本次部署接管" };
  }, signal);
}

export function runWindowsLifecycle(input: DeploymentInput, options: WindowsUpgradeOptions, signal?: AbortSignal): Promise<OpsResult> {
  return runDeploymentHost(input, options, windows, signal);
}
