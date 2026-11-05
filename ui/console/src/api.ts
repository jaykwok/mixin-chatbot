// Same-origin JSON calls. Every request carries X-Console-Request (the server refuses API calls without it, which keeps
// other pages on this host out even though SameSite cookies would ride along). Only user actions send the intent
// header that renews the idle timer; background polls never do.
import type { ApiError } from "./contract.ts";

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly code?: ApiError["code"] | "offline") {
    super(message);
  }
}

type Lost = (reason: "session" | "offline") => void;
let lost: Lost = () => {};
// Every login check, login and logout starts a new generation. A request reports a lost session or console only while
// the generation it was sent in is still current: a late failure from the page of an earlier login (a poll still in
// flight when a new login link was opened) must not take down the login shown now.
let generation = 0;

/** Called when a request finds the session gone or the console unreachable, so the page can drop its content. */
export function onConnectionLost(listener: Lost): void {
  lost = listener;
}

/** A login check, login or logout begins: requests sent before it no longer report a lost session or console. */
export function newLoginGeneration(): void {
  generation++;
}

export interface CallOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** A user action: renews the session's idle timer. */
  intent?: boolean;
  /** Do not report a missing session or an unreachable console; the caller decides what the failure means. */
  quiet?: boolean;
  /** Give up after this long, as if the console were unreachable (a half-open SSH tunnel may never answer). */
  timeoutMs?: number;
  /** Page/query cancellation must not be mistaken for loss of the console. */
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Console-Request": "1" };
  if (options.intent) headers["X-Console-Intent"] = "user";
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const sentIn = generation;
  const report = (reason: "session" | "offline") => { if (!options.quiet && sentIn === generation) lost(reason); };
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET", headers, credentials: "same-origin", cache: "no-store", redirect: "error",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.timeoutMs === undefined ? options.signal : options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    report("offline");
    const timedOut = (error as Error | null)?.name === "TimeoutError";
    throw new ApiFailure(timedOut ? `控制台在 ${Math.round(options.timeoutMs! / 1000)} 秒内没有应答` : "无法连接控制台，它可能已经退出", 0, "offline");
  }
  const payload = await response.json().catch(() => null) as (T & ApiError) | null;
  if (!response.ok) {
    if (response.status === 401) report("session");
    throw new ApiFailure(payload?.error ?? `请求失败（HTTP ${response.status}）`, response.status, payload?.code);
  }
  return payload as T;
}
