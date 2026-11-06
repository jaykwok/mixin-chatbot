// The console's loopback HTTP server. No npm imports: Linux Docker hosts run it without node_modules.
import type { ApiError, Overview, SessionResponse, SessionView } from "../ui/src/contract.ts";
import type { Auth } from "./auth.ts";
import type { Bundle } from "./bundle.ts";
import { refusal, SECURITY_HEADERS, type GuardConfig, type RequestKind } from "./guard.ts";
import { ApiProblem, type Route } from "./routes.ts";

export interface ConsoleServerOptions {
  port: number;
  guard: GuardConfig;
  bundle: Bundle;
  auth: Auth;
  /** Not secret: lets a second `bun run console` recognise a live instance. */
  instanceId: string;
  /** False after code replacement: only login and stable task records may be used. */
  current?: () => boolean;
  dataSignal?: AbortSignal;
  overview: () => Promise<Overview>;
  /** Further API routes by `METHOD /path`, all behind the session. */
  routes?: Record<string, Route>;
  /** Answers `GET /download/<ticket>` for a logged-in session. */
  download?: (ticket: string, context: { session: SessionView; signal: AbortSignal }) => Response | Promise<Response>;
}

const MAX_BODY = 16 * 1024;
/** Routes marked slow (several bot reads in a row) may take this long; others get the server's idle timeout. */
const SLOW_ROUTE_SECONDS = 120;
/**
 * A download connection may sit this long without any byte moving (a bot read retried, a browser that stopped reading)
 * before it is closed; the export also has its own total limit.
 */
const DOWNLOAD_IDLE_SECONDS = 120;

/** The part of Bun's server a handler uses: lifting the idle timeout of one request. */
export interface RequestTimeouts { timeout(request: Request, seconds: number): void }

function respond(body: string | Uint8Array | null, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return respond(JSON.stringify(value), status, { "Content-Type": "application/json; charset=utf-8", ...headers });
}

const failure = (status: number, error: string, code: ApiError["code"], headers: Record<string, string> = {}) =>
  json({ error, code } satisfies ApiError, status, headers);

function cookie(request: Request, name: string): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new Error("请求格式应为 JSON");
  if (!request.body) throw new Error("缺少请求内容");
  const reader = request.body.getReader(), decoder = new TextDecoder(); let text = "", bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY) { await reader.cancel(); throw new Error("请求内容过大"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

function classify(path: string): RequestKind | null {
  if (path === "/") return "page";
  if (path.startsWith("/assets/")) return "asset";
  if (path.startsWith("/api/")) return "api";
  if (path.startsWith("/download/")) return "download";
  return null;
}

export function createHandler(options: ConsoleServerOptions): (request: Request, server?: RequestTimeouts) => Promise<Response> {
  const { auth, bundle } = options;
  const clearCookie = { "Set-Cookie": `${auth.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` };

  return async (request, server) => {
    let path: string;
    try { path = new URL(request.url).pathname; }
    catch { return failure(400, "请求地址无效", "guard"); }
    const kind = classify(path);
    const refused = refusal(request, kind ?? "asset", options.guard);
    if (refused) return failure(403, refused, "guard");
    if (kind === null) return failure(404, "没有这个地址", "not-found");

    if (kind === "page") return respond(request.method === "HEAD" ? null : bundle.index.body, 200, { "Content-Type": bundle.index.type });
    if (kind === "asset") {
      const asset = bundle.assets.get(path);
      if (!asset) return failure(404, "没有这个资源", "not-found");
      return respond(request.method === "HEAD" ? null : asset.body, 200, { "Content-Type": asset.type });
    }

    const route = `${request.method} ${path}`;
    if (route === "GET /api/instance") return json({ instanceId: options.instanceId });
    if (route === "POST /api/session/exchange") {
      let token: unknown;
      try { token = (await readJson(request) as { token?: unknown } | null)?.token; }
      catch (error) { return failure(400, (error as Error).message, "input"); }
      const result = typeof token === "string" ? auth.exchange(token) : null;
      if (!result) return failure(401, "登录链接无效、已使用或已过期。请在运行控制台的终端按 Enter 获取新链接。", "session");
      const maxAge = Math.ceil((result.view.expiresAt - result.view.createdAt) / 1000);
      return json({ session: result.view, now: auth.now() } satisfies SessionResponse, 200, {
        "Set-Cookie": `${auth.cookieName}=${result.sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
      });
    }

    // Everything below needs a session. Only explicit user actions renew the idle timer; polls never do.
    const sessionId = cookie(request, auth.cookieName);
    const touch = request.headers.get("x-console-intent") === "user";
    const session = auth.session(sessionId, touch);
    if (!session) return failure(401, "登录已失效。请在运行控制台的终端按 Enter 获取新链接。", "session", clearCookie);
    const stable = route === "GET /api/session" || route === "POST /api/session/touch" || route === "POST /api/session/logout"
      || /^GET \/api\/tasks(?:\/task-[a-f0-9]{32}(?:\/events)?)?$/.test(route) || /^POST \/api\/tasks\/task-[a-f0-9]{32}\/log$/.test(route);
    const current = () => options.current?.() ?? true;
    const replaced = () => failure(409, "代码已变化。当前控制台只能查看任务结果；请退出并重新运行 bun run console。", "version-changed");
    if (route === "GET /api/runtime") return json({ current: current() });
    if (!current() && !stable) return replaced();

    if (kind === "download") {
      if (!options.download) return failure(404, "没有这个地址", "not-found");
      server?.timeout(request, DOWNLOAD_IDLE_SECONDS);
      return options.download(path.slice("/download/".length), { session, signal: request.signal });
    }
    switch (route) {
      case "GET /api/session":
        return json({ session, now: auth.now() } satisfies SessionResponse);
      case "POST /api/session/touch":
        return json({ session: auth.session(sessionId, true) ?? session, now: auth.now() } satisfies SessionResponse);
      case "POST /api/session/logout":
        auth.revoke(sessionId);
        return json({ ok: true }, 200, clearCookie);
      case "GET /api/overview":
        const overview = await options.overview();
        return current() ? json(overview) : replaced();
    }
    let custom = options.routes?.[route];
    let params: Record<string, string> = {};
    if (!custom) {
      for (const [pattern, candidate] of Object.entries(options.routes ?? {})) {
        if (!pattern.includes(":")) continue;
        const pieces = pattern.split("/"), actual = route.split("/");
        if (pieces.length !== actual.length || !pieces.every((piece, index) => piece.startsWith(":") || piece === actual[index])) continue;
        params = Object.fromEntries(pieces.flatMap((piece, index) => piece.startsWith(":") ? [[piece.slice(1), actual[index]!]] : []));
        custom = candidate; break;
      }
    }
    if (!custom) return failure(404, "没有这个接口", "not-found");
    if (custom.slow) server?.timeout(request, SLOW_ROUTE_SECONDS);
    let body: unknown;
    if (request.method === "POST" && !custom.raw) {
      try { body = await readJson(request); }
      catch (error) { return failure(400, (error as Error).message, "input"); }
    }
    try {
      const signal = stable || !options.dataSignal ? request.signal : AbortSignal.any([request.signal, options.dataSignal]);
      const result = await custom.run({ session, body, signal, request, params, sessionAlive: () => !!auth.session(sessionId, false) });
      if (!stable && !current()) return replaced();
      if (result instanceof Response) {
        const headers = new Headers(result.headers);
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
        return new Response(result.body, { status: result.status, headers });
      }
      return json(result);
    } catch (error) {
      if (error instanceof ApiProblem) return failure(error.status, error.message, error.code);
      console.error(`控制台接口 ${route} 出错：${error instanceof Error ? error.message : String(error)}`);
      return failure(500, "控制台内部错误，详情见运行控制台的终端", "internal");
    }
  };
}

/** Binds 127.0.0.1 only. A busy port is an error: the console never scans for another one. */
export function startServer(options: ConsoleServerOptions) {
  const handler = createHandler(options);
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
      reusePort: false,
      maxRequestBodySize: 512 * 1024 * 1024,
      idleTimeout: 30,
      fetch: handler,
      error: error => {
        console.error(`控制台请求出错：${error.message}`);
        return failure(500, "控制台内部错误，详情见运行控制台的终端", "internal");
      },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(String((error as Error).message))) {
      throw new Error(`端口 ${options.port} 已被占用。控制台不会自动换端口；请关闭占用它的程序，或用 bun run console --port <端口> 指定其他端口。`);
    }
    throw error;
  }
}
