// Docker effects of a deployment transaction: the snapshot's key=value records (the shell entries write the candidate record
// and read the transaction record to offer resume or rollback), the pinned candidate image, the service container and the
// task daemon.
// runDeployment owns ordering, commit boundaries and rollback; nothing here decides them.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lchownSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureFiles, removeCompleted, resolvedPath, restoreFiles, serviceDirectories, type Owner } from "./deployment-files.ts";
import type { DockerPlatform } from "./docker-host.ts";
import { parseRecord, serializeRecord, type Values } from "./key-value-record.ts";
import type { NativeOutput, NativeRunner } from "./native-process.ts";
import { MaintenanceRefused } from "./maintenance.ts";

/** Providers, model selection and the dynamic catalogue restore together, so a rolled-back instance still resolves its model offline. */
export const DEPLOY_FILES = ["data/config", "data/runtime/pi/settings.json", "data/runtime/models-store.json", "data/state/bot-port",
  "data/state/workspace-root", "data/state/task-runtime"] as const;
export const SERVICE_CONTAINER = "mixin-bot", ROLLBACK_CONTAINER = "mixin-bot-rollback", SERVICE_IMAGE = "mixin-bot";
export const PREVIOUS_IMAGE_TAG = "mixin-bot:previous";
export const failedContainerName = () => `mixin-bot-failed-${Math.floor(Date.now() / 1000)}-${randomBytes(2).toString("hex")}`;
const GNU = { cp: "cp", mv: "mv" };
const LABEL_REVISION = "org.opencontainers.image.revision", LABEL_PROJECT = "org.mixin-bot.project",
  LABEL_OPERATION = "org.mixin-bot.operation", LABEL_SOURCE = "org.mixin-bot.source";

const CANDIDATE_KEYS = ["format", "source", "target_sha", "image_id", "image_tag", "daemon_id", "project_id", "operation_id"] as const;
export type CandidateRecord = Values<typeof CANDIDATE_KEYS[number]>;
export function parseCandidateRecord(text: string): CandidateRecord {
  const record = parseRecord(text, CANDIDATE_KEYS, { format: /^1$/, source: /^(commit|workspace)$/, target_sha: /^([0-9a-f]{40}|[0-9a-f]{64})?$/, image_id: /^sha256:[0-9a-f]{64}$/,
    image_tag: /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*:candidate-[0-9a-f]{12}-[0-9a-f]{16}$/, daemon_id: /^[A-Za-z0-9][A-Za-z0-9:-]{7,127}$/,
    project_id: /^[0-9a-f]{12}$/, operation_id: /^[0-9a-f]{16}$/ }, "候选镜像记录");
  if (!record.image_tag.endsWith(`:candidate-${record.project_id}-${record.operation_id}`)) throw new Error("候选镜像的保留标签与项目标识、操作 ID 不一致");
  if (record.source !== "workspace" && !record.target_sha) throw new Error("从提交构建的候选镜像记录缺少提交");
  return record;
}
export const serializeCandidateRecord = (record: CandidateRecord) => serializeRecord(record, CANDIDATE_KEYS);

const SERVICE_USER_KEYS = ["format", "user", "source"] as const;
export type ServiceUserRecord = Values<typeof SERVICE_USER_KEYS[number]>;
export const validServiceUser = (user: string) => /^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/.test(user) && user.split(":").every(part => Number(part) < 4294967295);
export function parseServiceUser(text: string): ServiceUserRecord {
  const record = parseRecord(text, SERVICE_USER_KEYS, { format: /^1$/, user: /^\d+:\d+$/, source: /^(container|default|confirmed)$/ }, "服务身份记录");
  if (!validServiceUser(record.user)) throw new Error("服务身份记录无效：user");
  return record;
}
export const serializeServiceUser = (record: ServiceUserRecord) => serializeRecord(record, SERVICE_USER_KEYS);
/** Rootless can only run as the 0:0 mapped to its owner; rootful never runs the service as host root. Returns the refusal. */
export function serviceUserRefusal(user: string, rootless: boolean): string | null {
  if (rootless) return user === "0:0" ? null : `rootless Docker 下服务应以映射为部署用户的 0:0 运行，记录的是 ${user}；其他 UID 映射到从属 ID 区间，读写不了部署用户的数据`;
  return user.split(":")[0] !== "0" ? null : `rootful Docker 下服务不应以 root（${user}）运行，本项目的部署不会这样启动它`;
}
export function serviceOwner(user: string) { const [uid, gid] = user.split(":").map(Number); return { uid: uid!, gid: gid! }; }

const TASK_RUNTIME_KEYS = ["endpoint", "daemon"] as const;
export type TaskRuntimeRecord = Values<typeof TASK_RUNTIME_KEYS[number]>;
export const parseTaskRuntime = (text: string): TaskRuntimeRecord =>
  parseRecord(text, TASK_RUNTIME_KEYS, { endpoint: /^unix:\/\/\/[^\x00-\x1f\x7f,]+$/, daemon: /^[a-zA-Z0-9:._-]+$/ }, "任务部署记录");
export const serializeTaskRuntime = (record: TaskRuntimeRecord) => serializeRecord(record, TASK_RUNTIME_KEYS);

/** The candidate tags of several deployments on one daemon stay apart by a digest of the project path. */
export const candidateProjectId = (project: string) => createHash("sha256").update(realpathSync(project)).digest("hex").slice(0, 12);

const done = (result: { code: number; stderr: string }, action: string) => {
  if (result.code !== 0) throw new Error(`${action}失败：${result.stderr.trim() || "退出码 " + result.code}`);
};
const parsed = (text: string, what: string): any => { try { return JSON.parse(text); } catch { throw new Error(`Docker 没有返回完整的${what}`); } };

export interface ContainerFacts {
  id: string;
  name: string;
  image: string;
  user: string;
  /** Source of the /app/data bind mount, null when there is none. */
  data: string | null;
  status: string;
  running: boolean;
}
export interface ServiceContainerOptions { image: string; user: string; port: string; workspace: string; socket: string }

export class DockerDeployment {
  readonly data: string;
  constructor(readonly project: string, readonly docker: DockerPlatform, private readonly output: NativeOutput) { this.data = docker.dataPath(); }

  async container(reference: string): Promise<ContainerFacts | null> {
    const result = await this.docker.probe(["container", "inspect", reference]);
    if (result.code !== 0) {
      if (/No such (container|object)/i.test(result.stderr)) return null;
      throw new Error(`无法读取容器 ${reference}：${result.stderr.trim() || "退出码 " + result.code}`);
    }
    const list = parsed(result.stdout, "容器信息"), c = Array.isArray(list) && list.length === 1 ? list[0] : null;
    if (!c || !/^[a-f0-9]{64}$/.test(c.Id) || typeof c.Name !== "string" || !/^sha256:[a-f0-9]{64}$/.test(c.Image) || typeof c.Config?.User !== "string"
      || !Array.isArray(c.Mounts) || typeof c.State?.Status !== "string" || typeof c.State.Running !== "boolean") throw new Error(`容器 ${reference} 的身份或状态无法核对`);
    const data = c.Mounts.filter((mount: any) => mount?.Destination === "/app/data");
    return { id: c.Id, name: c.Name.replace(/^\//, ""), image: c.Image, user: c.Config.User, status: c.State.Status, running: c.State.Running,
      data: data.length === 1 && data[0].Type === "bind" && typeof data[0].Source === "string" ? data[0].Source : null };
  }
  /** The bind source is what the container was created with; only its resolved path tells whether it is this project. */
  dataOwned(facts: ContainerFacts): boolean {
    if (!facts.data) return false;
    try { return resolvedPath(facts.data) === this.data; } catch { return false; }
  }
  async stop(id: string): Promise<void> { done(await this.docker.probe(["container", "stop", "--time", "30", id], 90_000), "停止容器"); }
  async start(id: string): Promise<void> { done(await this.docker.probe(["container", "start", id], 60_000), "启动容器"); }
  async rename(id: string, name: string): Promise<void> { done(await this.docker.probe(["container", "rename", id, name]), `容器改名为 ${name} `); }
  /** Diagnostics only: a container that failed verification reports why before the rollback renames it. */
  async showLogs(id: string): Promise<void> {
    try {
      const result = await this.docker.probe(["logs", "--tail", "50", id]);
      this.output(result.stdout + result.stderr, "stderr");
    } catch { /* The failure itself is already reported. */ }
  }

  private async image(reference: string): Promise<{ id: string; os: string; architecture: string; labels: Record<string, string>; env: unknown[] } | null> {
    const result = await this.docker.probe(["image", "inspect", reference]);
    if (result.code !== 0) {
      if (/No such (image|object)/i.test(result.stderr)) return null;
      throw new Error(`无法读取镜像 ${reference}：${result.stderr.trim() || "退出码 " + result.code}`);
    }
    const list = parsed(result.stdout, "镜像信息"), i = Array.isArray(list) && list.length === 1 ? list[0] : null;
    if (!i || !/^sha256:[0-9a-f]{64}$/.test(i.Id)) throw new Error(`镜像 ${reference} 的身份无法核对`);
    return { id: i.Id, os: String(i.Os), architecture: String(i.Architecture), labels: i.Config?.Labels ?? {}, env: Array.isArray(i.Config?.Env) ? i.Config.Env : [] };
  }
  /** The build the image's service reports on /health (Dockerfile: ENV APP_BUILD); empty for a build without a commit. */
  async imageBuild(reference: string): Promise<string> {
    const entry = (await this.image(reference))?.env.find(value => typeof value === "string" && value.startsWith("APP_BUILD=")) as string | undefined;
    return entry?.slice("APP_BUILD=".length) ?? "";
  }
  /** Same daemon, present by ID, built for this daemon's platform, this project and operation. Only "moved" still runs: execution always uses the recorded ID. */
  async verifyCandidate(record: CandidateRecord): Promise<"ok" | "moved" | "missing"> {
    if (this.docker.daemon !== record.daemon_id) throw new MaintenanceRefused("Docker daemon 与开始事务时不同：拒绝继续和自动回滚，不操作另一个 Docker 上的同名容器；请回到原来的 Docker 后重试");
    const image = await this.image(record.image_id);
    if (image?.id !== record.image_id) return "missing";
    const version = await this.docker.probe(["version", "--format", "{{json .Server.Arch}}"]);
    done(version, "读取 Docker daemon 架构");
    const arch = parsed(version.stdout, "架构信息"), labels = image.labels;
    if (image.os !== "linux" || image.architecture !== arch || labels[LABEL_REVISION] !== record.target_sha || labels[LABEL_PROJECT] !== record.project_id
      || labels[LABEL_OPERATION] !== record.operation_id || labels[LABEL_SOURCE] !== record.source)
      throw new MaintenanceRefused(`镜像 ${record.image_id} 不是本次构建的候选镜像（平台 ${image.os}/${image.architecture}，提交 ${labels[LABEL_REVISION] || "无"}，操作 ${labels[LABEL_OPERATION] || "无"}）`);
    return (await this.image(record.image_tag))?.id === record.image_id ? "ok" : "moved";
  }
  /** Points a reference at an image and checks the result. */
  async tag(image: string, reference: string): Promise<void> {
    done(await this.docker.probe(["image", "tag", image, reference]), `把 ${reference} 指向 ${image} `);
    const current = (await this.image(reference))?.id;
    if (current !== image) throw new Error(`${reference} 没有指向 ${image}（当前 ${current ?? "不存在"}）`);
  }
  /** Removes only this reference while it still names the expected image; a tag moved elsewhere is kept and reported. */
  async releaseCandidate(record: CandidateRecord): Promise<void> {
    const current = (await this.image(record.image_tag))?.id;
    if (!current) return;
    if (current !== record.image_id) throw new Error(`保留标签 ${record.image_tag} 已指向其他镜像（${current}），不移除`);
    done(await this.docker.probe(["image", "rm", "--force", record.image_tag]), `移除保留标签 ${record.image_tag} `);
  }
  /** The rollback tag holds the old image only during the transaction; afterwards the image goes with its last reference. */
  async releasePrevious(): Promise<void> {
    if (!await this.image(PREVIOUS_IMAGE_TAG)) return;
    done(await this.docker.probe(["image", "rm", PREVIOUS_IMAGE_TAG]), `移除回滚标签 ${PREVIOUS_IMAGE_TAG} `);
  }

  /** Created, not started: the same container runs verification, then the service once the data is committed. */
  async createService(options: ServiceContainerOptions): Promise<void> {
    const backup = resolve(this.project, "backup"), logs = resolve(this.project, "logs");
    if ([this.data, backup, logs, options.socket, options.workspace].some(path => /[,\x00-\x1f]/.test(path))) throw new Error("数据目录不能包含 Docker --mount 无法表达的字符");
    const result = await this.docker.probe(["container", "create", "--init", "--user", options.user,
      "--env", "DOCKER_HOST=unix:///run/mixin-task/docker.sock", "--env", "MIXIN_TASK_DEPLOYMENT=/app/data/config/task-deployment.json",
      "--mount", `type=bind,src=${options.socket},dst=/run/mixin-task/docker.sock`,
      // A rootless host network is its own namespace: publish on the host's loopback and bind every interface inside.
      ...(this.docker.rootless ? ["--publish", `127.0.0.1:${options.port}:${options.port}`, "--env", "BOT_CONTAINER_BIND_ALL=1"] : ["--network", "host"]),
      "--env", "HOME=/app/data/runtime/home", "--env", `BOT_PORT=${options.port}`, "--env", "BOT_HOST=127.0.0.1",
      ...(options.workspace ? ["--mount", `type=bind,src=${options.workspace},dst=/app/workspace,readonly`, "--env", "WORKSPACE_ROOT=/app/workspace"] : []),
      "--mount", `type=bind,src=${logs},dst=/app/logs`, "--mount", `type=bind,src=${this.data},dst=/app/data`, "--mount", `type=bind,src=${backup},dst=/app/backup`,
      "--restart", "unless-stopped", "--stop-timeout", "30", "--name", SERVICE_CONTAINER, "--memory", "512m", "--memory-swap", "768m", "--cpus", "1.0",
      "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp:size=64m", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
      "--log-driver", "json-file", "--log-opt", "max-size=5m", "--log-opt", "max-file=2", options.image], 60_000);
    done(result, "创建验证实例");
  }

  /** Same boundary rule as the service start, in host path space: the service only sees /app/workspace. Read-only, no network. */
  async layoutCheck(image: string, user: string, hostWorkspace: string): Promise<void> {
    const project = realpathSync(this.project), backup = resolvedPath(join(this.project, "backup")), logs = resolvedPath(join(this.project, "logs"));
    const workspace = hostWorkspace ? realpathSync(hostWorkspace) : join(this.data, "workspace");
    const mounts = [...new Set([this.data, backup, logs, workspace])].filter(path => existsSync(path)).flatMap(path => ["--mount", `type=bind,source=${path},target=${path},readonly`]);
    const result = await this.docker.probe(["run", "--rm", "--network", "none", "--user", user, "--read-only", "--tmpfs", "/tmp:size=8m", "--env", "HOME=/tmp", "--workdir", "/app",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", ...mounts, image, "bun", "ops/tools/layout-check.ts",
      "--project", project, "--data", this.data, "--backup", backup, "--logs", logs, "--workspace", workspace], 120_000);
    done(result, "核对共享资料目录的边界");
  }

  serviceDirectories(paths: readonly string[], owner?: Owner): void { serviceDirectories(this.project, paths, owner); }

  /** The service identity appends to this operation's log and starts its own diagnostics: only these two levels and the log change owner. */
  operationLogAccess(log: string | undefined, owner?: { uid: number; gid: number }): void {
    if (!owner) return;
    for (const relative of ["logs", "logs/operations", ...(log ? [`logs/operations/${log}`] : [])]) {
      const path = join(this.project, relative);
      if (existsSync(path) && !lstatSync(path).isSymbolicLink()) lchownSync(path, owner.uid, owner.gid);
    }
  }

  async captureFiles(snapshot: string, run: NativeRunner): Promise<void> { await captureFiles(this.project, snapshot, DEPLOY_FILES, run, GNU); }
  async restoreFiles(snapshot: string, name: string, run: NativeRunner): Promise<void> { await restoreFiles(this.project, snapshot, name, DEPLOY_FILES, run, GNU); }
  removeCompleted(name: string): void { removeCompleted(this.project, name); }

  async taskDaemon(record: TaskRuntimeRecord, uid: number): Promise<void> {
    const result = await this.docker.taskProbe(record.endpoint, uid, ["info", "--format", "{{json .}}"]);
    done(result, "读取任务 daemon");
    const info = parsed(result.stdout, "任务 daemon 信息");
    if (!Array.isArray(info?.SecurityOptions) || !info.SecurityOptions.includes("name=rootless")) throw new Error("任务 daemon 没有报告 rootless 隔离能力");
    if (info.ID !== record.daemon) throw new Error("任务 daemon 与部署记录不同；保留旧回执，拒绝切换 daemon");
  }
  async taskHasImage(record: TaskRuntimeRecord, uid: number, image: string): Promise<boolean> {
    const result = await this.docker.taskProbe(record.endpoint, uid, ["image", "inspect", "--format", "{{.Id}}", image]);
    return result.code === 0 && result.stdout.trim() === image;
  }

  /** A stopped or renamed container can still accept a queued start: retire the recorded immutable ID before business work resumes. */
  async retirePrevious(cid: string, previousImage: string): Promise<void> {
    if (!cid) return;
    const facts = await this.container(cid);
    if (!facts) return;
    if (facts.id !== cid || facts.image !== previousImage || !this.dataOwned(facts)) throw new Error("旧容器的固定身份、镜像或数据挂载与事务不符");
    done(await this.docker.probe(["container", "rm", "--force", cid], 90_000), "撤销旧容器");
    if (await this.container(cid)) throw new Error("旧容器撤销未确认，拒绝启动业务实例");
  }

  /**
   * Reclaim this deployment's unreferenced copies on a separate task daemon, once activation has completed: before that the
   * previous image is needed for rollback even when no task uses it. No runtime GC, global prune or forced removal.
   */
  async cleanupTaskImages(record: TaskRuntimeRecord, uid: number, image: string): Promise<void> {
    await this.taskDaemon(record, uid);
    // The shared daemon already follows the service's tag lifecycle.
    if (this.docker.daemon === record.daemon) return;
    const project = candidateProjectId(this.project), probe = (args: string[]) => this.docker.taskProbe(record.endpoint, uid, args);
    const facts = (id: string, extra: string) => probe(["image", "inspect", "--format", `{{.Id}}|{{index .Config.Labels "${LABEL_PROJECT}"}}${extra}`, id]);
    const current = await facts(image, "");
    done(current, "读取任务镜像");
    if (current.stdout.trim() !== `${image}|${project}`) throw new Error("无法确认当前任务镜像及其项目归属，保留其他镜像");
    const listed = await probe(["image", "ls", "--all", "--quiet", "--no-trunc", "--filter", `label=${LABEL_PROJECT}=${project}`]);
    done(listed, "列出任务镜像");
    let failed = false;
    for (const id of listed.stdout.split("\n").map(line => line.trim()).filter(Boolean)) {
      if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error("任务镜像清单无效");
      if (id === image) continue;
      const row = await facts(id, "|{{len .RepoTags}}|{{len .RepoDigests}}");
      done(row, "读取任务镜像");
      // Recheck immutable ownership and leave any explicitly named or pinned image alone.
      if (row.stdout.trim() !== `${id}|${project}|0|0`) continue;
      // Includes stopped containers; ancestor also keeps images used by descendants.
      const used = await probe(["ps", "--all", "--quiet", "--no-trunc", "--filter", `ancestor=${id}`]);
      done(used, "检查任务镜像的引用");
      if (used.stdout.trim()) continue;
      // Docker rejects a concurrent container reference. --no-prune keeps unrelated parent layers.
      if ((await probe(["image", "rm", "--no-prune", id])).code !== 0) failed = true;
    }
    if (failed) throw new Error("任务镜像清理未完成，保留后重试");
  }
}
