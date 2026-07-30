// HTTP 工具：可抛出的 HttpError + 仅用于日志的客户端 IP 提取。
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

/** 可抛出的 HTTP 错误，webhook 层捕获后返回对应状态码。 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 先摘要为固定长度再比较，避免不同长度的候选密钥走明显不同的比较路径。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a, "utf8").digest();
  const bDigest = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(aDigest, bDigest) &&
    Buffer.byteLength(a, "utf8") === Buffer.byteLength(b, "utf8");
}

/** 接受 application/json 及标准的 +json 媒体类型；空值由调用方决定是否放行。 */
export function isJsonContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^application\/(?:json|[^+\s]+\+json)$/u.test(mediaType);
}

/** 从请求提取客户端 IP（X-Forwarded-For 优先，否则回退 X-Real-IP）。仅用于日志，不参与鉴权。 */
export function getClientIp(c: Context): string {
  const xff = c.req.header("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return c.req.header("X-Real-IP") ?? "Unknown";
}
