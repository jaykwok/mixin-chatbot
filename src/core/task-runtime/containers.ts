// The task daemon: identity checks, the deployment mapping probe, and creating, inspecting and retiring a receipt's
// containers. Every container is checked against the receipt (labels, nonce, isolation flags, exact mounts) before it
// is trusted; a missing answer is never taken as a removal.
import { lstat } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Receipt, TaskMount } from "../../contracts/task-receipt.ts";
import { holdDirectory } from "../held-directory.ts";
import type { TaskPaths } from "../task-deployment.ts";
import { workPath } from "./entities.ts";

export interface DriverOptions { signal?: AbortSignal; timeoutMs?: number; onData?: (data: Buffer) => void }
export interface TaskDriver {
  run(args: string[], options?: DriverOptions): Promise<{ exitCode: number; output: string }>;
}

function mount(source: string, target: string, readonly: boolean): string {
  if (/[\n\r,]/.test(source + target)) throw new Error("容器挂载路径包含不支持的控制字符或逗号");
  return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}

/** `--mount` values for a worker's bindings; throws on a path the CLI syntax cannot carry. */
export const mountArguments = (bindings: readonly TaskMount[]) => bindings.map(value => mount(value.source, value.target, !value.writable));

const absent = (output: string, cid: string) => output.includes(`No such container: ${cid}`) || output.includes(`No such object: ${cid}`);

export class TaskContainers {
  /** `localSocket`: the production driver talks to the local CLI, whose endpoint must be this identity's own socket. */
  constructor(private readonly driver: TaskDriver, readonly image: string, private readonly paths: TaskPaths | undefined,
    private readonly localSocket: boolean) {}

  /** The daemon's name for a control-plane path. */
  source(path: string) { return this.paths?.source(path) ?? path; }

  async must(args: string[], options?: DriverOptions) {
    const result = await this.driver.run(args, options);
    if (result.exitCode !== 0) throw new Error(`任务容器操作失败 (${result.exitCode}): ${result.output.slice(-4096)}`);
    return result.output.trim();
  }

  async checkDaemon(): Promise<string> {
    if (this.localSocket) {
      const endpoint = process.env.DOCKER_HOST ?? JSON.parse(await this.must(["context", "inspect"]))[0]?.Endpoints?.docker?.Host;
      if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) throw new Error("任务 daemon 必须使用本机 rootless Unix socket");
      const socket = await lstat(endpoint.slice(7));
      if (!socket.isSocket() || socket.uid !== process.getuid!()) throw new Error("任务 socket 必须属于当前管理身份");
    }
    const facts = JSON.parse(await this.must(["info", "--format", "{{json .}}"]));
    if (!facts.ID || !Array.isArray(facts.SecurityOptions) || !facts.SecurityOptions.includes("name=rootless")) throw new Error("任务隔离要求已启用的 rootless Docker daemon");
    const image = JSON.parse(await this.must(["image", "inspect", this.image]));
    if (image.length !== 1 || image[0].Id !== this.image || image[0].Os !== "linux") throw new Error("任务镜像身份不匹配");
    return facts.ID;
  }

  /** A string mapping alone cannot prove both views name the same storage: a worker reads back a fresh nonce. */
  async verifyMappings(): Promise<void> {
    for (const root of this.paths!.roots) {
      const held = await holdDirectory(root, [], false);
      try {
        await held.use(async entries => {
          const name = ".task-mapping-" + randomUUID(), probe = await entries.create(name), nonce = randomBytes(32).toString("hex");
          try {
            await probe.handle.writeFile(nonce); await probe.handle.sync();
            const actual = await this.must(["run", "--rm", "--pull", "never", "--no-healthcheck", "--read-only", "--network", "none",
              "--ipc", "private", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0", "--pids-limit", "32", "--memory", "128m",
              "--mount", mount(this.source(join(root, name)), "/mapping-proof", true), "--entrypoint", "/usr/local/bin/bun", this.image,
              "-e", "process.stdout.write(require('fs').readFileSync('/mapping-proof','utf8'))"]);
            if (actual !== nonce) throw new Error("控制面与任务 daemon 的目录映射不指向同一实体：" + root);
          } finally { await probe.close(true); }
        });
      } finally { await held.release(); }
    }
  }

  /** The container exactly as the receipt registered it, or an error. */
  async inspect(receipt: Receipt, cid: string) {
    const result = await this.driver.run(["container", "inspect", cid]);
    if (result.exitCode !== 0) throw new Error(`无法证明容器 ${cid} 已回收；保留任务 ${receipt.id}`);
    const containers = JSON.parse(result.output), container = containers[0];
    if (containers.length !== 1 || container.Id !== cid || container.Image !== receipt.image || container.Config?.Labels?.["org.mixin-chatbot.task"] !== receipt.id
      || container.Config?.Labels?.["org.mixin-chatbot.manager"] !== receipt.manager || container.Config?.Labels?.["org.mixin-chatbot.nonce"] !== receipt.nonce) throw new Error("容器与管理回执不匹配");
    const work = workPath(receipt);
    const writable = container.Mounts.filter((mount: { RW: boolean; Type: string }) => mount.RW && mount.Type !== "tmpfs");
    const expected = receipt.mounts[cid];
    const binds = container.Mounts.filter((value: { Type: string }) => value.Type !== "tmpfs");
    if (container.HostConfig.Privileged || !["", "private"].includes(container.HostConfig.PidMode) || container.HostConfig.IpcMode !== "private"
      || container.HostConfig.NetworkMode !== "none" || !container.HostConfig.ReadonlyRootfs || !container.HostConfig.CapDrop?.includes("ALL")
      || !container.HostConfig.SecurityOpt?.includes("no-new-privileges") || writable.length !== 1 || writable[0].Source !== this.source(work) || writable[0].Destination !== work
      || !expected || binds.length !== expected.length || binds.some((value: { Type: string; Source: string; Destination: string; RW: boolean }) => value.Type !== "bind" || !expected.some(item => item.source === value.Source && item.target === value.Destination && item.writable === value.RW))) throw new Error("容器权限或挂载边界变化，拒绝授予回收权限");
    return container;
  }

  /** Unanswered creates may still complete in the daemon; a missing name is not an acknowledgement. Each name must
   * resolve to a registered container, which joins the receipt's CIDs (the caller then clears the names). */
  async resolvePending(receipt: Receipt): Promise<void> {
    for (const name of receipt.pendingNames) {
      const output = await this.must(["container", "inspect", name], { timeoutMs: 15_000 });
      const cid = JSON.parse(output)[0]?.Id;
      if (!/^[a-f\d]{64}$/.test(cid)) throw new Error("未完成的容器创建身份不明，保留任务");
      receipt.mounts[cid] ??= receipt.mounts[name]!;
      await this.inspect(receipt, cid);
      if (!receipt.containers.includes(cid)) receipt.containers.push(cid);
    }
  }

  /** Kill, wait and remove every registered CID, each confirmed absent afterwards. Cleanup has its own finite budget
   * and ignores the caller's cancelled signal. */
  async retireAll(receipt: Receipt): Promise<void> {
    for (const cid of receipt.containers) {
      const existing = await this.driver.run(["container", "inspect", cid], { timeoutMs: 15_000 });
      // A known immutable CID cannot be created later, unlike an unanswered create name.
      // This also recovers a removal whose acknowledgement was lost before saving the phase.
      if (existing.exitCode !== 0) {
        if (absent(existing.output, cid)) continue;
        throw new Error("容器撤销查询失败或 daemon 不可用，保留回执");
      }
      const container = await this.inspect(receipt, cid);
      if (container.State.Running) await this.must(["container", "kill", cid], { timeoutMs: 15_000 });
      await this.must(["container", "wait", cid], { timeoutMs: 15_000 });
      if ((await this.inspect(receipt, cid)).State.Running) throw new Error("容器仍有写者，保留任务");
      // CLI exit / not-running is only a snapshot: an accepted start may complete later.
      // Retire the registered CID before any scratch or work deletion, fencing queued starts.
      await this.must(["container", "rm", cid, "--force"], { timeoutMs: 15_000 });
      const after = await this.driver.run(["container", "inspect", cid], { timeoutMs: 15_000 });
      if (after.exitCode === 0 || !absent(after.output, cid)) throw new Error("容器撤销未确认或 daemon 不可用，保留回执与工作目录");
    }
  }

  /** Create a worker named `name` (already saved as pending) with `mountArguments` of its saved bindings. Returns its CID. */
  async create(receipt: Receipt, name: string, mounts: readonly string[], run: { cwd: string; command: string; args: string[] },
    env: [string, string | undefined][]): Promise<string> {
    const args = ["create", "--name", name, "--pull", "never", "--no-healthcheck", "--read-only", "--network", "none", "--ipc", "private", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "128", "--memory", "1g", "--cpus", "2", "--user", "0:0", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777", "--workdir", run.cwd,
      "--label", `org.mixin-chatbot.task=${receipt.id}`, "--label", `org.mixin-chatbot.manager=${receipt.manager}`, "--label", `org.mixin-chatbot.nonce=${receipt.nonce}`,
      ...mounts.flatMap(value => ["--mount", value]), ...env.flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--entrypoint", run.command, this.image, ...run.args];
    const cid = await this.must(args, { timeoutMs: 30_000 });
    if (!/^[a-f\d]{64}$/.test(cid)) throw new Error("容器创建未返回固定身份，保留任务");
    return cid;
  }

  /** Run a created worker to completion, then make sure it has stopped whatever the outcome of the attached start. */
  async runToEnd(receipt: Receipt, cid: string, options: DriverOptions): Promise<{ exitCode: number; output: string }> {
    let error: unknown, result: { exitCode: number; output: string } | undefined;
    try { result = await this.driver.run(["start", "--attach", cid], options); }
    catch (cause) { error = cause; }
    try {
      const container = await this.inspect(receipt, cid);
      if (container.State.Running) await this.must(["container", "kill", cid], { timeoutMs: 15_000 });
      await this.must(["container", "wait", cid], { timeoutMs: 15_000 });
      if ((await this.inspect(receipt, cid)).State.Running) throw new Error("任务进程尚未回收");
    } catch (cause) { throw new AggregateError([...(error ? [error] : []), cause], "任务回收失败，保留回执", { cause: error }); }
    if (error) throw error;
    return result!;
  }
}
