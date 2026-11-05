// Live conversation reads through the running bot's local admin port (src/server/http-app.ts `/_admin/read`). The bot's
// admin token stays in this process: it is read from the bot's instance record for each request and never reaches the
// page, a URL, an error message, a log line or the audit. Before the first request to an instance, and again every few
// seconds, /health must name the recorded instance, so a restarted bot or another program on the port is never trusted.
import { readFile } from "node:fs/promises";
import { matchesInstance } from "../../../src/core/health.ts";
import type { ReadOp } from "../../../src/durable/read/protocol.ts";

/** The bot is not running, is stopping, or is not the recorded instance. */
export class BotOffline extends Error { override name = "BotOffline"; }

/** The bot answered with a refusal; `code` is the bot's error name (SpaceChanged, ReadBusy, ReadLimit…). */
export class BotReadError extends Error {
  override name = "BotReadError";
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export interface BotReader {
  read<T>(op: ReadOp, signal?: AbortSignal): Promise<T>;
}

type Instance = { port: number; token: string; instanceId: string; pid: number; startedAt: number };

export interface BotLinkOptions {
  /** The bot's `data/state/instance.json`. */
  instanceFile: string;
  /** Requests in flight at once; the bot's read channel takes four, one stays free for others. */
  concurrency?: number;
  /** How long a /health check stays good for the same instance. */
  verifyMs?: number;
  /** Per request; above the bot's own read deadline (20 s) so its answer arrives first. */
  timeoutMs?: number;
  now?: () => number;
}

const signalWith = (timeoutMs: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

export class BotLink implements BotReader {
  readonly #options: Required<BotLinkOptions>;
  #verified: { key: string; at: number } | undefined;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(options: BotLinkOptions) {
    this.#options = { concurrency: 3, verifyMs: 10_000, timeoutMs: 30_000, now: Date.now, ...options };
  }

  async read<T>(op: ReadOp, signal?: AbortSignal): Promise<T> {
    await this.#acquire(signal);
    try {
      // A bare 404 (not the route's own JSON answer, which uses 404 for a missing space) means the token no longer
      // matches: the bot restarted between reading its record and the request.
      for (let attempt = 0; ; attempt++) {
        const instance = await this.#verify(signal);
        const response = await this.#post(instance, op, signal);
        const body = response.body as { status?: unknown; result?: unknown; code?: unknown; message?: unknown } | null;
        const refused = response.status === 404 && body?.status !== "error";
        if (refused && attempt === 0) { this.#verified = undefined; continue; }
        if (refused) throw new BotOffline("机器人拒绝了读取请求（实例口令不符），它可能刚刚重启，请稍后重试");
        if (response.status === 200 && body?.status === "ok") return body.result as T;
        throw new BotReadError(typeof body?.message === "string" ? body.message : `机器人读取失败（HTTP ${response.status}）`, response.status,
          typeof body?.code === "string" ? body.code : "unknown");
      }
    } finally {
      this.#release();
    }
  }

  async #instance(): Promise<Instance> {
    let text: string;
    try { text = await readFile(this.#options.instanceFile, "utf8"); }
    catch { throw new BotOffline("机器人未运行（没有服务实例记录）"); }
    try {
      const value = JSON.parse(text) as Partial<Instance>;
      if (Number.isSafeInteger(value.port) && typeof value.token === "string" && value.token.length >= 16 && typeof value.instanceId === "string"
        && Number.isSafeInteger(value.pid) && Number.isFinite(value.startedAt)) return value as Instance;
    } catch {}
    throw new BotOffline("机器人的服务实例记录无法识别");
  }

  async #verify(signal?: AbortSignal): Promise<Instance> {
    const instance = await this.#instance();
    const key = `${instance.instanceId}:${instance.port}:${instance.pid}:${instance.startedAt}:${instance.token}`;
    const now = this.#options.now();
    if (this.#verified?.key === key && now - this.#verified.at < this.#options.verifyMs) return instance;
    this.#verified = undefined;
    let body: Record<string, unknown> | undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/health`, { signal: signalWith(3_000, signal), redirect: "error" });
      body = await response.json() as Record<string, unknown>;
    } catch {
      signal?.throwIfAborted();
      throw new BotOffline("机器人未运行（本机端口没有应答）");
    }
    if (!matchesInstance(body, instance, instance.port)) throw new BotOffline("本机端口上的服务不是记录中的机器人实例，机器人可能未运行或正在重启");
    if (body.status !== "ready") throw new BotOffline("机器人正在停止");
    if (body.verificationOnly === true) throw new BotOffline("运行中的是不连接平台的验证实例，不提供会话读取");
    this.#verified = { key, at: now };
    return instance;
  }

  async #post(instance: Instance, op: ReadOp, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${instance.port}/_admin/read`, {
        method: "POST", headers: { Authorization: `Bearer ${instance.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(op), signal: signalWith(this.#options.timeoutMs, signal), redirect: "error",
      });
    } catch (error) {
      signal?.throwIfAborted();
      this.#verified = undefined;
      if ((error as Error).name === "TimeoutError") throw new BotReadError(`机器人 ${Math.round(this.#options.timeoutMs / 1000)} 秒内没有答复`, 504, "TimeoutError");
      throw new BotOffline("机器人没有应答，它可能已经停止");
    }
    return { status: response.status, body: await response.json().catch(() => null) };
  }

  #acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#active < this.#options.concurrency) { this.#active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const start = () => { signal?.removeEventListener("abort", abort); this.#active++; resolve(); };
      const abort = () => {
        const index = this.#waiting.indexOf(start);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal!.reason);
      };
      this.#waiting.push(start);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #release(): void {
    this.#active--;
    this.#waiting.shift()?.();
  }
}
