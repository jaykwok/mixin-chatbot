/** Process-wide admission. A result, a cancellation or close() is not a worker exit (seen first with Pi 1.3.0, checked
 * against the pinned codemode by tests/durable/codemode-workers.test.ts): a reservation ends only when the worker exits
 * or fails to start. */
export class CodemodeWorkers {
  #reserved = 0;
  #stopped = false;
  readonly #exits = new Set<Promise<void>>();

  constructor(readonly limit = 2) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("worker limit must be positive");
  }

  get reserved(): number { return this.#reserved; }
  get alive(): number { return this.#exits.size; }

  /** Passed directly to the official synchronous hook; it releases on construction failure or exit. */
  acquireWorker = (): (() => void) => {
    if (this.#stopped) throw new Error("Codemode 服务正在关闭");
    if (this.#reserved >= this.limit) throw new Error(`Codemode worker 容量已满（${this.limit}），请稍后重试`);
    this.#reserved++;
    let released = false;
    return () => { if (!released) { released = true; this.#reserved--; } };
  };

  onWorkerStarted = (exited: Promise<void>): void => {
    this.#exits.add(exited);
    void exited.finally(() => this.#exits.delete(exited)).catch(() => {});
  };

  stop(): void { this.#stopped = true; }

  /** The application's one shutdown deadline bounds this wait. Never free a living worker's slot. */
  async drain(): Promise<void> {
    while (this.#exits.size) await Promise.allSettled([...this.#exits]);
  }
}

export const codemodeWorkers = new CodemodeWorkers();
