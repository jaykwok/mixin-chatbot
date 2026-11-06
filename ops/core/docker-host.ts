import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { runNative, type NativeRunner, type NativeResult, type NativeOutput } from "./native-process.ts";
import { taskCommandDigest, taskInput, taskName, type DockerTaskDriver, type DockerTaskFacts } from "./docker-task.ts";
import type { DockerTaskRecord } from "../../src/contracts/ops-writer.ts";
import { validOpsDeploymentTask } from "../../src/contracts/ops-deployment-task.ts";
import { readDockerDataAccess } from "./docker-access.ts";
import { validateDockerDataAccess, type DockerDataAccess } from "../../src/contracts/ops-task-access.ts";
import { validateOpsTaskInput } from "../../src/contracts/ops-task-input.ts";
import { codeDigest } from "./source-runtime.ts";
import { runtimeEnvironment, runtimeEnvironmentDigest } from "./runtime-environment.ts";
import { validateOpsReports } from "../../src/contracts/ops-reports.ts";
import { checkReports, reportsPath } from "./reports.ts";
import { validOpsNetwork } from "../../src/contracts/ops-network.ts";
import { deploymentDataPath } from "./deployment-data.ts";

interface HostAccess {
  uid: number;
  env: NodeJS.ProcessEnv;
  socket(path: string): { uid: number; socket: boolean; link: boolean };
  data(project: string): string;
}
const actualAccess = (): HostAccess => ({ uid: process.geteuid?.() ?? -1, env: process.env,
  socket(path) { const stat = lstatSync(path); return { uid: stat.uid, socket: stat.isSocket(), link: stat.isSymbolicLink() }; },
  data: deploymentDataPath,
});
export interface DockerService {
  identity: string;
  owned: boolean;
  state: "running" | "stopped" | "absent" | "unsupported";
  rawState: string;
  container?: string;
  image?: string;
  user?: string;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const checked = (value: NativeResult) => {
  if (value.code !== 0) throw new Error(`Docker 查询或操作失败（退出码 ${value.code}），未假定容器不存在`);
  return value.stdout;
};
const json = (value: NativeResult): any => {
  try { return JSON.parse(checked(value)); } catch (error) {
    if (value.code !== 0) throw error;
    throw new Error("Docker 没有返回完整 JSON 结果");
  }
};

/** Pins the local daemon and uses immutable container IDs for effects. It never creates users or changes linger. */
export class DockerPlatform {
  private constructor(readonly project: string, readonly endpoint: string, readonly daemon: string, readonly rootless: boolean,
    private readonly run: NativeRunner, private readonly access: HostAccess) {}

  static async connect(project: string, run: NativeRunner = runNative, access = actualAccess()): Promise<DockerPlatform> {
    if (!Number.isSafeInteger(access.uid) || access.uid < 0) throw new Error("无法确定 Docker 运维身份");
    let endpoint = !access.env.DOCKER_CONTEXT && access.env.DOCKER_HOST;
    if (!endpoint) {
      const args = ["context", "inspect", ...(access.env.DOCKER_CONTEXT ? [access.env.DOCKER_CONTEXT] : [])];
      const values = json(await run({ command: "docker", args, cwd: project, env: access.env, protocol: true }));
      if (!Array.isArray(values) || values.length !== 1) throw new Error("无法确定当前 Docker context");
      endpoint = values[0]?.Endpoints?.docker?.Host;
    }
    if (typeof endpoint !== "string" || !/^unix:\/\/\/[^\x00-\x1f,]+$/.test(endpoint)) throw new Error("维护只支持当前身份的本机 Docker Unix socket");
    const provisional = new DockerPlatform(resolve(project), endpoint, "", access.uid !== 0, run, access);
    const info = await provisional.daemonInfo();
    return new DockerPlatform(resolve(project), endpoint, info.ID, info.rootless, run, access);
  }

  private async command(args: string[], timeoutMs = 30_000, signal?: AbortSignal, protocol = true, output?: NativeOutput, input?: Uint8Array): Promise<NativeResult> {
    const socket = this.access.socket(this.endpoint.slice("unix://".length));
    if (!socket.socket || socket.link || socket.uid !== this.access.uid) throw new Error("Docker socket 不属于当前运维身份或已被替换");
    const env = { ...this.access.env };
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
    return this.run({ command: "docker", args: ["--host", this.endpoint, ...args], cwd: this.project, env, protocol, timeoutMs, signal, input }, output);
  }

  /** One pinned-daemon CLI call whose stderr the caller classifies (for example "No such container"). Never echoed. */
  async probe(args: string[], timeoutMs = 30_000): Promise<NativeResult & { stderr: string }> {
    let stderr = "";
    const result = await this.command(args, timeoutMs, undefined, true, (text, stream) => { if (stream === "stderr" && stderr.length < 64 * 1024) stderr += text; });
    return { ...result, stderr };
  }

  /** The same CLI against the service's separate task daemon, after its socket owner is rechecked. */
  async taskProbe(endpoint: string, uid: number, args: string[], timeoutMs = 30_000): Promise<NativeResult & { stderr: string }> {
    if (!/^unix:\/\/\/[^\x00-\x1f,]+$/.test(endpoint)) throw new Error("任务 daemon 地址无效");
    const socket = this.access.socket(endpoint.slice(7));
    if (!socket.socket || socket.link || socket.uid !== uid) throw new Error(`需要属于宿主 UID ${uid} 的本机 rootless Docker socket：${endpoint.slice(7)}`);
    const env = { ...this.access.env };
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
    let stderr = "";
    const result = await this.run({ command: "docker", args: ["--host", endpoint, ...args], cwd: this.project, env, protocol: true, timeoutMs },
      (text, stream) => { if (stream === "stderr" && stderr.length < 64 * 1024) stderr += text; });
    return { ...result, stderr };
  }

  /** realpath of the project's data directory, the only accepted /app/data bind source. */
  dataPath(): string { return this.access.data(this.project); }

  private async daemonInfo(): Promise<{ ID: string; rootless: boolean }> {
    const value = json(await this.command(["info", "--format", "{{json .}}"]));
    if (!value || typeof value.ID !== "string" || !/^[a-zA-Z0-9:._-]{1,128}$/.test(value.ID) || !Array.isArray(value.SecurityOptions)
      || value.SecurityOptions.some((entry: unknown) => typeof entry !== "string")) throw new Error("Docker daemon 身份不完整");
    const rootless = value.SecurityOptions.includes("name=rootless");
    if (rootless !== (this.access.uid !== 0)) throw new Error("Docker daemon 的 rootful/rootless 模式与运维身份不符");
    if (this.daemon && value.ID !== this.daemon) throw new Error("Docker daemon 身份已变化，未继续操作");
    return { ID: value.ID, rootless };
  }

  async inspect(): Promise<DockerService> {
    await this.daemonInfo();
    const ids = checked(await this.command(["container", "ls", "--all", "--no-trunc", "--filter", "name=^/mixin-bot$", "--format", "{{.ID}}"])).trim();
    if (!ids) return { identity: digest([this.daemon, this.project, "absent"]), state: "absent", rawState: "absent", owned: true };
    if (!/^[a-f0-9]{64}$/.test(ids)) throw new Error("机器人容器清单不唯一或无效");
    const list = json(await this.command(["container", "inspect", ids]));
    if (!Array.isArray(list) || list.length !== 1) throw new Error("容器状态不完整");
    const c = list[0];
    if (c?.Id !== ids || c.Name !== "/mixin-bot" || !/^sha256:[a-f0-9]{64}$/.test(c.Image)
      || typeof c.Config?.User !== "string" || !/^\d+(?::\d+)?$/.test(c.Config.User) || !Array.isArray(c.Mounts)
      || typeof c.State?.Status !== "string" || typeof c.State.Running !== "boolean") throw new Error("机器人容器身份或状态无法核对");
    const data = c.Mounts.filter((mount: any) => mount?.Destination === "/app/data");
    const owned = data.length === 1 && data[0].Type === "bind" && data[0].RW === true && data[0].Source === this.access.data(this.project);
    const state = c.State.Status === "running" && c.State.Running && !c.State.Paused && !c.State.Restarting ? "running"
      : ["exited", "created"].includes(c.State.Status) && !c.State.Running ? "stopped" : "unsupported";
    return { identity: digest([this.daemon, c.Id, c.Image, c.Config.User]), owned, state, rawState: c.State.Status,
      container: c.Id, image: c.Image, user: c.Config.User };
  }

  private async change(action: "start" | "stop", expected: string): Promise<void> {
    const facts = await this.inspect();
    if (!facts.owned || facts.identity !== expected || (facts.state === "unsupported" && action !== "stop")) throw new Error("部署身份已变化或状态不支持，未操作容器");
    if (!facts.container) { if (action === "stop") return; throw new Error("机器人容器不存在，请先部署"); }
    checked(await this.command(["container", action, facts.container], action === "stop" ? 90_000 : 30_000));
  }
  async start(identity: string): Promise<void> { await this.change("start", identity); }
  async stop(identity: string): Promise<void> { await this.change("stop", identity); }

  /** Resolve the task backend before stopping the bot; no network daemon or account is installed or changed. */
  async dataAccess(expected: string): Promise<DockerDataAccess> {
    const facts = await this.inspect();
    if (!facts.owned || facts.identity !== expected || !facts.container) throw new Error("附加访问的部署身份已变化");
    const values = json(await this.command(["container", "inspect", facts.container]));
    if (!Array.isArray(values) || values.length !== 1 || values[0]?.Id !== facts.container || !Array.isArray(values[0].Mounts)
      || !Array.isArray(values[0].Config?.Env)) throw new Error("无法核对服务的数据访问环境");
    const access = readDockerDataAccess(this.project, { user: facts.user!, image: facts.image!, mounts: values[0].Mounts,
      env: values[0].Config.Env }, this.access.uid, this.rootless, undefined, this.access.data(this.project));
    await this.checkTaskAccess(access); return access;
  }

  private async checkTaskAccess(access?: DockerDataAccess): Promise<void> {
    if (!access) return;
    validateDockerDataAccess(access);
    if (!access.tasks) return;
    const { endpoint, daemon, uid } = access.tasks, socket = this.access.socket(endpoint.slice(7));
    if (!socket.socket || socket.link || socket.uid !== uid) throw new Error("任务 socket 不属于原服务身份");
    const env = { ...this.access.env };
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
    const info = json(await this.run({ command: "docker", args: ["--host", endpoint, "info", "--format", "{{json .}}"],
      cwd: this.project, env, protocol: true, timeoutMs: 30_000 }));
    if (info?.ID !== daemon || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.includes("name=rootless"))
      throw new Error("任务 daemon 的身份或 rootless 模式与部署记录不符");
  }

  async runtimeEnvironment(expected: string): Promise<string[]> {
    const facts = await this.inspect();
    if (!facts.owned || facts.identity !== expected || !facts.container) throw new Error("运行参数预检的实例身份已变化");
    const values = json(await this.command(["container", "inspect", facts.container]));
    if (!Array.isArray(values) || values.length !== 1 || values[0]?.Id !== facts.container) throw new Error("容器环境来源不符");
    return runtimeEnvironment(values[0].Config?.Env);
  }

  /** Daemon-side supervision for offline data commands. This never uses --rm or a mutable image tag. */
  taskDriver(timeoutMs = 60 * 60_000, protocol = true, output?: NativeOutput, input?: Uint8Array, environment?: string[]): DockerTaskDriver {
    const payload = input === undefined ? undefined : Buffer.from(input), payloadInfo = payload === undefined ? undefined : taskInput(payload);
    const envValues = environment === undefined ? undefined : runtimeEnvironment(environment), envDigest = envValues === undefined ? undefined : runtimeEnvironmentDigest(envValues);
    const matchInput = (record: DockerTaskRecord) => {
      if (!!record.input !== !!payloadInfo || record.input && (record.input.bytes !== payloadInfo!.bytes || record.input.digest !== payloadInfo!.digest))
        throw new Error("维护输入与记录不符，未启动数据步骤");
      if (record.runtimeEnvironment !== envDigest) throw new Error("运行参数环境与记录不符");
    };
    const validate = async (record: DockerTaskRecord) => {
      if (Object.hasOwn(record, "access")) validateDockerDataAccess(record.access);
      if (Object.hasOwn(record, "input")) validateOpsTaskInput(record.input);
      if (Object.hasOwn(record, "reports")) validateOpsReports(record.reports);
      if (Object.hasOwn(record, "deployment") && !validOpsDeploymentTask(record.deployment)) throw new Error("部署数据步骤记录无效");
      if (record.runtime !== undefined && !/^[a-f0-9]{64}$/.test(record.runtime)) throw new Error("维护运行包记录无效");
      if (record.runtimeEnvironment !== undefined && !/^[a-f0-9]{64}$/.test(record.runtimeEnvironment)) throw new Error("运行参数环境记录无效");
      if (record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.id) || record.daemon !== this.daemon || record.endpoint !== this.endpoint
        || !/^sha256:[a-f0-9]{64}$/.test(record.image) || !/^\d+(?::\d+)?$/.test(record.user)
        || !/^[a-f0-9]{64}$/.test(record.commandDigest) || !validOpsNetwork(record.network)
        || (record.container !== undefined && !/^[a-f0-9]{64}$/.test(record.container))
        || record.data !== this.access.data(this.project) || record.backup !== resolve(this.project, "backup")) throw new Error("维护容器记录不属于当前部署");
      await this.daemonInfo();
    };
    const runtimeRoot = (record: DockerTaskRecord) => resolve(this.project, ".console/runtime/source-" + record.runtime);
    const checkCode = (record: DockerTaskRecord) => {
      if (record.runtime && codeDigest(runtimeRoot(record)) !== record.runtime) throw new Error("维护运行包摘要不符");
    };
    const checkNetwork = async (record: DockerTaskRecord) => {
      if (!record.network.startsWith("container:")) return;
      const service = await this.inspect();
      if (!service.owned || service.state !== "running" || record.network !== "container:" + service.container
        || service.image !== record.image || service.user !== record.user) throw new Error("外链测试的服务网络所属实例已变化或停止");
    };
    const inspect = async (record: DockerTaskRecord): Promise<DockerTaskFacts | null> => {
      await validate(record);
      const id = checked(await this.command(["container", "ls", "--all", "--no-trunc", "--filter", `name=^/${taskName(record)}$`, "--format", "{{.ID}}"])).trim();
      if (!id) return null;
      if (!/^[a-f0-9]{64}$/.test(id) || record.container && id !== record.container) throw new Error("维护容器名称对应的 ID 已变化");
      const list = json(await this.command(["container", "inspect", id]));
      if (!Array.isArray(list) || list.length !== 1) throw new Error("维护容器状态不完整");
      const c = list[0], mounts = c?.Mounts, config = c?.Config, host = c?.HostConfig, state = c?.State;
      const mount = (destination: string, source: string, writable = true) => mounts?.filter((m: any) => m.Destination === destination && m.Source === source && m.Type === "bind" && m.RW === writable).length === 1;
      const access = record.access, deployment = record.deployment, logs = resolve(this.project, "logs");
      const additional = Number(!!access?.workspace) + Number(!!access?.tasks) + (record.runtime ? 2 : 0) + Number(!!record.reports) + Number(!!deployment);
      const expectedEnv = [...(access?.workspace ? ["WORKSPACE_ROOT=/app/workspace"] : []),
        ...(access?.tasks ? ["DOCKER_HOST=unix:///run/mixin-task/docker.sock", "MIXIN_TASK_DEPLOYMENT=/app/data/config/task-deployment.json"] : []),
        ...(deployment?.log ? ["BOT_OPERATION_LOG=" + deployment.log] : [])];
      const accessEnv = Array.isArray(config?.Env) ? config.Env.filter((e: unknown) => typeof e === "string"
        && /^(WORKSPACE_ROOT|DOCKER_HOST|MIXIN_TASK_DEPLOYMENT|BOT_OPERATION_LOG)=/.test(e)) : [];
      if (c?.Id !== id || c.Name !== "/" + taskName(record) || c.Image !== record.image || config?.User !== record.user
        || config.OpenStdin !== !!record.input || config.StdinOnce !== !!record.input || config.Tty !== false
        || record.runtimeEnvironment && runtimeEnvironmentDigest(config.Env) !== record.runtimeEnvironment
        || config.Labels?.["org.mixin.maintenance.id"] !== record.id || config.Labels?.["org.mixin.maintenance.command"] !== record.commandDigest
        || JSON.stringify(config.Entrypoint) !== '["bun"]' || !Array.isArray(config.Cmd) || config.Cmd.some((arg: unknown) => typeof arg !== "string")
        || taskCommandDigest(config.Cmd) !== record.commandDigest || !Array.isArray(mounts) || mounts.filter((m: any) => m.Type !== "tmpfs").length !== 2 + additional
        || access?.workspace && !mount("/app/workspace", access.workspace, false) || access?.tasks && !mount("/run/mixin-task/docker.sock", access.tasks.endpoint.slice(7))
        || record.runtime && ["ops", "src"].some(tree => !mount("/app/" + tree, resolve(runtimeRoot(record), tree), false))
        || record.reports && !mount("/app/tmp/backup-cleanup", reportsPath(this.project))
        || deployment && !mount("/app/logs", logs)
        || JSON.stringify(accessEnv.sort()) !== JSON.stringify(expectedEnv.sort())
        || !mount("/app/data", record.data) || !mount("/app/backup", record.backup) || host?.Privileged !== false || host.ReadonlyRootfs !== true
        || host.NetworkMode !== record.network || host.RestartPolicy?.Name !== "no" || host.AutoRemove !== false
        || state?.Paused || state?.Restarting || !["created", "running", "exited"].includes(state?.Status)
        || typeof state.Running !== "boolean" || state.Running !== (state.Status === "running")
        || !Number.isInteger(state.ExitCode) || state.ExitCode < 0 || state.ExitCode > 255) throw new Error("维护容器身份、挂载或状态不符，保留记录，未操作该容器");
      return { id, state: state.Status, exitCode: state.ExitCode };
    };
    return {
      inspect,
      create: async (record, args) => {
        await validate(record);
        matchInput(record);
        checkCode(record);
        if (record.reports) checkReports(this.project, record.reports);
        await checkNetwork(record);
        await this.checkTaskAccess(record.access);
        if (taskCommandDigest(args) !== record.commandDigest) throw new Error("维护命令摘要不符");
        // --mount refuses missing directories; it must not silently create a host path with the daemon's identity.
        const logs = resolve(this.project, "logs");
        if ([record.data, record.backup, ...(record.deployment ? [logs] : [])].some(path => /[,\x00-\x1f]/.test(path))) throw new Error("数据目录不能包含 Docker --mount 无法表达的字符");
        const extra = [...(record.access?.workspace ? ["--mount", `type=bind,src=${record.access.workspace},dst=/app/workspace,readonly`, "--env", "WORKSPACE_ROOT=/app/workspace"] : []),
          ...(record.access?.tasks ? ["--mount", `type=bind,src=${record.access.tasks.endpoint.slice(7)},dst=/run/mixin-task/docker.sock`,
            "--env", "DOCKER_HOST=unix:///run/mixin-task/docker.sock", "--env", "MIXIN_TASK_DEPLOYMENT=/app/data/config/task-deployment.json"] : []),
          ...(record.deployment ? ["--mount", `type=bind,src=${logs},dst=/app/logs`,
            ...(record.deployment.log ? ["--env", "BOT_OPERATION_LOG=" + record.deployment.log] : [])] : [])];
        const value = checked(await this.command(["container", "create", "--name", taskName(record),
          "--label", `org.mixin.maintenance.id=${record.id}`, "--label", `org.mixin.maintenance.command=${record.commandDigest}`,
          "--user", record.user, "--network", record.network, "--restart", "no", "--read-only", "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges", "--log-driver", "none", "--tmpfs", "/tmp:rw,nosuid,size=64m",
          "--mount", `type=bind,src=${record.data},dst=/app/data`, "--mount", `type=bind,src=${record.backup},dst=/app/backup`,
          ...extra, ...(record.runtime ? ["ops", "src"].flatMap(tree => ["--mount", `type=bind,src=${resolve(runtimeRoot(record), tree)},dst=/app/${tree},readonly`]) : []),
          ...(record.reports ? ["--mount", `type=bind,src=${reportsPath(this.project)},dst=/app/tmp/backup-cleanup`] : []),
          ...(record.input ? ["--interactive", "--attach", "stdin", "--attach", "stdout", "--attach", "stderr"] : []),
          ...(envValues ?? []).flatMap(value => ["--env", value]),
          "--env", "HOME=/app/data/runtime/home", "--workdir", "/app", "--entrypoint", "bun", record.image, ...args])).trim();
        if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Docker 未返回有效的维护容器 ID");
        return value;
      },
      attach: async (record, signal) => {
        matchInput(record);
        checkCode(record);
        if (record.reports) checkReports(this.project, record.reports);
        await checkNetwork(record);
        const before = await inspect(record);
        if (!before || before.state !== "created") throw new Error("只有核对过的新维护容器可以启动");
        await this.checkTaskAccess(record.access);
        // Docker owns the writer. runNative only reaps the attach client; runDockerTask separately reaps the container.
        return this.command(["container", "start", "--attach", ...(record.input ? ["--interactive"] : []), before.id], timeoutMs, signal, protocol, output, payload);
      },
      reap: async record => {
        let facts = await inspect(record);
        if (!facts) return;
        if (facts.state === "running") {
          checked(await this.command(["container", "stop", "--time", "10", facts.id], 30_000));
          facts = await inspect(record);
          if (!facts) return;
          if (facts.state === "running") throw new Error("维护容器仍在写入，未报告回收完成");
        }
        // Removing a created container also closes an uncertain in-flight start request. Docker serializes removal
        // against start. A start that won the race makes rm fail, retaining the blocker for an explicit retry.
        checked(await this.command(["container", "rm", facts.id]));
        if (await inspect(record)) throw new Error("维护容器移除后仍然存在");
      },
    };
  }
}
