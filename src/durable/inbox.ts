// The service's own durable state in a group database (D3): each member's inbox and the group's control stream.
//
// Inbox. A webhook message is admitted by one commit to the member conversation's `mixin.inbox` before the webhook is
// acknowledged; the member's worker (src/durable/service.ts) submits the head item to Durable with the item's requestId,
// waits for it to settle, stores the reply in the outbox and only then removes the item. Durable admits a known
// requestId once, so submitting again after a crash is idempotent: a crash before the submission submits it, a crash
// after it waits for the same submission. Items run one at a time in arrival order; nothing behind the head is in
// Durable's queue, so /stop and /clear only abort the head and drop the rest.
//
// Controls. A /stop or /clear is committed to `mixin.controls` (with the stream sequence the request door uses) before
// it runs and removed after; the door holds the member's model requests in between (src/durable/door.ts). On startup
// the waiting controls are loaded into the door before scheduling resumes, then executed again (both are idempotent).
import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";

export type InboxItem = {
  requestId: string;
  content: string;
  receivedAt: number;
  // Together with epoch this is the persisted strictly increasing arrival order. The service reserves
  // the member's admission turn before any await, so later arrivals cannot commit or run ahead of it.
  /** Persisted group-open generation. Missing on older development data means 0. */
  epoch?: number;
  /** When the worker first submitted it (the total deadline counts from here, across restarts). */
  startedAt?: number;
  /** A /stop or /clear dropped it: never submitted again; a running submission was aborted. */
  cancelled?: boolean;
};

export const InboxDoc = defineDoc<{ items: InboxItem[] }>({
  kind: "mixin.inbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: [] }),
});

/** Bounded webhook content receipts; written with the inbox, retained across conversation resets and process restarts. */
export const WebhookReceiptsDoc = defineDoc<{ items: { phone: string; digest: string; at: number }[] }>({
  kind: "mixin.webhook-receipts", version: 1, scope: "session", initial: () => ({ items: [] }),
});

export type ControlCommand = "/stop" | "/clear";
export type StoredControl = { phone: string; requestId: string; seq: number; command: ControlCommand; receivedAt: number; epoch?: number; resetDone?: true };

export const ControlsDoc = defineDoc<{ seq: number; epoch?: number; pending: StoredControl[] }>({
  kind: "mixin.controls",
  version: 1,
  scope: "session",
  initial: () => ({ seq: 0, pending: [] }),
});

/** Wall time may move backwards across restarts. Within one process, receivedAt is strictly increasing. */
export function receivedBefore(item: InboxItem, control: StoredControl): boolean {
  const itemEpoch = item.epoch ?? 0, controlEpoch = control.epoch ?? 0;
  return itemEpoch < controlEpoch || (itemEpoch === controlEpoch && item.receivedAt <= control.receivedAt);
}

export async function inboxItems(harness: Harness, conversationId: number, context: Context): Promise<readonly InboxItem[]> {
  return (await harness.snapshot(InboxDoc, conversationId as ConversationId, context))?.items ?? [];
}

export async function pendingControls(harness: Harness, context: Context): Promise<readonly StoredControl[]> {
  return (await harness.snapshot(ControlsDoc, context))?.pending ?? [];
}
