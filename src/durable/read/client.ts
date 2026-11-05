// Main-thread side of the console's read channel: a few in-flight requests at most, each with a deadline that covers its
// wait and its run. The worker cannot be interrupted inside a statement (each one is bounded instead), so cancelling or
// expiring stops the operation at its next statement; the caller is answered at once and the slot stays taken until the
// worker has let go of it. A worker that stops answering is replaced; the write thread is never involved.
import { Worker } from "node:worker_threads";
import { decodeError, type RemoteError } from "../sqlite-protocol.ts";
import { READ_ERRORS, type ReadMessage, type ReadOp, type WorkerInit } from "./protocol.ts";

export class ReadBusy extends Error { override name = "ReadBusy"; }
export class ReadUnavailable extends Error { override name = "ReadUnavailable"; }
class ReadExpired extends Error { override name = READ_ERRORS.expired; }

export type ReadChannelOptions = {
  conversations: string; state: string;
  /** In-flight requests (queued or running) at most. */
  slots?: number;
  /** From submission to answer, wait included. */
  deadlineMs?: number;
  /** Past the deadline by this much without its reply, the worker counts as stuck and is replaced. */
  stuckMs?: number;
  /** An idle worker stops after this long. */
  idleMs?: number;
};

type Reply = { request: number; ok: true; value: unknown } | { request: number; ok: false; error: RemoteError };
type Pending = {
  slot: number;
  /** Until the deadline, then until the worker counts as stuck. */
  timer: ReturnType<typeof setTimeout>;
  /** Answers the caller once; later calls do nothing. */
  answer(outcome: { value: unknown } | { error: unknown }): void;
  /** Settles when the worker no longer holds the slot. */
  released: PromiseWithResolvers<void>;
};

export class ReadChannel {
  readonly #options: Required<ReadChannelOptions>;
  #worker?: Worker;
  #flags?: Int32Array;
  readonly #pending = new Map<number, Pending>();
  #next = 0;
  #idle?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(options: ReadChannelOptions) {
    this.#options = { slots: 4, deadlineMs: 20_000, stuckMs: 30_000, idleMs: 120_000, ...options };
  }

  /** The longest a caller waits for an answer (the route's HTTP limit builds on it). */
  get deadlineMs(): number { return this.#options.deadlineMs; }

  run(op: ReadOp, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ReadUnavailable("读取通道已关闭"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const taken = new Set([...this.#pending.values()].map(entry => entry.slot));
    const slot = Array.from({ length: this.#options.slots }, (_, i) => i).find(i => !taken.has(i));
    if (slot === undefined) return Promise.reject(new ReadBusy("读取繁忙，请稍后重试"));
    const worker = this.#start(), flags = this.#flags!;
    clearTimeout(this.#idle);
    Atomics.store(flags, slot, 0);
    const request = ++this.#next, deadline = Date.now() + this.#options.deadlineMs;
    const result = Promise.withResolvers<unknown>();
    let answered = false;
    const onAbort = () => { Atomics.store(flags, slot, 1); entry.answer({ error: signal!.reason }); };
    const entry: Pending = {
      slot, released: Promise.withResolvers<void>(),
      timer: setTimeout(() => {
        Atomics.store(flags, slot, 1);
        entry.answer({ error: new ReadExpired("读取超过期限") });
        entry.timer = setTimeout(() => this.#stop(new ReadUnavailable("读取线程没有响应，已重启")), this.#options.stuckMs);
      }, this.#options.deadlineMs),
      answer: outcome => {
        if (answered) return;
        answered = true;
        signal?.removeEventListener("abort", onAbort);
        if ("error" in outcome) result.reject(outcome.error); else result.resolve(outcome.value);
      },
    };
    this.#pending.set(request, entry);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage({ request, slot, deadline, op } satisfies ReadMessage);
    return result.promise;
  }

  /** Stops new work, cancels what is in flight at its next statement, waits for that (bounded), then stops the worker. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#idle);
    const flags = this.#flags;
    if (flags) for (const entry of this.#pending.values()) Atomics.store(flags, entry.slot, 1);
    const released = Promise.all([...this.#pending.values()].map(entry => entry.released.promise));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([released, new Promise(resolve => { timer = setTimeout(resolve, this.#options.stuckMs); })]);
    clearTimeout(timer);
    this.#stop(new ReadUnavailable("读取通道已关闭"));
  }

  #start(): Worker {
    if (this.#worker) return this.#worker;
    const cancel = new SharedArrayBuffer(4 * this.#options.slots);
    this.#flags = new Int32Array(cancel);
    const worker = new Worker(new URL("./worker.ts", import.meta.url),
      { workerData: { conversations: this.#options.conversations, state: this.#options.state, cancel } satisfies WorkerInit });
    worker.on("message", (reply: Reply) => {
      const entry = this.#pending.get(reply.request);
      if (!entry || this.#worker !== worker) return;
      this.#pending.delete(reply.request);
      clearTimeout(entry.timer);
      entry.released.resolve();
      entry.answer(reply.ok ? { value: reply.value } : { error: decodeError(reply.error) });
      if (!this.#pending.size && !this.#closed) this.#idle = setTimeout(() => this.#stop(), this.#options.idleMs);
    });
    worker.on("error", error => { if (this.#worker === worker) this.#stop(new ReadUnavailable("读取线程异常，已重启", { cause: error })); });
    worker.on("exit", code => { if (this.#worker === worker) this.#stop(new ReadUnavailable(`读取线程退出（${code}）`)); });
    worker.unref();
    return this.#worker = worker;
  }

  /** Answers everything in flight with `error` and lets the worker go (terminate itself waits for a running statement). */
  #stop(error = new ReadUnavailable("读取线程空闲退出")): void {
    const worker = this.#worker;
    this.#worker = undefined; this.#flags = undefined;
    clearTimeout(this.#idle);
    for (const entry of this.#pending.values()) { clearTimeout(entry.timer); entry.answer({ error }); entry.released.resolve(); }
    this.#pending.clear();
    void worker?.terminate();
  }
}

/** The HTTP status of a read failure. */
export function readStatus(error: unknown): 400 | 404 | 409 | 413 | 429 | 503 | 504 | 500 {
  switch ((error as Error | undefined)?.name) {
    case "ReadRequestError": return 400;
    case READ_ERRORS.absent: return 404;
    case READ_ERRORS.changed: return 409;
    case "ReadLimit": return 413;
    case "ReadBusy": return 429;
    // Cancelled: the caller has gone, nobody reads this answer.
    case "ReadUnavailable": case READ_ERRORS.cancelled: case "AbortError": return 503;
    case READ_ERRORS.expired: case "TimeoutError": return 504;
    default: return 500;
  }
}
