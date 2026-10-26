// 消息发送：消息体构造、按字数和字节分段、本地限流和发送结果分类。
// 平台不按 idem_key 去重，所以只有确定没有发出时才重试；结果不确定的发送交给调用方记录，不自动重发。
import { randomUUID } from "node:crypto";
import { KeyedQueue } from "../../core/lifecycle.ts";
import { log } from "../../core/log.ts";
import { accepted, PlatformRequestError, type PlatformClient } from "./client.ts";

/** 单条消息正文上限（含姓名、摘要、迟到提示和 Markdown 包装）。项目保守值，不是平台极限。 */
export const SEGMENT_MAX_CHARS = 3500;
export const SEGMENT_MAX_BYTES = 10 * 1024;

export interface Target {
  readonly kind: "direct" | "group";
  /** 群为 groupId，单聊为对方的 userId。 */
  readonly receiveId: string;
}

export type OutboundMessage =
  | { readonly msgType: "text"; readonly content: { readonly content: string } }
  | { readonly msgType: "markdown"; readonly content: { readonly title: string; readonly content: string; readonly a?: readonly { readonly i: string }[] } }
  | { readonly msgType: "image"; readonly content: ImageContent }
  | { readonly msgType: "file"; readonly content: FileContent };

export interface ImageContent {
  readonly fileId: string;
  readonly width: number;
  readonly height: number;
  /** 扩展名，不带点，如 png。 */
  readonly mimeType: string;
  readonly altText?: string;
}

export interface FileContent {
  readonly fileId: string;
  readonly fileName: string;
  readonly size: number;
  /** 扩展名，不带点，如 txt。 */
  readonly mimeType: string;
}

export function textMessage(text: string): OutboundMessage {
  return { msgType: "text", content: { content: text } };
}

/** 群 @ 只在 Markdown 生效：`a: [{ i: 提问人 userId }]`。其他字段（mentionedInfo 等）不需要。 */
export function markdownMessage(body: string, mention?: string): OutboundMessage {
  return { msgType: "markdown", content: { title: markdownTitle(body), content: body, ...(mention ? { a: [{ i: mention }] } : {}) } };
}

export function imageMessage(content: ImageContent): OutboundMessage {
  return { msgType: "image", content };
}

export function fileMessage(content: FileContent): OutboundMessage {
  return { msgType: "file", content };
}

/** 标题不显示在气泡里，只用于会话列表摘要。 */
function markdownTitle(body: string): string {
  const line = body.trim().split("\n", 1)[0]?.trim() ?? "";
  const clean = line.replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/u, "").replace(/^[*_`\t ]+|[*_`\t ]+$/g, "");
  return Array.from(clean || "AI 回复").slice(0, 24).join("");
}

// ===== 分段 =====

export interface SegmentSize { readonly chars: number; readonly bytes: number }

export function measure(text: string): SegmentSize {
  let chars = 0;
  for (const _ of text) chars++;
  return { chars, bytes: Buffer.byteLength(text, "utf8") };
}

interface Fence { readonly opener: string; readonly marker: string }

/** 行首 ``` 或 ~~~ 开启代码块；同字符、不短于开启标记且后面只有空白的行关闭它。 */
function nextFence(line: string, fence: Fence | undefined): Fence | undefined {
  const trimmed = line.replace(/\r?\n$/, "");
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(trimmed);
  if (!match) return fence;
  const run = match[1]!;
  if (!fence) return run[0] === "`" && match[2]!.includes("`") ? undefined : { opener: trimmed, marker: run };
  return run[0] === fence.marker[0] && run.length >= fence.marker.length && !match[2]!.trim() ? undefined : fence;
}

/**
 * 按行分段，每段不超过字数和字节上限。代码块跨段时在段尾补上关闭标记、下一段开头重新打开，
 * 保持每段的 Markdown 结构完整。`firstReserve` 为首段前缀（姓名、摘要、迟到提示）预留的大小。
 */
export function splitText(text: string, options: { maxChars?: number; maxBytes?: number; firstReserve?: SegmentSize } = {}): string[] {
  const maxChars = options.maxChars ?? SEGMENT_MAX_CHARS;
  const maxBytes = options.maxBytes ?? SEGMENT_MAX_BYTES;
  const reserve = options.firstReserve ?? { chars: 0, bytes: 0 };
  const chunks: string[] = [];
  let current = "";
  let size = { chars: 0, bytes: 0 };
  let fence: Fence | undefined;
  /** current 里除了重新打开的代码块标记外是否已有内容。 */
  let hasBody = false;

  const limit = () => chunks.length === 0
    ? { chars: maxChars - reserve.chars, bytes: maxBytes - reserve.bytes }
    : { chars: maxChars, bytes: maxBytes };
  const closer = (state: Fence | undefined) => state ? 1 + state.marker.length : 0;
  const append = (piece: string) => {
    const measured = measure(piece);
    current += piece;
    size = { chars: size.chars + measured.chars, bytes: size.bytes + measured.bytes };
    hasBody = true;
  };
  const fits = (piece: SegmentSize, after: Fence | undefined) => {
    const room = limit();
    const tail = closer(after);
    return size.chars + piece.chars + tail <= room.chars && size.bytes + piece.bytes + tail <= room.bytes;
  };
  const flush = () => {
    if (hasBody) {
      let chunk = current;
      if (fence) chunk += (chunk.endsWith("\n") ? "" : "\n") + fence.marker;
      chunks.push(chunk);
    }
    current = "";
    size = { chars: 0, bytes: 0 };
    hasBody = false;
    // 过长的开启行不再重复，避免下一段被它占满。
    if (fence && fence.opener.length <= 200) {
      current = fence.opener + "\n";
      size = measure(current);
    }
  };

  for (const line of text.match(/[^\n]*\n|[^\n]+/g) ?? []) {
    const after = nextFence(line, fence);
    const measured = measure(line);
    if (fits(measured, after)) { append(line); fence = after; continue; }
    if (hasBody) {
      flush();
      if (fits(measured, after)) { append(line); fence = after; continue; }
    }
    // 单行超过一段：按码点硬切。
    let rest = line;
    while (rest) {
      const room = limit();
      const tail = closer(fence);
      let take = 0, chars = 0, bytes = 0;
      for (const point of rest) {
        const width = Buffer.byteLength(point, "utf8");
        if (size.chars + chars + 1 + tail > room.chars || size.bytes + bytes + width + tail > room.bytes) break;
        take += point.length; chars++; bytes += width;
      }
      if (take === 0) {
        if (!hasBody) throw new Error("分段上限过小");
        flush();
        continue;
      }
      append(rest.slice(0, take));
      rest = rest.slice(take);
      if (rest) flush();
    }
    fence = after;
  }
  flush();
  return chunks;
}

// ===== 发送 =====

export type SendOutcome =
  | { readonly status: "sent" }
  /** 确定没有送达：平台明确拒绝，或请求没有发出。 */
  | { readonly status: "failed"; readonly reason: string }
  /** 平台可能已经收到：超时、连接中途断开、网关超时。不能自动重发。 */
  | { readonly status: "uncertain"; readonly reason: string };

export interface SendOptions {
  /** 原消息 msgUid；客户端目前不显示引用框，平台以后支持时自动生效。 */
  readonly replyMsgId?: string;
  /** 只用于日志关联；平台不按它去重。 */
  readonly idemKey?: string;
  /** 只取消排队和限流等待；请求一旦发出就等它结束，以免把已发出的消息记成未发。 */
  readonly signal?: AbortSignal;
}

export interface RateLimits {
  readonly perTarget: number;
  readonly global: number;
  readonly windowMs: number;
}

/** 项目自己的保护参数（每会话 5 条/秒、全局 20 条/秒），不是平台公开配额。 */
export const DEFAULT_RATE_LIMITS: RateLimits = { perTarget: 5, global: 20, windowMs: 1000 };

export type Send = (message: OutboundMessage, options?: SendOptions) => Promise<SendOutcome>;

export class MessageSender {
  readonly #queue = new KeyedQueue();
  readonly #global: number[] = [];
  readonly #targets = new Map<string, number[]>();

  constructor(private readonly client: PlatformClient, private readonly limits: RateLimits = DEFAULT_RATE_LIMITS) {}

  /** 占住目标会话的发送顺序，期间的多条消息不会被同一会话的其他发送插入。 */
  transaction<T>(target: Target, work: (send: Send) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#queue.run(targetKey(target), () => work((message, options) => this.#post(target, message, options ?? {})), signal);
  }

  send(target: Target, message: OutboundMessage, options: SendOptions = {}): Promise<SendOutcome> {
    return this.transaction(target, send => send(message, options), options.signal)
      .catch(error => cancelled(error, options.signal));
  }

  async #reserve(target: Target, signal?: AbortSignal): Promise<void> {
    const key = targetKey(target);
    while (true) {
      const now = this.client.now();
      const cutoff = now - this.limits.windowMs;
      const own = this.#targets.get(key) ?? [];
      while (own.length && own[0]! <= cutoff) own.shift();
      while (this.#global.length && this.#global[0]! <= cutoff) this.#global.shift();
      if (own.length < this.limits.perTarget && this.#global.length < this.limits.global) {
        own.push(now);
        this.#global.push(now);
        this.#targets.set(key, own);
        return;
      }
      const earliest = Math.min(own.length >= this.limits.perTarget ? own[0]! : Infinity,
        this.#global.length >= this.limits.global ? this.#global[0]! : Infinity);
      await this.client.sleep(Math.max(1, earliest + this.limits.windowMs - now + 1), signal);
      // 空闲会话的窗口不再保留。
      for (const [name, stamps] of this.#targets) if (!stamps.length || stamps[stamps.length - 1]! <= cutoff) this.#targets.delete(name);
    }
  }

  async #post(target: Target, message: OutboundMessage, options: SendOptions): Promise<SendOutcome> {
    try { await this.#reserve(target, options.signal); }
    catch (error) { return cancelled(error, options.signal); }
    const body = {
      receive_id: target.receiveId,
      conversation_type: target.kind === "group" ? "group" : "single",
      msg_type: message.msgType,
      content: JSON.stringify(message.content),
      ...(options.replyMsgId ? { reply_msg_id: options.replyMsgId } : {}),
      idem_key: options.idemKey ?? randomUUID(),
    };
    const label = `发送${message.msgType}（${target.kind === "group" ? "群" : "单聊"}）`;
    let started = false;
    try {
      const response = await this.client.request("POST", "/open-apis/v1/messages/v1/send", {
        body, label, onSent: () => { started = true; },
      });
      if (accepted(response)) return { status: "sent" };
      const code = response.json?.code;
      const detail = `HTTP ${response.status}${code === undefined ? "" : ` code=${String(code)}`}`;
      if (response.status === 502 || response.status === 504) {
        log.warn(`${label}结果未知：${detail}`);
        return { status: "uncertain", reason: `平台网关超时（${detail}）` };
      }
      // 2xx 只有带明确拒绝（success=false 或非成功 code）才算未发出；空、损坏或缺字段的响应无法确认结果。
      if (response.status >= 200 && response.status < 300 && !rejected(response.json)) {
        log.warn(`${label}结果未知：${detail} 响应无法确认结果`);
        return { status: "uncertain", reason: `平台响应无法确认结果（${detail}）` };
      }
      log.error(`${label}失败：${detail}`);
      return { status: "failed", reason: `平台拒绝（${detail}）` };
    } catch (error) {
      if (error instanceof PlatformRequestError) {
        if (error.kind === "uncertain") {
          log.warn(error.message);
          return { status: "uncertain", reason: error.message };
        }
        log.error(error.message);
        return { status: "failed", reason: error.message };
      }
      // 关闭中止：请求已发出则结果未知。
      if (started) return { status: "uncertain", reason: "发送过程中服务关闭" };
      return cancelled(error, options.signal);
    }
  }
}

/** 明确拒绝：success 为 false，或 code 是 0/200 以外的数字。code 为 null、字符串、对象或数组都不算。 */
function rejected(json: Record<string, unknown> | null): boolean {
  return json?.success === false || (typeof json?.code === "number" && json.code !== 0 && json.code !== 200);
}

function targetKey(target: Target): string {
  return `${target.kind}:${target.receiveId}`;
}

function cancelled(error: unknown, signal?: AbortSignal): SendOutcome {
  if (signal?.aborted || (error as { name?: unknown } | undefined)?.name === "AbortError")
    return { status: "failed", reason: "发送前已取消" };
  throw error;
}
