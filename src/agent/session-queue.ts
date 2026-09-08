import { abortError } from "../core/lifecycle.ts";

type Job = {
  task: (signal: AbortSignal) => Promise<void>;
  resolve: () => void;
  reject: (cause: unknown) => void;
};

/** Owns all transitions for one (group, user), including clear/dispose barriers. */
export class SessionQueue {
  private pending: Job[] = [];
  private current?: { controller: AbortController; done: Promise<void> };
  private closed = false;
  phase = "空闲";
  get waiting(): number { return this.pending.length; }
  get busy(): boolean { return !!this.current; }

  enqueue(task: Job["task"]): Promise<void> {
    if (this.closed) return Promise.reject(abortError("会话已关闭"));
    if (this.pending.length >= 8) return Promise.reject(new Error("本会话已有 8 条消息排队，请稍后重发"));
    const result = new Promise<void>((resolve, reject) => this.pending.push({ task, resolve, reject }));
    this.pump();
    return result;
  }

  /** Cancellation happens synchronously; waiting for cleanup is optional for the caller. */
  cancel(): Promise<void> {
    const reason = abortError();
    for (const job of this.pending.splice(0)) job.reject(reason);
    this.current?.controller.abort(reason);
    if (this.current) this.phase = "正在停止";
    return this.current?.done ?? Promise.resolve();
  }

  close(): Promise<void> { this.closed = true; return this.cancel(); }

  private pump(): void {
    if (this.current || !this.pending.length) return;
    const job = this.pending.shift()!;
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.current = { controller, done };
    this.phase = "准备中";
    const complete = (success: boolean, error?: unknown) => {
      this.current = undefined;
      this.phase = "空闲";
      finish();
      if (success) job.resolve(); else job.reject(error);
      this.pump();
    };
    // Store ownership and completion handling before starting any asynchronous work.
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return job.task(controller.signal);
    }).then(() => complete(true), (error) => complete(false, error));
  }
}
