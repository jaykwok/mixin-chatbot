// HTTP 工具：本机控制接口的令牌比较。
import { createHash, timingSafeEqual } from "node:crypto";

/** 先摘要为固定长度再比较，避免不同长度的候选密钥走明显不同的比较路径。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a, "utf8").digest();
  const bDigest = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(aDigest, bDigest) &&
    Buffer.byteLength(a, "utf8") === Buffer.byteLength(b, "utf8");
}
