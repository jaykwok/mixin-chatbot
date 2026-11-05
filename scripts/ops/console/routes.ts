// Shapes shared by the server and the API modules: a route gets the session and the parsed body, and answers a JSON
// value or throws an ApiProblem. Bot and audit failures map to the page's error codes here.
import type { ApiErrorCode, SessionView } from "../../../ui/console/src/contract.ts";
import { AuditUnavailable } from "./audit.ts";
import { BotOffline, BotReadError } from "./bot.ts";

export interface RouteContext {
  session: SessionView;
  body: unknown;
  /** Aborts when the page goes away (the connection closes). */
  signal: AbortSignal;
  request?: Request;
  params?: Record<string, string>;
  /** Long-lived streams must recheck without renewing the idle deadline. */
  sessionAlive?: () => boolean;
}

export interface Route {
  run(context: RouteContext): Promise<unknown>;
  /** Allowed to take longer than the server's idle timeout (several bot reads in a row). */
  slow?: boolean;
  /** Authenticated streaming upload; the route enforces a declared byte limit before writing. */
  raw?: boolean;
}

export class ApiProblem extends Error {
  override name = "ApiProblem";
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string) { super(message); }
}

export const input = (message: string): never => { throw new ApiProblem(400, "input", message); };

const BOT_CODES: Record<string, [number, ApiErrorCode, string?]> = {
  SpaceChanged: [409, "space-changed", "会话库已更换（例如清空全部后重建），请重新打开这个空间"],
  SpaceAbsent: [404, "space-absent", "这个会话空间已不存在"],
  ReadBusy: [429, "busy", "机器人正忙于其他读取，请稍后重试"],
  ReadLimit: [413, "too-large"],
  ReadExpired: [504, "timeout", "读取超过期限，请稍后重试"],
  TimeoutError: [504, "timeout"],
  ReadRequestError: [400, "input"],
};

/**
 * The page's answer for a failure, or the error itself when it is the console's own (the server reports it as internal).
 * `clean` rewrites a message that may name members (the bot's own text) before it leaves the host.
 */
export function problemOf(error: unknown, clean: (text: string) => string = text => text): unknown {
  if (error instanceof ApiProblem) return error;
  if (error instanceof BotOffline) return new ApiProblem(503, "bot-offline", error.message);
  if (error instanceof AuditUnavailable) return new ApiProblem(503, "audit", `${error.message}，未执行这次操作`);
  if (error instanceof BotReadError) {
    const [status, code, text] = BOT_CODES[error.code] ?? [502, "bot-error" as const];
    return new ApiProblem(status, code, text ?? clean(error.message));
  }
  return error;
}
