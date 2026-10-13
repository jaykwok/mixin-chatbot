import type { Context } from "@earendil-works/chord";
import { type ConversationId, type Harness, InboxDoc as PiInboxDoc } from "@earendil-works/pi-durable";
import { InboxDoc } from "./inbox.ts";

/** Scan once through the public transaction API; callers choose whether forks count. */
export async function conversationIds(session: Pick<Harness, "commit">, context: Context, ownerless = false): Promise<ConversationId[]> {
  return session.commit(async tx => {
    const ids: ConversationId[] = [];
    let cursor: Parameters<typeof tx.scanConversations>[2];
    for (;;) {
      const page = await tx.scanConversations({}, 200, cursor);
      for (const record of page.items) if (!ownerless || record.owner === undefined) ids.push(record.id);
      if (page.next === undefined) return ids;
      cursor = page.next;
    }
  }, context);
}

/** Call only while the group admission gate is held. Any recoverable work postpones physical reclamation. */
export async function idleGroupReferences(harness: Harness, context: Context): Promise<unknown[] | undefined> {
  const busy = await harness.commit(async tx => {
    for (const status of ["pending", "running", "waiting", "completing"] as const) {
      if ((await tx.scanTasks({ status }, 1)).items.length) return true;
    }
    return false;
  }, context);
  if (busy) return undefined;
  const references: unknown[] = [];
  for (const id of await conversationIds(harness, context)) {
    // Tx does not expose scanSubmissions. Both project and SDK inboxes cover queued/placed inputs.
    if ((await harness.snapshot(InboxDoc, id, context))?.items.length
      || (await harness.snapshot(PiInboxDoc, id, context))?.items.length) return undefined;
    const conversation = await harness.conversation(id, context);
    if (conversation) references.push((await conversation.context(context)).messages);
  }
  return references;
}
