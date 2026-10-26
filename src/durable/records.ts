// Run records of a space (a group, or the shared direct-chat space) in its Durable database, next to the inbox and the
// control stream (./inbox.ts). Everything a request needs after its run lives here and changes in the same commits as
// the inbox: the immutable reply context of the inbound message, link notes and file sends of the run, registered
// deliverables, and the delivery plan of the final reply with the state of every part.
//
// Receipts. Every inbound message that leads to a durable record (an inbox item, a persistent command, an attachment)
// leaves its platform `msgUid` in `mixin.receipts`, written in the same commit as that record: a redelivered event finds
// it and is dropped. A rolled-back commit leaves no receipt, so the redelivery is admitted again.
//
// Delivery parts. Each part of a delivery (a reply segment, the link notes, a file) is sent on its own and goes
// pending → sending → sent | failed | uncertain. `sending` is committed before the platform call; a part still
// `sending` after a restart is uncertain. Uncertain parts count as sent and are never sent again (the platform does not
// deduplicate). A failed part is tried again after a growing wait, also across restarts, until the delivery's window
// ends; a failure that retrying cannot fix (an expired link, a changed snapshot) is final at once.
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import type { RelayReference } from "../integrations/relay.ts";

/** Where the answers to one inbound message go, fixed when it arrives. */
export type ReplyContext = {
  kind: "group" | "direct";
  /** The group id, or the sender's platform user id in a direct chat. */
  receiveId: string;
  /** The sender's platform user id of this message: the group @ target. */
  senderImUserId: string;
  msgUid: string;
  /** Directory name of the sender; shown in the group summary line. */
  name?: string;
  /** The first characters of the question, one line. */
  summary: string;
  /** Platform send time (`X-CTQ-Timestamp`), when the frame had one. */
  sentAt?: number;
  receivedAt: number;
};

/** A relay link the run produced: sent as its own text message after the reply, refreshed at send time. */
export type LinkNote = { original: string; reference: RelayReference };

export type ReviewStatus = "checked" | "draft" | "rejected";
export type Deliverable = {
  id: string; slot: string; seq: number; name: string;
  sourcePath: string; path: string; size: number; sha256: string; format: string; complete: boolean;
  status: ReviewStatus; checked: string[]; unchecked: string[]; issues: string[]; at: number;
};

/** A file the model sent during its run (send_file); state as for delivery parts. */
export type FileSend = {
  id: string; name: string; path: string; sha256: string; size: number; mode: "direct" | "relay";
  state: "planned" | "sending" | "sent" | "failed" | "uncertain";
  attempts: number; error?: string; at: number;
  relay?: { url: string; note: string; attachment: LinkNote; size: number };
};

/**
 * pending: not tried yet. failed: certainly not sent; tried again at `retryAt`, never again without it. uncertain: the
 * platform may have it (it does not deduplicate), so it counts as sent and is never resent.
 */
export type PartState = "pending" | "sending" | "sent" | "uncertain" | "failed";
export type DeliveryPart = {
  id: string;
  /** markdown: one reply segment; links: one of the run's link notes (one platform message); file: a frozen file. */
  kind: "markdown" | "links" | "file";
  body?: string;
  /** links: the index of the note in the record's notes. */
  note?: number;
  /** The first segment: carries the summary line and, in a group, the @ of the sender. */
  lead?: true;
  file?: { name: string; path: string; size: number; sha256: string };
  state: PartState;
  attempts: number;
  /** Failed: when the next automatic attempt is due; absent when the failure is final. */
  retryAt?: number;
  error?: string;
  at?: number;
};
export type Delivery = {
  kind: "reply" | "fallback";
  createdAt: number;
  parts: DeliveryPart[];
  /** Fallback: sending ends here, before the retry window would. */
  deadline?: number;
  /** Sending ended with parts left: a /stop or /clear withdrew it, or its window passed. */
  abandoned?: { at: number; reason: "withdrawn" | "expired" };
};

/** Waits before the next attempt of a failed part, by attempts made so far; the last one repeats. */
export const DELIVERY_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 1_800_000, 3_600_000] as const;
/** A delivery that is still not sent this long after its creation is given up. */
export const DELIVERY_WINDOW_MS = 6 * 3600_000;

export function deliveryRetryDelay(attempts: number, delays: readonly number[] = DELIVERY_RETRY_DELAYS_MS): number {
  return delays[Math.min(Math.max(attempts, 1), delays.length) - 1]!;
}

/** When automatic sending of a delivery ends at the latest. */
export function deliveryEnd(delivery: Readonly<Delivery>, windowMs = DELIVERY_WINDOW_MS): number {
  return Math.min(delivery.createdAt + windowMs, delivery.deadline ?? Infinity);
}

/** A part that still has to go out: untried, being sent, or failed with a retry due. */
export function openPart(part: Readonly<DeliveryPart>): boolean {
  return part.state === "pending" || part.state === "sending" || (part.state === "failed" && part.retryAt !== undefined);
}

export type RequestRecord = {
  requestId: string;
  reply: ReplyContext;
  createdAt: number;
  notes: LinkNote[];
  deliverables: Deliverable[];
  files: FileSend[];
  /** Hook and tool observations of the run (document builds, reminders), keyed for idempotence. */
  events: Record<string, { name: string; digest?: string; at: number }>;
  delivery?: Delivery;
  /** Set when the inbox item is removed: the run is over (answered, failed or cancelled). */
  closedAt?: number;
  cancelled?: true;
};

/** Inbound attachment of a direct chat (S3); bound to the next request of the member. */
export type AttachmentState = "pending" | "ready" | "failed" | "rejected" | "void";
export type Attachment = {
  id: string;
  msgUid: string;
  receivedAt: number;
  epoch: number;
  fileId: string;
  kind: "image" | "file" | "video";
  name: string;
  /** Declared size, when the event had one. */
  size?: number;
  mimeType?: string;
  reply: ReplyContext;
  state: AttachmentState;
  /** Ready: the final path. */
  path?: string;
  actualSize?: number;
  error?: string;
  /** The request that consumed it. */
  boundTo?: string;
  at: number;
};

export type MemberRecords = { requests: Record<string, RequestRecord>; attachments: Record<string, Attachment> };

/** One member's run records in the space. */
export const MemberRecordsDoc = defineDocFamily<MemberRecords, null>({
  kind: "mixin.member-records",
  version: 1,
  checkpointWhen: () => false,
  scope: "session",
  family: true,
  initial: () => ({ requests: {}, attachments: {} }),
});

export type Receipt = { at: number; phone: string; request?: string };
export const ReceiptsDoc = defineDoc<{ items: Record<string, Receipt> }>({
  kind: "mixin.receipts", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ items: {} }),
});

export const RECEIPT_RETENTION_MS = 24 * 3600_000;
export const CLOSED_RECORD_RETENTION_MS = 24 * 3600_000;

export async function memberRecords(reader: Pick<DocumentReader, "snapshot">, phone: string, context: Context): Promise<Readonly<MemberRecords>> {
  return (await reader.snapshot(MemberRecordsDoc, phone, context)) ?? { requests: {}, attachments: {} };
}

export function recordsOf(tx: Tx, phone: string): Promise<MemberRecords> {
  return tx.doc(MemberRecordsDoc, phone, null);
}

/** A delivery that is still sending: not abandoned, with an open part. */
export function undelivered(record: Readonly<RequestRecord>): boolean {
  return record.delivery !== undefined && record.delivery.abandoned === undefined && record.delivery.parts.some(openPart);
}

/** Oldest first: the deliveries automatic sending still works on. */
export function pendingDeliveries(records: Readonly<MemberRecords>): RequestRecord[] {
  return Object.values(records.requests).filter(undelivered).sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
}

/** Parts left `sending` by an ended process: their platform outcome is unknown, so they count as sent. */
export function settleInterrupted(records: MemberRecords): boolean {
  let changed = false;
  for (const record of Object.values(records.requests)) {
    for (const part of record.delivery?.parts ?? []) {
      if (part.state === "sending") { part.state = "uncertain"; part.error = "发送过程中服务中断，结果未知"; changed = true; }
    }
    for (const file of record.files) {
      if (file.state === "sending") { file.state = "uncertain"; file.error = "发送过程中服务中断，结果未知"; changed = true; }
    }
  }
  return changed;
}

/**
 * Drop closed records whose delivery is complete (or that had none) after the retention, and their receipts' links.
 * Records still delivering, and receipts of open requests, stay. A record is the source of its ask's count, so it also
 * stays until `settled` (given the candidates) names it: a ledger failure must not lose the ask for good.
 */
export function pruneRecords(records: MemberRecords, now: number, settled: (candidates: readonly RequestRecord[]) => ReadonlySet<string>): void {
  const candidates = Object.values(records.requests)
    .filter(record => record.closedAt !== undefined && !undelivered(record) && now - record.closedAt > CLOSED_RECORD_RETENTION_MS);
  const done = candidates.length ? settled(candidates) : new Set<string>();
  for (const record of candidates) if (done.has(record.requestId)) delete records.requests[record.requestId];
  for (const [id, attachment] of Object.entries(records.attachments)) {
    if (attachment.state === "void" && now - attachment.at > CLOSED_RECORD_RETENTION_MS) delete records.attachments[id];
  }
}

export function pruneReceipts(receipts: { items: Record<string, Receipt> }, open: (receipt: Receipt) => boolean, now: number): void {
  for (const [uid, receipt] of Object.entries(receipts.items)) {
    if (now - receipt.at > RECEIPT_RETENTION_MS && !open(receipt)) delete receipts.items[uid];
  }
}

/** The first characters of a question, on one line. */
export function summarize(text: string, length = 30): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length > length ? chars.slice(0, length).join("") + "…" : line;
}
