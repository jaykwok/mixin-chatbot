// 发送层：量子密信群聊 webhook 消息、附件上传和出站限流。
import { log } from "../core/log.ts";
import {
  ATTACHMENT_HTTP_TIMEOUT,
  IM_HEARTBEAT_PAUSE_AT,
  IM_HTTP_TIMEOUT,
  IM_RATE_LIMIT_MAX_MESSAGES,
  IM_RATE_LIMIT_WINDOW,
  IM_RATE_WARNING_AT,
  IM_RETRY_COUNT,
  IM_RETRY_DELAY,
  MAX_ATTACHMENT_BYTES,
} from "../core/config.ts";

const IM_SEND_HOST = "imtwo.zdxlz.com";
const UPLOAD_PATH = "/im-external/v1/webhook/upload-attachment";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** 每个机器人 callback key 一个窗口；同一机器人的多个用户/群共享 20 RPM。 */
const outboundRates = new Map<string, OutboundRateState>();

function callbackRateKey(callbackUrl: string): string {
  try {
    const url = new URL(callbackUrl);
    return `${url.hostname}:${url.searchParams.get("key") ?? callbackUrl}`;
  } catch {
    return callbackUrl;
  }
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
        : used >= IM_HEARTBEAT_PAUSE_AT
          ? "reduced"
          : "normal";
  return {
    used,
    limit: IM_RATE_LIMIT_MAX_MESSAGES,
    pending: state.pending,
    mode,
  };
}

/**
 * 为一次真实 HTTP 发送预留滑动窗口名额。
 * - status（思考提示/心跳）达到 12/60s 后直接丢弃，为关键消息留出 8 个名额；
 * - required 达到 20/60s 后按 FIFO 等待，绝不丢最终回复/指令/附件；
 * - 所有重试也重新占名额，因为平台通常按 HTTP 请求次数计算 RPM。
 */
async function reserveOutboundSlot(
  callbackUrl: string,
  traffic: OutboundTraffic,
  canSendPressureWarning: boolean
): Promise<SlotReservation> {
  const state = getRateState(callbackUrl);
  let now = Date.now();
  pruneWindow(state, now);

  // 心跳是可降级消息，先快速判定，避免排在已拥堵的关键消息后面。
  if (
    traffic === "status" &&
    (state.blockedUntil > now || state.timestamps.length >= IM_HEARTBEAT_PAUSE_AT)
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
      `出站 RPM 保护：暂停心跳，当前窗口 ${state.timestamps.length}/${IM_RATE_LIMIT_MAX_MESSAGES}`
    );
    return { allowed: false, shouldWarn };
  }
  if (traffic === "warning" && state.timestamps.length >= IM_RATE_LIMIT_MAX_MESSAGES) {
    return { allowed: false, shouldWarn: false };
  }

  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.pending++;
  await previous;

  try {
    while (true) {
      now = Date.now();
      pruneWindow(state, now);
      if (state.blockedUntil > now) {
        if (traffic === "warning") {
          return { allowed: false, shouldWarn: false };
        }
        const waitMs = state.blockedUntil - now + 10;
        log.warn(`出站 RPM 保护：平台限流冷却中，关键消息排队 ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      if (state.timestamps.length < IM_RATE_LIMIT_MAX_MESSAGES) break;

      const waitMs = Math.max(
        1,
        state.timestamps[0]! + IM_RATE_LIMIT_WINDOW - now + 10
      );
      log.warn(
        `出站 RPM 保护：窗口已满 ${state.timestamps.length}/${IM_RATE_LIMIT_MAX_MESSAGES}，关键消息排队 ${waitMs}ms`
      );
      await sleep(waitMs);
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
  } finally {
    state.pending--;
    release();
  }
}

/**
 * 429 只是额外的防御性信号；平台可能 HTTP 200 但静默丢弃超限消息，
 * 因此主保护始终依赖上面的本地滑动窗口，不依赖此函数。
 */
function noteServerRateLimit(callbackUrl: string, response: Response): void {
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
  state.blockedUntil = Math.max(state.blockedUntil, now + delayMs);
  state.lastActivity = now;
  log.warn(`平台返回 429，出站发送自适应冷却 ${delayMs}ms`);
}

/** 从 callBackUrl（send?key=xxx）解析机器人 key，用于上传附件。 */
function extractKeyFromCallback(callbackUrl: string): string | null {
  try {
    return new URL(callbackUrl).searchParams.get("key");
  } catch {
    return null;
  }
}

/** 带重试的 JSON POST，成功（HTTP 200）返回 true。 */
async function postWithRetry(
  url: string,
  payload: unknown,
  label = "消息",
  traffic: OutboundTraffic = "required",
  pressureWarningPayload?: unknown
): Promise<boolean> {
  for (let attempt = 0; attempt < IM_RETRY_COUNT; attempt++) {
    const reservation = await reserveOutboundSlot(
      url,
      traffic,
      pressureWarningPayload !== undefined
    );
    if (!reservation.allowed) {
      if (reservation.shouldWarn && pressureWarningPayload) {
        void postWithRetry(
          url,
          pressureWarningPayload,
          "RPM 预警",
          "warning"
        ).catch((e) => log.error(`RPM 预警发送异常: ${String(e)}`));
      }
      return false;
    }

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(IM_HTTP_TIMEOUT),
      });
      if (resp.status === 200) {
        await resp.body?.cancel().catch(() => {});
        if (reservation.shouldWarn && pressureWarningPayload) {
          void postWithRetry(
            url,
            pressureWarningPayload,
            "RPM 预警",
            "warning"
          ).catch((e) => log.error(`RPM 预警发送异常: ${String(e)}`));
        }
        return true;
      }
      if (resp.status === 429) noteServerRateLimit(url, resp);
      await resp.body?.cancel().catch(() => {});
      log.error(`${label}发送失败，状态码: ${resp.status}`);
    } catch (e) {
      log.error(`${label}发送异常: ${String(e)}，第${attempt + 1}次`);
    }
    if (attempt === 0) await sleep(IM_RETRY_DELAY);
  }
  log.error(`${label}最终发送失败`);
  return false;
}

/** 从 markdown 正文提取首行作卡片标题（去标记、截断）。A 套 markdown 的 title 必填。 */
function buildMarkdownTitle(content: string, limit = 24): string {
  const firstLine = content.trim().split("\n", 1)[0]?.trim() ?? "";
  let clean = firstLine.replace(/^[#>\*\-\d\.\s]+/, "");
  clean = clean.replace(/^[*_`\t ]+/, "").replace(/[*_`\t ]+$/, "");
  return (clean || "AI 回复").slice(0, limit);
}

// ===== 消息构建器（A 套群聊 webhook 协议，已实测验证）=====
function buildText(content: string, groupId: string, phone: string) {
  return {
    type: "text" as const,
    textMsg: {
      content,
      isMentioned: true,
      mentionType: 2,
      mentionedMobileList: [phone],
      groupId,
    },
  };
}

function buildMarkdown(content: string) {
  return {
    type: "markdown" as const,
    markdown: { title: buildMarkdownTitle(content), content },
  };
}

function buildImage(fileId: string, width?: number, height?: number) {
  const body: Record<string, unknown> = { fileId };
  if (width !== undefined) body.width = width;
  if (height !== undefined) body.height = height;
  return { type: "image" as const, imageMsg: body };
}

function buildFile(fileId: string) {
  return { type: "file" as const, fileMsg: { fileId } };
}

// ===== 发送接口 =====
export async function sendText(
  content: string,
  groupId: string,
  phone: string,
  callbackUrl: string,
  options?: { traffic?: OutboundTraffic }
): Promise<boolean> {
  const warning = buildText(
    "⚠️ 当前机器人消息较多，已自动减少心跳并排队保护最终回复；任务仍在继续。",
    groupId,
    phone
  );
  const ok = await postWithRetry(
    callbackUrl,
    buildText(content, groupId, phone),
    "text",
    options?.traffic ?? "required",
    warning
  );
  if (ok) log.info(`消息发送成功，用户: ${phone}`);
  return ok;
}

/** 内容是否含 markdown 格式（代码块/粗体/标题/列表/引用/空行分段）——决定走 markdown 卡片还是纯 text。 */
function looksLikeMarkdown(s: string): boolean {
  return (
    /```|\*\*[^*]+\*\*|__[^_]+__|(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)/.test(s) ||
    /\n\s*\n/.test(s)
  );
}

/** 群聊回复：
 *  - 内容含格式 → markdown 卡片（渲染正文）+ 一条 text@（仅触发 @ 通知，不重复正文）。
 *    markdown 不支持 @（已实测），故 @ 通知单独走 text。
 *  - 纯文本 → 只发一条 text（带 @），避免「同内容发两次」。 */
export async function sendReplyWithMention(
  content: string,
  groupId: string,
  phone: string,
  callbackUrl: string
): Promise<boolean> {
  if (looksLikeMarkdown(content)) {
    const markdownOk = await postWithRetry(
      callbackUrl,
      buildMarkdown(content),
      "markdown"
    );
    if (!markdownOk) {
      log.warn(`markdown 发送失败，降级为纯 text - 用户: ${phone}`);
      const fallbackOk = await postWithRetry(
        callbackUrl,
        buildText(content, groupId, phone),
        "text fallback"
      );
      if (fallbackOk) log.info(`回复发送完成（text fallback），用户: ${phone}`);
      return fallbackOk;
    }

    const mentionOk = await postWithRetry(
      callbackUrl,
      buildText("（已回复，见上方卡片）", groupId, phone),
      "text@"
    );
    if (!mentionOk) {
      // 正文已经送达，@ 通知失败不应触发一条误导性的“处理请求失败”回复。
      log.warn(`markdown 正文已发送，但 text@ 通知失败 - 用户: ${phone}`);
    }
    log.info(`回复发送完成（markdown${mentionOk ? " + text@" : ""}），用户: ${phone}`);
    return true;
  }
  const ok = await postWithRetry(callbackUrl, buildText(content, groupId, phone), "text");
  if (ok) log.info(`回复发送完成（text@），用户: ${phone}`);
  return ok;
}

export async function sendImage(
  fileId: string,
  callbackUrl: string,
  phone?: string,
  width?: number,
  height?: number
): Promise<boolean> {
  const ok = await postWithRetry(callbackUrl, buildImage(fileId, width, height), "image");
  if (ok) log.info(`image 发送成功，用户: ${phone ?? "-"}`);
  return ok;
}

export async function sendFile(
  fileId: string,
  callbackUrl: string,
  phone?: string
): Promise<boolean> {
  const ok = await postWithRetry(callbackUrl, buildFile(fileId), "file");
  if (ok) log.info(`file 发送成功，用户: ${phone ?? "-"}`);
  return ok;
}

/** 上传附件，返回 fileId（失败返回 null）。
 *  fileType: 'image' | 'file'（决定 type 参数：1=图片，2=文件）。
 *  data 为内存字节，不落盘，适配只读容器；key 从 callBackUrl 提取。 */
export async function uploadAttachment(
  callbackUrl: string,
  data: Uint8Array,
  filename: string,
  fileType: "image" | "file"
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
  const url = `https://${IM_SEND_HOST}${UPLOAD_PATH}?key=${encodeURIComponent(key)}&type=${typeEnum}`;
  try {
    const form = new FormData();
    form.append("file", new Blob([data]), filename);
    const resp = await fetch(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(ATTACHMENT_HTTP_TIMEOUT),
    });
    if (!resp.ok) {
      log.error(`附件上传 HTTP 失败: ${resp.status}`);
      return null;
    }
    const result = (await resp.json()) as {
      ok?: boolean;
      code?: number;
      data?: { id?: string };
    };
    if (result.ok && result.code === 200) {
      const fileId = result.data?.id ?? null;
      log.info(`附件上传成功: ${filename} -> ${fileId}`);
      return fileId;
    }
    log.error(`附件上传接口返回错误: ${JSON.stringify(result)}`);
  } catch (e) {
    log.error(`附件上传异常: ${String(e)}`);
  }
  return null;
}
