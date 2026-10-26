// What the service sends, and how a reply context shapes it (plan 5.4).
//
// Group: every message is Markdown; the first segment of a reply or notice starts with the summary line
// `> 回复 <name>：<question>`, and that of a final reply or a terminal error also @-mentions the sender (`a[].i`,
// Markdown only). Later segments carry neither: they are sent under the conversation's held send order (sequence), so
// no other message from the service lands between them. Direct chat: no summary; notices are plain text, replies Markdown.
// The name and question are escaped as plain text: they cannot open a link, a list or a heading.
import { refreshDeliveryText } from "../agent/delivery-links.ts";
import { PlatformClient } from "../integrations/open-platform/client.ts";
import { uploadFile, type UploadSource } from "../integrations/open-platform/files.ts";
import { fileMessage, imageMessage, markdownMessage, measure, MessageSender, type OutboundMessage, type Send, splitText, type SegmentSize,
  type SendOptions, type SendOutcome, type Target, textMessage } from "../integrations/open-platform/messages.ts";
import type { LinkNote, ReplyContext } from "./records.ts";

/** The platform as the service uses it; tests record or fail sends here. */
export interface Outbound {
  send(target: Target, message: OutboundMessage, options?: SendOptions): Promise<SendOutcome>;
  /**
   * Hold the conversation's send order while `work` sends several messages in a row through the `send` it is given
   * (never through `send` above, which would wait for this hold): nothing else the service sends lands between them.
   */
  sequence<T>(target: Target, work: (send: Send) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Upload a local file for an image or file message; returns the platform file id. */
  upload(source: UploadSource, signal?: AbortSignal): Promise<string>;
  /** The text of link notes, with every relay link refreshed. */
  links(notes: readonly LinkNote[], signal?: AbortSignal): Promise<string>;
}

export function platformOutbound(client: PlatformClient, sender: MessageSender): Outbound {
  return {
    send: (target, message, options) => sender.send(target, message, options),
    sequence: (target, work, signal) => sender.transaction(target, work, signal),
    upload: (source, signal) => uploadFile(client, source, signal),
    links: (notes, signal) => refreshDeliveryText({ text: notes.map(note => note.original).join("\n\n"), attachments: [...notes] }, signal),
  };
}

/** Messages older than this when received are maintenance redeliveries (plan 2.7). */
export const LATE_MS = 60_000;

export function lateMinutes(reply: ReplyContext): number | undefined {
  if (reply.sentAt === undefined || reply.receivedAt - reply.sentAt <= LATE_MS) return undefined;
  return Math.max(1, Math.round((reply.receivedAt - reply.sentAt) / 60_000));
}

export function targetOf(reply: ReplyContext): Target {
  return { kind: reply.kind, receiveId: reply.receiveId };
}

const MARKDOWN_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~=$&]/g;

/** Plain text inside Markdown: one line, no structure, no links. */
export function escapeInline(text: string): string {
  // \s also covers U+00A0, U+2028/2029 and the ideographic space.
  return text.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().replace(MARKDOWN_SPECIAL, "\\$&");
}

export function summaryLine(reply: ReplyContext): string {
  const name = reply.name ? ` ${escapeInline(reply.name)}` : "";
  return `> 回复${name}：${escapeInline(reply.summary)}\n\n`;
}

function reserve(reply: ReplyContext): SegmentSize | undefined {
  return reply.kind === "group" ? measure(summaryLine(reply)) : undefined;
}

/** Segments of a final reply body; the first leaves room for the summary line. */
export function replySegments(reply: ReplyContext, body: string): string[] {
  const firstReserve = reserve(reply);
  return splitText(body, firstReserve ? { firstReserve } : {});
}

/** One segment of a final reply (Markdown); the lead segment carries the summary and the @ in a group. */
export function replyMessage(reply: ReplyContext, segment: string, lead: boolean): OutboundMessage {
  if (reply.kind !== "group") return markdownMessage(segment);
  return lead ? markdownMessage(summaryLine(reply) + segment, reply.senderImUserId) : markdownMessage(segment);
}

/** A notice (status, receipt, error) as messages; `mention` only for terminal errors. */
export function noticeMessages(reply: ReplyContext, text: string, mention = false): OutboundMessage[] {
  if (reply.kind !== "group") return splitText(text).map(textMessage);
  return replySegments(reply, text).map((segment, index) => index === 0
    ? markdownMessage(summaryLine(reply) + segment, mention ? reply.senderImUserId : undefined)
    : markdownMessage(segment));
}

/** Send a notice; false unless every segment was confirmed. Best effort: never throws for platform failures. */
export async function sendNotice(outbound: Outbound, reply: ReplyContext, text: string, options: { mention?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
  return outbound.sequence(targetOf(reply), send => noticeVia(send, reply, text, options), options.signal)
    .catch(error => { if (options.signal?.aborted) return false; throw error; });
}

/** A notice through a held sequence's `send` (see Outbound.sequence); false unless every segment was confirmed. */
export async function noticeVia(send: Send, reply: ReplyContext, text: string, options: { mention?: boolean; signal?: AbortSignal } = {}): Promise<boolean> {
  for (const message of noticeMessages(reply, text, options.mention)) {
    const outcome = await send(message, { replyMsgId: reply.msgUid, ...(options.signal ? { signal: options.signal } : {}) });
    if (outcome.status !== "sent") return false;
  }
  return true;
}

const IMAGE_TYPES: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp", bmp: "bmp" };

/** Upload and send one local file as a file message. `dispatched` marks the irreversible send call. */
export async function sendFileMessage(outbound: Outbound, reply: ReplyContext, file: { path: string; name: string; size: number },
  signal: AbortSignal | undefined, dispatched: () => void): Promise<SendOutcome> {
  const extension = extensionOf(file.name);
  const fileId = await outbound.upload({ path: file.path, fileName: file.name, size: file.size, mimeType: mimeOf(extension) }, signal);
  signal?.throwIfAborted();
  dispatched();
  return outbound.send(targetOf(reply), fileMessage({ fileId, fileName: file.name, size: file.size, mimeType: extension || "bin" }),
    { replyMsgId: reply.msgUid, ...(signal ? { signal } : {}) });
}

export async function sendImageMessage(outbound: Outbound, reply: ReplyContext, image: { path: string; name: string; size: number; width: number; height: number; format: string },
  signal: AbortSignal | undefined, dispatched: () => void): Promise<SendOutcome> {
  const type = IMAGE_TYPES[image.format] ?? image.format;
  const fileId = await outbound.upload({ path: image.path, fileName: image.name, size: image.size, mimeType: `image/${type === "jpg" ? "jpeg" : type}` }, signal);
  signal?.throwIfAborted();
  dispatched();
  return outbound.send(targetOf(reply), imageMessage({ fileId, width: image.width, height: image.height, mimeType: type }),
    { replyMsgId: reply.msgUid, ...(signal ? { signal } : {}) });
}

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return match ? match[1]!.toLowerCase() : "";
}

const MIME: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
};

function mimeOf(extension: string): string {
  return MIME[extension] ?? "application/octet-stream";
}
