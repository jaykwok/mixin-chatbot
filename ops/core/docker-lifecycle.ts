// Docker platform of the shared lifecycle host. The entry built and previewed the candidate image while the old service kept
// running; this session rechecks those facts under deploy.lock and performs the container, snapshot and task-daemon effects.
// No rollback/startup policy here: runDeployment owns that order and deployment-host.ts the transaction around it.
import { chmodSync, chownSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { publish } from "../../src/lib/atomic-file.ts";
import { openOperationLog } from "../../src/lib/operation-log.ts";
import { inheritedOperationLog } from "../../src/contracts/ops-deployment-task.ts";
import type { DockerDataAccess } from "../../src/contracts/ops-task-access.ts";
import { STAGE_UNCHANGED } from "./deploy-stage.ts";
import type { DeploymentGit } from "./deployment-git.ts";
import { DockerPlatform } from "./docker-host.ts";
import { DockerDeployment, failedContainerName, parseCandidateRecord, parseServiceUser, parseTaskRuntime, PREVIOUS_IMAGE_TAG, ROLLBACK_CONTAINER,
  serializeCandidateRecord, serializeServiceUser, serializeTaskRuntime, serviceOwner, serviceUserRefusal, SERVICE_CONTAINER, SERVICE_IMAGE, validServiceUser,
  type CandidateRecord, type ContainerFacts, type ServiceUserRecord, type TaskRuntimeRecord } from "./docker-deployment.ts";
import { newDockerTask, recoverDockerTask, runDockerTask } from "./docker-task.ts";
import { readText } from "./host-files.ts";
import { parseRecord } from "./key-value-record.ts";
import { newLinuxTask, recoverLinuxTask, runLinuxTask } from "./linux-task.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import type { NativeRunner } from "./native-process.ts";
import { serviceReady } from "./readiness.ts";
import type { OpsResult } from "./result.ts";
import { preflightHost, runDeploymentHost, switchRefusal, validDeployInput, validUpgradeInput, type DeployInput, type DeploymentContext, type DeploymentOptions,
  type DeploymentPlatform, type DeploymentSession, type DeploymentWriter, type UpgradeInput } from "./deployment-host.ts";

export interface DockerUpgradeInput extends UpgradeInput {
  /** What the upgrader prepared before the stop, for a fresh upgrade: the candidate-image record and its facts file. */
  candidate?: string;
  facts?: string;
}
/** A deployment's candidate, service identity, task daemon and original container come in its stage (deploy-stage.ts). */
export type DockerInput = DockerUpgradeInput | DeployInput;
export type DockerOptions = DeploymentOptions;

const FACT_KEYS = ["format", "container", "user", "image", "data", "main", "endpoint", "daemon"] as const;
const parseFacts = (text: string) => parseRecord(text, FACT_KEYS, { format: /^1$/, container: /^[a-f0-9]{64}$/, user: /^\d+:\d+$/, image: /^sha256:[a-f0-9]{64}$/,
  data: /^\/[^\x00-\x1f\x7f]*$/, main: /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/, endpoint: /^unix:\/\/\/[^\x00-\x1f\x7f,]+$/, daemon: /^[a-zA-Z0-9:._-]+$/ }, "升级准备记录");
/** The original container as the deploy entry saw it; all empty when there was none (a first deployment). */
const DEPLOY_FACT_KEYS = ["format", "container", "image", "data"] as const;
const parseDeployFacts = (text: string) => parseRecord(text, DEPLOY_FACT_KEYS, { format: /^1$/, container: /^([a-f0-9]{64})?$/, image: /^(sha256:[a-f0-9]{64})?$/,
  data: /^(\/[^\x00-\x1f\x7f]*)?$/ }, "部署准备记录");
// Bind mounts refuse a missing source, and a directory created here must not end up owned by root for a non-root service.
const SERVICE_DIRECTORIES = ["data/config", "data/state", "data/runtime/home", "logs", "backup/snapshots", "backup/rm"];

async function dockerSession(context: DeploymentContext<DockerInput>): Promise<DeploymentSession> {
  const { project, native, output, lock, input, name, snapshot, operation: kind } = context, docker = await DockerPlatform.connect(project, native);
  const effects = new DockerDeployment(project, docker, output), held = () => lock.assertHeld();
  const save = (value: DeploymentWriter) => context.store().writer(value);
  const operation = openOperationLog(project, kind), noun = kind === "deploy" ? "部署" : "升级";
  let candidate: CandidateRecord | undefined, user: ServiceUserRecord | undefined, runtime: TaskRuntimeRecord | undefined, build = "";
  let previousImage = "", previousContainer = "", present = true, git: DeploymentGit | undefined, stoppedAt: number | undefined;
  const owner = () => docker.rootless || !user ? undefined : serviceOwner(user.user);
  // The task daemon is rootless and belongs to the operator (rootless) or to the service's own UID (rootful).
  const taskUid = () => docker.rootless ? process.geteuid!() : serviceOwner(user!.user).uid;
  const writer: NativeRunner = async (command, report) => {
    context.store();
    return runLinuxTask(project, command, newLinuxTask(project, command, held), save, held, c => native(c, report));
  };
  const isOriginal = (facts: ContainerFacts) => facts.id === previousContainer;
  const isCandidate = (facts: ContainerFacts) => !isOriginal(facts) && facts.image === candidate?.image_id && facts.user === user?.user && effects.dataOwned(facts);
  /** A data step of the target release: the candidate image as the service user, without network, its container journaled. */
  const dataTask = async (path: string, args: string[], cancellation?: AbortSignal, access?: DockerDataAccess) => {
    if (!present || !candidate || !user) throw new Error("候选镜像已不存在，不能运行目标版本的数据工具");
    const argv = ["--no-env-file", "run", path, ...args], log = inheritedOperationLog();
    const record = newDockerTask({ daemon: docker.daemon, endpoint: docker.endpoint, image: candidate.image_id, user: user.user, data: effects.data, backup: resolve(project, "backup"),
      network: "none", ...(access ? { access } : {}), deployment: { id: name, ...(log ? { log } : {}) } }, argv);
    return runDockerTask(docker.taskDriver(60 * 60_000, true, output), record, argv, save, cancellation);
  };
  const downtimeEnds = (detail: string) => {
    operation.event("info", kind, stoppedAt === undefined ? `service back (${detail}); the stop happened in an earlier process`
      : `service back (${detail}); downtime ${Math.round((Date.now() - stoppedAt) / 1000)}s`);
    stoppedAt = undefined;
  };
  const warnOnFailure = async (work: () => unknown, message: string) => {
    try { await work(); } catch (error) { output(`${message}（${error instanceof Error ? error.message : "原因未知"}）\n`, "stderr"); }
  };
  /** `docker start` does nothing to a running container: one still up after a failed start is a restart loop, so start it fresh. */
  const restart = async (current: ContainerFacts) => {
    if (current.running || current.status === "restarting") await effects.stop(current.id);
    await effects.start(current.id);
  };
  /** The health of the candidate reports the build its image carries; an unversioned image has nothing to compare. */
  const candidateBuild = (): { build?: string } => build ? { build } : {};
  const checkOriginal = (original: ContainerFacts) => {
    if (!effects.dataOwned(original)) throw new MaintenanceRefused(`容器 mixin-bot 的数据目录（${original.data ?? "未挂载"}）不是本项目的 ${effects.data}，无法确认它是本项目的服务`);
    if (!["running", "created", "exited"].includes(original.status)) throw new MaintenanceRefused(`容器 mixin-bot 的状态（${original.status}）不支持${noun}；旧服务尚未停止`);
  };
  const checkCandidate = async (rejected: string) => {
    if (await effects.verifyCandidate(candidate!) !== "ok") throw new MaintenanceRefused(`候选镜像核对未通过；${rejected}`);
    await effects.taskDaemon(runtime!, taskUid());
    if (!await effects.taskHasImage(runtime!, taskUid(), candidate!.image_id)) throw new MaintenanceRefused(`任务 daemon 中没有候选镜像；${rejected}`);
  };
  const startUpgrade = async (checkGit: DeploymentGit, upgrade: DockerUpgradeInput, signal?: AbortSignal) => {
    const replaced = "原容器 mixin-bot 在准备期间被删除、替换或改动；服务和数据未改动，请重新运行升级";
    if (!upgrade.candidate || !upgrade.facts) throw new MaintenanceRefused("Linux 升级参数不完整");
    const factsText = readText(resolve(upgrade.facts)), candidateText = readText(resolve(upgrade.candidate));
    if (factsText === null || candidateText === null) throw new MaintenanceRefused("升级准备记录缺失；服务和数据未改动，请重新运行升级");
    let facts: ReturnType<typeof parseFacts>;
    try { facts = parseFacts(factsText); candidate = parseCandidateRecord(candidateText); }
    catch (error) { throw new MaintenanceRefused(`${error instanceof Error ? error.message : "升级准备记录无效"}；服务和数据未改动，请重新运行升级`); }
    if (candidate.source !== "commit" || candidate.target_sha !== upgrade.target) throw new MaintenanceRefused("候选镜像不是从本次目标提交构建的；服务和数据未改动，请重新运行升级");
    if (!await checkGit.mainExists(signal)) throw new MaintenanceRefused("本地 main 分支不存在；旧服务尚未停止");
    if (await effects.container(ROLLBACK_CONTAINER)) throw new MaintenanceRefused("发现旧回滚容器 mixin-bot-rollback，请先确认其状态");
    const original = await effects.container(SERVICE_CONTAINER);
    if (!original || original.name !== SERVICE_CONTAINER || original.id !== facts.container || original.user !== facts.user || original.image !== facts.image || original.data !== facts.data)
      throw new MaintenanceRefused(replaced);
    checkOriginal(original);
    if (!validServiceUser(original.user)) throw new MaintenanceRefused(`原容器 mixin-bot 的运行身份不是数值 UID:GID（${original.user || "镜像默认用户"}），无法可靠确定`);
    const refusal = serviceUserRefusal(original.user, docker.rootless);
    if (refusal) throw new MaintenanceRefused(refusal);
    user = { format: "1", user: original.user, source: "container" };
    runtime = { endpoint: facts.endpoint, daemon: facts.daemon };
    await checkCandidate("服务尚未停止，请重新运行升级");
    const checked = await checkGit.switchConflicts(upgrade.target, signal);
    if (checked.identity.head !== upgrade.original || checked.identity.branch !== upgrade.branch || checked.identity.main !== facts.main)
      throw new MaintenanceRefused("升级开始后检出发生了变化（提交、分支或 main）；服务尚未停止，请处理后重新运行升级");
    if (checked.conflicts.length) throw new MaintenanceRefused(switchRefusal(upgrade.target, checked.conflicts, true, "容器"));
    previousImage = original.image; previousContainer = original.id;
    return { wasRunning: original.running, checkout: checked.identity };
  };
  const startDeploy = async () => {
    const stage = context.stage(), refuse = (text: string) => new MaintenanceRefused(text + STAGE_UNCHANGED);
    const { "candidate-image": candidateText, "service-user": userText, "task-runtime": runtimeText, facts: factsText } = stage.platform;
    if (!candidateText || !userText || !runtimeText || !factsText) throw refuse("部署暂存缺少候选镜像、服务身份或任务 daemon 记录");
    let facts: ReturnType<typeof parseDeployFacts>;
    try { facts = parseDeployFacts(factsText); candidate = parseCandidateRecord(candidateText); user = parseServiceUser(userText); runtime = parseTaskRuntime(runtimeText); }
    catch (error) { throw refuse(error instanceof Error ? error.message : "部署准备记录无效"); }
    if (candidate.source !== "workspace" || candidate.target_sha !== stage.choices.target) throw refuse("候选镜像不是从本次部署的工作区构建的");
    if (await effects.container(ROLLBACK_CONTAINER)) throw new MaintenanceRefused("发现旧回滚容器 mixin-bot-rollback，请先确认其状态");
    const original = await effects.container(SERVICE_CONTAINER);
    if ((original?.id ?? "") !== facts.container || (original?.image ?? "") !== facts.image || (original?.data ?? "") !== facts.data)
      throw refuse("原容器 mixin-bot 在准备期间被删除、替换或改动");
    if (original) {
      checkOriginal(original);
      if (user.source !== "container" || user.user !== original.user) throw refuse("服务身份记录与原容器不一致");
      previousImage = original.image; previousContainer = original.id;
    } else if (user.source === "container") throw refuse("服务身份记录来自原容器，但原容器不存在");
    const refusal = serviceUserRefusal(user.user, docker.rootless);
    if (refusal) throw new MaintenanceRefused(refusal);
    await checkCandidate("服务尚未停止，请重新部署");
    return { wasRunning: !!original?.running };
  };
  return {
    writer,
    tools: { project: "/app", file: file => `/app/backup/snapshots/${name}/${file}`, workspace: () => undefined },
    get owner() { return owner(); },
    async recover(previous) {
      if (previous.kind === "docker") await recoverDockerTask(docker.taskDriver(), previous, save);
      else if (previous.kind === "linux-supervisor") await recoverLinuxTask(project, previous, save, held);
      else throw new Error("此事务需要原平台恢复写入者");
    },
    start: (checkGit, signal) => kind === "deploy" ? startDeploy() : startUpgrade(checkGit, input as DockerUpgradeInput, signal),
    async prepare(checkGit) { git = checkGit; },
    async capture(record) {
      effects.serviceDirectories(SERVICE_DIRECTORIES, owner());
      const current = await effects.container(SERVICE_CONTAINER);
      if ((current?.id ?? "") !== previousContainer) throw new MaintenanceRefused(`原容器 mixin-bot 在准备期间被删除、替换或改动；服务和数据未改动，请重新运行${noun}`);
      if (previousImage) {
        try { await effects.tag(previousImage, PREVIOUS_IMAGE_TAG); }
        catch { throw new MaintenanceRefused(`无法为原容器的镜像添加回滚标签 ${PREVIOUS_IMAGE_TAG}；为保证能回滚，未做任何改动`); }
      }
      mkdirSync(snapshot, { mode: 0o700 }); chmodSync(snapshot, 0o700);
      // Containers running as the service read plans here; only the directory itself is handed over.
      const own = owner(); if (own) chownSync(snapshot, own.uid, own.gid);
      await effects.captureFiles(snapshot, native);
      const files = { "was-running": current?.running ? "1" : "0", "previous-image": previousImage, "target-sha": record.target_sha + "\n",
        "candidate-image": serializeCandidateRecord(candidate!), "service-user": serializeServiceUser(user!), "task-runtime": serializeTaskRuntime(runtime!),
        "task-previous-cid": previousContainer + "\n" };
      for (const [file, text] of Object.entries(files)) await publish(join(snapshot, file), text, { createOnly: true });
      return { wasRunning: !!current?.running };
    },
    // From here on only the records decide the image and identity: nothing is rebuilt, pulled or chosen by tag.
    async confirm(record) {
      const file = (relative: string) => context.state().confirmation.text(`backup/snapshots/${name}/${relative}`);
      const required = (relative: string) => {
        const text = file(relative);
        if (text === null) throw new Error(`事务缺少有效的候选镜像或服务身份记录（${relative}）；不按标签猜测镜像，也不猜测运行身份`);
        return text;
      };
      candidate = parseCandidateRecord(required("candidate-image")); user = parseServiceUser(required("service-user")); runtime = parseTaskRuntime(required("task-runtime"));
      previousImage = file("previous-image")?.trim() ?? ""; previousContainer = file("task-previous-cid")?.trim() ?? "";
      if (candidate.target_sha !== record.target_sha || required("target-sha").trim() !== record.target_sha) throw new Error("候选镜像记录的提交与事务的目标提交不一致");
      if (required("was-running").trim() !== record.was_running) throw new Error("快照与原运行状态不一致");
      // Only a deployment can start without an original container.
      if (!(kind === "deploy" && !previousImage && !previousContainer) && (!/^sha256:[a-f0-9]{64}$/.test(previousImage) || !/^[a-f0-9]{64}$/.test(previousContainer)))
        throw new Error("事务的原容器记录无效");
      const refusal = serviceUserRefusal(user.user, docker.rootless);
      if (refusal) throw new MaintenanceRefused(`记录的服务身份与当前 Docker 的模式不符：${refusal}；请回到开始事务时的 Docker`);
      const status = await effects.verifyCandidate(candidate);
      present = status !== "missing";
      if (status === "moved") output(`保留标签不再指向候选镜像；执行仍只按记录的 ID ${candidate.image_id}\n`, "stderr");
      if (present) build = await effects.imageBuild(candidate.image_id);
      effects.serviceDirectories(SERVICE_DIRECTORIES, owner());
      effects.operationLogAccess(inheritedOperationLog(), owner());
    },
    tool: (path, args, cancellation) => dataTask(path, args, cancellation),
    available: () => present,
    async inspect() {
      const current = await effects.container(SERVICE_CONTAINER), saved = await effects.container(ROLLBACK_CONTAINER), record = context.record();
      const supported = !current || ["running", "restarting", "created", "exited"].includes(current.status);
      // A deployment never moves the checkout, and the containers run images: only an upgrade binds the instance to the code.
      const code = kind === "deploy" || [record.original_sha, record.target_sha].includes((await git!.identity()).head);
      const owned = supported && (!saved || isOriginal(saved)) && (!current || isOriginal(current) || isCandidate(current)) && code;
      const running = !!current && (current.running || current.status === "restarting"), role = !current ? "absent" : isOriginal(current) ? "original" : "candidate";
      return { owned, role, state: !current ? "absent" : running ? "running" : "stopped",
        ready: running && await serviceReady(project, 2500, role === "candidate" ? candidateBuild() : {}) };
    },
    async preflight(direction) {
      if (direction === "forward" && !present) throw new MaintenanceRefused(`继续需要记录的候选镜像 ${candidate!.image_id}，但它已不存在；请恢复完全相同的镜像（同一 image ID）后重试，重新构建的镜像不能代替。本次${noun}尚未开始迁移时也可以回滚`);
      const original = context.record().original_workspace_root;
      if (direction === "rollback" && original) {
        let usable = false;
        try { usable = lstatSync(original).isDirectory(); } catch { /* Reported below. */ }
        if (!usable) throw new MaintenanceRefused(`原共享资料目录不存在：${original}；旧容器依赖它，请恢复原挂载后再回滚`);
      }
    },
    async effect(step) {
      switch (step) {
        case "stop": {
          const current = await effects.container(SERVICE_CONTAINER);
          if (!current || !current.running && current.status !== "restarting") return;
          await effects.stop(current.id);
          if (isOriginal(current)) {
            stoppedAt = Date.now(); operation.event("info", kind, "service stopped; downtime begins");
            output(`已停止机器人服务（容器 mixin-bot）；${noun}完成前不处理消息\n`, "stderr");
          }
          return;
        }
        case "prepare-dependencies": return; // The image carries its own dependencies.
        case "install-candidate": {
          const record = context.record(), workspace = record.target_workspace_root;
          const manifest = await dataTask("ops/tools/task-deployment.ts", ["write", "--image", candidate!.image_id, "--data", effects.data, ...(workspace ? ["--workspace", workspace] : [])],
            undefined, { ...(workspace ? { workspace } : {}), tasks: { endpoint: runtime!.endpoint, daemon: runtime!.daemon, uid: taskUid() } });
          if (manifest.code !== 0) throw new Error("任务清单写入失败");
          await publish(join(project, "data/state/task-runtime"), serializeTaskRuntime(runtime!), { owner: owner() });
          const current = await effects.container(SERVICE_CONTAINER);
          if (current) {
            if (current.running) throw new Error("机器人容器仍在运行，未创建验证实例");
            // The original waits for a possible rollback; an instance left by an earlier attempt keeps its logs.
            await effects.rename(current.id, isOriginal(current) ? ROLLBACK_CONTAINER : failedContainerName());
          }
          await effects.createService({ image: candidate!.image_id, user: user!.user, port: record.bot_port, workspace, socket: runtime!.endpoint.slice("unix://".length) });
          return;
        }
        case "start-verification": case "start-candidate": {
          const current = await effects.container(SERVICE_CONTAINER);
          if (!current || !isCandidate(current)) throw new Error("候选实例的身份不符，未启动");
          await restart(current); return;
        }
        case "start-original": {
          const current = await effects.container(SERVICE_CONTAINER);
          if (!current || !isOriginal(current)) throw new Error("原实例的身份不符，未启动");
          await restart(current); return;
        }
        case "retire-previous-writers": await effects.retirePrevious(previousContainer, previousImage); return;
        case "disable-verification": return;
        case "publish-target":
          try { await effects.tag(candidate!.image_id, SERVICE_IMAGE); }
          catch (error) { throw new Error(`数据已经提交，但正式标签 mixin-bot 未能指向 ${candidate!.image_id}（${error instanceof Error ? error.message : "原因未知"}）；保留事务，处理后继续重试`); }
          return;
        case "restore-dependencies": return;
        case "restore-configuration": await effects.restoreFiles(snapshot, name, writer); return;
        case "restore-service": {
          const current = await effects.container(SERVICE_CONTAINER);
          if (current && !isOriginal(current)) {
            if (current.running) throw new Error("新容器未停止，拒绝覆盖其配置");
            await effects.rename(current.id, failedContainerName());
          }
          // A first deployment has nothing to go back to: the service tag moves only after the data commit.
          if (!previousImage) return;
          try { await effects.tag(previousImage, SERVICE_IMAGE); }
          catch { throw new Error(`原镜像 ${previousImage.replace(/^sha256:/, "")} 已不存在（回滚标签 ${PREVIOUS_IMAGE_TAG} 缺失），无法恢复 mixin-bot 标签`); }
          const saved = await effects.container(ROLLBACK_CONTAINER);
          if (saved) {
            if (!isOriginal(saved)) throw new Error("回滚容器不是事务记录的原容器");
            await effects.rename(saved.id, SERVICE_CONTAINER);
          }
          return;
        }
      }
    },
    async beforeCommit() {
      // The workspace may have been replaced or remounted since the preview.
      try { await effects.layoutCheck(candidate!.image_id, user!.user, context.record().target_workspace_root); }
      catch (error) { throw new Error(`共享资料目录在预检后发生变化（${error instanceof Error ? error.message : "原因未知"}），部署未提交，正在恢复原部署`); }
    },
    async ready(role, deadlineMs) {
      const current = await effects.container(SERVICE_CONTAINER);
      if (!current || !(role === "original" ? isOriginal(current) : isCandidate(current))) throw new Error("等待就绪时实例归属变化");
      if (!current.running && current.status !== "restarting") { await effects.showLogs(current.id); return null; }
      const ready = await serviceReady(project, deadlineMs, { ...(role === "original" ? {} : candidateBuild()), verification: role === "verification" });
      if (ready && role !== "verification") downtimeEnds(role === "candidate" ? "new version healthy" : "previous version restarted");
      return ready;
    },
    async unready() {
      // A crash loop under the restart policy never counts as exited: show why before the rollback renames the container.
      try { const current = await effects.container(SERVICE_CONTAINER); if (current) await effects.showLogs(current.id); }
      catch { /* The readiness failure itself is reported. */ }
    },
    async cleanup(completion) {
      const tag = candidate!.image_tag;
      const releaseCandidate = () => warnOnFailure(() => effects.releaseCandidate(candidate!), `候选镜像的保留标签 ${tag} 未移除；确认不再需要后可手动 docker image rm ${tag}`);
      const releasePrevious = () => warnOnFailure(() => effects.releasePrevious(), `回滚标签 ${PREVIOUS_IMAGE_TAG} 清理失败；确认不再需要后可手动 docker image rm ${PREVIOUS_IMAGE_TAG}`);
      if (completion === "rollback") { await releasePrevious(); await releaseCandidate(); return; }
      await releaseCandidate();
      await warnOnFailure(() => effects.removeCompleted(name), `${noun}已完成，但备份清理未完成，请检查 ${snapshot} 和 backup/rm`);
      await releasePrevious();
      await warnOnFailure(() => effects.cleanupTaskImages(runtime!, taskUid(), candidate!.image_id), `${noun}已完成，但独立任务 daemon 的旧镜像清理未完成；下次成功${noun}会重试`);
    },
  };
}

const docker: DeploymentPlatform<DockerInput> = {
  label: "Linux ", noun: "容器", upgradePointer: "deploy-transaction", module: "ops/core/docker-lifecycle.ts", entry: "runDockerLifecycle",
  valid: input => process.platform === "linux" && (input.operation === "deploy" ? validDeployInput(input) : validUpgradeInput(input)),
  open: context => dockerSession(context),
};

/** Read-only, before the upgrader builds anything: lock, unfinished transaction or maintenance, main, the original container and
 * the code switch (local files the route through main would overwrite). The real run repeats every check under the lock. */
export function preflightDockerUpgrade(input: DockerUpgradeInput, options: Pick<DockerOptions, "project" | "source" | "native" | "gitPath">,
  signal?: AbortSignal): Promise<OpsResult> {
  return preflightHost(input, options, docker, async ({ project, native, git }, cancellation) => {
    if (!await git.mainExists(cancellation)) throw new MaintenanceRefused("本地 main 分支不存在；旧服务尚未停止");
    const effects = new DockerDeployment(project, await DockerPlatform.connect(project, native), () => {});
    if (await effects.container(ROLLBACK_CONTAINER)) throw new MaintenanceRefused("发现旧回滚容器 mixin-bot-rollback，请先确认其状态；旧服务尚未停止");
    const original = await effects.container(SERVICE_CONTAINER);
    if (!original) throw new MaintenanceRefused("找不到原容器 mixin-bot；升级沿用原服务，请先部署；旧服务尚未停止");
    const checked = await git.switchConflicts(input.target, cancellation);
    if (checked.identity.head !== input.original || checked.identity.branch !== input.branch)
      throw new MaintenanceRefused("升级开始后检出发生了变化（提交或分支）；旧服务尚未停止，请处理后重新运行升级");
    if (checked.conflicts.length) throw new MaintenanceRefused(switchRefusal(input.target, checked.conflicts, true, "容器"));
    return { wasRunning: original.running, message: "停机前检查通过：部署锁、未完成的事务和运维任务、main、原容器与代码切换均可进行" };
  }, signal);
}

/** Read-only, before the deploy entry builds anything: lock, unfinished transaction or maintenance, and a leftover rollback container. */
export function preflightDockerDeploy(input: DeployInput, options: Pick<DockerOptions, "project" | "source" | "native" | "gitPath">, signal?: AbortSignal): Promise<OpsResult> {
  return preflightHost(input, options, docker, async ({ project, native }) => {
    const effects = new DockerDeployment(project, await DockerPlatform.connect(project, native), () => {});
    if (await effects.container(ROLLBACK_CONTAINER)) throw new MaintenanceRefused("发现旧回滚容器 mixin-bot-rollback，请先确认其状态；旧服务尚未停止");
    const original = await effects.container(SERVICE_CONTAINER);
    return { wasRunning: !!original?.running, message: "停机前检查通过：部署锁、未完成的事务和运维任务与回滚容器均可进行" };
  }, signal);
}

export function runDockerLifecycle(input: DockerInput, options: DockerOptions, signal?: AbortSignal): Promise<OpsResult> {
  return runDeploymentHost(input, options, docker, signal);
}
