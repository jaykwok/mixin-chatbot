import { MessageChannel, Worker, type TransferListItem } from "node:worker_threads";
import type { CaptureOptions, RunResult } from "./exec.ts";
import type { CaptureOutcome, FromReaper, FromWorker, ToReaper, ToWorker } from "./exec-protocol.ts";

const abortError = () => new DOMException("查询已取消", "AbortError");
const unconfirmed = "无法确认查询进程已退出";
/**
 * Final drain only. Each stop is bounded inside the reaper (exec-owner.ts): 0.3 s for the exit ack, the native
 * calls (seconds under endpoint security), at most 30 s after termination, then at most 1 s for an ack queued
 * behind a failed call. Hosts still unconfirmed after this are reported, never waited for.
 */
const DRAIN_LIMIT_MS = 60_000;

interface Pending {
  resolve: (result: RunResult) => void;
  reject: (error: unknown) => void;
  cancelled: Int32Array;
  timeout: number;
  stdout: string;
  stderr: string;
  cancel?: { timedOut: boolean; reason: unknown };
  host?: number;
  timer?: ReturnType<typeof setTimeout>;
  detach: () => void;
}
/**
 * Kept for the whole worker generation. The spawner and the reaper report on separate channels with no
 * relative order, so news about a host can arrive after it was settled; both facts below are final.
 */
interface Host {
  request?: number;
  /** We asked it to exit. Its exit, reported by either thread in either order, is then expected. Settles
   * when the exit is confirmed (undefined) or the reaper could not confirm it (its error). */
  stop?: { done: Promise<string | undefined>; settle: (error?: string) => void };
  /** Exit confirmed by the spawner or the reaper. A later "could not confirm" from the other is moot. */
  gone?: boolean;
}

function bounded(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

/**
 * One lifecycle per TUI session. The UI thread only exchanges messages: a spawner Worker starts query hosts
 * (Bun.spawn can block it for seconds), and a reaper Worker owns their termination, including every native
 * process call. The two talk directly, so neither ownership nor exit confirmation waits for this thread.
 */
export class QueryPool {
  private worker: Worker | null = null;
  private reaper: Worker | null = null;
  private generation = 0;
  private sequence = 0;
  private shutdown = new Int32Array(new SharedArrayBuffer(4));
  private pending = new Map<number, Pending>();
  private hosts = new Map<number, Host>();
  /** Hosts whose exit could not be confirmed, per worker generation; a later exit confirmation removes the entry. */
  private failures = new Map<string, Error>();
  /** Resource release failures survive exit confirmations and worker recovery for the whole TUI session. */
  private cleanupFailures = new Map<string, Error>();
  private stops = 0;
  private spawnerStopped: Promise<void> = Promise.resolve();
  private notifySpawnerStopped = () => {};
  private reaperStopped: Promise<void> = Promise.resolve();
  private notifyReaperStopped = () => {};
  private closing?: Promise<void>;
  private recovery?: Promise<void>;
  private stopping?: Promise<void>;
  private stopRequested = false;
  closed = false;

  capture(command: string, args: string[], options: CaptureOptions = {}): Promise<RunResult> {
    if (this.recovery && !this.stopRequested) return this.recovery.then(() => this.capture(command, args, options));
    if (this.closed) return Promise.reject(abortError());
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? abortError());
    const timeout = options.timeout ?? 20_000;
    if (!Number.isFinite(timeout) || timeout <= 0) return Promise.reject(new Error("查询时限必须大于零"));
    if (!this.worker) this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const cancelled = new Int32Array(new SharedArrayBuffer(4));
      const onAbort = () => this.cancel(id, options.signal?.reason ?? abortError());
      const pending: Pending = { resolve, reject, cancelled, timeout, stdout: "", stderr: "",
        detach: () => options.signal?.removeEventListener("abort", onAbort) };
      this.pending.set(id, pending);
      this.worker!.ref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.send({ type: "capture", request: {
        id, command, args, input: options.input, env: { ...process.env, ...options.env }, cancelled: cancelled.buffer as SharedArrayBuffer,
      } });
      if (options.signal?.aborted) onAbort();
    });
  }

  private start(): void {
    const generation = this.generation;
    const current = () => generation === this.generation;
    const { port1, port2 } = new MessageChannel();
    this.spawnerStopped = new Promise(resolve => { this.notifySpawnerStopped = resolve; });
    this.reaperStopped = new Promise(resolve => { this.notifyReaperStopped = resolve; });
    const reaper = new Worker(new URL("./exec-reaper.ts", import.meta.url));
    this.reaper = reaper;
    reaper.unref();
    reaper.on("message", (message: FromReaper) => { if (current()) this.fromReaper(message); });
    reaper.on("error", error => { if (current()) this.fail(error); });
    reaper.on("exit", code => {
      if (!current()) return;
      this.notifyReaperStopped();
      if (!this.closed) this.fail(new Error(`查询回收线程已退出（${code}）`));
    });
    this.toReaper({ type: "spawner", port: port2 }, [port2]);
    const worker = new Worker(new URL("./exec-worker.ts", import.meta.url), { workerData: { shutdown: this.shutdown.buffer } });
    this.worker = worker;
    worker.on("message", (message: FromWorker) => { if (current()) this.receive(message); });
    worker.on("error", error => { if (current()) this.fail(error); });
    worker.on("exit", code => {
      if (!current()) return;
      this.notifySpawnerStopped();
      if (!this.closed) this.fail(new Error(`查询线程已退出（${code}）`));
    });
    this.send({ type: "reaper", port: port1 }, [port1]);
  }

  private send(message: ToWorker, transfer?: TransferListItem[]): void {
    try { this.worker?.postMessage(message, transfer); } catch (error) { this.fail(error); }
  }
  private toReaper(message: ToReaper, transfer?: TransferListItem[]): void {
    try { this.reaper?.postMessage(message, transfer); } catch (error) { this.fail(error); }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    // Fail current queries with the actual fault, drain their process trees, and let the next refresh
    // start fresh workers in the same session. Reclaim failures are reported by stop(); they never block this.
    this.recovery = this.close(error).then(() => {
      if (this.stopRequested) return;
      this.worker = null;
      this.reaper = null;
      this.hosts.clear();
      this.generation++;
      this.shutdown = new Int32Array(new SharedArrayBuffer(4));
      this.closing = undefined;
      this.recovery = undefined;
      this.closed = false;
    });
  }

  private finish(id: number, outcome?: CaptureOutcome, reclaimError?: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.detach();
    if (reclaimError) pending.reject(new Error(reclaimError));
    else if (pending.cancel?.timedOut) {
      pending.resolve({ code: 124, stdout: pending.stdout, stderr: pending.stderr, timedOut: true });
    } else if (pending.cancel) pending.reject(pending.cancel.reason);
    else if (outcome && "result" in outcome) pending.resolve(outcome.result);
    else pending.reject(new Error(outcome && "error" in outcome ? outcome.error : "查询进程已退出"));
    if (!this.pending.size && !this.closed) this.worker?.unref();
  }

  private cancel(id: number, reason: unknown, timedOut = false): void {
    const pending = this.pending.get(id);
    if (!pending || pending.cancel) return;
    pending.cancel = { reason, timedOut };
    Atomics.store(pending.cancelled, 0, 1);
    this.send({ type: "cancel", id });
    // A request without a host cannot execute: dispatch needs another UI ack.
    // For active work, resolve only after its exit is confirmed.
    if (pending.host === undefined) this.finish(id);
    else void this.stopHost(pending.host).then(error => this.finish(id, undefined, error));
  }

  private record(id: number): Host {
    let host = this.hosts.get(id);
    if (!host) this.hosts.set(id, host = {});
    return host;
  }
  private key(id: number): string { return `${this.generation}:${id}`; }

  /** Retire a host and wait for confirmation of its exit. Resolves with the reclaim error, if any. */
  private stopHost(id: number): Promise<string | undefined> {
    const host = this.record(id);
    if (host.stop) return host.stop.done;
    let settle!: (error?: string) => void;
    const done = new Promise<string | undefined>(resolve => { settle = resolve; });
    host.stop = { done, settle };
    if (host.gone) { settle(); return done; }
    this.stops++;
    this.reaper?.ref();
    void done.then(() => { if (--this.stops === 0 && !this.closed) this.reaper?.unref(); });
    this.send({ type: "retire", host: id });
    this.toReaper({ type: "stop", host: id });
    return done;
  }

  /** Exit confirmed: clears an earlier "could not confirm", and nothing that arrives later brings it back. */
  private confirmExit(id: number): void {
    const host = this.record(id);
    host.gone = true;
    this.failures.delete(this.key(id));
    host.stop?.settle();
  }

  private fromReaper(message: FromReaper): void {
    if (message.type === "stopped-all") return this.notifyReaperStopped();
    // Exit proves the process tree is gone, not that its native handles were released successfully.
    if (message.cleanupError && !this.cleanupFailures.has(this.key(message.host))) {
      this.cleanupFailures.set(this.key(message.host), new Error(message.cleanupError));
    }
    const host = this.record(message.host);
    if (host.gone) return;
    if (message.error) {
      this.failures.set(this.key(message.host), new Error(message.error));
      host.stop?.settle(message.error);
      return;
    }
    const request = host.stop ? undefined : host.request;
    this.confirmExit(message.host);
    // Not stopped by us (only stop-all does that): the host was running this request.
    if (request !== undefined) { host.request = undefined; this.finish(request, { error: "查询进程已退出" }); }
  }

  private receive(message: FromWorker): void {
    if (message.type === "dispatch") {
      const pending = this.pending.get(message.id);
      const host = this.hosts.get(message.host);
      if (!pending || pending.cancel || this.closed || host?.stop || host?.gone) {
        // The retire for a host we stopped may still be on its way (or lost); repeat it so the spawner
        // stops offering that host. Nothing ran yet; the spawner puts a live request back in its queue.
        if (host?.stop || host?.gone) this.send({ type: "retire", host: message.host });
        this.send({ type: "release", host: message.host, id: message.id, requeue: true });
        return;
      }
      this.record(message.host).request = message.id;
      pending.host = message.host;
      this.send({ type: "execute", host: message.host, id: message.id });
    } else if (message.type === "started") {
      const pending = this.pending.get(message.id);
      if (pending && pending.host === message.host && !pending.cancel && !pending.timer) {
        pending.timer = setTimeout(() => this.cancel(message.id, abortError(), true),
          Math.max(0, pending.timeout - (Date.now() - message.at)));
      }
    } else if (message.type === "output") {
      const pending = this.pending.get(message.id);
      if (pending?.host === message.host) pending[message.stream] += message.text;
    } else if (message.type === "result") {
      const pending = this.pending.get(message.id);
      const host = this.hosts.get(message.host);
      if (!pending || pending.host !== message.host || !host) return;
      clearTimeout(pending.timer);
      // Queries may not leave daemon grandchildren behind. Reuse only an idle host. A reclaim failure
      // after a completed command is reported by stop(); the command's own result stays valid.
      if (pending.cancel || host.stop || message.retire) void this.stopHost(message.host).then(() => this.finish(message.id, message.outcome));
      else {
        host.request = undefined;
        this.send({ type: "release", host: message.host, id: message.id });
        this.finish(message.id, message.outcome);
      }
    } else if (message.type === "cancelled") {
      // Never executed. A cancelled request with a host is settled by that host's stop.
      const pending = this.pending.get(message.id);
      if (pending && !pending.cancel) this.finish(message.id, { error: "查询进程已退出" });
      else if (pending?.host === undefined) this.finish(message.id);
    } else if (message.type === "retired") {
      // The spawner saw the process exit; with its job or subreaper, the tree is gone. This can arrive
      // after the reaper already confirmed a stop we asked for: that exit was expected, whatever the
      // spawner knew when it saw it.
      const host = this.record(message.host);
      const request = host.stop ? undefined : host.request;
      host.request = undefined;
      const expected = message.expected || host.stop !== undefined || host.gone;
      this.confirmExit(message.host);
      // Died while running this request.
      if (request !== undefined) this.finish(request, { error: message.error });
      // Left on its own before or between queries (failed start, broken channel, lost grant). Fail the
      // queued work with that cause; otherwise the spawner would start replacement hosts indefinitely.
      else if (!expected) this.fail(new Error(message.error));
    } else if (message.type === "fault") this.fail(new Error(message.error));
    else this.notifySpawnerStopped();
  }

  stop(reason: unknown = abortError()): Promise<void> {
    this.stopRequested = true;
    return this.stopping ??= (async () => {
      await this.close(reason);
      const errors = [...this.failures.values(), ...this.cleanupFailures.values()];
      if (errors.length) throw new AggregateError(errors, "查询进程回收失败");
    })();
  }

  private close(reason: unknown): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    Atomics.store(this.shutdown, 0, 1);
    for (const id of this.pending.keys()) this.cancel(id, reason);
    this.worker?.ref();
    this.reaper?.ref();
    this.closing = (async () => {
      this.send({ type: "shutdown" });
      this.toReaper({ type: "stop-all" });
      // The spawner may be inside a blocking spawn; the reaper stops every owned host without it.
      await bounded(this.spawnerStopped, 10_000);
      await Promise.allSettled([this.worker?.terminate()]);
      await bounded(this.reaperStopped, DRAIN_LIMIT_MS);
      await Promise.allSettled([this.reaper?.terminate()]);
      // Asked to stop, and neither thread has confirmed the exit or reported why it could not.
      for (const [id, host] of this.hosts) {
        if (!host.stop || host.gone || this.failures.has(this.key(id))) continue;
        this.failures.set(this.key(id), new Error(unconfirmed));
        host.stop.settle(unconfirmed);
      }
      for (const id of this.pending.keys()) this.finish(id);
    })();
    return this.closing;
  }
}
