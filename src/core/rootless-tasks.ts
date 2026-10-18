// Isolated tasks: one manager object per control root owns the per-task queue, the control root (owner lock, manager
// identity, receipts), pending allocation-failure checkpoints and the sweep's directory streams. The receipt protocol
// steps live in `task-runtime/phases.ts`; each is saved before the side effect it permits.
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { executeProcess, type ProcessOptions } from "../../scripts/lib/process.ts";
import { publishJson } from "../../scripts/lib/atomic-file.ts";
import { ID_PATTERN, RESULT_NAME, validTreeEvidence, type TreeEvidence } from "../contracts/maintenance.ts";
import { IMAGE_PATTERN, type Receipt, type ReceiptPhase } from "../contracts/task-receipt.ts";
import { archiveEntry } from "./archive-entry.ts";
import { holdDirectory, type DirectoryRemoval } from "./held-directory.ts";
import { application, KeyedQueue } from "./lifecycle.ts";
import type { ReferenceText } from "./reference-text.ts";
import { reclamationEvidence, type TreeEntry } from "./reclamation-files.ts";
import { TaskPaths, type TaskDeployment } from "./task-deployment.ts";
import { mountArguments, TaskContainers, type TaskDriver } from "./task-runtime/containers.ts";
import { TaskControl, type TaskStorage } from "./task-runtime/control.ts";
import { DiscardJournals, sameEntry, type DiscardJournal } from "./task-runtime/discards.ts";
import { allocationProof, discardInternalTree, removeTree, workPath } from "./task-runtime/entities.ts";
import { assertReadOnlyExport, selectInputs, snapshotInput, validateWork, workerEnvironment } from "./task-runtime/inputs.ts";
import * as phases from "./task-runtime/phases.ts";
import { ReceiptSweep, type ResultSettled } from "./task-runtime/sweep.ts";

export type { TaskDriver } from "./task-runtime/containers.ts";
export type { TaskStorage } from "./task-runtime/control.ts";

const nativeDriver: TaskDriver = {
  run: (args, options) => executeProcess({ command: "docker", args, cwd: process.cwd(), timeoutMs: options?.timeoutMs ?? 30_000, ...options,
    env: Object.fromEntries(["HOME", "USER", "PATH", "DOCKER_HOST", "XDG_RUNTIME_DIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) }),
};
const nativeStorage: TaskStorage = {
  holdDirectory,
  async saveReceipt(path, envelope, first) {
    if (first) await writeFile(path, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
    else await publishJson(path, envelope);
  },
};
export interface IsolatedTask {
  readonly id: string; readonly path: string;
  run(options: ProcessOptions, readOnly?: readonly string[], inputs?: { paths: readonly string[] }): Promise<{ exitCode: number; output: string }>;
  seal(options?: { discardScratch: boolean }): Promise<void>;
}
export interface TaskReservation { readonly id: string; readonly path: string; create(): Promise<IsolatedTask> }

/** Rootless Docker is a control-plane dependency. Workers get neither its socket nor host PID/proc namespaces. */
export class RootlessTasks {
  #queue = new KeyedQueue();
  #mappingReady: Promise<void> | undefined;
  #allocationFailures = new Map<string, Receipt>();
  readonly root: string;
  readonly #paths: TaskPaths | undefined;
  readonly #control: TaskControl;
  readonly #containers: TaskContainers;
  readonly #sweep: ReceiptSweep;
  readonly #discards: DiscardJournals;
  constructor(root: string, readonly image: string, driver: TaskDriver = nativeDriver, private readonly storage: TaskStorage = nativeStorage,
    deployment?: TaskDeployment) {
    this.root = resolve(root);
    if (process.platform !== "linux") throw new Error("隔离任务需要 Linux rootless Docker");
    if (!IMAGE_PATTERN.test(image)) throw new Error("任务镜像必须固定为完整 sha256 ID");
    this.#paths = deployment ? new TaskPaths(deployment, image) : undefined;
    this.#containers = new TaskContainers(driver, image, this.#paths, driver === nativeDriver);
    this.#containers.source(this.root);
    this.#control = new TaskControl(this.root, storage, () => this.#containers.checkDaemon(), this.#paths?.identity);
    this.#sweep = new ReceiptSweep(this.#control, this.#queue, (id, temp) => this.reclaim(id, temp));
    this.#discards = new DiscardJournals(this.#control, (path, value) => publishJson(path, value));
  }
  /** Preflight runs before accepting work; a string mapping alone cannot prove both views name the same storage. */
  async verifyDeployment(): Promise<void> {
    await this.#containers.checkDaemon();
    if (this.#paths) await this.#containers.verifyMappings();
  }
  async verify(): Promise<void> {
    await this.#control.initialize();
    if (!this.#paths) return;
    if (!this.#mappingReady) {
      const attempt = this.#containers.verifyMappings(); this.#mappingReady = attempt;
      void attempt.catch(() => { if (this.#mappingReady === attempt) this.#mappingReady = undefined; });
    }
    await this.#mappingReady;
  }
  /** Retire every writer, keeping a saved deletion or archive intent. A failed reconfirmation must remain resumable
   * even if the subtree is already gone. */
  async #retireWriters(receipt: Receipt) {
    phases.stopping(receipt); await this.#control.save(receipt);
    await this.#containers.resolvePending(receipt);
    receipt.pendingNames = [];
    await this.#control.save(receipt);
    await this.#containers.retireAll(receipt);
    phases.writersReaped(receipt); await this.#control.save(receipt);
  }
  /** The public work parent is never mounted into a worker. Only this task's `work` entity is writable. */
  reserve(tempDir: string, role: "worker" | "results" = "worker", resultName?: string): TaskReservation {
    if (resultName !== undefined && (role !== "results" || !RESULT_NAME.test(resultName))) throw new Error("隔离结果归属名称无效");
    const id = randomUUID(); let creating: Promise<IsolatedTask> | undefined;
    return { id, path: join(tempDir, ".isolated-work", id, "work"), create: () => creating ??= this.#queue.run(id, () => this.#allocate(tempDir, id, role, resultName)) };
  }
  create(tempDir: string) { return this.reserve(tempDir).create(); }
  async #failAllocation(receipt: Receipt, cause: unknown): Promise<never> {
    phases.allocationFailed(receipt, cause);
    // Retain the failed transaction even if its failure checkpoint cannot currently be written.
    this.#allocationFailures.set(receipt.id, receipt);
    try { await this.#control.save(receipt); this.#allocationFailures.delete(receipt.id); }
    catch (recordError) { throw new AggregateError([cause, recordError], "任务分配及失败记录保存均失败，保留待恢复回执", { cause }); }
    throw cause;
  }
  async #allocate(tempDir: string, id: string, role: "worker" | "results", resultName?: string): Promise<IsolatedTask> {
    await this.verify();
    const { manager, daemon, ownerEpoch } = await this.#control.initialize(), temp = await realpath(tempDir);
    const receipt = phases.reserved({ version: 2, id, nonce: randomBytes(32).toString("hex"), manager, daemon, image: this.image,
      ...(this.#paths ? { deployment: this.#paths.identity } : {}),
      temp, createdAt: Date.now(), pid: process.pid, ownerEpoch }, role, resultName);
    this.#containers.source(temp);
    if (this.root === temp || this.root.startsWith(temp + "/") || temp.startsWith(this.root + "/")) throw new Error("任务管理根必须独立于用户 tmp");
    // Persist ownership before creating any work or container. A failed write may have completed.
    try { await this.#control.save(receipt, true); }
    catch (cause) {
      try {
        const persisted = await this.#control.load(receipt.id);
        if (JSON.stringify(persisted) !== JSON.stringify(receipt)) throw new Error("首回执不属于本次分配，保留现有记录");
      } catch (confirmationError) { throw new AggregateError([cause, confirmationError], "首回执保存失败且登记无法确认，保留现有记录", { cause }); }
      return this.#failAllocation(receipt, cause);
    }
    try {
      const held = await this.storage.holdDirectory(temp, [".isolated-work", receipt.id], true);
      try {
        const parent = await this.storage.holdDirectory(temp, [".isolated-work"], false);
        let parentIdentity;
        try { parentIdentity = parent.identity; } finally { await parent.release(); }
        phases.entityRegistered(receipt, parentIdentity, held.identity); await this.#control.save(receipt);
        await held.use(async entries => { const marker = await entries.create(".manager-owner"); try { await marker.handle.writeFile(receipt.nonce); await marker.handle.sync(); } finally { await marker.close(); } });
        phases.allocationStep(receipt, "marker-written"); await this.#control.save(receipt);
        const work = await this.storage.holdDirectory(temp, [".isolated-work", receipt.id, "work"], true); await work.release();
        phases.allocationStep(receipt, "work-created");
      } finally { await held.release(); }
      // No caller can launch a worker until all allocation I/O and closes succeeded.
      phases.activated(receipt); await this.#control.save(receipt);
    } catch (cause) {
      return this.#failAllocation(receipt, cause);
    }
    let sealed = false;
    const path = workPath(receipt);
    return {
      id: receipt.id, path,
      run: (options, readOnly = [], inputs = { paths: [] }) => application.track(this.#queue.run(receipt.id, async () => {
        const signal = AbortSignal.any([application.signal, AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
        signal.throwIfAborted();
        if (receipt.role === "results") throw new Error("管理端结果任务不能启动工作进程");
        if (sealed || receipt.phase !== "active" || receipt.pendingNames.length) throw new Error("任务已停止或创建未确认，禁止新写者进入");
        const bindings = await this.#prepareInputs(receipt, temp, path, readOnly, inputs, signal);
        const env = workerEnvironment(options.env), name = `mixin-task-${receipt.id}-${receipt.containers.length}`;
        // An unusable mount path fails before the name is saved as pending.
        const mounts = mountArguments(bindings);
        receipt.pendingNames.push(name); receipt.mounts[name] = bindings; await this.#control.save(receipt);
        const cid = await this.#containers.create(receipt, name, mounts, options, env);
        receipt.containers.push(cid); receipt.mounts[cid] = bindings; receipt.pendingNames = receipt.pendingNames.filter(candidate => candidate !== name); await this.#control.save(receipt);
        await this.#containers.inspect(receipt, cid);
        const result = await this.#containers.runToEnd(receipt, cid, { signal, timeoutMs: options.timeoutMs, onData: options.onData });
        await validateWork(path);
        return result;
      }, AbortSignal.any([application.signal, ...(options.signal ? [options.signal] : [])]))),
      seal: (options) => { sealed = true; return application.track(this.#queue.run(receipt.id, async () => {
        if (receipt.phase !== "writers-reaped") await this.#retireWriters(receipt);
        if (options?.discardScratch) await discardInternalTree(path, ".work");
        // A completed worker no longer needs its private input copy. Writer retirement above
        // fences every queued start before these manager-owned snapshots are removed.
        await discardInternalTree(join(this.root, "snapshots"), receipt.id);
      })); },
    };
  }
  /** A fresh private snapshot of the explicit inputs, and the worker's mounts: the snapshot as its read-only tmp, its own
   * `work` writable, and permitted read-only host paths. Only explicit inputs are copied, so unrelated history cannot
   * exhaust a new task's input budget. */
  async #prepareInputs(receipt: Receipt, temp: string, path: string, readOnly: readonly string[], inputs: { paths: readonly string[] }, signal: AbortSignal) {
    const snapshot = join(this.root, "snapshots", receipt.id, "temp");
    await discardInternalTree(join(this.root, "snapshots"), receipt.id);
    await mkdir(snapshot, { recursive: true, mode: 0o700 });
    const inputBudget = { entries: 0, totalBytes: 0 };
    for (const entry of selectInputs(temp, inputs.paths)) {
      const parts = entry.split("/");
      if (parts[0] === ".office-jobs") throw new Error("任务输入不得包含管理回执");
      if (parts[0] === ".isolated-work") {
        const otherId = parts[1];
        if (!otherId || !ID_PATTERN.test(otherId) || otherId === receipt.id || parts[2] !== "work") throw new Error("任务输入必须指定已登记的工作产物");
        const other = await this.#control.load(otherId);
        const readableResults = other.role === "results" && other.phase === "active" && !other.containers.length && !other.pendingNames.length;
        if (other.temp !== temp || other.phase !== "writers-reaped" && !readableResults) throw new Error("任务输入仍有工作进程或已回收");
      }
      await snapshotInput(temp, parts, join(snapshot, entry), signal, inputBudget);
    }
    await mkdir(join(snapshot, ".isolated-work", receipt.id, "work"), { recursive: true });
    const bindings = [{ source: this.#containers.source(snapshot), target: temp, writable: false }, { source: this.#containers.source(path), target: path, writable: true }];
    for (const source of [...new Set(readOnly)]) {
      const canonical = await realpath(source);
      if (canonical === temp || canonical === path) continue;
      assertReadOnlyExport(source, canonical, this.root, temp);
      // Only an explicitly registered path in the pinned image may omit a host bind.
      // Keep the worker-visible spelling identical; aliases must not silently select another image path.
      if (canonical === source && this.#paths?.suppliedByImage(canonical)) continue;
      bindings.push({ source: this.#containers.source(canonical), target: source, writable: false });
    }
    return bindings;
  }
  /** Only registered task IDs are accepted, never an arbitrary deletion path or a prefix/age filesystem scan. */
  async describe(id: string, tempDir: string) {
    const receipt = await this.#control.load(id);
    if (receipt.temp !== await realpath(tempDir)) throw new Error("任务回执属于另一用户 tmp");
    return { path: workPath(receipt), createdAt: receipt.createdAt, phase: receipt.phase };
  }
  /** Registered IDs for offline planning; each damaged receipt is reported independently.
   * `observe` reads without the kernel lock (previews beside a running service); the plan is rechecked under the lock. */
  async inventory(tempDir: string, observe = false) {
    if (!observe) await this.#control.initialize();
    const temp = await realpath(tempDir);
    const items: { id: string; path: string; createdAt: number; phase: ReceiptPhase; token: string }[] = [], refused: { id: string; reason: string }[] = [];
    // An observer creates nothing: a control root that was never initialized has no receipts.
    const names = await readdir(join(this.root, "receipts")).catch(error => { if (observe && error.code === "ENOENT") return []; throw error; });
    for (const filename of names.sort()) {
      const id = filename.slice(0, -5); if (!filename.endsWith(".json") || !ID_PATTERN.test(id)) continue;
      try {
        const receipt = await this.#control.load(id, observe);
        if (receipt.temp !== temp) continue;
        items.push({ id, path: workPath(receipt), createdAt: receipt.createdAt, phase: receipt.phase,
          token: JSON.stringify([receipt.id, receipt.nonce, receipt.manager, receipt.daemon, receipt.deployment, receipt.temp, receipt.parentIdentity, receipt.identity]) });
      } catch (error) { refused.push({ id, reason: String(error) }); }
    }
    return { items, refused };
  }
  async reclaim(id: string, tempDir?: string): Promise<DirectoryRemoval> {
    return this.#queue.run(id, async () => {
      const failedAllocation = this.#allocationFailures.get(id);
      if (failedAllocation) { await this.#control.save(failedAllocation); this.#allocationFailures.delete(id); }
      const receipt = await this.#control.load(id);
      if (tempDir !== undefined && receipt.temp !== await realpath(tempDir)) throw new Error("任务回执属于另一用户 tmp");
      if (receipt.phase === "removed") return { name: id, status: "removed", completedEarlier: true };
      if (receipt.phase === "archiving" || receipt.phase === "archived") return { name: id, status: "deferred", reason: "task-owned-by-archive-plan" };
      await this.verify();
      if (receipt.phase === "active" || receipt.phase === "allocating") {
        const live = { name: id, status: "deferred" as const, reason: receipt.phase === "active" ? "task-owner-live" : "task-allocation-live" };
        if (receipt.ownerEpoch !== undefined) {
          // Acquiring this same process-lifetime kernel lock proves the previous controller exited,
          // even when its PID is reused (or refers to another process in this container's namespace).
          if (receipt.ownerEpoch === (await this.#control.initialize()).ownerEpoch) return live;
        } else {
          // Legacy controllers did not hold the kernel lock; do not infer their exit from an epoch.
          try { process.kill(receipt.pid, 0); return live; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
      if (receipt.phase === "allocating" || receipt.phase === "allocation-failed") {
        const reason = await allocationProof(receipt);
        if (reason) return { name: id, status: "deferred", reason };
      }
      const resuming = receipt.phase === "reclaiming";
      // Reconfirm retirement even when resuming receipts written by the previous layout.
      await this.#retireWriters(receipt);
      const temp = await realpath(receipt.temp), base = join(temp, ".isolated-work");
      if (temp !== receipt.temp || (await stat(temp)).dev !== (await stat(base)).dev) return { name: id, status: "deferred", reason: "location-or-device-mismatch" };
      phases.reclaiming(receipt); await this.#control.save(receipt);
      let result;
      try { result = await removeTree(base, id, { nonce: receipt.nonce, receipt }); }
      catch (error) { if (!resuming || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; result = { name: id, status: "removed" as const, completedEarlier: true as const }; }
      if (result.status !== "removed") return result;
      await discardInternalTree(join(this.root, "snapshots"), id);
      phases.removed(receipt); await this.#control.save(receipt);
      return result;
    });
  }
  /** Offline archival keeps bytes and a signed destination; replays never delete the archive. */
  async archive(id: string, tempDir: string, destination: string, evidence: TreeEvidence): Promise<void> {
    await this.#queue.run(id, async () => {
      const receipt = await this.#control.load(id);
      if (receipt.temp !== await realpath(tempDir) || !validTreeEvidence(evidence)
        || receipt.identity?.dev !== evidence.dev || receipt.identity.ino !== evidence.ino) throw new Error("隔离归档实体与管理回执不符");
      if (receipt.archive && (receipt.archive.destination !== destination || JSON.stringify(receipt.archive.evidence) !== JSON.stringify(evidence))) throw new Error("隔离任务已由另一归档清单接管");
      if (receipt.phase === "archived") return;
      if (receipt.phase === "removed" || receipt.phase === "reclaiming") throw new Error("隔离任务已经进入物理回收，不能归档");
      if (["active", "allocating"].includes(receipt.phase)) {
        if (!receipt.ownerEpoch || receipt.ownerEpoch === (await this.#control.initialize()).ownerEpoch) throw new Error("隔离任务的创建者仍在运行，保留");
      }
      await this.verify(); await this.#retireWriters(receipt);
      const source = join(receipt.temp, ".isolated-work", id);
      if (!receipt.archive) {
        const current = await reclamationEvidence(source);
        if (current.fingerprint !== evidence.fingerprint || current.dev !== evidence.dev || current.ino !== evidence.ino) throw new Error("隔离任务在预览后改变");
        phases.archiving(receipt, destination, evidence); await this.#control.save(receipt);
      }
      const exists = await lstat(destination).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
      if (!exists) await archiveEntry(source, destination, { dev: BigInt(evidence.dev), ino: BigInt(evidence.ino) });
      const saved = await reclamationEvidence(destination);
      if (saved.fingerprint !== evidence.fingerprint || saved.dev !== evidence.dev || saved.ino !== evidence.ino) throw new Error("隔离归档目标与清单不符，保留现场");
      await discardInternalTree(join(this.root, "snapshots"), id);
      phases.archived(receipt); await this.#control.save(receipt);
    });
  }
  /** Permanently delete an archived task tree: the receipt names its destination and evidence, and the archive
   * already reaped every writer. A deletion journal listing every reviewed entry is saved first; an interrupted
   * deletion resumes only while each remaining entry is one of them, unchanged (see `task-runtime/discards.ts`).
   * The receipt goes only after the tree is confirmed removed; a missing destination is reported, never taken as
   * proof of deletion. */
  async discardArchive(id: string, destination: string, evidence: TreeEvidence): Promise<DirectoryRemoval> {
    return this.#queue.run(id, async () => {
      const expected = { destination, evidence };
      let journal = await this.#discards.load(id, expected);
      const resumed = journal !== undefined;
      if (journal?.phase === "removed") { await this.#dropReceipt(id); return { name: id, status: "removed", completedEarlier: true }; }
      // Without a journal, a missing receipt cannot say what happened to the archive.
      if (!await lstat(join(this.root, "receipts", id + ".json")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
        return { name: id, status: "refused", reason: "archive-receipt-missing" };
      }
      const receipt = await this.#control.load(id);
      if (receipt.phase !== "archived" || receipt.archive?.destination !== destination || JSON.stringify(receipt.archive.evidence) !== JSON.stringify(evidence)) {
        return { name: id, status: "refused", reason: "archive-receipt-mismatch" };
      }
      const parent = await lstat(dirname(destination), { bigint: true });
      if (!journal) {
        const entries: TreeEntry[] = [];
        const current = await reclamationEvidence(destination, entry => entries.push(entry)).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        if (!current) return { name: id, status: "deferred", reason: "archive-destination-missing" };
        if (current.fingerprint !== evidence.fingerprint || current.dev !== evidence.dev || current.ino !== evidence.ino) return { name: id, status: "deferred", reason: "archive-changed" };
        journal = { version: 1, id, destination, evidence, parent: { dev: String(parent.dev), ino: String(parent.ino) }, phase: "deleting", entries };
        await this.#discards.save(journal);
      } else {
        const reason = await this.#resumable(journal, parent);
        if (reason) return { name: id, status: "deferred", reason };
      }
      // A resumed deletion may already have removed the marker; the journal's entries stand in for it.
      const result = await removeTree(dirname(destination), basename(destination), { nonce: resumed ? undefined : receipt.nonce,
        parent: journal.parent, entry: { dev: evidence.dev, ino: evidence.ino } });
      if (result.status !== "removed") return result;
      await this.#discards.save({ ...journal, phase: "removed", entries: [] });
      await this.#dropReceipt(id);
      return result;
    });
  }
  /** Why the remaining tree cannot be taken as the rest of the journaled one, or undefined when it can. An absent root
   * cannot prove that this deletion removed it, so it is reported, not completed. */
  async #resumable(journal: DiscardJournal, parent: { dev: bigint; ino: bigint }): Promise<string | undefined> {
    if (String(parent.dev) !== journal.parent.dev || String(parent.ino) !== journal.parent.ino) return "archive-parent-replaced";
    const listed = new Map(journal.entries.map(entry => [entry.path, entry]));
    let foreign = false;
    try { await reclamationEvidence(journal.destination, entry => { const saved = listed.get(entry.path); if (!saved || !sameEntry(saved, entry)) foreign = true; }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "archive-removal-unconfirmed"; throw error; }
    return foreign ? "archive-changed-during-removal" : undefined;
  }
  async #dropReceipt(id: string) {
    await unlink(join(this.root, "receipts", id + ".json")).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  /** Whether a deletion journal of this exact archive exists; read-only, also beside a running service. */
  async discardStarted(id: string, destination: string, evidence: TreeEvidence): Promise<boolean> {
    return !!await this.#discards.load(id, { destination, evidence }, true);
  }
  /** Drop a finished deletion journal once the removal plan has saved its outcome. */
  async forgetDiscard(id: string, destination: string, evidence: TreeEvidence): Promise<void> {
    await this.#queue.run(id, async () => {
      if ((await this.#discards.load(id, { destination, evidence }))?.phase === "removed") await this.#discards.drop(id);
    });
  }
  async sweep(tempDir: string, before: number, references: ReferenceText, excluded: ReadonlySet<string> = new Set(),
    settled?: ResultSettled): Promise<DirectoryRemoval[]> {
    return this.#queue.run("sweep", () => this.#sweep.tick(tempDir, before, references, excluded, settled));
  }
}
