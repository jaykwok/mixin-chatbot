// 开放平台 HTTP 客户端：token 缓存、单次超时、按请求类型重试与失败分类。
// 只记录路径和状态码，不记录 token、AppSecret、请求体和预签名地址。
import { setTimeout as sleep } from "node:timers/promises";
import { abortError, waitFor } from "../../core/lifecycle.ts";
import { log } from "../../core/log.ts";
import { platformEndpoints, type AppBotConfig, type PlatformEndpoints } from "./config.ts";

export const PLATFORM_HTTP_TIMEOUT_MS = 15_000;
const TOKEN_EARLY_REFRESH_MS = 60_000;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];
const MAX_COOLDOWN_MS = 60_000;

/**
 * unsent：确定没有发出（连接未建立、DNS 失败、平台在鉴权/限流阶段拒绝）；
 * uncertain：可能已被平台处理（超时、连接中途断开）；
 * rejected：平台返回了明确的失败响应。
 */
export type FailureKind = "unsent" | "uncertain" | "rejected";

export class PlatformRequestError extends Error {
  /** code：平台响应里的业务错误码（有时）；按它区分错误，不按文案。 */
  constructor(message: string, readonly kind: FailureKind, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "PlatformRequestError";
  }
}

export interface ApiResponse {
  readonly status: number;
  readonly json: Record<string, unknown> | null;
  readonly headers: Headers;
}

/** HTTP 2xx 且业务成功（`success:true` 或 `code` 为 0/200）。 */
export function accepted(response: ApiResponse): boolean {
  return response.status >= 200 && response.status < 300
    && (response.json?.success === true || response.json?.code === 0 || response.json?.code === 200);
}

/** 业务数据对象（`data` 字段）；没有时为空对象。 */
export function responseData(response: ApiResponse): Record<string, unknown> {
  const data = response.json?.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

/** 连接阶段失败：请求一定没有到达平台。 */
const UNSENT_CODES = new Set(["ECONNREFUSED", "ConnectionRefused", "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "DNSException",
  "FailedToOpenSocket", "UnableToConnect", "ENETUNREACH", "EHOSTUNREACH", "ERR_INVALID_URL"]);

function failureKind(error: unknown): FailureKind {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && UNSENT_CODES.has(code) ? "unsent" : "uncertain";
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  const name = (error as { name?: unknown } | undefined)?.name;
  return typeof code === "string" ? code : typeof name === "string" ? name : "网络错误";
}

export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

interface TokenValue { readonly token: string; readonly expiresAt: number }

/** 合并并发换取，过期前 60 s 刷新；平台返回 401 时只作废引起 401 的那个 token。 */
export class TokenCache {
  #value: TokenValue | undefined;
  #pending: Promise<TokenValue> | undefined;

  constructor(private readonly fetchToken: () => Promise<{ token: string; expiresInSeconds: number }>,
    private readonly now: () => number = Date.now) {}

  async get(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const current = this.#value;
    if (current && this.now() < current.expiresAt - TOKEN_EARLY_REFRESH_MS) return current.token;
    this.#pending ??= this.fetchToken().then(
      ({ token, expiresInSeconds }) => {
        const value = { token, expiresAt: this.now() + expiresInSeconds * 1000 };
        this.#value = value;
        this.#pending = undefined;
        return value;
      },
      error => { this.#pending = undefined; throw error; },
    );
    return (await waitFor(this.#pending, signal)).token;
  }

  invalidate(token: string): void {
    if (this.#value?.token === token) this.#value = undefined;
  }
}

export type TokenKind = "app" | "address" | "none";

export interface RequestOptions {
  readonly body?: unknown;
  readonly token?: TokenKind;
  /** 可安全重放（换 token、查询、换下载地址）：网络失败和 5xx 都重试。否则只在确定未发出时重试。 */
  readonly idempotent?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** 用于日志的简短说明。 */
  readonly label?: string;
  /** 每次真正发起 HTTP 请求前调用；之后的中止意味着平台可能已经收到。 */
  readonly onSent?: () => void;
}

export interface ClientOptions {
  readonly endpoints?: PlatformEndpoints;
  readonly timeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly now?: () => number;
}

export class PlatformClient {
  readonly endpoints: PlatformEndpoints;
  readonly appToken: TokenCache;
  /** `/open/applied/*` 通讯录查询专用（`/seal/oauth2/token`，scope=address）。 */
  readonly addressToken: TokenCache;
  readonly #timeoutMs: number;
  readonly #retryDelays: readonly number[];
  readonly #closing = new AbortController();
  readonly now: () => number;
  #cooldownUntil = 0;

  constructor(readonly config: AppBotConfig, options: ClientOptions = {}) {
    this.endpoints = options.endpoints ?? platformEndpoints(config.environment);
    this.#timeoutMs = options.timeoutMs ?? PLATFORM_HTTP_TIMEOUT_MS;
    this.#retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? Date.now;
    this.appToken = new TokenCache(() => this.#fetchToken("/open-apis/v1/auth/token"), this.now);
    this.addressToken = new TokenCache(() => this.#fetchToken("/seal/oauth2/token", "address"), this.now);
  }

  get closingSignal(): AbortSignal { return this.#closing.signal; }

  /** 进程关闭：中止所有进行中的请求和等待。 */
  close(): void {
    if (!this.#closing.signal.aborted) this.#closing.abort(abortError("应用正在关闭，平台请求已取消"));
  }

  /** 平台限流冷却：所有请求在冷却结束前等待。 */
  noteRateLimit(headers: Headers): number {
    const delay = Math.min(Math.max(retryAfterMs(headers, this.now()) ?? 1000, 1000), MAX_COOLDOWN_MS);
    this.#cooldownUntil = Math.max(this.#cooldownUntil, this.now() + delay);
    log.warn(`开放平台返回 429，所有请求冷却 ${delay}ms`);
    return delay;
  }

  async waitCooldown(signal?: AbortSignal): Promise<void> {
    const wait = this.#cooldownUntil - this.now();
    if (wait > 0) await this.sleep(wait, signal);
  }

  /** 第 attempt 次重试前的等待时间；超过重试次数时为 undefined。 */
  retryDelay(attempt: number): number | undefined {
    return this.#retryDelays[attempt];
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await sleep(ms, undefined, { signal: this.#signal(signal) });
  }

  #signal(signal?: AbortSignal, timeoutMs?: number): AbortSignal {
    return AbortSignal.any([this.#closing.signal, ...(signal ? [signal] : []), ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])]);
  }

  /** 调用方或关闭引起的中止原样抛出；不当作网络失败。 */
  #rethrowAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason;
    if (this.#closing.signal.aborted) throw this.#closing.signal.reason;
  }

  async #fetchToken(path: string, scope?: string): Promise<{ token: string; expiresInSeconds: number }> {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.appId, client_secret: this.config.appSecret });
    if (scope) form.set("scope", scope);
    const response = await this.#exchange("POST", path, { body: form, token: "none", idempotent: true, label: "换取 token" });
    const json = response.json ?? {};
    const holder = typeof json.access_token === "string" ? json : responseData(response);
    const token = holder.access_token;
    if (response.status !== 200 || typeof token !== "string" || !token)
      throw new PlatformRequestError(`换取 token 失败：HTTP ${response.status}`, "rejected", response.status);
    const expires = Number(holder.expires_in);
    return { token, expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : 3600 };
  }

  /** 平台 API 调用。返回任意 HTTP 响应，由调用方判断业务结果；网络失败抛 PlatformRequestError。 */
  request(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    return this.#exchange(method, path, options);
  }

  async #exchange(method: string, path: string, options: RequestOptions & { body?: unknown }): Promise<ApiResponse> {
    const label = options.label ?? `${method} ${path}`;
    const tokens = options.token === "address" ? this.addressToken : options.token === "none" ? undefined : this.appToken;
    let authRetried = false;
    let attempt = 0;
    while (true) {
      this.#rethrowAbort(options.signal);
      await this.waitCooldown(options.signal);
      let token: string | undefined;
      try { token = tokens ? await tokens.get(this.#signal(options.signal)) : undefined; }
      catch (error) {
        this.#rethrowAbort(options.signal);
        throw error instanceof PlatformRequestError ? new PlatformRequestError(error.message, "unsent", error.status)
          : new PlatformRequestError(`换取 token 失败：${describe(error)}`, "unsent");
      }
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        headers["X-Client-Id"] = this.config.appId;
      }
      let body: string | URLSearchParams | undefined;
      if (options.body instanceof URLSearchParams) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = options.body;
      } else if (options.body !== undefined) {
        headers["Content-Type"] = "application/json; charset=utf-8";
        body = JSON.stringify(options.body);
      }
      let failure: PlatformRequestError;
      try {
        options.onSent?.();
        const response = await fetch(`${this.endpoints.api}${path}`, {
          method, headers, body, signal: this.#signal(options.signal, options.timeoutMs ?? this.#timeoutMs),
        });
        const text = await response.text();
        let json: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
        } catch { /* 非 JSON 响应由调用方按状态码处理 */ }
        const result = { status: response.status, json, headers: response.headers };
        if (response.status === 401 && token && tokens && !authRetried) {
          // 鉴权阶段拒绝，平台未处理请求；换新 token 重试一次。
          tokens.invalidate(token);
          authRetried = true;
          log.warn(`${label}：平台返回 401，重新换取 token`);
          continue;
        }
        if (response.status === 429) {
          const delay = this.noteRateLimit(response.headers);
          if (attempt < this.#retryDelays.length) { attempt++; await this.sleep(delay, options.signal); continue; }
          return result;
        }
        if (options.idempotent && response.status >= 500 && attempt < this.#retryDelays.length) {
          log.warn(`${label}：HTTP ${response.status}，稍后重试`);
          await this.sleep(this.#retryDelays[attempt++]!, options.signal);
          continue;
        }
        return result;
      } catch (error) {
        this.#rethrowAbort(options.signal);
        const kind = failureKind(error);
        failure = new PlatformRequestError(`${label}：${kind === "unsent" ? "连接失败" : "结果未知"}（${describe(error)}）`, kind);
      }
      if ((options.idempotent || failure.kind === "unsent") && attempt < this.#retryDelays.length) {
        log.warn(`${failure.message}，稍后重试`);
        await this.sleep(this.#retryDelays[attempt++]!, options.signal);
        continue;
      }
      throw failure;
    }
  }
}
