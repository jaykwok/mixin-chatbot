// 事件 Stream：一个应用同时只有一条服务连接。应答 stream.validate，消息事件同步交给回调，断线指数退避重连。
import { log } from "../../core/log.ts";
import type { PlatformClient } from "./client.ts";

/** 帧解析后的事件；`sentAt` 来自 X-CTQ-Timestamp（毫秒），缺失或无效时为 undefined。 */
export interface StreamEvent {
  readonly payload: Record<string, unknown>;
  readonly sentAt: number | undefined;
  readonly receivedAt: number;
}

export interface StreamStatus {
  readonly connected: boolean;
  /** 当前连接建立时间。 */
  readonly connectedAt?: number;
  /** 最近一次断开（或连接失败）的时间与原因。 */
  readonly lastDisconnect?: { readonly at: number; readonly reason: string };
  /** 从启动到现在断开后重新连上的次数。 */
  readonly reconnects: number;
  /** 当前断开开始的时间；连接正常时为 undefined。 */
  readonly disconnectedSince?: number;
  readonly lastEventAt?: number;
}

export interface StreamOptions {
  /** 同步处理消息事件。抛错只记日志，不影响连接。 */
  readonly onEvent: (event: StreamEvent) => void;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** 断开超过这个时长写告警日志。 */
  readonly warnAfterMs?: number;
  /** 存活检查：每隔这么久发一次 ping。 */
  readonly pingIntervalMs?: number;
}

const DEFAULT_WARN_AFTER_MS = 60_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;

export class StreamConnection {
  #socket: WebSocket | undefined;
  #stopped = true;
  #attempts = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #warnTimer: ReturnType<typeof setTimeout> | undefined;
  #everConnected = false;
  #forceToken = false;
  #status: { connected: boolean; connectedAt?: number; lastDisconnect?: { at: number; reason: string }; reconnects: number;
    disconnectedSince?: number; lastEventAt?: number } = { connected: false, reconnects: 0 };
  readonly #initialBackoff: number;
  readonly #maxBackoff: number;
  readonly #warnAfter: number;
  readonly #pingInterval: number;
  #closed: Promise<void> = Promise.resolve();

  constructor(private readonly client: PlatformClient, private readonly options: StreamOptions) {
    this.#initialBackoff = options.initialBackoffMs ?? 1000;
    this.#maxBackoff = options.maxBackoffMs ?? 60_000;
    this.#warnAfter = options.warnAfterMs ?? DEFAULT_WARN_AFTER_MS;
    this.#pingInterval = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  }

  status(): StreamStatus { return { ...this.#status }; }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#markDisconnected("尚未连接");
    void this.#connect();
  }

  /** 关闭连接并停止重连；返回时套接字已关闭。 */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#warnTimer);
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "service stopping");
      // 半开连接收不到对端的关闭帧，关闭握手等不完。
      const force = setTimeout(() => socket.terminate(), 2000);
      await this.#closed;
      clearTimeout(force);
    }
    this.#status = { ...this.#status, connected: false };
  }

  #markDisconnected(reason: string): void {
    const now = this.client.now();
    this.#status = { ...this.#status, connected: false, connectedAt: undefined, lastDisconnect: { at: now, reason },
      disconnectedSince: this.#status.disconnectedSince ?? now };
    if (this.#warnTimer === undefined && !this.#stopped) {
      this.#warnTimer = setTimeout(() => {
        this.#warnTimer = undefined;
        if (!this.#status.connected && !this.#stopped)
          log.warn(`Stream 已断开超过 ${Math.round(this.#warnAfter / 1000)} 秒：${this.#status.lastDisconnect?.reason ?? "未知原因"}`);
      }, this.#warnAfter);
      this.#warnTimer.unref?.();
    }
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    let token: string;
    try {
      // 上次连接未建立就断开时，先换新 token 再连。
      if (this.#forceToken) {
        const stale = await this.client.appToken.get(this.client.closingSignal);
        this.client.appToken.invalidate(stale);
      }
      token = await this.client.appToken.get(this.client.closingSignal);
    } catch (error) {
      if (this.#stopped) return;
      this.#markDisconnected(`换取 token 失败：${error instanceof Error ? error.message : String(error)}`);
      this.#schedule();
      return;
    }
    if (this.#stopped) return;
    let opened = false;
    // 半开连接（例如 NAT 超时回收）不会触发 close：定时 ping，连续一个周期既没有 pong 也没有任何帧就断开重连。
    // 只在本连接回过 pong 之后才执行，不回 pong 的服务端不会因此被反复重连。
    let answersPing = false, quiet = false;
    let pinger: ReturnType<typeof setInterval> | undefined;
    let resolveClosed!: () => void;
    this.#closed = new Promise(resolve => { resolveClosed = resolve; });
    // Bun 的 WebSocket 构造参数支持 headers 扩展。
    const socket = new WebSocket(this.client.endpoints.stream, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      opened = true;
      this.#attempts = 0;
      this.#forceToken = false;
      clearTimeout(this.#warnTimer);
      this.#warnTimer = undefined;
      const now = this.client.now();
      const downFor = this.#status.disconnectedSince === undefined ? 0 : now - this.#status.disconnectedSince;
      if (this.#everConnected) this.#status.reconnects++;
      this.#everConnected = true;
      this.#status = { ...this.#status, connected: true, connectedAt: now, disconnectedSince: undefined };
      log.info(`Stream 已连接${downFor >= 1000 ? `（断开 ${Math.round(downFor / 1000)} 秒后恢复）` : ""}`);
      pinger = setInterval(() => {
        if (this.#socket !== socket) { clearInterval(pinger); return; }
        if (quiet && answersPing) {
          clearInterval(pinger);
          log.warn(`Stream ${Math.round(this.#pingInterval / 1000)} 秒没有回应 ping，断开重连`);
          socket.terminate();
          return;
        }
        quiet = true;
        socket.ping();
      }, this.#pingInterval);
      pinger.unref?.();
    });
    socket.addEventListener("pong", () => { answersPing = true; quiet = false; });
    socket.addEventListener("message", message => {
      quiet = false;
      if (this.#socket !== socket) return;
      const raw = typeof message.data === "string" ? message.data : Buffer.from(message.data as ArrayBuffer).toString("utf8");
      this.#frame(socket, raw);
    });
    socket.addEventListener("close", event => {
      clearInterval(pinger);
      resolveClosed();
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (this.#stopped) return;
      const reason = `${opened ? "连接断开" : "连接未建立"}（code ${event.code}${event.reason ? `，${event.reason}` : ""}）`;
      if (!opened) this.#forceToken = true;
      log.warn(`Stream ${reason}`);
      this.#markDisconnected(reason);
      this.#schedule();
    });
  }

  #schedule(): void {
    if (this.#stopped) return;
    const delay = Math.min(this.#maxBackoff, this.#initialBackoff * 2 ** Math.min(this.#attempts, 16));
    this.#attempts++;
    this.#timer = setTimeout(() => void this.#connect(), delay);
  }

  #frame(socket: WebSocket, raw: string): void {
    const receivedAt = this.client.now();
    let frame: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      frame = JSON.parse(raw);
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("帧不是对象");
      if (typeof frame["X-CTQ-Signature"] === "string" && frame["X-CTQ-Signature"]) {
        // 平台开启了传输层加密；本服务不实现解密。
        log.warn("Stream 帧带签名（平台开启了传输加密），已丢弃；请在开发者后台关闭加密");
        return;
      }
      payload = typeof frame.data === "string" ? JSON.parse(frame.data) : frame;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("事件不是对象");
    } catch (error) {
      log.warn(`Stream 帧无法解析，已丢弃：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (payload.eventType === "stream.validate") {
      if (typeof payload.eventId === "string" && payload.eventId) {
        socket.send(JSON.stringify({ eventType: "stream.validate.ack", eventId: payload.eventId, success: true }));
        log.info("已应答 Stream 验证");
      }
      return;
    }
    const stamp = Number(frame["X-CTQ-Timestamp"]);
    this.#status.lastEventAt = receivedAt;
    try { this.options.onEvent({ payload, sentAt: Number.isFinite(stamp) && stamp > 0 ? stamp : undefined, receivedAt }); }
    catch (error) { log.error(`Stream 事件处理失败：${error instanceof Error ? error.message : String(error)}`); }
  }
}
