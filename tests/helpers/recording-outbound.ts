// A recording `Outbound` for service tests: every send is decoded back to the member that asked (through the reply
// msgUid) and classified. No platform, no network.
import { AsyncLocalStorage } from "node:async_hooks";
import type { OutboundMessage, SendOptions, SendOutcome, Target } from "../../src/integrations/open-platform/messages.ts";
import type { Outbound } from "../../src/durable/outbound.ts";
import { KeyedQueue } from "../../src/core/lifecycle.ts";
import type { LinkNote, ReplyContext } from "../../src/durable/records.ts";
import { DIRECT_SCOPE, groupScope } from "../../src/core/layout.ts";
import type { Inbound } from "../../src/durable/service.ts";

/**
 * notice: a summary-carrying notice (receipts, late-message notes, errors without @);
 * reply: a reply segment (the lead one carries `mention` in a group); links: the link-note text; file: a file message.
 */
export type SentKind = "notice" | "reply" | "links" | "file";
/** The direct space in `message` and `Sent.space`; anything else is a group id. */
export const DIRECT_SPACE = "direct";

export type Sent = { kind: SentKind; text: string; phone: string; space: string; mention?: string; msgUid: string };

export type Failure = "failed" | "uncertain" | "throw";

/**
 * Unique across recordings and processes: a restarted service (in this process or after a killed child) must not see a
 * new message as a redelivery.
 */
let serial = 0;
const PROCESS = crypto.randomUUID().slice(0, 8);

export function recordingOutbound() {
  const sent: Sent[] = [];
  const messages = new Map<string, { phone: string; space: string }>();
  /** `fail` applies to every send; `failWhen` decides per message (checked first). */
  const state: { fail: Failure | false; failWhen?: (sent: Sent) => Failure | false; uploads: number } = { fail: false, uploads: 0 };

  function decode(target: Target, message: OutboundMessage, options: SendOptions | undefined): Sent {
    const msgUid = options?.replyMsgId ?? "";
    const origin = messages.get(msgUid) ?? { phone: "", space: target.kind === "group" ? target.receiveId : DIRECT_SPACE };
    const base = { phone: origin.phone, space: origin.space, msgUid };
    if (message.msgType === "file") return { ...base, kind: "file", text: message.content.fileName };
    if (message.msgType === "image") return { ...base, kind: "file", text: message.content.altText ?? "image" };
    if (message.msgType === "text") {
      return { ...base, kind: "notice", text: message.content.content };
    }
    const body = message.content.content;
    const mention = message.content.a?.[0]?.i;
    const summary = /^> 回复[^\n]*\n\n/.exec(body);
    const text = summary ? body.slice(summary[0].length) : body;
    if (target.kind === "group" && summary && mention === undefined) return { ...base, kind: "notice", text };
    return { ...base, kind: "reply", text, ...(mention === undefined ? {} : { mention }) };
  }

  async function post(target: Target, message: OutboundMessage, options: SendOptions | undefined): Promise<SendOutcome> {
    const item = decode(target, message, options);
    // Link notes are plain text in both chats; mark them by the text the `links` stub produced.
    if (message.msgType === "text" && linkTexts.has(message.content.content)) item.kind = "links";
    const failure = state.failWhen?.(item) ?? state.fail;
    if (failure === "throw") throw new Error("synthetic send failure");
    if (failure) return { status: failure, reason: `synthetic ${failure}` };
    sent.push(item);
    return { status: "sent" };
  }
  // Per-conversation send order as MessageSender keeps it: a held sequence delays every other send to that conversation.
  // Tests intercept `send` (also on spread copies), so a held sequence sends through `this.send`; inside the hold that
  // send goes straight through instead of waiting for the hold it is part of.
  const order = new KeyedQueue(), holding = new AsyncLocalStorage<string>(), key = (target: Target) => `${target.kind}:${target.receiveId}`;
  const outbound: Outbound = {
    send: (target, message, options) => holding.getStore() === key(target) ? post(target, message, options)
      : order.run(key(target), () => post(target, message, options)),
    sequence(target, work, signal) {
      return order.run(key(target), () => holding.run(key(target), () => work((message, options) => this.send(target, message, options))), signal);
    },
    async upload(source) {
      state.uploads++;
      return `file-${source.fileName}`;
    },
    async links(notes: readonly LinkNote[]) {
      const text = notes.map(note => note.original).join("\n\n");
      linkTexts.add(text);
      return text;
    },
  };
  const linkTexts = new Set<string>();

  /** An inbound message of `phone` in `space` (a group id or `DIRECT_SPACE`). */
  function message(space: string, phone: string, content: string, extra: Partial<ReplyContext> = {}): Inbound {
    const msgUid = extra.msgUid ?? `msg-${PROCESS}-${++serial}-${phone}`;
    messages.set(msgUid, { phone, space });
    const direct = space === DIRECT_SPACE;
    const reply: ReplyContext = {
      kind: direct ? "direct" : "group", receiveId: direct ? `im-${phone}` : space, senderImUserId: `im-${phone}`, msgUid,
      summary: content.slice(0, 30), receivedAt: Date.now(), ...extra,
    };
    return { scope: direct ? DIRECT_SCOPE : groupScope(space), phone, content, reply };
  }

  /** Texts of one kind, optionally only those of one member. */
  const texts = (kind: SentKind, phone?: string) => sent.filter(item => item.kind === kind && (phone === undefined || item.phone === phone)).map(item => item.text);

  return { sent, state, outbound, message, texts };
}

export type Recording = ReturnType<typeof recordingOutbound>;

/** Each answered message's reply segments joined, in the order the first segment went out. */
export function replyTexts(sent: readonly Sent[]): string[] {
  const joined = new Map<string, string>();
  for (const item of sent) if (item.kind === "reply") joined.set(item.msgUid, (joined.get(item.msgUid) ?? "") + item.text);
  return [...joined.values()];
}
