import type { Context } from "hono";
import { REJECTION_LOG_DETAIL_LIMIT, REJECTION_LOG_WINDOW_MS } from "../core/config.ts";
import { log } from "../core/log.ts";
import { getClientIp, type HttpError } from "./http.ts";

const categories = {
  webhook_secret_mismatch: "suspected_probe",
  webhook_secret_missing: "suspected_probe",
  route_not_found: "suspected_probe",
  invalid_request: "request_validation",
  forbidden_request: "request_validation",
  request_timeout: "request_validation",
  payload_too_large: "request_validation",
  unsupported_media_type: "request_validation",
  request_rejected: "request_validation",
  service_stopping: "runtime_protection",
  callback_route_capacity: "runtime_protection",
  callback_route_conflict: "runtime_protection",
  request_capacity: "runtime_protection",
  runtime_rejected: "runtime_protection",
} as const;
type Reason = keyof typeof categories;
type Category = (typeof categories)[Reason];
interface Bucket {
  total: number;
  details: number;
  reasons: Partial<Record<Reason, number>>;
}

/** 每个应用最多三个桶；不按攻击者可控的 IP、路径或错误消息建表。 */
export class RejectionLogger {
  private buckets = new Map<Category, Bucket>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly warn: (message: string) => void = (message) => log.warn(message),
    private readonly windowMs = REJECTION_LOG_WINDOW_MS,
    private readonly detailLimit = REJECTION_LOG_DETAIL_LIMIT,
  ) {}

  record(c: Context, status: number, reason: Reason): void {
    if (!this.timer) {
      // 即使攻击停止、没有后续请求，也按时输出汇总；不阻止进程退出。
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      this.timer.unref();
    }
    const category = categories[reason];
    let bucket = this.buckets.get(category);
    if (!bucket) {
      bucket = { total: 0, details: 0, reasons: {} };
      this.buckets.set(category, bucket);
    }
    bucket.total++;
    bucket.reasons[reason] = (bucket.reasons[reason] ?? 0) + 1;
    if (bucket.details >= this.detailLimit) return;
    bucket.details++;
    // 不记录 query、body、Authorization 或 HttpError.message；保持长度有界。
    const path = c.req.path.startsWith("/webhook/") ? "/webhook/<redacted>" : c.req.path;
    this.warn(
      `拒绝请求 - 分类: ${category}, IP: ${getClientIp(c).slice(0, 128)}, 方法: ${c.req.method.slice(0, 32)}, 路径: ${path.slice(0, 256)}, 状态码: ${status}, 原因: ${reason}`
    );
  }

  httpError(c: Context, error: HttpError): void {
    const reasons: Partial<Record<number, Reason>> = {
      400: "invalid_request", 403: "forbidden_request", 408: "request_timeout",
      413: "payload_too_large", 415: "unsupported_media_type",
    };
    this.record(c, error.status, error.reason ??
      (error.status === 409 || error.status >= 500 ? "runtime_rejected" :
        reasons[error.status] ?? "request_rejected"));
  }

  /** 窗口结束或服务开始关闭时汇总。汇总总数已包含明细，不应重复相加。 */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const [category, bucket] of this.buckets) {
      this.warn(
        `拒绝请求汇总 - 分类: ${category}, 总数: ${bucket.total}, 已记录: ${bucket.details}, 已抑制: ${bucket.total - bucket.details}, 原因计数: ${JSON.stringify(bucket.reasons)}`
      );
    }
    this.buckets.clear();
  }
}
