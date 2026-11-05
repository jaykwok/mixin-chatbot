import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
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

/**
 * Call only while the space admission gate is held. Any recoverable work postpones physical reclamation; `yielding` (a
 * waiting admission) ends the read between conversations. Undefined in both cases.
 */
export async function idleSpaceReferences(harness: Harness, context: Context, yielding: () => boolean): Promise<unknown[] | undefined> {
  const inspection = await harness.inspect(context);
  if (inspection.tasks.length || inspection.submissions.length) return undefined;
  const references: unknown[] = [];
  for (const id of await conversationIds(harness, context)) {
    if (yielding() || (await harness.snapshot(InboxDoc, id, context))?.items.length) return undefined;
    const conversation = await harness.conversation(id, context);
    if (conversation) references.push((await conversation.context(context)).messages);
  }
  return references;
}
