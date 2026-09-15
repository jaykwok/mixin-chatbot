import type { AppApi, Loading } from "../view.ts";

/** 设置项独立缓存；导航不等待 I/O，失效后的旧结果不能覆盖新状态。 */
export class LazySetting<T> {
  state: Loading<T> = { kind: "idle" };
  private job?: { abort: AbortController; done: Promise<void> };

  constructor(private readonly read: (signal: AbortSignal) => Promise<T>) {}

  load(app: AppApi, force = false): Promise<void> {
    if (this.job) return this.job.done;
    if (!force && this.state.kind !== "idle") return Promise.resolve();
    const job = { abort: new AbortController(), done: Promise.resolve() };
    this.job = job;
    this.state = { kind: "loading" };
    app.redraw();
    job.done = (async () => {
      try {
        const value = await this.read(job.abort.signal);
        if (this.job === job) this.state = { kind: "ready", value };
      } catch (error) {
        if (this.job === job) this.state = { kind: "error", message: error instanceof Error ? error.message : String(error) };
      } finally {
        if (this.job === job) { this.job = undefined; app.redraw(); }
      }
    })();
    return job.done;
  }

  invalidate(): void {
    this.job?.abort.abort();
    this.job = undefined;
    this.state = { kind: "idle" };
  }

  onLeave(): boolean {
    if (!this.job) return false;
    this.invalidate();
    return true;
  }
}
