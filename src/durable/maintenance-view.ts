// The service side of offline maintenance: one member's protected view over a space database snapshot. The database's write
// reservation (apply) is held for the whole callback; only the view leaves it.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Harness, Storage } from "@earendil-works/pi-durable";
import { join } from "node:path";
import { assertDataDirectory } from "../../scripts/lib/group-data.ts";
import { scopeKey, spacePath, userSegment } from "../core/layout.ts";
import type { ResultOwnership } from "../contracts/maintenance.ts";
import { exists } from "../maintenance/plans.ts";
import { reclamationReferences, type MemberScope } from "../maintenance/scope.ts";
import { withSpaceSnapshot } from "./diagnostics.ts";
import { databaseSpace, IdentityDoc } from "./identity.ts";
import { ControlsDoc, InboxDoc } from "./inbox.ts";
import { memberRecords } from "./records.ts";
import { ResultsDoc } from "./results/ownership.ts";
import { ReclamationItems, settleOfflineResults } from "./results/queue.ts";

/** Entire space context is considered: private paths can occur in forked or another member's persisted state. */
async function reclamationView(harness: Harness, storage: Storage, path: string, user: string) {
  const scope = await databaseSpace(harness, context);
  if (!scope || spacePath(scope) !== path) throw new Error("回收会话库身份与目录不符");
  const space = scopeKey(scope);
  const references: unknown[] = [], phones = new Set<string>();
  let busy = !!(await harness.snapshot(ControlsDoc, context))?.pending.length;
  let cursor: Parameters<Storage["scanConversations"]>[2];
  for (;;) {
    const page = await storage.scanConversations({}, 200, cursor, context);
    for (const record of page.items) {
      if ((await harness.snapshot(InboxDoc, record.id, context))?.items.length) busy = true;
      const identity = await harness.snapshot(IdentityDoc, record.id, context);
      if (identity?.space === space && userSegment(identity.phone) === user) phones.add(identity.phone);
      // Run records (replies still being sent, link notes, file snapshots) of every member may name result files.
      if (identity?.phone) references.push(await memberRecords(harness, identity.phone, context));
      const conversation = await harness.conversation(record.id, context);
      if (conversation) references.push((await conversation.context(context)).messages);
    }
    if (!page.next) break; cursor = page.next;
  }
  if (phones.size !== 1) throw new Error("回收成员在会话库中缺失或身份不唯一");
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
  return { phone, calls, references, busy };
}

/** Shared by deletion and reversible archival. The source DB keeps its write reservation throughout. */
export const durableMemberScope: MemberScope = {
  async withMember(paths, user, { exclusive, requireGroup }, run) {
    await assertDataDirectory(user.dir, paths.root);
    const path = join(paths.root, "conversations", ...user.space.split("/"), "durable.sqlite");
    if (!requireGroup && !await exists(path)) {
      return run({ calls: {}, liveWork: false, protectedPath: reclamationReferences([], paths), settle: async () => {} });
    }
    return withSpaceSnapshot(path, async (harness, storage, liveWork, commit) => {
      const view = await reclamationView(harness, storage, user.space, user.user);
      const referenced = reclamationReferences(view.references, paths);
      return run({ calls: view.calls, liveWork, protectedPath: path => liveWork || view.busy || referenced(path),
        settle: async owners => {
          if (!commit) throw new Error("只读预览不能结算回收账本");
          await commit(tx => settleOfflineResults(tx, view.phone, owners));
        } });
    }, exclusive);
  },
};
