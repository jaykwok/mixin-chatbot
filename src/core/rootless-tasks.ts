import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeProcess, type ProcessOptions } from "../../scripts/lib/process.ts";
import { publishJson } from "../../scripts/migrations/lib/io.ts";
import { holdDirectory, type DirectoryRemoval } from "./held-directory.ts";
import { RemovalPermit } from "./reclamation.ts";
import { application, KeyedQueue } from "./lifecycle.ts";
import { runtimeSetting } from "./runtime-config.ts";
import { isPathInside } from "../agent/paths.ts";

const nativeDriver: TaskDriver = {
  run: (args, options) => executeProcess({ command: "docker", args, cwd: process.cwd(), timeoutMs: options?.timeoutMs ?? 30_000, ...options,
    env: Object.fromEntries(["HOME", "USER", "PATH", "DOCKER_HOST", "XDG_RUNTIME_DIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) }),
};

const idPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const imagePattern = /^sha256:[a-f\d]{64}$/;
const phases = ["allocating", "allocation-failed", "active", "stopping", "writers-reaped", "reclaiming", "removed"] as const;
const allocationSteps = ["reserved", "entity-registered", "marker-written", "work-created"] as const;
type Phase = typeof phases[number];
interface Receipt {
  version: 2; id: string; nonce: string; manager: string; daemon: string; image: string;
  temp: string; createdAt: number; pid: number; phase: Phase; containers: string[];
  pendingNames: string[];
  role?: "worker" | "results";
  allocation?: { step: typeof allocationSteps[number]; error?: string };
  mounts: Record<string, { source: string; target: string; writable: boolean }[]>;
  reclamation?: { attemptedAt: number; nextAttemptAt: number; reason?: string };
  parentIdentity?: { dev: string; ino: string }; identity?: { dev: string; ino: string };
}
export interface TaskDriver {
  run(args: string[], options?: Pick<ProcessOptions, "signal" | "timeoutMs" | "onData">): Promise<{ exitCode: number; output: string }>;
}
/** Explicit storage dependency for allocation fault regressions; production uses ordinary held I/O. */
export interface TaskStorage {
  holdDirectory(base: string, names: readonly string[], create: boolean): Promise<Pick<Awaited<ReturnType<typeof holdDirectory>>, "identity" | "use" | "release">>;
  saveReceipt(path: string, envelope: { payload: string; signature: string }, first: boolean): Promise<void>;
}
const nativeStorage: TaskStorage = {
  holdDirectory,
  async saveReceipt(path, envelope, first) {
    if (first) await writeFile(path, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
    else await publishJson(path, envelope);
  },
};
export interface IsolatedTask {
  readonly id: string; readonly path: string;
  run(options: ProcessOptions, readOnly?: readonly string[]): Promise<{ exitCode: number; output: string }>;
  seal(options?: { discardScratch: boolean }): Promise<void>;
}
export interface TaskReservation { readonly id: string; readonly path: string; create(): Promise<IsolatedTask> }

/** Rootless Docker is a control-plane dependency. Workers get neither its socket nor host PID/proc namespaces. */
export class RootlessTasks {
  #queue = new KeyedQueue();
  #ready: Promise<{ manager: string; key: Buffer; daemon: string }> | undefined;
  #allocationFailures = new Map<string, Receipt>();
  readonly root: string;
  constructor(root: string, readonly image: string, private readonly driver: TaskDriver = nativeDriver, private readonly storage: TaskStorage = nativeStorage) {
    this.root = resolve(root);
    if (process.platform !== "linux") throw new Error("隔离任务需要 Linux rootless Docker");
    if (!imagePattern.test(image)) throw new Error("任务镜像必须固定为完整 sha256 ID");
  }
  async #must(args: string[], options?: Pick<ProcessOptions, "signal" | "timeoutMs" | "onData">) {
    const result = await this.driver.run(args, options);
    if (result.exitCode !== 0) throw new Error(`任务容器操作失败 (${result.exitCode}): ${result.output.slice(-4096)}`);
    return result.output.trim();
  }
  #initialize() {
    if (this.#ready) return this.#ready;
    const attempt = (async () => {
      if (this.driver === nativeDriver) {
        const endpoint = process.env.DOCKER_HOST ?? JSON.parse(await this.#must(["context", "inspect"]))[0]?.Endpoints?.docker?.Host;
        if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) throw new Error("任务 daemon 必须使用本机 rootless Unix socket");
        const socket = await lstat(endpoint.slice(7));
        if (!socket.isSocket() || socket.uid !== process.getuid!()) throw new Error("任务 socket 必须属于当前管理身份");
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.root);
      if (!info.isDirectory() || await realpath(this.root) !== this.root || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0) throw new Error("任务管理根必须是管理端拥有的普通 0700 目录");
      await mkdir(join(this.root, "receipts"), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      await mkdir(join(this.root, "snapshots"), { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      for (const name of ["receipts", "snapshots"]) { const directory = await holdDirectory(this.root, [name], false); await directory.release(); }
      const keyPath = join(this.root, "manager.json");
      try { await writeFile(keyPath, JSON.stringify({ manager: randomUUID(), key: randomBytes(32).toString("hex") }), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const held = await holdDirectory(this.root, [], false);
      let saved: { manager: string; key: string };
      try { saved = JSON.parse((await held.use(entries => entries.read("manager.json")))!); } finally { await held.release(); }
      if (!idPattern.test(saved.manager) || !/^[a-f\d]{64}$/.test(saved.key)) throw new Error("任务管理身份损坏");
      const facts = JSON.parse(await this.#must(["info", "--format", "{{json .}}"]));
      if (!facts.ID || !Array.isArray(facts.SecurityOptions) || !facts.SecurityOptions.includes("name=rootless")) throw new Error("任务隔离要求已启用的 rootless Docker daemon");
      const image = JSON.parse(await this.#must(["image", "inspect", this.image]));
      if (image.length !== 1 || image[0].Id !== this.image || image[0].Os !== "linux") throw new Error("任务镜像身份不匹配");
      return { manager: saved.manager, key: Buffer.from(saved.key, "hex"), daemon: facts.ID as string };
    })();
    this.#ready = attempt;
    // Share in-flight / successful checks, but let a later call recheck recovered dependencies.
    void attempt.catch(() => { if (this.#ready === attempt) this.#ready = undefined; });
    return attempt;
  }
  async #save(receipt: Receipt, first = false) {
    const { key } = await this.#initialize(), payload = JSON.stringify(receipt);
    const saved = { payload, signature: createHmac("sha256", key).update(payload).digest("hex") };
    await this.storage.saveReceipt(join(this.root, "receipts", receipt.id + ".json"), saved, first);
  }
  async #load(id: string): Promise<Receipt> {
    if (!idPattern.test(id)) throw new Error("任务 ID 无效");
    const { key, manager, daemon } = await this.#initialize();
    const held = await holdDirectory(this.root, ["receipts"], false);
    let saved: { payload: string; signature: string };
    try { saved = JSON.parse((await held.use(entries => entries.read(id + ".json")))!); } finally { await held.release(); }
    if (typeof saved.payload !== "string" || !/^[a-f\d]{64}$/.test(saved.signature) || !timingSafeEqual(Buffer.from(saved.signature, "hex"), createHmac("sha256", key).update(saved.payload).digest())) throw new Error("任务回执签名无效，保留目录");
    const receipt = JSON.parse(saved.payload) as Receipt;
    if (receipt.version !== 2 || receipt.id !== id || receipt.manager !== manager || receipt.daemon !== daemon || !imagePattern.test(receipt.image) || !phases.includes(receipt.phase)
      || !/^[a-f\d]{64}$/.test(receipt.nonce) || !Array.isArray(receipt.containers) || receipt.containers.some(cid => !/^[a-f\d]{64}$/.test(cid))
      || !Array.isArray(receipt.pendingNames) || receipt.pendingNames.some(name => !new RegExp(`^mixin-task-${id}-[0-9]+$`).test(name))
      || !receipt.mounts || typeof receipt.mounts !== "object"
      || receipt.role !== undefined && receipt.role !== "worker" && receipt.role !== "results"
      || receipt.role === "results" && (receipt.containers.length > 0 || receipt.pendingNames.length > 0)
      || receipt.allocation !== undefined && (!allocationSteps.includes(receipt.allocation.step) || receipt.allocation.error !== undefined && typeof receipt.allocation.error !== "string")
      || ["allocating", "allocation-failed"].includes(receipt.phase) && (!receipt.allocation || receipt.containers.length > 0 || receipt.pendingNames.length > 0)
      || !Number.isFinite(receipt.createdAt) || !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 || typeof receipt.temp !== "string" || resolve(receipt.temp) !== receipt.temp) throw new Error("任务回执位置或身份不匹配，保留目录");
    return receipt;
  }
  #work(receipt: Receipt) { return join(receipt.temp, ".isolated-work", receipt.id, "work"); }
  async #inspect(receipt: Receipt, cid: string) {
    const result = await this.driver.run(["container", "inspect", cid]);
    if (result.exitCode !== 0) throw new Error(`无法证明容器 ${cid} 已回收；保留任务 ${receipt.id}`);
    const containers = JSON.parse(result.output), container = containers[0];
    if (containers.length !== 1 || container.Id !== cid || container.Image !== receipt.image || container.Config?.Labels?.["org.mixin-chatbot.task"] !== receipt.id
      || container.Config?.Labels?.["org.mixin-chatbot.manager"] !== receipt.manager || container.Config?.Labels?.["org.mixin-chatbot.nonce"] !== receipt.nonce) throw new Error("容器与管理回执不匹配");
    const writable = container.Mounts.filter((mount: { RW: boolean; Type: string }) => mount.RW && mount.Type !== "tmpfs");
    const expected = receipt.mounts[cid];
    const binds = container.Mounts.filter((value: { Type: string }) => value.Type !== "tmpfs");
    if (container.HostConfig.Privileged || !["", "private"].includes(container.HostConfig.PidMode) || container.HostConfig.IpcMode !== "private"
      || container.HostConfig.NetworkMode !== "none" || !container.HostConfig.ReadonlyRootfs || !container.HostConfig.CapDrop?.includes("ALL")
      || !container.HostConfig.SecurityOpt?.includes("no-new-privileges") || writable.length !== 1 || writable[0].Source !== this.#work(receipt) || writable[0].Destination !== this.#work(receipt)
      || !expected || binds.length !== expected.length || binds.some((value: { Type: string; Source: string; Destination: string; RW: boolean }) => value.Type !== "bind" || !expected.some(item => item.source === value.Source && item.target === value.Destination && item.writable === value.RW))) throw new Error("容器权限或挂载边界变化，拒绝授予回收权限");
    return container;
  }
  async #stop(receipt: Receipt) {
    // Do not lose the durable proof that filesystem reclamation already began.
    // A failed reconfirmation must remain resumable even if the subtree is already gone.
    const reclaiming = receipt.phase === "reclaiming";
    if (!reclaiming) receipt.phase = "stopping"; await this.#save(receipt);
    // An unanswered create may still be completing in the daemon. A missing name is not an acknowledgement.
    for (const name of receipt.pendingNames) {
      const output = await this.#must(["container", "inspect", name], { timeoutMs: 15_000 });
      const cid = JSON.parse(output)[0]?.Id;
      if (!/^[a-f\d]{64}$/.test(cid)) throw new Error("未完成的容器创建身份不明，保留任务");
      receipt.mounts[cid] ??= receipt.mounts[name]!;
      await this.#inspect(receipt, cid);
      if (!receipt.containers.includes(cid)) receipt.containers.push(cid);
    }
    receipt.pendingNames = [];
    await this.#save(receipt);
    // Cleanup ignores the caller's cancelled signal and always has a finite separate budget.
    for (const cid of receipt.containers) {
      const existing = await this.driver.run(["container", "inspect", cid], { timeoutMs: 15_000 });
      // A known immutable CID cannot be created later, unlike an unanswered create name.
      // This also recovers a removal whose acknowledgement was lost before saving the phase.
      if (existing.exitCode !== 0) {
        if (existing.output.includes(`No such container: ${cid}`) || existing.output.includes(`No such object: ${cid}`)) continue;
        throw new Error("容器撤销查询失败或 daemon 不可用，保留回执");
      }
      const container = await this.#inspect(receipt, cid);
      if (container.State.Running) await this.#must(["container", "kill", cid], { timeoutMs: 15_000 });
      await this.#must(["container", "wait", cid], { timeoutMs: 15_000 });
      if ((await this.#inspect(receipt, cid)).State.Running) throw new Error("容器仍有写者，保留任务");
      // CLI exit / not-running is only a snapshot: an accepted start may complete later.
      // Retire the registered CID before any scratch or work deletion, fencing queued starts.
      await this.#must(["container", "rm", cid, "--force"], { timeoutMs: 15_000 });
      const absent = await this.driver.run(["container", "inspect", cid], { timeoutMs: 15_000 });
      if (absent.exitCode === 0 || !absent.output.includes(`No such container: ${cid}`) && !absent.output.includes(`No such object: ${cid}`))
        throw new Error("容器撤销未确认或 daemon 不可用，保留回执与工作目录");
    }
    if (!reclaiming) receipt.phase = "writers-reaped"; await this.#save(receipt);
  }
  /** The public work parent is never mounted into a worker. Only this task's `work` entity is writable. */
  reserve(tempDir: string, role: "worker" | "results" = "worker"): TaskReservation {
    const id = randomUUID(); let creating: Promise<IsolatedTask> | undefined;
    return { id, path: join(tempDir, ".isolated-work", id, "work"), create: () => creating ??= this.#create(tempDir, id, role) };
  }
  create(tempDir: string) { return this.reserve(tempDir).create(); }
  async #create(tempDir: string, id: string, role: "worker" | "results"): Promise<IsolatedTask> {
    return this.#queue.run(id, () => this.#allocate(tempDir, id, role));
  }
  async #failAllocation(receipt: Receipt, cause: unknown): Promise<never> {
    receipt.phase = "allocation-failed"; receipt.allocation!.error = String(cause).slice(-4096);
    // Retain the failed transaction even if its failure checkpoint cannot currently be written.
    this.#allocationFailures.set(receipt.id, receipt);
    try { await this.#save(receipt); this.#allocationFailures.delete(receipt.id); }
    catch (recordError) { throw new AggregateError([cause, recordError], "任务分配及失败记录保存均失败，保留待恢复回执", { cause }); }
    throw cause;
  }
  async #allocate(tempDir: string, id: string, role: "worker" | "results"): Promise<IsolatedTask> {
    const { manager, daemon } = await this.#initialize(), temp = await realpath(tempDir);
    const receipt: Receipt = { version: 2, id, nonce: randomBytes(32).toString("hex"), manager, daemon, image: this.image,
      temp, createdAt: Date.now(), pid: process.pid, phase: "allocating", allocation: { step: "reserved" }, containers: [], pendingNames: [], mounts: {}, role };
    if (this.root === temp || this.root.startsWith(temp + "/") || temp.startsWith(this.root + "/")) throw new Error("任务管理根必须独立于用户 tmp");
    // Persist ownership before creating any work or container. A failed write may have completed.
    try { await this.#save(receipt, true); }
    catch (cause) {
      try {
        const persisted = await this.#load(receipt.id);
        if (JSON.stringify(persisted) !== JSON.stringify(receipt)) throw new Error("首回执不属于本次分配，保留现有记录");
      } catch (confirmationError) { throw new AggregateError([cause, confirmationError], "首回执保存失败且登记无法确认，保留现有记录", { cause }); }
      return this.#failAllocation(receipt, cause);
    }
    try {
      const held = await this.storage.holdDirectory(temp, [".isolated-work", receipt.id], true);
      try {
        const parent = await this.storage.holdDirectory(temp, [".isolated-work"], false);
        try { receipt.parentIdentity = { dev: String(parent.identity.dev), ino: String(parent.identity.ino) }; } finally { await parent.release(); }
        receipt.identity = { dev: String(held.identity.dev), ino: String(held.identity.ino) };
        receipt.allocation!.step = "entity-registered"; await this.#save(receipt);
        await held.use(async entries => { const marker = await entries.create(".manager-owner"); try { await marker.handle.writeFile(receipt.nonce); await marker.handle.sync(); } finally { await marker.close(); } });
        receipt.allocation!.step = "marker-written"; await this.#save(receipt);
        const work = await this.storage.holdDirectory(temp, [".isolated-work", receipt.id, "work"], true); await work.release();
        receipt.allocation!.step = "work-created";
      } finally { await held.release(); }
      // No caller can launch a worker until all allocation I/O and closes succeeded.
      receipt.phase = "active"; await this.#save(receipt);
    } catch (cause) {
      return this.#failAllocation(receipt, cause);
    }
    let sealed = false;
    const path = this.#work(receipt);
    return {
      id: receipt.id, path,
      run: (options, readOnly = []) => application.track(this.#queue.run(receipt.id, async () => {
        const signal = AbortSignal.any([application.signal, AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
        signal.throwIfAborted();
        if (receipt.role === "results") throw new Error("管理端结果任务不能启动工作进程");
        if (sealed || receipt.phase !== "active" || receipt.pendingNames.length) throw new Error("任务已停止或创建未确认，禁止新写者进入");
        const snapshot = join(this.root, "snapshots", receipt.id, "temp");
        // Snapshot the caller's ordinary files; keep management journals and other tasks out of the mount.
        try { await this.#removeInternalTree(join(this.root, "snapshots"), receipt.id); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await mkdir(snapshot, { recursive: true, mode: 0o700 });
        const inputBudget = { entries: 0, totalBytes: 0 };
        await snapshotFiles(temp, snapshot, signal, inputBudget);
        for (const filename of await readdir(join(this.root, "receipts"))) {
          const otherId = filename.slice(0, -5);
          if (!filename.endsWith(".json") || !idPattern.test(otherId) || otherId === receipt.id) continue;
          const other = await this.#load(otherId);
          const readableResults = other.role === "results" && other.phase === "active" && !other.containers.length && !other.pendingNames.length;
          if (other.temp !== temp || other.phase !== "writers-reaped" && !readableResults) continue;
          const target = join(snapshot, ".isolated-work", otherId, "work"); await mkdir(target, { recursive: true });
          await snapshotFiles(this.#work(other), target, signal, inputBudget);
        }
        await mkdir(join(snapshot, ".isolated-work", receipt.id, "work"), { recursive: true });
        const bindings = [{ source: snapshot, target: temp, writable: false }, { source: path, target: path, writable: true }];
        for (const source of [...new Set(readOnly)]) {
          const canonical = await realpath(source);
          if (canonical === temp || canonical === path) continue;
          if (this.root === canonical || this.root.startsWith(canonical + "/") || canonical.startsWith(this.root + "/") || temp.startsWith(canonical + "/")
            || canonical.startsWith(join(temp, ".isolated-work") + "/") || source === "/tmp") throw new Error("不得向工作进程导出管理根、其他任务或共享系统 tmp");
          bindings.push({ source: canonical, target: source, writable: false });
        }
        const env = Object.entries(options.env ?? {}).filter(([key]) => allowedEnvironment.has(key));
        const name = `mixin-task-${receipt.id}-${receipt.containers.length}`;
        const mounts = bindings.map(value => mount(value.source, value.target, !value.writable));
        receipt.pendingNames.push(name); receipt.mounts[name] = bindings; await this.#save(receipt);
        const args = ["create", "--name", name, "--pull", "never", "--no-healthcheck", "--read-only", "--network", "none", "--ipc", "private", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          "--pids-limit", "128", "--memory", "1g", "--cpus", "2", "--user", "0:0", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777", "--workdir", options.cwd,
          "--label", `org.mixin-chatbot.task=${receipt.id}`, "--label", `org.mixin-chatbot.manager=${receipt.manager}`, "--label", `org.mixin-chatbot.nonce=${receipt.nonce}`,
          ...mounts.flatMap(value => ["--mount", value]), ...env.flatMap(([key, value]) => ["--env", `${key}=${value}`]), "--entrypoint", options.command, this.image, ...options.args];
        const cid = await this.#must(args, { timeoutMs: 30_000 });
        if (!/^[a-f\d]{64}$/.test(cid)) throw new Error("容器创建未返回固定身份，保留任务");
        receipt.containers.push(cid); receipt.mounts[cid] = bindings; receipt.pendingNames = receipt.pendingNames.filter(candidate => candidate !== name); await this.#save(receipt);
        await this.#inspect(receipt, cid);
        let error: unknown, result: { exitCode: number; output: string } | undefined;
        try { result = await this.driver.run(["start", "--attach", cid], { signal, timeoutMs: options.timeoutMs, onData: options.onData }); }
        catch (cause) { error = cause; }
        try {
          const container = await this.#inspect(receipt, cid);
          if (container.State.Running) await this.#must(["container", "kill", cid], { timeoutMs: 15_000 });
          await this.#must(["container", "wait", cid], { timeoutMs: 15_000 });
          if ((await this.#inspect(receipt, cid)).State.Running) throw new Error("任务进程尚未回收");
        } catch (cause) { throw new AggregateError([...(error ? [error] : []), cause], "任务回收失败，保留回执", { cause: error }); }
        if (error) throw error;
        await validateWork(path);
        return result!;
      }, AbortSignal.any([application.signal, ...(options.signal ? [options.signal] : [])]))),
      seal: (options) => { sealed = true; return application.track(this.#queue.run(receipt.id, async () => {
        if (receipt.phase !== "writers-reaped") await this.#stop(receipt);
        if (options?.discardScratch) {
          try { await this.#removeInternalTree(path, ".work"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      })); },
    };
  }
  async #removeTree(base: string, name: string, nonce?: string, receipt?: Receipt): Promise<DirectoryRemoval> {
    const parent = await holdDirectory(base, [], false);
    let child: Awaited<ReturnType<typeof holdDirectory>> | undefined, permit: RemovalPermit | undefined;
    try {
      child = await holdDirectory(base, [name], false);
      if (receipt && (!receipt.parentIdentity || !receipt.identity || String(parent.identity.dev) !== receipt.parentIdentity.dev || String(parent.identity.ino) !== receipt.parentIdentity.ino
        || String(child.identity.dev) !== receipt.identity.dev || String(child.identity.ino) !== receipt.identity.ino)) return { name, status: "deferred", reason: "registered-entity-moved-or-replaced" };
      if (parent.identity.dev !== child.identity.dev) return { name, status: "deferred", reason: "different-device" };
      permit = new RemovalPermit(parent.identity, child.identity);
      const results = await parent.use(entries => entries.removeDirectories({ select: entry => entry === name, permit, requireRemoval: true,
        beforeRemove: async (_name, _time, entries) => {
          if (nonce !== undefined && await entries.read(".manager-owner") !== nonce) throw new Error("任务实体登记不匹配，保留目录");
          return true;
        } }));
      return results[0] ?? { name, status: "deferred", reason: "registered-entry-missing" };
    } finally { permit?.revoke(); try { await child?.release(); } finally { await parent.release(); } }
  }
  async #removeInternalTree(base: string, name: string) {
    const result = await this.#removeTree(base, name);
    if (result.status !== "removed") throw new Error(`内部任务目录未确认回收：${name}: ${result.reason}`);
  }
  /** Only registered task IDs are accepted, never an arbitrary deletion path or a prefix/age filesystem scan. */
  async describe(id: string, tempDir: string) {
    const receipt = await this.#load(id);
    if (receipt.temp !== await realpath(tempDir)) throw new Error("任务回执属于另一用户 tmp");
    return { path: this.#work(receipt), createdAt: receipt.createdAt, phase: receipt.phase };
  }
  async #allocationProof(receipt: Receipt): Promise<string | undefined> {
    if (!receipt.parentIdentity || !receipt.identity) return "allocation-entity-unconfirmed";
    let parent: Awaited<ReturnType<typeof holdDirectory>> | undefined, child: Awaited<ReturnType<typeof holdDirectory>> | undefined;
    try {
      parent = await holdDirectory(receipt.temp, [".isolated-work"], false);
      child = await holdDirectory(receipt.temp, [".isolated-work", receipt.id], false);
      if (String(parent.identity.dev) !== receipt.parentIdentity.dev || String(parent.identity.ino) !== receipt.parentIdentity.ino
        || String(child.identity.dev) !== receipt.identity.dev || String(child.identity.ino) !== receipt.identity.ino) return "registered-entity-moved-or-replaced";
      if (await child.use(entries => entries.read(".manager-owner")) !== receipt.nonce) return "allocation-marker-unconfirmed";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "allocation-entity-unconfirmed";
      throw error;
    } finally { try { await child?.release(); } finally { await parent?.release(); } }
  }
  async reclaim(id: string, tempDir?: string): Promise<DirectoryRemoval> {
    return this.#queue.run(id, async () => {
      const failedAllocation = this.#allocationFailures.get(id);
      if (failedAllocation) { await this.#save(failedAllocation); this.#allocationFailures.delete(id); }
      const receipt = await this.#load(id);
      if (tempDir !== undefined && receipt.temp !== await realpath(tempDir)) throw new Error("任务回执属于另一用户 tmp");
      if (receipt.phase === "removed") return { name: id, status: "removed" };
      if (receipt.phase === "active" || receipt.phase === "allocating") {
        try { process.kill(receipt.pid, 0); return { name: id, status: "deferred", reason: receipt.phase === "active" ? "task-owner-live" : "task-allocation-live" }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      if (receipt.phase === "allocating" || receipt.phase === "allocation-failed") {
        const reason = await this.#allocationProof(receipt);
        if (reason) return { name: id, status: "deferred", reason };
      }
      const resuming = receipt.phase === "reclaiming";
      // Reconfirm retirement even when resuming receipts written by the previous layout.
      await this.#stop(receipt);
      const temp = await realpath(receipt.temp), base = join(temp, ".isolated-work");
      if (temp !== receipt.temp || (await stat(temp)).dev !== (await stat(base)).dev) return { name: id, status: "deferred", reason: "location-or-device-mismatch" };
      receipt.phase = "reclaiming"; await this.#save(receipt);
      let result;
      try { result = await this.#removeTree(base, id, receipt.nonce, receipt); }
      catch (error) { if (!resuming || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; result = { name: id, status: "removed" as const }; }
      if (result.status !== "removed") return result;
      const snapshots = join(this.root, "snapshots");
      try { await this.#removeInternalTree(snapshots, id); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      receipt.phase = "removed"; await this.#save(receipt);
      return result;
    });
  }
  async sweep(tempDir: string, before: number, references: readonly unknown[], excluded: ReadonlySet<string> = new Set()): Promise<DirectoryRemoval[]> {
    await this.#initialize(); const temp = await realpath(tempDir), results: DirectoryRemoval[] = [];
    const text = JSON.stringify(references).replaceAll("\\\\", "\\");
    for (const name of await readdir(join(this.root, "receipts"))) {
      const id = name.slice(0, -5); if (!name.endsWith(".json") || !idPattern.test(id)) continue;
      if (excluded.has(id)) continue;
      let receipt: Receipt;
      try { receipt = await this.#load(id); }
      catch (error) { results.push({ name: id, status: "refused", reason: String(error) }); continue; }
      if (receipt.temp !== temp || receipt.createdAt >= before || receipt.phase === "removed" || (receipt.reclamation?.nextAttemptAt ?? 0) > Date.now() || text.includes(join(temp, ".isolated-work", id))) continue;
      let result: DirectoryRemoval;
      try { result = await this.reclaim(id, temp); }
      catch (error) { result = { name: id, status: "refused", reason: String(error) }; }
      if (result.status !== "removed") {
        const current = await this.#load(id), attemptedAt = Date.now();
        current.reclamation = { attemptedAt, nextAttemptAt: attemptedAt + 60_000, reason: result.reason }; await this.#save(current);
      }
      results.push(result);
    }
    return results;
  }
}

function mount(source: string, target: string, readonly: boolean): string {
  if (/[\n\r,]/.test(source + target)) throw new Error("容器挂载路径包含不支持的控制字符或逗号");
  return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
}
async function snapshotFiles(source: string, destination: string, signal?: AbortSignal, budget = { entries: 0, totalBytes: 0 }) {
  const directory = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const copy = async (held: FileHandle, target: string, depth: number) => {
    if (depth > 64) throw new Error("任务输入目录超过 64 层");
    for (const name of await readdir(`/proc/self/fd/${held.fd}`)) {
      signal?.throwIfAborted();
      if (depth === 0 && [".office-jobs", ".isolated-work"].includes(name)) continue;
      if (++budget.entries > 20_000) throw new Error("任务输入超过 20000 个条目");
      const file = await open(`/proc/self/fd/${held.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
        if (!["ENOENT", "ELOOP"].includes(error.code)) throw error;
      });
      if (!file) continue;
      try {
        const info = await file.stat(), path = join(target, name);
        if (info.isDirectory()) { await mkdir(path, { recursive: true, mode: 0o700 }); await copy(file, path, depth + 1); }
        else if (info.isFile()) {
          if (info.size > 128 * 1024 * 1024) throw new Error("任务输入单文件超过 128 MiB");
          const output = await open(path, "w", 0o600); let size = 0;
          try {
            // Bun's FileHandle streams with autoClose:false can retain pipeline completion and lose handle ownership.
            // Explicit fd reads/writes keep both handles owned until the finally blocks below.
            const buffer = Buffer.alloc(64 * 1024);
            while (true) {
              signal?.throwIfAborted();
              const { bytesRead } = await file.read(buffer, 0, buffer.length, size); if (!bytesRead) break;
              budget.totalBytes += bytesRead;
              if (size + bytesRead > 128 * 1024 * 1024 || budget.totalBytes > 256 * 1024 * 1024) throw new Error("任务输入超过 256 MiB");
              let written = 0;
              while (written < bytesRead) {
                const { bytesWritten } = await output.write(buffer, written, bytesRead - written, size + written);
                if (!bytesWritten) throw new Error("任务快照写入未取得进展"); written += bytesWritten;
              }
              size += bytesRead;
            }
            await output.sync();
          } finally { await output.close(); }
        } else throw new Error("任务输入包含 FIFO 或其他特殊文件");
      } finally { await file.close(); }
    }
  };
  try { await copy(directory, destination, 0); } finally { await directory.close(); }
}

/** A worker-created link/FIFO must never become a host-manager input after the worker exits. */
async function validateWork(path: string) {
  let count = 0;
  const visit = async (directory: FileHandle, depth: number) => {
    if (depth > 64) throw new Error("任务产物目录超过 64 层");
    for (const name of await readdir(`/proc/self/fd/${directory.fd}`)) {
      if (++count > 20_000) throw new Error("任务产物超过 20000 个条目");
      const child = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const info = await child.stat();
        if (info.isDirectory()) await visit(child, depth + 1);
        else if (!info.isFile()) throw new Error("任务产物包含 FIFO 或其他特殊文件，拒绝向管理端导出");
      } finally { await child.close(); }
    }
  };
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await visit(directory, 0); } finally { await directory.close(); }
}
const allowedEnvironment = new Set(["TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "PYTHONUTF8", "PYTHONIOENCODING", "PYTHONDONTWRITEBYTECODE", "PYTHON_BASIC_REPL",
  "XDG_CACHE_HOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "PI_USER_TMP", "PI_PYTHON", "PI_MATERIALS_INDEX", "PI_CALLER_PHONE", "PI_GROUP_ID", "AI_AGENT", "PI_CODING_AGENT",
  "npm_config_cache", "BUN_INSTALL_CACHE_DIR", "PIP_CACHE_DIR", "UV_CACHE_DIR"]);

let configured: RootlessTasks | undefined;
export const ISOLATED_PYTHON = "/app/.venv/bin/python";
export function configuredRootlessTasks(): RootlessTasks | undefined {
  const image = runtimeSetting("BOT_TASK_IMAGE");
  if (!image) return;
  if (process.platform !== "linux") throw new Error("BOT_TASK_IMAGE 只适用于 Linux rootless 任务部署");
  return configured ??= new RootlessTasks(runtimeSetting("BOT_TASK_CONTROL_ROOT") ?? fileURLToPath(new URL("../../data/runtime/task-control", import.meta.url)), image);
}

/** Every host-side tool reader checks this after canonicalizing and before copying, hashing or using a cache. */
export async function assertTaskPathAllowed(path: string): Promise<void> {
  const backend = configuredRootlessTasks(); if (!backend) return;
  const canonical = await realpath(backend.root).catch(error => { if (error.code === "ENOENT") return backend.root; throw error; });
  if (isPathInside(path, backend.root) || isPathInside(path, canonical)) throw new Error("任务管理目录与回执不向工具开放");
}
