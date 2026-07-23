// HTTP 工具：可抛出的 HttpError + 客户端 IP 提取。
// （鉴权/白名单已移除：管理页面下线，访问控制交给服务器防火墙。）
import type { Context } from "hono";

/** 可抛出的 HTTP 错误，webhook 层捕获后返回对应状态码。 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 从请求提取客户端 IP（X-Forwarded-For 优先，否则回退 x-real-ip）。仅用于日志。 */
export function getClientIp(c: Context): string {
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  // Hono on Bun：尝试从原始请求拿 remote addr，拿不到则 Unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addr = (c.req.raw as any)?.headers?.get("x-real-ip");
  return addr ?? "Unknown";
}
