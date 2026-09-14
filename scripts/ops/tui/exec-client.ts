import { Worker } from "node:worker_threads";
import { ownQueryHost, type QueryOwner } from "./exec-owner.ts";
import type { CaptureOptions, RunResult } from "./exec.ts";
import type { CaptureOutcome, FromWorker, ToWorker } from "./exec-protocol.ts";

const abortError = () => new DOMException("查询已取消", "AbortError");
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
interface Host {
  owner: QueryOwner;
  exited: () => void;
  request?: number;
  stopping?: Promise<void>;
  didExit?: boolean;
}

/** One lifecycle per TUI session; no subprocess is launched in the UI thread. */
export class QueryPool {
  private worker: Worker | null = null;
  private sequence = 0;
  private shutdown = new Int32Array(new SharedArrayBuffer(4));
  private pending = new Map<number, Pending>();
  private hosts = new Map<number, Host>();
  private retiredHosts = new Set<number>();
  private cleanups = new Set<Promise<void>>();
  private cleanupErrors: unknown[] = [];
  private stopped = Promise.resolve();
  private notifyStopped = () => {};
  private closing?: Promise<void>;
  private recovery?: Promise<void>;
  private stopRequested = false;
  closed = false;

  capture(command: string, args: string[], options: CaptureOptions = {}): Promise<RunResult> {
    if (this.recovery && !this.stopRequested) return this.recovery.then(() => this.capture(command, args, options));
    if (this.closed) return Promise.reject(abortError());
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? abortError());
    const timeout = options.timeout ?? 20_000;
    if (!Number.isFinite(timeout) || timeout <= 0) return Promise.reject(new Error("查询时限必须大于零"));
    if (!this.worker) {
      this.stopped = new Promise(resolve => { this.notifyStopped = resolve; });
      const worker = new Worker(new URL("./exec-worker.ts", import.meta.url), { workerData: { shutdown: this.shutdown.buffer } });
      this.worker = worker;
      worker.on("message", (message: FromWorker) => {
        void this.receive(message).catch(error => this.fail(error));
      });
      worker.on("error", error => this.fail(error));
      worker.on("exit", code => {
        this.notifyStopped();
        if (!this.closed) this.fail(new Error(`查询线程已退出（${code}）`));
      });
    }
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

  private send(message: ToWorker): void {
    try { this.worker?.postMessage(message); } catch (error) { this.fail(error); }
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    // Fail current queries with the actual fault, drain their process trees, and
    // allow the next refresh to start a fresh worker within the same TUI session.
    this.recovery = this.close(error).then(() => {
      if (this.stopRequested) return;
      this.worker = null;
      this.retiredHosts.clear();
      this.shutdown = new Int32Array(new SharedArrayBuffer(4));
      this.closing = undefined;
      this.recovery = undefined;
      this.closed = false;
    });
    void this.recovery.catch(() => {});
  }
  private finish(id: number, outcome?: CaptureOutcome): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.detach();
    if (pending.cancel?.timedOut) {
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
    // For active work, resolve only after OS-level supervision confirms its exit.
    if (pending.host === undefined) this.finish(id);
    else void this.retire(pending.host).then(() => this.finish(id), error => {
      pending.cancel = { reason: error, timedOut: false };
      this.finish(id);
    });
  }
  private retire(id: number): Promise<void> {
    const host = this.hosts.get(id);
    if (!host) return Promise.resolve();
    if (host.stopping) return host.stopping;
    this.send({ type: "retire", host: id });
    const cleanup = host.owner.stop().finally(() => {
      if (!host.didExit) this.retiredHosts.add(id);
      this.hosts.delete(id);
      this.cleanups.delete(cleanup);
    });
    host.stopping = cleanup;
    this.cleanups.add(cleanup);
    void cleanup.catch(error => { this.cleanupErrors.push(error); });
    return cleanup;
  }
  private async receive(message: FromWorker): Promise<void> {
    if (message.type === "host") {
      let exited!: () => void;
      const exit = new Promise<void>(resolve => { exited = resolve; });
      try { this.hosts.set(message.host, { owner: ownQueryHost(message.pid, exit, message.birth), exited }); }
      catch (error) {
        this.send({ type: "retire", host: message.host });
        if (!this.closed) throw error;
        return;
      }
      if (this.closed) await this.retire(message.host);
      else this.send({ type: "owned", host: message.host });
    } else if (message.type === "dispatch") {
      const pending = this.pending.get(message.id);
      const host = this.hosts.get(message.host);
      if (!pending || pending.cancel || this.closed || !host || host.stopping) {
        await this.retire(message.host);
        return;
      }
      host.request = message.id;
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
      if (!pending || !host) return;
      clearTimeout(pending.timer);
      // Queries may not leave daemon grandchildren behind. Reuse only an idle host.
      if (pending.cancel || host.stopping || message.retire) await this.retire(message.host);
      else {
        host.request = undefined;
        this.send({ type: "release", host: message.host, id: message.id });
      }
      this.finish(message.id, message.outcome);
    } else if (message.type === "cancelled") {
      const pending = this.pending.get(message.id);
      if (pending?.host !== undefined) await this.retire(pending.host);
      this.finish(message.id);
    } else if (message.type === "retired") {
      const host = this.hosts.get(message.host);
      if (!host) {
        if (!this.retiredHosts.delete(message.host)) this.fail(new Error(message.error));
        return;
      }
      host.didExit = true;
      host.exited();
      const unexpected = !host.stopping && !this.closed;
      await this.retire(message.host);
      if (host.request !== undefined) this.finish(host.request, { error: message.error });
      else if (unexpected) this.fail(new Error(message.error));
    } else this.notifyStopped();
  }

  stop(reason: unknown = abortError()): Promise<void> {
    this.stopRequested = true;
    return this.close(reason);
  }

  private close(reason: unknown): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    Atomics.store(this.shutdown, 0, 1);
    for (const id of this.pending.keys()) this.cancel(id, reason);
    for (const id of this.hosts.keys()) void this.retire(id).catch(() => {});
    this.worker?.ref();
    this.closing = (async () => {
      this.send({ type: "shutdown" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Allow a blocking spawn to return, publish its PID and observe shutdown.
        // The UI remains responsive and restores its terminal before this drain.
        await Promise.race([this.stopped, new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); })]);
      } finally { clearTimeout(timer); }
      await this.worker?.terminate();
      await Promise.allSettled([...this.hosts.keys()].map(id => this.retire(id)));
      await Promise.allSettled([...this.cleanups]);
      for (const id of this.pending.keys()) this.finish(id);
      if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, "查询进程回收失败");
    })();
    return this.closing;
  }
}
