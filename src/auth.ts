// 鉴权：/admin Basic Auth 中间件 + webhook 鉴权。对应 Python auth.py + authorize_webhook。
import type { Context, Next } from "hono";
import { log } from "./log.ts";
import { ALLOWED_IPS, ALLOWED_ROBOT_IDS, APP_PASSWORD, APP_USERNAME } from "./config.ts";

/** 可抛出的 HTTP 错误，webhook 层捕获后返回对应状态码。 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 常量时间字符串比较（防时序攻击），等价 Python hmac.compare_digest。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function unauthorized(): Response {
  return new Response("认证失败", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="admin"' },
  });
}

/** /admin Basic Auth 中间件。 */
export async function requireAdminAuth(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();
  let user = "";
  let pass = "";
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch {
    return unauthorized();
  }
  const ok =
    timingSafeEqualStr(user, APP_USERNAME!) && timingSafeEqualStr(pass, APP_PASSWORD!);
  if (!ok) return unauthorized();
  await next();
}

/** 从请求提取客户端 IP（X-Forwarded-For 优先，否则回退连接地址）。 */
export function getClientIp(c: Context): string {
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  // Hono on Bun：尝试从请求信息拿 remote addr，拿不到则 Unknown
  const addr = (c.req.raw as any)?.headers?.get("x-real-ip");
  return addr ?? "Unknown";
}

/** webhook 鉴权：robotId 白名单（强校验）+ 来源 IP 白名单（可选）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function authorizeWebhook(data: any, clientIp: string): void {
  if (ALLOWED_ROBOT_IDS.size === 0) {
    throw new HttpError(503, "未配置 ROBOT_IDS 白名单，服务暂不可用");
  }
  const robotId = String(data?.robotId ?? "").trim();
  if (!ALLOWED_ROBOT_IDS.has(robotId)) {
    log.warn(`webhook 鉴权失败 - robotId 不在白名单: ${robotId}, IP: ${clientIp}`);
    throw new HttpError(403, "拒绝访问");
  }
  if (ALLOWED_IPS.size > 0 && !ALLOWED_IPS.has(clientIp)) {
    log.warn(`webhook 鉴权失败 - IP 不在白名单: ${clientIp}, robotId: ${robotId}`);
    throw new HttpError(403, "拒绝访问");
  }
}
