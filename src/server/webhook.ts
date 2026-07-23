// webhook 处理逻辑：字段校验、请求去重、速率限制、后台异步处理（per-phone 串行）。
// 校验含安全约束：phone 格式（防会话文件名路径穿越）、内容长度、callBackUrl 结构（防 SSRF/伪造）。
import { createHash } from "node:crypto";
import { log } from "../lib/log.ts";
import {
  CALLBACK_PATH_PREFIX,
  DEDUP_TTL,
  DEBUG,
  MAX_CONTENT_LENGTH,
  MAX_DEDUP_SIZE,
  PHONE_PATTERN,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW,
  REQUIRED_WEBHOOK_FIELDS,
  VALID_CALLBACK_PORTS,
  VALID_HOSTNAMES,
} from "../lib/config.ts";
import { HttpError } from "./http.ts";
import { sendReplyWithMention } from "../im/im.ts";
import { handleUserMessage } from "../agent/agent.ts";

// 请求去重（Map 保持插入顺序，按序清过期）
const recentRequests = new Map<string, number>();
// 速率限制（每用户在窗口内的时间戳列表）
const rateLimits = new Map<string, number[]>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WebhookData = Record<string, any>;

export interface ValidatedRequest {
  phone: string;
  groupId: string;
  content: string;
  callbackUrl: string;
}

/** 验证并提取 webhook 数据。 */
export function validateWebhookData(data: WebhookData): ValidatedRequest {
  const missing = REQUIRED_WEBHOOK_FIELDS.filter((f) => !(f in data));
  if (missing.length) throw new HttpError(400, `缺少必要字段: ${missing.join(", ")}`);

  if (data.type !== "text") throw new HttpError(400, `不支持的消息类型: ${data.type}`);

  const phone = String(data.phone ?? "").trim();
  const groupId = String(data.groupId ?? "").trim();
  const callbackUrl = String(data.callBackUrl ?? "").trim();
  const textMsg = data.textMsg ?? {};
  const content =
    typeof textMsg === "object" ? String(textMsg.content ?? "").trim() : "";

  if (!phone || !groupId || !content) {
    throw new HttpError(400, "phone、groupId 或 content 不能为空");
  }
  // phone 被用作会话文件名，必须严格字符集（防 ../ 路径穿越）
  if (!PHONE_PATTERN.test(phone)) {
    throw new HttpError(400, "无效的 phone");
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new HttpError(413, `消息内容过长（上限 ${MAX_CONTENT_LENGTH} 字节）`);
  }

  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new HttpError(403, "无效的回调URL");
  }
  if (parsed.protocol !== "https:" || !VALID_HOSTNAMES.has(parsed.hostname)) {
    throw new HttpError(403, "无效的回调URL");
  }
  // 端口校验：未显式指定端口时为空字符串（走默认 443）允许；显式端口必须在白名单
  if (parsed.port && !VALID_CALLBACK_PORTS.has(Number(parsed.port))) {
    throw new HttpError(403, `无效的回调URL端口: ${parsed.port}`);
  }
  if (parsed.username || parsed.password) {
    throw new HttpError(403, "回调URL不允许包含用户信息");
  }
  // 路径必须是量子密信出站发送端点，且带 key 参数（防 SSRF / 伪造回调）
  if (parsed.pathname !== CALLBACK_PATH_PREFIX) {
    throw new HttpError(403, "无效的回调URL路径");
  }
  if (!parsed.searchParams.has("key")) {
    throw new HttpError(403, "回调URL缺少 key 参数");
  }
  return { phone, groupId, content, callbackUrl };
}

/** 请求去重（DEDUP_TTL 内相同 phone+content 跳过）。 */
export function isDuplicate(phone: string, content: string): boolean {
  const now = Date.now();
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  const key = `${phone}:${hash}`;
  // 从头部清过期（Map 按插入顺序）
  for (const [k, t] of recentRequests) {
    if (now - t > DEDUP_TTL) recentRequests.delete(k);
    else break;
  }
  if (recentRequests.has(key)) return true;
  recentRequests.set(key, now);
  while (recentRequests.size > MAX_DEDUP_SIZE) {
    const firstKey = recentRequests.keys().next().value;
    if (firstKey === undefined) break;
    recentRequests.delete(firstKey);
  }
  return false;
}

/** 速率限制检查（窗口内超过 RATE_LIMIT_MAX_REQUESTS 则限流）。 */
export function isRateLimited(phone: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  const timestamps = (rateLimits.get(phone) ?? []).filter((t) => t > windowStart);
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimits.set(phone, timestamps);
    return true;
  }
  timestamps.push(now);
  rateLimits.set(phone, timestamps);
  return false;
}

/** 清理限流字典中窗口外已无时间戳的用户，防止内存无限增长。 */
export function cleanupRateLimits(): void {
  if (rateLimits.size === 0) return;
  const windowStart = Date.now() - RATE_LIMIT_WINDOW;
  for (const [phone, ts] of rateLimits) {
    const fresh = ts.filter((t) => t > windowStart);
    if (fresh.length === 0) rateLimits.delete(phone);
    else rateLimits.set(phone, fresh);
  }
}

// per-phone 串行链：同一用户的消息依次处理，避免并发改会话历史竞态。
// 等价 Python 的 per-user asyncio.Lock。
const userChains = new Map<string, Promise<void>>();

/** 后台异步处理：调 Pi agent 生成回复并发送。失败则发错误提示。 */
export async function processRequest(
  content: string,
  phone: string,
  groupId: string,
  callbackUrl: string,
  clientIp: string
): Promise<void> {
  const start = Date.now();
  log.info(`请求处理开始 - 用户: ${phone}, IP: ${clientIp}`);
  try {
    if (DEBUG) log.info(`[DEBUG] webhook 内容 - 用户: ${phone}, 内容: ${content}`);
    await handleUserMessage(phone, groupId, content, callbackUrl);
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    log.error(`请求处理失败 - 用户: ${phone}, 耗时: ${elapsed}秒, 错误: ${String(e)}`);
    try {
      await sendReplyWithMention(
        "⚠️ 抱歉，处理您的请求时出现了问题，请稍后再试。",
        groupId,
        phone,
        callbackUrl
      );
    } catch (sendErr) {
      log.error(`错误回复发送失败 - 用户: ${phone}, 错误: ${String(sendErr)}`);
    }
  }
}

/** 把请求串行化到该用户的处理链后（fire-and-forget）。webhook ack 后调用。 */
export function enqueueUserRequest(
  content: string,
  phone: string,
  groupId: string,
  callbackUrl: string,
  clientIp: string
): void {
  const prev = userChains.get(phone) ?? Promise.resolve();
  const next = prev.then(() =>
    processRequest(content, phone, groupId, callbackUrl, clientIp)
  );
  userChains.set(phone, next);
  next.finally(() => {
    if (userChains.get(phone) === next) userChains.delete(phone);
  });
}
