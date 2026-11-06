// Request origin checks. A page on another port of the same host is "same-site", so SameSite=Strict cookies still ride
// along with its requests: every API call must prove it comes from this exact origin.

export type RequestKind = "page" | "asset" | "api" | "download";

export interface GuardConfig { hosts: ReadonlySet<string>; origins: ReadonlySet<string> }

/** The console port plus local ports explicitly allowed for an SSH forward that uses a different local port. */
export function guardConfig(port: number, forwardedPorts: readonly number[] = []): GuardConfig {
  const ports = [port, ...forwardedPorts];
  return {
    hosts: new Set(ports.map(value => `127.0.0.1:${value}`)),
    origins: new Set(ports.map(value => `http://127.0.0.1:${value}`)),
  };
}

/** Returns why the request is refused, or null when it may proceed. */
export function refusal(request: Request, kind: RequestKind, config: GuardConfig): string | null {
  const host = request.headers.get("host");
  if (!host || !config.hosts.has(host)) return "Host 不是控制台地址";
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  if (origin !== null && !config.origins.has(origin)) return "来源不是控制台本身";
  switch (kind) {
    case "page":
      // Typing or pasting the link is "none"; reloads are same-origin. Navigations from other sites are refused.
      if (request.method !== "GET" && request.method !== "HEAD") return "请求方法不允许";
      return site === null || site === "none" || site === "same-origin" ? null : "页面只能直接打开";
    case "asset":
      if (request.method !== "GET" && request.method !== "HEAD") return "请求方法不允许";
      return site === null || site === "same-origin" ? null : "资源只供控制台页面加载";
    case "api":
      // The custom header forces a CORS preflight for any cross-origin caller, and the console never answers one.
      if (request.headers.get("x-console-request") !== "1") return "缺少控制台请求标记";
      if (site !== null && site !== "same-origin") return "只接受控制台页面发起的请求";
      if (request.method !== "GET" && request.method !== "HEAD" && origin === null) return "写请求缺少来源";
      return null;
    case "download":
      // A navigation cannot carry the request header, so a download needs a one-time ticket from an API request, and only
      // the console page itself may start it: a typed or pasted link ("none") is refused too.
      if (request.method !== "GET") return "请求方法不允许";
      return site === null || site === "same-origin" ? null : "下载只能由控制台页面发起";
  }
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "font-src 'self'; manifest-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
