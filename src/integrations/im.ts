// 发送层：量子密信群聊 webhook 消息、附件上传和出站限流。
import { createHash } from "node:crypto";
import { log } from "../core/log.ts";
import {
  markdownToPlainText,
  shouldRenderMarkdown,
} from "./markdown.ts";
import {
  ATTACHMENT_HTTP_TIMEOUT,
  IM_HTTP_TIMEOUT,
  IM_RATE_LIMIT_MAX_MESSAGES,
  IM_RATE_LIMIT_WINDOW,
  IM_RATE_WARNING_AT,
  IM_RETRY_COUNT,
  IM_RETRY_DELAY,
  IM_STATUS_PAUSE_AT,
  IM_TEXT_MAX_LENGTH,
  MAX_ATTACHMENT_BYTES,
} from "../core/config.ts";

const UPLOAD_PATH = "/im-external/v1/webhook/upload-attachment";

const outboundAbortController = new AbortController();

function abortError(): Error {
  const error = new Error("应用正在关闭，出站发送已取消");
  error.name = "AbortError";
  return error;
}

function throwIfDeliveryAborted(signal?: AbortSignal): void {
  const abortedSignal = signal?.aborted
    ? signal
    : outboundAbortController.signal.aborted
      ? outboundAbortController.signal
      : null;
  if (!abortedSignal) return;
  if (abortedSignal.reason instanceof Error) throw abortedSignal.reason;
  throw abortError();
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const signals = [outboundAbortController.signal, AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

async function waitForDelivery(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfDeliveryAborted(signal);
  const waitSignal = signal
    ? AbortSignal.any([outboundAbortController.signal, signal])
    : outboundAbortController.signal;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waitSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(waitSignal.reason instanceof Error ? waitSignal.reason : abortError());
    };
    waitSignal.addEventListener("abort", onAbort, { once: true });
    if (waitSignal.aborted) onAbort();
  });
}

/**
 * 等待前一个 FIFO 事务结束，但允许当前事务在尚未到达队首前立即取消。
 * 调用方的 gate 会串到 previous 之后，所以提前释放自身也不会让后续消息越过前一条。
 */
async function waitForQueueTurn(
  previous: Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  throwIfDeliveryAborted(signal);
  const waitSignal = signal
    ? AbortSignal.any([outboundAbortController.signal, signal])
    : outboundAbortController.signal;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      waitSignal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          waitSignal.reason instanceof Error ? waitSignal.reason : abortError()
        )
      );
    waitSignal.addEventListener("abort", onAbort, { once: true });
    if (waitSignal.aborted) {
      onAbort();
      return;
    }
    void previous.then(() => finish(resolve));
  });
}

/** 仅供进程关闭：取消正在等待/发送的出站请求，让会话清理可以及时完成。 */
export function abortOutboundRequests(): void {
  if (!outboundAbortController.signal.aborted) {
    outboundAbortController.abort(abortError());
  }
}

type OutboundTraffic = "required" | "status" | "warning";

interface OutboundRateState {
  timestamps: number[];
  tail: Promise<void>;
  pending: number;
  lastActivity: number;
  lastWarningAt: number;
  blockedUntil: number;
}

interface SlotReservation {
  allowed: boolean;
  shouldWarn: boolean;
}

interface WebhookResponse {
  ok?: boolean;
  code?: number;
  message?: string;
}

/** HTTP 200 响应体可能用通用 429 或平台业务码 10029 表示发送频率超限。 */
const BUSINESS_RATE_LIMIT_CODES = new Set([429, 10029]);

/** 每个机器人 callback key 一个窗口；同一机器人的多个用户/群共享 20 RPM。 */
const outboundRates = new Map<string, OutboundRateState>();

function callbackRateKey(callbackUrl: string): string {
  let rawKey = callbackUrl;
  try {
    const url = new URL(callbackUrl);
    rawKey = url.searchParams.get("key") ?? callbackUrl;
  } catch {
    // 调用方仍会在发送时报告 URL 错误；这里仅生成不泄露原值的队列键。
  }
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

function pruneWindow(state: OutboundRateState, now: number): void {
  const cutoff = now - IM_RATE_LIMIT_WINDOW;
  state.timestamps = state.timestamps.filter((timestamp) => timestamp > cutoff);
}

function canWarn(state: OutboundRateState, now: number): boolean {
  return now - state.lastWarningAt >= IM_RATE_LIMIT_WINDOW;
}

function getRateState(callbackUrl: string): OutboundRateState {
  const now = Date.now();
  const key = callbackRateKey(callbackUrl);
  let state = outboundRates.get(key);
  if (state) return state;

  // 顺手回收已空闲一个窗口且没有排队任务的旧机器人 key。
  for (const [oldKey, oldState] of outboundRates) {
    pruneWindow(oldState, now);
    if (
      oldState.pending === 0 &&
      oldState.timestamps.length === 0 &&
      oldState.blockedUntil <= now &&
      now - oldState.lastActivity >= IM_RATE_LIMIT_WINDOW
    ) {
      outboundRates.delete(oldKey);
    }
  }

  state = {
    timestamps: [],
    tail: Promise.resolve(),
    pending: 0,
    lastActivity: now,
    lastWarningAt: 0,
    blockedUntil: 0,
  };
  outboundRates.set(key, state);
  return state;
}

/** 供 /status 展示当前机器人（跨用户共享）的出站窗口状态。 */
export function getOutboundRateStatus(callbackUrl: string): {
  used: number;
  limit: number;
  pending: number;
  mode: "normal" | "reduced" | "full" | "cooldown";
} {
  const state = getRateState(callbackUrl);
  const now = Date.now();
  pruneWindow(state, now);
  const used = state.timestamps.length;
  const mode =
    state.blockedUntil > now
      ? "cooldown"
      : used >= IM_RATE_LIMIT_MAX_MESSAGES
        ? "full"
        : used >= IM_STATUS_PAUSE_AT
          ? "reduced"
          : "normal";
  return {
    used,
    limit: IM_RATE_LIMIT_MAX_MESSAGES,
    pending: state.pending,
    mode,
  };
}

function rejectDroppableTraffic(
  state: OutboundRateState,
  traffic: OutboundTraffic,
  canSendPressureWarning: boolean,
  now: number
): SlotReservation | null {
  pruneWindow(state, now);
  if (
    traffic === "status" &&
    (state.blockedUntil > now || state.timestamps.length >= IM_STATUS_PAUSE_AT)
  ) {
    const shouldWarn =
      canSendPressureWarning &&
      state.blockedUntil <= now &&
      state.timestamps.length >= IM_RATE_WARNING_AT &&
      state.timestamps.length < IM_RATE_LIMIT_MAX_MESSAGES &&
      canWarn(state, now);
    if (shouldWarn) state.lastWarningAt = now;
    state.lastActivity = now;
    log.warn(
      `出站 RPM 保护：暂停非关键状态消息，当前窗口 ${state.timestamps.length}/${IM_RATE_LIMIT_MAX_MESSAGES}`
    );
    return { allowed: false, shouldWarn };
  }
  if (
    traffic === "warning" &&
    (state.blockedUntil > now || state.timestamps.length >= IM_RATE_LIMIT_MAX_MESSAGES)
  ) {
    return { allowed: false, shouldWarn: false };
  }
  return null;
}

/** 整个发送事务占据 callback key 的 FIFO 队首，限流重试期间不会被后续消息越过。 */
async function enqueueOutbound<T>(
  callbackUrl: string,
  task: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfDeliveryAborted(signal);
  const state = getRateState(callbackUrl);
  const previous = state.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 把当前 gate 串在旧队尾之后；若当前事务排队时取消，后续事务仍会等待旧队尾。
  state.tail = previous.then(() => gate);
  state.pending++;
  try {
    await waitForQueueTurn(previous, signal);
    throwIfDeliveryAborted(signal);
    return await task();
  } finally {
    state.pending--;
    release();
  }
}

/**
 * 为一次真实 HTTP 尝试预留滑动窗口名额。调用者已经持有 FIFO 队首。
 * 所有重试也重新占名额，因为平台通常按 HTTP 请求次数计算 RPM。
 */
async function reserveOutboundSlot(
  callbackUrl: string,
  traffic: OutboundTraffic,
  canSendPressureWarning: boolean,
  signal?: AbortSignal
): Promise<SlotReservation> {
  throwIfDeliveryAborted(signal);
  const state = getRateState(callbackUrl);
  let now = Date.now();
  const rejected = rejectDroppableTraffic(
    state,
    traffic,
    canSendPressureWarning,
    now
  );
  if (rejected) return rejected;

  while (true) {
    throwIfDeliveryAborted(signal);
    now = Date.now();
    pruneWindow(state, now);
    if (state.blockedUntil > now) {
      if (traffic !== "required") {
        return { allowed: false, shouldWarn: false };
      }
      const waitMs = state.blockedUntil - now + 10;
      log.warn(`出站 RPM 保护：平台限流冷却中，队首消息等待 ${waitMs}ms`);
      await waitForDelivery(waitMs, signal);
      continue;
    }
    if (state.timestamps.length < IM_RATE_LIMIT_MAX_MESSAGES) break;

    if (traffic === "warning") return { allowed: false, shouldWarn: false };
    const waitMs = Math.max(
      1,
      state.timestamps[0]! + IM_RATE_LIMIT_WINDOW - now + 10
    );
    log.warn(
      `出站 RPM 保护：窗口已满 ${state.timestamps.length}/${IM_RATE_LIMIT_MAX_MESSAGES}，队首消息等待 ${waitMs}ms`
    );
    await waitForDelivery(waitMs, signal);
  }

  now = Date.now();
  state.timestamps.push(now);
  state.lastActivity = now;
  const count = state.timestamps.length;
  const shouldWarn =
    canSendPressureWarning &&
    traffic !== "warning" &&
    count >= IM_RATE_WARNING_AT &&
    count < IM_RATE_LIMIT_MAX_MESSAGES &&
    canWarn(state, now);
  if (shouldWarn) state.lastWarningAt = now;
  return { allowed: true, shouldWarn };
}

/**
 * 平台明确返回 HTTP 429 或业务限流时，把本地窗口立即标满并开始冷却。
 */
function noteServerRateLimit(
  callbackUrl: string,
  response: Response,
  reason = "平台返回 429"
): void {
  const state = getRateState(callbackUrl);
  const now = Date.now();
  const retryAfter = response.headers.get("retry-after")?.trim();
  let delayMs = IM_RATE_LIMIT_WINDOW;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      delayMs = Math.max(1000, seconds * 1000);
    } else {
      const dateMs = Date.parse(retryAfter);
      if (Number.isFinite(dateMs)) delayMs = Math.max(1000, dateMs - now);
    }
  }
  // 本地已把窗口写成 20/20；即使 Retry-After 更短，也必须等最早时间戳滚出窗口。
  delayMs = Math.max(delayMs, IM_RATE_LIMIT_WINDOW);
  state.timestamps = Array<number>(IM_RATE_LIMIT_MAX_MESSAGES).fill(now);
  state.blockedUntil = Math.max(state.blockedUntil, now + delayMs);
  state.lastActivity = now;
  log.warn(
    `${reason}，本地窗口标记 ${IM_RATE_LIMIT_MAX_MESSAGES}/${IM_RATE_LIMIT_MAX_MESSAGES}，队首消息冷却 ${delayMs}ms`
  );
}

/** 从 callBackUrl（send?key=xxx）解析机器人 key，用于上传附件。 */
function extractKeyFromCallback(callbackUrl: string): string | null {
  try {
    return new URL(callbackUrl).searchParams.get("key");
  } catch {
    return null;
  }
}

async function readWebhookResponse(response: Response): Promise<WebhookResponse | null> {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? (value as WebhookResponse) : null;
  } catch {
    return null;
  }
}

function queuePressureWarning(
  url: string,
  payload: unknown,
  signal?: AbortSignal
): void {
  void postWithRetry(
    url,
    payload,
    "RPM 预警",
    "warning",
    undefined,
    signal
  ).catch((error) => {
    if (signal?.aborted || outboundAbortController.signal.aborted) return;
    log.error(`RPM 预警发送异常: ${String(error)}`);
  });
}

/** 已位于 FIFO 队首；限流不消耗普通重试次数，关键消息会持续等待后重发。 */
async function postAtQueueFront(
  url: string,
  payload: unknown,
  label = "消息",
  traffic: OutboundTraffic = "required",
  pressureWarningPayload?: unknown,
  signal?: AbortSignal
): Promise<boolean> {
  let attempt = 0;
  while (attempt < IM_RETRY_COUNT) {
    throwIfDeliveryAborted(signal);
    const reservation = await reserveOutboundSlot(
      url,
      traffic,
      pressureWarningPayload !== undefined,
      signal
    );
    if (!reservation.allowed) {
      if (reservation.shouldWarn && pressureWarningPayload) {
        queuePressureWarning(url, pressureWarningPayload, signal);
      }
      return false;
    }

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: requestSignal(IM_HTTP_TIMEOUT, signal),
      });
      if (resp.status === 200) {
        const result = await readWebhookResponse(resp);
        if (result?.ok === true && result.code === 200) {
          if (reservation.shouldWarn && pressureWarningPayload) {
            queuePressureWarning(url, pressureWarningPayload, signal);
          }
          return true;
        }
        const rateLimited =
          (result?.code !== undefined &&
            BUSINESS_RATE_LIMIT_CODES.has(result.code)) ||
          (result?.message !== undefined &&
            /频率|频繁|限流|请求过多|too many|rate.?limit/i.test(result.message));
        if (rateLimited) {
          noteServerRateLimit(url, resp, "平台业务响应限流");
        }
        log.error(
          `${label}发送业务失败: code=${result?.code ?? "?"}, message=${result?.message ?? "无有效 JSON 响应"}`
        );
        if (rateLimited && traffic === "required") continue;
        return false;
      }
      if (resp.status === 429) {
        noteServerRateLimit(url, resp);
        await resp.body?.cancel().catch(() => {});
        log.error(`${label}发送失败，状态码: 429`);
        if (traffic === "required") continue;
        return false;
      }
      await resp.body?.cancel().catch(() => {});
      log.error(`${label}发送失败，状态码: ${resp.status}`);
    } catch (e) {
      throwIfDeliveryAborted(signal);
      log.error(`${label}发送异常: ${String(e)}，第${attempt + 1}次`);
    }
    attempt++;
    if (attempt < IM_RETRY_COUNT) await waitForDelivery(IM_RETRY_DELAY, signal);
  }
  log.error(`${label}最终发送失败`);
  return false;
}

/** 预检可丢弃流量，然后让整个逻辑发送事务占据同一个 callback FIFO 位置。 */
async function enqueueOutboundTransaction(
  url: string,
  traffic: OutboundTraffic,
  task: () => Promise<boolean>,
  pressureWarningPayload?: unknown,
  signal?: AbortSignal
): Promise<boolean> {
  throwIfDeliveryAborted(signal);
  const state = getRateState(url);
  const rejected = rejectDroppableTraffic(
    state,
    traffic,
    pressureWarningPayload !== undefined,
    Date.now()
  );
  if (rejected) {
    if (rejected.shouldWarn && pressureWarningPayload) {
      queuePressureWarning(url, pressureWarningPayload, signal);
    }
    return false;
  }
  return enqueueOutbound(url, task, signal);
}

/** 带重试的 JSON POST，HTTP 与业务响应都成功才返回 true。 */
async function postWithRetry(
  url: string,
  payload: unknown,
  label = "消息",
  traffic: OutboundTraffic = "required",
  pressureWarningPayload?: unknown,
  signal?: AbortSignal
): Promise<boolean> {
  return enqueueOutboundTransaction(
    url,
    traffic,
    () => postAtQueueFront(
      url,
      payload,
      label,
      traffic,
      pressureWarningPayload,
      signal
    ),
    pressureWarningPayload,
    signal
  );
}

/** 从 markdown 正文提取首行作卡片标题（去标记、截断）。 */
function buildMarkdownTitle(content: string, limit = 24): string {
  const firstLine = content.trim().split("\n", 1)[0]?.trim() ?? "";
  let clean = firstLine.replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/u, "");
  clean = clean.replace(/^[*_`\t ]+/, "").replace(/[*_`\t ]+$/, "");
  return Array.from(clean || "AI 回复").slice(0, limit).join("");
}

// ===== 消息构建器 =====
// 官方推送按 webhook key 关联的群广播；消息体中的 groupId 是 @ 上下文，
// 未定义为目标群选择器；本项目仍只把 groupId 用于隔离、日志和 key 冲突保护。
function buildText(content: string, phone: string) {
  const textMsg: Record<string, unknown> = { content };
  addMention(textMsg, phone);
  return {
    type: "text" as const,
    textMsg,
  };
}

/** Markdown 是实测可用但未写入官方文档的扩展，同样由 webhook key 路由。 */
function buildMarkdown(content: string) {
  return {
    type: "markdown" as const,
    markdown: { title: buildMarkdownTitle(content), content },
  };
}

function addMention(body: Record<string, unknown>, phone?: string): void {
  if (!phone) return;
  Object.assign(body, {
    isMentioned: true,
    mentionType: 2,
    mentionedMobileList: [phone],
  });
}

function buildImage(
  fileId: string,
  phone?: string,
  width?: number,
  height?: number
) {
  const body: Record<string, unknown> = { fileId };
  if (width !== undefined) body.width = width;
  if (height !== undefined) body.height = height;
  addMention(body, phone);
  return { type: "image" as const, imageMsg: body };
}

function buildFile(fileId: string, phone?: string) {
  const body: Record<string, unknown> = { fileId };
  addMention(body, phone);
  return { type: "file" as const, fileMsg: body };
}

function splitTextContent(content: string): string[] {
  if (content.length <= IM_TEXT_MAX_LENGTH) return [content];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(offset + IM_TEXT_MAX_LENGTH, content.length);
    if (end < content.length) {
      const previous = content.charCodeAt(end - 1);
      const next = content.charCodeAt(end);
      if (
        (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
        (previous === 0x0d && next === 0x0a)
      ) {
        end--;
      }
      const lineBreak = content.lastIndexOf("\n", end - 1);
      if (lineBreak >= offset + Math.floor(IM_TEXT_MAX_LENGTH / 2)) {
        end = lineBreak + 1;
      }
    }
    chunks.push(content.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function buildPressureWarning(phone: string) {
  return buildText(
    "⚠️ 当前机器人消息较多，已自动减少非关键状态消息并排队保护最终回复；任务仍在继续。",
    phone
  );
}

async function sendTextChunksAtQueueFront(
  content: string,
  phone: string,
  callbackUrl: string,
  traffic: OutboundTraffic,
  warning: unknown,
  signal?: AbortSignal
): Promise<boolean> {
  const chunks = splitTextContent(content);
  for (let index = 0; index < chunks.length; index++) {
    const isLast = index === chunks.length - 1;
    const ok = await postAtQueueFront(
      callbackUrl,
      buildText(chunks[index]!, isLast ? phone : ""),
      "text",
      traffic,
      warning,
      signal
    );
    if (!ok) return false;
  }
  return true;
}

async function sendTextChunks(
  content: string,
  phone: string,
  callbackUrl: string,
  traffic: OutboundTraffic,
  signal?: AbortSignal
): Promise<boolean> {
  const warning = buildPressureWarning(phone);
  return enqueueOutboundTransaction(
    callbackUrl,
    traffic,
    () => sendTextChunksAtQueueFront(
      content,
      phone,
      callbackUrl,
      traffic,
      warning,
      signal
    ),
    warning,
    signal
  );
}

// ===== 发送接口 =====
export async function sendText(
  content: string,
  groupId: string,
  phone: string,
  callbackUrl: string,
  options?: { traffic?: OutboundTraffic; signal?: AbortSignal }
): Promise<boolean> {
  const ok = await sendTextChunks(
    content,
    phone,
    callbackUrl,
    options?.traffic ?? "required",
    options?.signal
  );
  if (ok) log.info(`消息发送成功，群: ${groupId}, 用户: ${phone}`);
  return ok;
}

const COMPLETION_NOTICE = "✅ 任务已完成，请查看上方回复";

/** 群聊回复只产生一条成功消息：
 *  - 普通文本直接发送一条 text@，它本身就是完成通知；
 *  - 带格式的回复先发 Markdown，再发一条简短 text@ 完成提醒；
 *  - Markdown HTTP 明确失败时转换并降级为一条 text@，不重复提醒。 */
export async function sendReplyWithMention(
  content: string,
  groupId: string,
  phone: string,
  callbackUrl: string,
  signal?: AbortSignal,
  /**
   * 必须逐字进群的附加文本（目前是大文件外链）。
   *
   * 它全程不经过 markdownToPlainText，也不参与 Markdown 判定——那个转换会把 `_x_`
   * 当成强调标记去掉，而对象名里带下划线的文件名（`报告_2025_最终.pdf`）编码进 URL
   * 后正好长这样，被改写一次链接就废了。
   *
   * 落点跟着回复形态走，两种都不额外多发消息：Markdown 回复挂在那条本来就要发的完成
   * 提醒后面，纯文本回复直接并进正文。
   */
  appendix?: string
): Promise<boolean> {
  const warning = buildPressureWarning(phone);
  const notice = appendix ? `${COMPLETION_NOTICE}\n\n${appendix}` : COMPLETION_NOTICE;
  return enqueueOutboundTransaction(
    callbackUrl,
    "required",
    async () => {
      if (shouldRenderMarkdown(content)) {
        const markdownOk = await postAtQueueFront(
          callbackUrl,
          buildMarkdown(content),
          "markdown",
          "required",
          warning,
          signal
        );
        if (markdownOk) {
          const notified = await sendTextChunksAtQueueFront(
            notice,
            phone,
            callbackUrl,
            "required",
            warning,
            signal
          );
          if (!notified) {
            log.warn(`markdown 已送达，但完成提醒发送失败 - 群: ${groupId}, 用户: ${phone}`);
          }
          log.info(
            `回复发送完成（markdown + text@${notified ? "" : "失败"}），群: ${groupId}, 用户: ${phone}`
          );
          // 带 appendix 时完成提醒不再是可有可无的提醒，它载着这次唯一的下载地址；
          // 发失败就必须如实报错，让调用方走补发。
          return appendix ? notified : true;
        }
        log.warn(`markdown 发送失败，降级为 text@ - 群: ${groupId}, 用户: ${phone}`);
      }
      const converted = markdownToPlainText(content) || "（回复内容无法以纯文本显示）";
      const plainText = appendix ? `${converted}\n\n${appendix}` : converted;
      const ok = await sendTextChunksAtQueueFront(
        plainText,
        phone,
        callbackUrl,
        "required",
        warning,
        signal
      );
      if (ok) log.info(`回复发送完成（text@），群: ${groupId}, 用户: ${phone}`);
      return ok;
    },
    warning,
    signal
  );
}

export async function sendImage(
  fileId: string,
  groupId: string,
  callbackUrl: string,
  phone?: string,
  width?: number,
  height?: number,
  signal?: AbortSignal
): Promise<boolean> {
  const ok = await postWithRetry(
    callbackUrl,
    buildImage(fileId, phone, width, height),
    "image",
    "required",
    undefined,
    signal
  );
  if (ok) log.info(`image 发送成功，群: ${groupId}, 用户: ${phone ?? "-"}`);
  return ok;
}

export async function sendFile(
  fileId: string,
  groupId: string,
  callbackUrl: string,
  phone?: string,
  signal?: AbortSignal
): Promise<boolean> {
  const ok = await postWithRetry(
    callbackUrl,
    buildFile(fileId, phone),
    "file",
    "required",
    undefined,
    signal
  );
  if (ok) log.info(`file 发送成功，群: ${groupId}, 用户: ${phone ?? "-"}`);
  return ok;
}

/** 上传附件，返回 fileId（失败返回 null）。
 *  fileType: 'image' | 'file'（决定 type 参数：1=图片，2=文件）。
 *  data 为内存字节，不落盘，适配只读容器；key 从 callBackUrl 提取。 */
export async function uploadAttachment(
  callbackUrl: string,
  data: Uint8Array,
  filename: string,
  fileType: "image" | "file",
  signal?: AbortSignal
): Promise<string | null> {
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    log.error(
      `附件过大: ${filename} (${data.byteLength} > ${MAX_ATTACHMENT_BYTES})`
    );
    return null;
  }
  const key = extractKeyFromCallback(callbackUrl);
  if (!key) {
    log.error("无法从 callBackUrl 提取 key，附件上传失败");
    return null;
  }
  const typeEnum = fileType === "image" ? "1" : "2";
  const url = new URL(UPLOAD_PATH, callbackUrl).toString();
  try {
    const form = new FormData();
    form.append("key", key);
    form.append("type", typeEnum);
    form.append("file", new Blob([data]), filename);
    const resp = await fetch(url, {
      method: "POST",
      body: form,
      signal: requestSignal(ATTACHMENT_HTTP_TIMEOUT, signal),
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      log.error(`附件上传 HTTP 失败: ${resp.status}`);
      return null;
    }
    const result = (await resp.json()) as {
      ok?: boolean;
      code?: number;
      data?: { id?: string };
      content?: { id?: string };
    };
    if (result.ok && result.code === 200) {
      const fileId = result.data?.id ?? result.content?.id;
      if (fileId) {
        log.info(`附件上传成功: ${filename} -> ${fileId}`);
        return fileId;
      }
    }
    log.error(`附件上传接口返回错误: ${JSON.stringify(result)}`);
  } catch (e) {
    throwIfDeliveryAborted(signal);
    log.error(`附件上传异常: ${String(e)}`);
  }
  return null;
}
