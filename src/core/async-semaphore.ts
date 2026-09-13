/** Bounded FIFO, including waiters cancelled before an attachment starts allocating buffers. */
export class AsyncSemaphore {
  private active = 0;
  private waiting: { start: () => void }[] = [];
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid concurrency limit");
  }
  acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter = {
        start: () => {
          signal?.removeEventListener("abort", waiter.cancel);
          this.active++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.active--;
            this.waiting.shift()?.start();
          });
        },
        cancel: () => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal?.removeEventListener("abort", waiter.cancel);
          reject(signal?.reason);
        },
      };
      if (this.active < this.limit) waiter.start();
      else { this.waiting.push(waiter); signal?.addEventListener("abort", waiter.cancel, { once: true }); }
    });
  }
}
