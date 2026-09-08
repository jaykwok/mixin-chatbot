/** Abort-aware waiting shared by queues, tools and shutdown. */
export function abortError(message = "任务已取消"): Error {
  return new DOMException(message, "AbortError");
}

export function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** A FIFO reservation stays behind its predecessor even when its waiter cancels. */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    try {
      await waitFor(previous, signal);
      signal?.throwIfAborted();
      return await task();
    } finally {
      release();
      void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    }
  }
}

export class TaskScope {
  readonly controller = new AbortController();
  private tasks = new Set<Promise<unknown>>();
  get signal(): AbortSignal { return this.controller.signal; }

  track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  abort(reason: Error = abortError("应用正在关闭")): void { this.controller.abort(reason); }
  async drain(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks]);
  }
}

export const application = new TaskScope();
