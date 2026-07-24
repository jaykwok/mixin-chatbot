// HTTP 工具：可抛出的 HttpError + 仅用于日志的客户端 IP 提取。
import type { Context } from "hono";

/** 可抛出的 HTTP 错误，webhook 层捕获后返回对应状态码。 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 从请求提取客户端 IP（X-Forwarded-For 优先，否则回退 X-Real-IP）。仅用于日志，不参与鉴权。 */
export function getClientIp(c: Context): string {
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return c.req.header("X-Real-IP") ?? "Unknown";
}
