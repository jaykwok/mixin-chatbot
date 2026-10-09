// webhook 处理逻辑：字段校验、请求去重、入站速率限制、交给消息服务（src/durable/service.ts）。
// 校验含安全约束：调用者/群标识、内容长度、callBackUrl 结构（防 SSRF/伪造）。
// 普通消息写进成员的 inbox 之后才回执 200，重启后从 inbox 继续；控制命令在后台执行，结果直接回给成员。
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
  MAX_RATE_LIMIT_KEYS,
  PHONE_PATTERN,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW,
  REQUIRED_WEBHOOK_FIELDS,
  VALID_CALLBACK_PORTS,
  VALID_HOSTNAMES,
} from "../core/config.ts";
import { HttpError } from "./http.ts";
import { sendText } from "../integrations/im.ts";
import { describeRequestFailure } from "../agent/failure.ts";
import { canonicalCommand } from "../agent/commands.ts";
import { application } from "../core/lifecycle.ts";

/** 接收消息的服务（src/durable/service.ts 的 DurableService），启动时绑定一次。 */
export interface MessageService {
  admit(phone: string, groupId: string, content: string, callbackUrl: string, deduplicate?: boolean): Promise<{ status: "accepted" } | { status: "full"; message: string; reason?: "capacity" }>;
  hasUserRequestCapacity(): boolean;
  control(phone: string, groupId: string, content: string, callbackUrl: string, onAdmitted?: () => void): Promise<string>;
  callbackUrl(phone: string, groupId: string, fallback: string): string;
}
let messages: MessageService | undefined;
export function bindMessageService(service: MessageService | undefined): void { messages = service; }
function service(): MessageService {
  if (!messages) throw new Error("消息服务尚未启动");
  return messages;
}

// 已接收请求去重（Map 保持插入顺序，按序清过期）
const recentRequests = new Map<string, { at: number }>();
// 速率限制（每个群内用户在窗口内的时间戳列表）
const rateLimits = new Map<string, number[]>();
const activeRequests = new Set<Promise<void>>();
const activeControls = new Map<string, { action: Promise<void>; admitted: Promise<boolean> }>();
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
  for (const [key, entry] of recentRequests) {
    if (now - entry.at > DEDUP_TTL) recentRequests.delete(key);
    else break;
  }
}

/** 查询已成功接收的重复请求；限流拒绝的请求不会被记入。 */
export function isDuplicate(phone: string, groupId: string, content: string): boolean {
  const now = Date.now();
  pruneRecentRequests(now);
  return recentRequests.has(requestDedupKey(phone, groupId, content));
}

/** 入队前预约去重状态；拒绝、失败或取消时只释放本次预约。 */
export function rememberRequest(phone: string, groupId: string, content: string): () => void {
  const now = Date.now();
  pruneRecentRequests(now);
  const key = requestDedupKey(phone, groupId, content);
  const entry = { at: now };
  recentRequests.delete(key);
  recentRequests.set(key, entry);
  while (recentRequests.size > MAX_DEDUP_SIZE) {
    const firstKey = recentRequests.keys().next().value;
    if (firstKey === undefined) break;
    recentRequests.delete(firstKey);
  }
  // An old job finishing must never remove a replacement request's reservation.
  return () => { if (recentRequests.get(key) === entry) recentRequests.delete(key); };
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

/** 失败回执走 text：不能带「✅ 任务已完成」，报错原文里的 JSON 也不该被 Markdown 判定挑中再被转换改写。 */
async function sendFailure(error: unknown, phone: string, groupId: string, callbackUrl: string): Promise<void> {
  try {
    const sent = await sendText(describeRequestFailure(error), groupId, phone, messages?.callbackUrl(phone, groupId, callbackUrl) ?? callbackUrl);
    if (!sent) log.error(`错误回复未送达 - 用户: ${phone}`);
  } catch (sendErr) {
    log.error(`错误回复发送失败 - 用户: ${phone}, 错误: ${String(sendErr)}`);
  }
}

const aborted = (error: unknown) => application.signal.aborted || (error instanceof Error && error.name === "AbortError");

/**
 * 普通消息：写进成员的 inbox 后才结束（webhook 等它结束再回执 200），之后由成员的 worker 处理。
 * 排队已满或写入失败时给成员发回执，并释放去重预约。没有容量时不接收，返回 undefined。
 */
export function admitUserRequest(content: string, phone: string, groupId: string, callbackUrl: string, clientIp: string): Promise<void> | undefined {
  if (!hasUserRequestCapacity()) return undefined;
  const invalidate = rememberRequest(phone, groupId, content);
  const request = (async () => {
    const start = Date.now();
    log.info(`请求处理开始 - 群: ${groupId}, 用户: ${phone}, IP: ${clientIp}`);
    if (DEBUG) log.info(`[DEBUG] webhook 内容 - 用户: ${phone}, 内容: ${content}`);
    try {
      const result = await service().admit(phone, groupId, content, callbackUrl, true);
      if (result.status === "full") {
        invalidate();
        log.warn(`${result.reason === "capacity" ? "后台请求容量已满" : "成员排队已满"} - 群: ${groupId}, 用户: ${phone}`);
        enqueueUserNotice(result.reason === "capacity" ? "capacity" : "queue-full", result.message, phone, groupId, callbackUrl);
      }
    } catch (e) {
      invalidate();
      if (aborted(e)) return;
      const elapsed = ((Date.now() - start) / 1000).toFixed(2);
      log.error(`请求接收失败 - 群: ${groupId}, 用户: ${phone}, 耗时: ${elapsed}秒, 错误: ${String(e)}`);
      await sendFailure(e, phone, groupId, callbackUrl);
    }
  })();
  activeRequests.add(request);
  void request.finally(() => activeRequests.delete(request));
  return request;
}

/** 控制命令在后台执行，同一成员的同一命令执行完之前重复发送只算一次；结果由消息服务回给成员。 */
export function enqueueUserControl(content: string, phone: string, groupId: string, callbackUrl: string, clientIp: string): Promise<boolean> {
  const command = canonicalCommand(content);
  const key = JSON.stringify([groupId, phone, command]);
  const waiting = activeControls.get(key);
  if (waiting) return waiting.admitted;
  if (activeControls.size >= 128) return Promise.resolve(false);
  const admitted = Promise.withResolvers<boolean>();
  const action = (async () => {
    log.info(`控制命令 ${command} - 群: ${groupId}, 用户: ${phone}, IP: ${clientIp}`);
    try {
      await service().control(phone, groupId, content, callbackUrl, () => admitted.resolve(true));
      admitted.resolve(true);
    } catch (e) {
      admitted.reject(e);
      if (aborted(e)) return;
      log.error(`控制命令失败 - 群: ${groupId}, 用户: ${phone}, 命令: ${command}, 错误: ${String(e)}`);
      await sendFailure(e, phone, groupId, callbackUrl);
    }
  })();
  // Cleanup can remain blocked after admission; HTTP waits only for the persisted control receipt.
  void admitted.promise.catch(() => {});
  activeControls.set(key, { action, admitted: admitted.promise });
  void action.finally(() => activeControls.delete(key));
  return admitted.promise;
}

export function hasUserRequestCapacity(): boolean {
  return messages?.hasUserRequestCapacity() ?? false;
}

/**
 * 平台不会重投业务拒绝，因此容量/入站限流不能只返回 429/503。
 * 同一群用户的同类通知在发送完成前合并，避免压力状态下继续堆积相同回执。
 */
export function enqueueUserNotice(
  kind: "capacity" | "rate-limit" | "queue-full",
  message: string,
  phone: string,
  groupId: string,
  callbackUrl: string
): void {
  const key = JSON.stringify([kind, groupId, phone, callbackUrl]);
  if (activeNotices.has(key) || activeNotices.size >= 128 || application.signal.aborted) return;
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
  while (activeRequests.size > 0 || activeNotices.size > 0 || activeControls.size > 0) {
    await Promise.allSettled([
      ...activeRequests,
      ...activeNotices.values(),
      ...[...activeControls.values()].map(control => control.action),
    ]);
  }
}
