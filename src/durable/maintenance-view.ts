// The service side of offline maintenance: one member's protected view over the outbox ledger and a group database
// snapshot. The ledger and group write reservations (apply) are held for the whole callback; only the view leaves it.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { assertDataDirectory } from "../../scripts/lib/group-data.ts";
import { assertDeliverySchema } from "../agent/delivery-store.ts";
import { groupSegment, userSegment } from "../agent/paths.ts";
import type { ResultOwnership } from "../contracts/maintenance.ts";
import { exists } from "../maintenance/plans.ts";
import { reclamationReferences, type MemberScope } from "../maintenance/scope.ts";
import { withGroupSnapshot } from "./diagnostics.ts";
import { databaseGroup, IdentityDoc } from "./identity.ts";
import { ControlsDoc, InboxDoc } from "./inbox.ts";
import { ResultsDoc } from "./results/ownership.ts";
import { ReclamationItems, settleOfflineResults } from "./results/queue.ts";

/** Entire group context is considered: private paths can occur in forked or another member's persisted state. */
async function reclamationView(harness: Harness, storage: Storage, segment: string, user: string) {
  const groupId = await databaseGroup(harness, context);
  if (!groupId || groupSegment(groupId) !== segment) throw new Error("回收群库身份与目录不符");
  const references: unknown[] = [], phones = new Set<string>();
  let busy = !!(await harness.snapshot(ControlsDoc, context))?.pending.length;
  let cursor: Parameters<Storage["scanConversations"]>[2];
  for (;;) {
    const page = await storage.scanConversations({}, 200, cursor, context);
    for (const record of page.items) {
      if ((await harness.snapshot(InboxDoc, record.id, context))?.items.length) busy = true;
      const identity = await harness.snapshot(IdentityDoc, record.id, context);
      if (identity?.groupId === groupId && userSegment(identity.phone) === user) phones.add(identity.phone);
      const conversation = await harness.conversation(record.id, context);
      if (conversation) references.push((await conversation.context(context)).messages);
    }
    if (!page.next) break; cursor = page.next;
  }
  if (phones.size !== 1) throw new Error("回收成员在群库中缺失或身份不唯一");
  const phone = [...phones][0]!;
  const calls: Record<string, ResultOwnership> = Object.fromEntries(Object.entries((await harness.snapshot(ResultsDoc, context))?.calls ?? {})
    .filter(([, call]) => call.phone === phone && call.expiredAt === undefined));
  let documents: Parameters<Storage["scanDocuments"]>[2];
  for (;;) {
    const page = await storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind: "mixin.reclamation-item" }, 200, documents, context);
    for (const record of page.items) {
      if (!record.key) throw new Error("回收账本条目缺少身份");
      const item = await harness.snapshot(ReclamationItems, record.key, context);
      if (!item || item.name !== record.key) throw new Error("回收账本条目损坏");
      if (item.call.phone === phone) {
        if (calls[item.name]) throw new Error("活动结果与回收账本重复登记");
        calls[item.name] = item.call;
      }
    }
    if (!page.next) break; documents = page.next;
  }
  return { groupId, phone, calls, references, busy };
}

/** Keep the outbox write reservation while deleting. Missing/corrupt ledgers fail closed. */
async function withDeliveries<T>(path: string, exclusive: boolean, read: (values: unknown[]) => Promise<T>): Promise<T> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("待交付账本必须是普通文件");
  const db = new Database(path, { readonly: !exclusive, strict: true });
  try {
    db.exec(exclusive ? "BEGIN IMMEDIATE" : "BEGIN"); assertDeliverySchema(db);
    const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get();
    const rows = exists ? db.query("SELECT text, attachments FROM deliveries ORDER BY id").all() as { text: string; attachments: string }[] : [];
    return await read(rows.map(row => ({ text: row.text, attachments: JSON.parse(row.attachments) })));
  } finally { db.close(); }
}

/** Shared by deletion and reversible archival. The source DB and outbox keep their write reservations throughout. */
export const durableMemberScope: MemberScope = {
  async withMember(paths, user, { exclusive, requireGroup }, run) {
    await assertDataDirectory(user.dir, paths.root);
    const path = join(paths.root, user.group, "durable.sqlite");
    if (!requireGroup && !await exists(path)) {
      const read = (references: unknown[]) => run({ calls: {}, liveWork: false, protectedPath: reclamationReferences(references, paths), settle: async () => {} });
      return await exists(paths.state) ? withDeliveries(paths.state, exclusive, read) : read([]);
    }
    return withDeliveries(paths.state, exclusive, deliveries => withGroupSnapshot(path, async (harness, storage, liveWork, commit) => {
      const view = await reclamationView(harness, storage, user.group, user.user);
      const referenced = reclamationReferences([...deliveries, ...view.references], paths);
      return run({ calls: view.calls, liveWork, protectedPath: path => liveWork || view.busy || referenced(path),
        settle: async owners => {
          if (!commit) throw new Error("只读预览不能结算回收账本");
          await commit(tx => settleOfflineResults(tx, view.phone, owners));
        } });
    }, exclusive));
  },
};
