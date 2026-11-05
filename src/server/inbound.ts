// 入站（方案 5.2）：Stream 事件 → 解析 → 身份 → 分派（推送、命令、提问、附件）。
//
// 回调里同步完成：字段校验、会话识别、身份查询（本地映射表）、生成回复上下文，并调用推送服务或 admit/control/attach，
// 它们在第一个 await 之前取到达序号并占住成员顺序，所以同一成员的消息按事件到达顺序处理。之后的等待在后台进行。
//
// 推送（src/push/service.ts）：卡片点击直接交给推送服务。单聊里的文字和附件先问推送服务：成员正在回复推送时记入回复，
// /完成、/取消 结束回复，其余照常交给消息服务。群里的文字也先问推送服务：它由此知道这个群；/登记群 由它处理；群正在回复
// 推送时记入群的回复，/完成、/取消 结束回复。
//
// 去重：写入持久记录的消息由回执去重（消息服务在同一事务里写回执，推送回复按消息 ID 唯一）。不产生持久记录的结果
// （身份未知、类型不支持、量子消息、迟到被忽略的命令、/status、/help、排队已满）只在进程内去重；重启后重复投递最多
// 多回一条提示。
import { isSlashCommandMessage, canonicalCommand } from "../agent/commands.ts";
import { MAX_CONTENT_LENGTH, PHONE_PATTERN } from "../core/config.ts";
import { log } from "../core/log.ts";
import type { StreamEvent } from "../integrations/open-platform/stream.ts";
import type { DirectoryIdentity } from "../integrations/open-platform/identity-directory.ts";
import { lateMinutes, type Outbound, sendNotice } from "../durable/outbound.ts";
import { type ReplyContext, summarize } from "../durable/records.ts";
import { DIRECT_SCOPE, groupScope } from "../core/layout.ts";
import type { AttachmentEvent } from "../durable/attachments.ts";
import type { AdmitResult, AttachResult, Inbound, InboundAttachment } from "../durable/service.ts";

export interface InboundService {
  seen(msgUid: string): boolean;
  admit(message: Inbound): Promise<AdmitResult>;
  control(message: Inbound): Promise<string>;
  /** 单聊的图片、文件、视频：登记后由成员的下一条消息使用。 */
  attach(message: InboundAttachment): Promise<AttachResult>;
}

/** 推送服务在入站上的部分（src/push/service.ts）。同步方法：调用顺序就是到达顺序。 */
export interface InboundPush {
  /** 这条消息已记入推送回复（重复投递）。 */
  seen(msgUid: string): boolean;
  click(event: StreamEvent): void;
  /** 单聊文字：推送收下（记入回复，或 /完成、/取消）时为 true。 */
  directText(identity: DirectoryIdentity, reply: ReplyContext, text: string): boolean;
  /** 单聊附件：记入回复时为 true，否则留给成员的下一条消息。 */
  directAttachment(identity: DirectoryIdentity, reply: ReplyContext, attachment: AttachmentEvent): boolean;
  /** 群里 @ 机器人的文字：推送收下（/登记群、群回复，或 /完成、/取消）时为 true。 */
  groupText(groupId: string, identity: DirectoryIdentity, reply: ReplyContext, text: string): boolean;
}

export interface InboundOptions {
  service: InboundService;
  push?: InboundPush;
  /** applying：保存的同步范围还在应用，之前的名单仍然生效；unset：没有设置同步范围，不同步。 */
  directory: { lookup(imUserId: string): DirectoryIdentity | undefined; readonly initializing: boolean; readonly scoped?: boolean; readonly applying?: boolean;
    readonly unset?: boolean };
  outbound: Outbound;
  /** 未知或已失效的 userId：触发一次通讯录扫描（冷却由目录控制）。 */
  onUnknown: () => void;
  signal: AbortSignal;
  onReport?: (error: unknown) => void;
}

/** 改变状态或产生交付副作用的命令：迟到时不执行。 */
const STATEFUL = new Set(["/stop", "/clear", "/compact", "/完成", "/取消", "/登记群"]);
const CARD_EVENT = "callback:card_interaction";
const HANDLED_LIMIT = 20_000;
const GROUP_ID = /^[0-9]{1,64}$/;
const PLATFORM_ID = /^[\x21-\x7e]{1,128}$/;

/** 校验过的消息事件。 */
type Parsed = {
  msgUid: string;
  userId: string;
  type: string;
  groupId: string | undefined;
  content: Record<string, unknown>;
  /** 文字或引用消息的文字；其他类型为 undefined。 */
  text: string | undefined;
  sentAt: number | undefined;
  receivedAt: number;
};

export class InboundRouter {
  readonly #options: InboundOptions;
  /** 进程内去重：没有持久记录的结果，以及正在入队的消息。 */
  readonly #handled = new Set<string>();
  readonly #inflight = new Set<string>();
  readonly #work = new Set<Promise<unknown>>();

  constructor(options: InboundOptions) {
    this.#options = options;
  }

  /** 同步处理一个事件；抛错只由 Stream 记日志。 */
  handle(event: StreamEvent): void {
    if (event.payload.eventType === CARD_EVENT) {
      if (this.#options.push) this.#options.push.click(event);
      else log.info("忽略卡片点击事件");
      return;
    }
    const message = this.#parse(event);
    if (!message) return;
    const found = this.#options.directory.lookup(message.userId);
    const reply = replyContext(message, found);
    const identity = this.#identify(found, reply);
    if (!identity) return;
    if (message.text === undefined) this.#media(message, identity, reply);
    else this.#text(message, identity, reply);
  }

  /** 等待已接收事件的入队和回执完成（关闭时调用）。 */
  async drain(): Promise<void> {
    while (this.#work.size) await Promise.allSettled([...this.#work]);
  }

  /** 字段校验、会话类型与群号、去重、量子会话；不处理的事件返回 undefined。 */
  #parse(event: StreamEvent): Parsed | undefined {
    const payload = event.payload;
    const eventType = payload.eventType;
    if (eventType !== "callback:direct" && eventType !== "callback:alt") {
      log.info(`忽略事件类型 ${String(eventType).slice(0, 64)}`);
      return;
    }
    const { msgUid, userId, type } = payload;
    const groupId = typeof payload.groupId === "string" ? payload.groupId : "";
    if (typeof msgUid !== "string" || !PLATFORM_ID.test(msgUid) || typeof userId !== "string" || !PLATFORM_ID.test(userId) || typeof type !== "string") {
      log.warn("入站事件缺少有效的 msgUid、userId 或 type，已丢弃");
      return;
    }
    const group = eventType === "callback:alt";
    if (group ? !GROUP_ID.test(groupId) : groupId !== "") {
      log.warn(`入站事件的群号与会话类型不符（${eventType}），已丢弃`);
      return;
    }
    if (this.#handled.has(msgUid) || this.#inflight.has(msgUid) || this.#options.service.seen(msgUid) || this.#options.push?.seen(msgUid)) return;
    if (quantumSession(payload.extraContent)) {
      this.#remember(msgUid);
      log.info(`跳过量子会话消息（${group ? "群" : "单聊"}）`);
      return;
    }
    const content = payload.content && typeof payload.content === "object" ? payload.content as Record<string, unknown> : {};
    const text = type === "text" ? content.content : type === "reference" ? content.contentText : undefined;
    return { msgUid, userId, type, groupId: group ? groupId : undefined, content, text: typeof text === "string" ? text : undefined,
      sentAt: event.sentAt, receivedAt: event.receivedAt };
  }

  /** 可用的通讯录身份；未知或手机号无效时回复提示并触发扫描。 */
  #identify(identity: DirectoryIdentity | undefined, reply: ReplyContext): DirectoryIdentity | undefined {
    if (identity !== undefined && PHONE_PATTERN.test(identity.phone)) return identity;
    if (identity !== undefined) log.error("通讯录映射中的手机号格式无效，按身份未知处理");
    const directory = this.#options.directory;
    this.#notice(reply, directory.unset ? "机器人还没有设置通讯录同步范围，暂时无法确认你的身份，请联系管理员。"
      : directory.initializing ? "正在同步通讯录，完成前暂时无法确认你的身份，请稍后重发。"
      : directory.applying ? "通讯录同步范围正在更新，完成前暂时无法确认你的身份，请稍后重发。"
      : directory.scoped ? "暂时无法确认你的身份：你可能不在机器人同步的部门范围内；如果刚加入，请稍后重发。"
      : "暂时无法确认你的身份，正在同步通讯录，请稍后重发。");
    this.#options.onUnknown();
    return undefined;
  }

  /** 图片、文件、视频（只在单聊收）：推送回复，或登记给成员的下一条消息。 */
  #media(message: Parsed, identity: DirectoryIdentity, reply: ReplyContext): void {
    const { type, msgUid } = message;
    const media = type === "image" || type === "file" || type === "video";
    const attachment = media && message.groupId === undefined ? attachmentEvent(type, message.content) : undefined;
    if (attachment === undefined) {
      this.#notice(reply, !media ? "暂不支持该类型的消息，请发送文字。"
        : message.groupId !== undefined ? "群里暂不支持接收图片、文件和视频，请在单聊中发送。" : "附件信息不完整，请重新发送。");
      return;
    }
    if (this.#options.push?.directAttachment(identity, reply, attachment)) { this.#remember(msgUid); return; }
    this.#inflight.add(msgUid);
    // attach() reserves arrival order before its first await, like admit(): the next message binds this attachment.
    this.#track(this.#options.service.attach({ scope: DIRECT_SCOPE, phone: identity.phone, reply, attachment }).then(result => {
      if (result.status === "full") {
        this.#remember(msgUid);
        this.#notice(reply, result.message, false);
      }
    }, error => {
      if (this.#options.signal.aborted) { log.warn("服务关闭中，一个单聊附件未能登记"); return; }
      this.#report(error);
      this.#notice(reply, "⚠️ 附件未能登记，请稍后重发。", false);
    }).finally(() => this.#inflight.delete(msgUid)));
  }

  /** 文字：推送回复与推送命令，然后是命令和提问。 */
  #text(parsed: Parsed, identity: DirectoryIdentity, reply: ReplyContext): void {
    const { msgUid } = parsed;
    const trimmed = parsed.text!.trim();
    if (!trimmed) {
      this.#notice(reply, "请输入问题，发送 /help 查看可用指令。");
      return;
    }
    if (Buffer.byteLength(trimmed, "utf8") > MAX_CONTENT_LENGTH) {
      this.#notice(reply, `消息过长（上限 ${MAX_CONTENT_LENGTH} 字节），请精简后重发。`);
      return;
    }
    const command = isSlashCommandMessage(trimmed) ? canonicalCommand(trimmed) : undefined;
    const late = lateMinutes(reply);
    if (command !== undefined && late !== undefined && STATEFUL.has(command)) {
      this.#notice(reply, `这条命令是 ${late} 分钟前发的，已忽略，如仍需要请重发。`);
      return;
    }
    const push = this.#options.push;
    if (push && (parsed.groupId === undefined ? push.directText(identity, reply, trimmed) : push.groupText(parsed.groupId, identity, reply, trimmed))) {
      this.#remember(msgUid);
      return;
    }
    const message: Inbound = { scope: parsed.groupId === undefined ? DIRECT_SCOPE : groupScope(parsed.groupId), phone: identity.phone, content: trimmed, reply };
    if (command !== undefined) {
      if (!STATEFUL.has(command)) this.#remember(msgUid);
      else this.#inflight.add(msgUid);
      // control() reserves the member's command order before its first await.
      this.#track(this.#options.service.control(message).then(() => {}, error => {
        // Shutdown closes the group under a waiting command; it stays in the stream and runs again at the next start.
        if (this.#options.signal.aborted) return;
        this.#report(error);
        this.#notice(reply, "⚠️ 指令未能执行，请稍后重发。", false);
      }).finally(() => this.#inflight.delete(msgUid)));
      return;
    }
    this.#inflight.add(msgUid);
    // admit() reserves arrival order and the member's admission turn before its first await.
    this.#track(this.#options.service.admit(message).then(result => {
      if (result.status === "full") {
        this.#remember(msgUid);
        this.#notice(reply, result.message, false);
      }
    }, error => {
      // Sends are closed by then; the sender gets no notice, so leave a trace without the content.
      if (this.#options.signal.aborted) { log.warn(`服务关闭中，一条消息未能加入队列（${reply.kind === "group" ? "群" : "单聊"}）`); return; }
      this.#report(error);
      this.#notice(reply, "⚠️ 消息未能加入队列，请稍后重发。", false);
    }).finally(() => this.#inflight.delete(msgUid)));
  }

  #notice(reply: ReplyContext, text: string, remember = true): void {
    if (remember) this.#remember(reply.msgUid);
    this.#track(sendNotice(this.#options.outbound, reply, text, { signal: this.#options.signal }).then(sent => {
      if (!sent && !this.#options.signal.aborted) log.warn("入站提示未送达");
    }, error => this.#report(error)));
  }

  #remember(msgUid: string): void {
    if (this.#handled.size >= HANDLED_LIMIT) this.#handled.delete(this.#handled.values().next().value!);
    this.#handled.add(msgUid);
  }

  #track(work: Promise<unknown>): void {
    this.#work.add(work);
    void work.finally(() => this.#work.delete(work));
  }

  #report(error: unknown): void {
    try { this.#options.onReport?.(error); } catch {}
  }
}

/** 回复上下文：回到消息所在的群或单聊。 */
function replyContext(message: Parsed, identity: DirectoryIdentity | undefined): ReplyContext {
  const { type, text } = message;
  return {
    kind: message.groupId === undefined ? "direct" : "group", receiveId: message.groupId ?? message.userId, senderImUserId: message.userId, msgUid: message.msgUid,
    ...(identity?.name ? { name: identity.name } : {}),
    summary: summarize(text ?? (type === "image" ? "[图片]" : type === "file" ? "[文件]" : type === "video" ? "[视频]" : `[${type}]`)),
    ...(message.sentAt === undefined ? {} : { sentAt: message.sentAt }), receivedAt: message.receivedAt,
  };
}

/** 单聊附件事件的内容（方案 2.2）：fileId 必需；文件带 filename、size、mimeType。 */
function attachmentEvent(type: AttachmentEvent["kind"], content: Record<string, unknown>): AttachmentEvent | undefined {
  const { fileId, filename, size, mimeType } = content;
  if (typeof fileId !== "string" || !/^[\x21-\x7e]{1,512}$/.test(fileId)) return undefined;
  const declared = typeof size === "number" ? size : typeof size === "string" && /^\d{1,15}$/.test(size) ? Number(size) : undefined;
  const name = type === "file" && typeof filename === "string" && filename.trim() ? [...filename.trim()].slice(0, 200).join("")
    : type === "image" ? "图片" : type === "video" ? "视频" : "文件";
  return {
    fileId, kind: type, name,
    ...(declared !== undefined && Number.isSafeInteger(declared) && declared >= 0 ? { size: declared } : {}),
    ...(typeof mimeType === "string" && mimeType && mimeType.length <= 100 ? { mimeType } : {}),
  };
}

/** `extraContent.sessionId` 非空：量子会话消息。extraContent 是 JSON 字符串、对象或空串。 */
function quantumSession(extra: unknown): boolean {
  let value = extra;
  if (typeof value === "string") {
    if (!value.trim()) return false;
    try { value = JSON.parse(value); } catch { return false; }
  }
  if (!value || typeof value !== "object") return false;
  const session = (value as Record<string, unknown>).sessionId;
  return session !== undefined && session !== null && session !== "";
}
