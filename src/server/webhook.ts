// webhook 处理逻辑：字段校验、请求去重、入站速率限制、后台并发派发。
// 校验含安全约束：调用者/群标识、内容长度、callBackUrl 结构（防 SSRF/伪造）。
import { createHash } from "node:crypto";
import { log } from "../core/log.ts";
import {
  CALLBACK_PATH_PREFIX,
  DEDUP_TTL,
  DEBUG,
  GROUP_ID_PATTERN,
  MAX_CALLBACK_URL_LENGTH,
  MAX_CONTENT_LENGTH,
  MAX_DEDUP_SIZE,
  MAX_GROUP_ID_LENGTH,
  MAX_ACTIVE_REQUESTS,
  MAX_RATE_LIMIT_KEYS,
  PHONE_PATTERN,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW,
  REQUIRED_WEBHOOK_FIELDS,
  VALID_CALLBACK_PORTS,
  VALID_HOSTNAMES,
} from "../core/config.ts";
import { HttpError } from "./http.ts";
import { sendReplyWithMention, sendText } from "../integrations/im.ts";
import {
  handleUserMessage,
  resolveSessionCallbackUrl,
} from "../agent/runtime.ts";

// 已接收请求去重（Map 保持插入顺序，按序清过期）
const recentRequests = new Map<string, number>();
// 速率限制（每个群内用户在窗口内的时间戳列表）
const rateLimits = new Map<string, number[]>();
const activeRequests = new Set<Promise<void>>();
const activeNotices = new Map<string, Promise<void>>();

export type WebhookData = Record<string, unknown>;

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

  if (data.type !== "text") throw new HttpError(400, `不支持的消息类型: ${String(data.type)}`);

  if (
    typeof data.phone !== "string" ||
    typeof data.groupId !== "string" ||
    typeof data.callBackUrl !== "string" ||
    !data.textMsg ||
    typeof data.textMsg !== "object" ||
    Array.isArray(data.textMsg)
  ) {
    throw new HttpError(400, "phone、groupId、callBackUrl 和 textMsg 必须使用正确类型");
  }
  const textMsg = data.textMsg as Record<string, unknown>;
  if (typeof textMsg.content !== "string") {
    throw new HttpError(400, "textMsg.content 必须是字符串");
  }
  const phone = data.phone.trim();
  const groupId = data.groupId.trim();
  const callbackUrl = data.callBackUrl.trim();
  const content = textMsg.content.trim();

  if (!phone || !groupId || !content) {
    throw new HttpError(400, "phone、groupId 或 content 不能为空");
  }
  // phone 同时是群内用户身份和可读目录段，只接受平台约定字符集。
  if (!PHONE_PATTERN.test(phone)) {
    throw new HttpError(400, "无效的 phone");
  }
  if (!GROUP_ID_PATTERN.test(groupId)) {
    throw new HttpError(400, "无效的 groupId");
  }
  if (Buffer.byteLength(groupId, "utf8") > MAX_GROUP_ID_LENGTH) {
    throw new HttpError(400, `groupId 过长（上限 ${MAX_GROUP_ID_LENGTH} 字节）`);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_LENGTH) {
    throw new HttpError(413, `消息内容过长（上限 ${MAX_CONTENT_LENGTH} 字节）`);
  }
  if (callbackUrl.length > MAX_CALLBACK_URL_LENGTH) {
    throw new HttpError(403, "回调URL过长");
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
  const callbackKeys = parsed.searchParams.getAll("key");
  if (callbackKeys.length !== 1 || !callbackKeys[0]?.trim()) {
    throw new HttpError(403, "回调URL必须且只能包含一个非空 key 参数");
  }
  if (parsed.hash) {
    throw new HttpError(403, "回调URL不允许包含片段");
  }
  return { phone, groupId, content, callbackUrl };
}

function requestDedupKey(phone: string, groupId: string, content: string): string {
  const hash = createHash("sha256").update(content, "utf8").digest("hex");
  return JSON.stringify([groupId, phone, hash]);
}

function pruneRecentRequests(now: number): void {
  // 从头部清过期（Map 按插入顺序）。
  for (const [key, timestamp] of recentRequests) {
    if (now - timestamp > DEDUP_TTL) recentRequests.delete(key);
    else break;
  }
}

/** 查询已成功接收的重复请求；限流拒绝的请求不会被记入。 */
export function isDuplicate(phone: string, groupId: string, content: string): boolean {
  const now = Date.now();
  pruneRecentRequests(now);
  return recentRequests.has(requestDedupKey(phone, groupId, content));
}

/** 在请求成功入队后记录，供重复请求直接确认。 */
export function rememberRequest(phone: string, groupId: string, content: string): void {
  const now = Date.now();
  pruneRecentRequests(now);
  recentRequests.set(requestDedupKey(phone, groupId, content), now);
  while (recentRequests.size > MAX_DEDUP_SIZE) {
    const firstKey = recentRequests.keys().next().value;
    if (firstKey === undefined) break;
    recentRequests.delete(firstKey);
  }
}

/** 速率限制检查；同一手机号在不同群使用互相独立的窗口。 */
export function isRateLimited(phone: string, groupId: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;
  const key = JSON.stringify([groupId, phone]);
  if (!rateLimits.has(key) && rateLimits.size >= MAX_RATE_LIMIT_KEYS) {
    cleanupRateLimits(now);
    if (rateLimits.size >= MAX_RATE_LIMIT_KEYS) return true;
  }
  const timestamps = (rateLimits.get(key) ?? []).filter((t) => t > windowStart);
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimits.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  rateLimits.set(key, timestamps);
  return false;
}

/** 清理限流字典中窗口外已无时间戳的用户，防止内存无限增长。 */
export function cleanupRateLimits(now = Date.now()): void {
  if (rateLimits.size === 0) return;
  const windowStart = now - RATE_LIMIT_WINDOW;
  for (const [key, ts] of rateLimits) {
    const fresh = ts.filter((t) => t > windowStart);
    if (fresh.length === 0) rateLimits.delete(key);
    else rateLimits.set(key, fresh);
  }
}

/** 后台异步处理：调 Pi agent 生成回复并发送。失败则发错误提示。
 *  agent 干活途中的新消息/指令由 agent.ts 内部 steer/abort 处理，故此处不再串行化。 */
async function processRequest(
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
      const sent = await sendReplyWithMention(
        "⚠️ 抱歉，处理您的请求时出现了问题，请稍后再试。",
        groupId,
        phone,
        resolveSessionCallbackUrl(phone, groupId, callbackUrl)
      );
      if (!sent) log.error(`错误回复未送达 - 用户: ${phone}`);
    } catch (sendErr) {
      log.error(`错误回复发送失败 - 用户: ${phone}, 错误: ${String(sendErr)}`);
    }
  }
}

/** 后台 fire-and-forget 派发（webhook 已 ack 200）。agent 正忙时新消息走
 *  steer、指令立即处理；新的完整轮次由 agent 层按群共享 workspace 串行。 */
export function enqueueUserRequest(
  content: string,
  phone: string,
  groupId: string,
  callbackUrl: string,
  clientIp: string
): boolean {
  if (activeRequests.size >= MAX_ACTIVE_REQUESTS) return false;
  const request = processRequest(content, phone, groupId, callbackUrl, clientIp);
  activeRequests.add(request);
  void request.then(
    () => activeRequests.delete(request),
    (error) => {
      activeRequests.delete(request);
      log.error(`后台处理异常 - 用户: ${phone}, 错误: ${String(error)}`);
    }
  );
  return true;
}

export function hasUserRequestCapacity(): boolean {
  return activeRequests.size < MAX_ACTIVE_REQUESTS;
}

/**
 * 平台不会重投业务拒绝，因此容量/入站限流不能只返回 429/503。
 * 同一群用户的同类通知在发送完成前合并，避免压力状态下继续堆积相同回执。
 */
export function enqueueUserNotice(
  kind: "capacity" | "rate-limit",
  message: string,
  phone: string,
  groupId: string,
  callbackUrl: string
): void {
  const key = JSON.stringify([kind, groupId, phone, callbackUrl]);
  if (activeNotices.has(key)) return;
  const notice = (async () => {
    try {
      const sent = await sendText(message, groupId, phone, callbackUrl);
      if (!sent) log.error(`系统回执未送达 - 类型: ${kind}, 用户: ${phone}`);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      log.error(`系统回执发送失败 - 类型: ${kind}, 用户: ${phone}, 错误: ${String(error)}`);
    }
  })();
  activeNotices.set(key, notice);
  void notice.finally(() => {
    if (activeNotices.get(key) === notice) activeNotices.delete(key);
  });
}

/** 停止接收新请求后，等待所有已确认的后台请求完成清理。 */
export async function drainUserRequests(): Promise<void> {
  while (activeRequests.size > 0 || activeNotices.size > 0) {
    await Promise.allSettled([
      ...activeRequests,
      ...activeNotices.values(),
    ]);
  }
}
