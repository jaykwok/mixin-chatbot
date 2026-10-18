// Executed with the SOURCE release's cwd, dependencies and readers, before code/dependency replacement.
// No network or model execution. The target never imports old conversation formats into its new runtime.
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { statsDigest } from "./data-reset.ts";
import { publishJson } from "../lib/atomic-file.ts";
import { readMetadata } from "../../src/core/data-version.ts";

export async function freezeSourceStats(project: string, groups: string, receipt: string): Promise<void> {
  const source = <T>(name: string) => import(pathToFileURL(join(project, name)).href) as Promise<T>;
  const { acquireLease, acquireGroupRootLease } = await source<typeof import("../../src/core/maintenance.ts")>("src/core/maintenance.ts");
  const { dataDirectoryNames } = await source<typeof import("../lib/group-data.ts")>("scripts/lib/group-data.ts");
  const ledger = await source<typeof import("../../src/agent/stats-ledger.ts") & {
    sweepSessionStats?: (root: string, options: { force: boolean }) => Promise<{ failed: number }>;
  }>("src/agent/stats-ledger.ts");
  const { withGroupSnapshot } = await source<typeof import("../../src/durable/diagnostics.ts")>("src/durable/diagnostics.ts");
  const { IdentityDoc, databaseGroup } = await source<typeof import("../../src/durable/identity.ts")>("src/durable/identity.ts");
  const { groupSegment } = await source<typeof import("../../src/agent/paths.ts")>("src/agent/paths.ts");
  const { projectConversation } = await source<typeof import("../../src/durable/projection.ts")>("src/durable/projection.ts");
  const { readRelayIndex } = await source<typeof import("../../src/integrations/relay-index.ts")>("src/integrations/relay-index.ts");
  const { openGroupStorage } = await source<typeof import("../../src/durable/sqlite.ts")>("src/durable/sqlite.ts");
  const { InboxDoc, ControlsDoc } = await source<typeof import("../../src/durable/inbox.ts")>("src/durable/inbox.ts");
  // These packages expose ESM-only exports; resolve with import conditions in the source installation.
  const dependency = (name: string) => pathToFileURL(Bun.resolveSync(name, project)).href;
  const { BACKGROUND_CONTEXT: context } = await import(dependency("@earendil-works/chord/context")) as typeof import("@earendil-works/chord/context");
  const { Harness, createRegistry } = await import(dependency("@earendil-works/pi-durable")) as typeof import("@earendil-works/pi-durable");
  const { createModels } = await import(dependency("@earendil-works/pi-ai")) as typeof import("@earendil-works/pi-ai");
  const release = await acquireLease("stats-freeze", join(project, "data/state/service"));
  let releaseGroups: (() => Promise<void>) | undefined;
  try {
    releaseGroups = await acquireGroupRootLease("stats-freeze", groups);
    // Refuse missing/unsupported ledgers before a source reader can create or change their schema.
    statsDigest(join(groups, "stats.sqlite"));
    if (readdirSync(groups, { withFileTypes: true }).some(entry => entry.isSymbolicLink())) throw new Error("群根含链接，拒绝跳过群数据后清理");
    if (readRelayIndex(join(project, "data/state/relay.sqlite")).length)
      throw new Error("仍有远端外链对象待清理；请先用旧版外链管理收尾，再重试升级（原数据未清理）");
    const frozen = readMetadata(receipt) as { format?: number; digest?: string; timezone?: string } | null;
    if (frozen) {
      if (frozen.format !== 1 || frozen.digest !== statsDigest(join(groups, "stats.sqlite"))
        || frozen.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone) throw new Error("统计冻结后发生变化，请回滚后重新升级");
      return;
    }
    // Older sources may own a final JSONL sweep. Its implementation stays with that installed release.
    if (ledger.sweepSessionStats && (await ledger.sweepSessionStats(groups, { force: true })).failed)
      throw new Error("旧版统计扫描失败，拒绝清理会话");
    const db = ledger.openStatsLedger(groups);
    try {
      for (const group of await dataDirectoryNames(groups, groups)) {
        const path = join(groups, group, "durable.sqlite");
        if (!existsSync(path)) continue;
        await withGroupSnapshot(path, async (snapshot, _storage, liveWork) => {
          if (liveWork) throw new Error(`群 ${group} 仍有未结束任务，请先在旧版收尾再升级`);
          const groupId = await databaseGroup(snapshot, context);
          if (!groupId || groupSegment(groupId) !== group) throw new Error("群库身份与目录不匹配，拒绝补账");
          if ((await snapshot.snapshot(ControlsDoc, context))?.pending.length) throw new Error("旧版仍有未执行控制指令，请先收尾");
        });
        const storage = await openGroupStorage(path);
        const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
        try {
          const groupId = await databaseGroup(harness, context);
          if (!groupId) throw new Error("群库缺少身份，拒绝补账");
          let cursor: Parameters<typeof storage.scanConversations>[2];
          for (;;) {
            const page = await storage.scanConversations({}, 200, cursor, context);
            for (const conversation of page.items) {
              if ((await harness.snapshot(InboxDoc, conversation.id, context))?.items.length) throw new Error("旧版仍有待处理消息，请先收尾");
              const identity = await harness.snapshot(IdentityDoc, conversation.id, context);
              if (!identity?.phone || identity.groupId !== groupId) throw new Error("会话身份缺失或不匹配，拒绝补账");
              await projectConversation(db, harness, { groupId, phone: identity.phone, conversationId: conversation.id }, context);
            }
            if (!page.next) break; cursor = page.next;
          }
        } finally { await harness.close(context); }
      }
      // JSONL projections 1 and 2 can retain an unfinished final line forever, including after
      // archival. The source reader has counted all complete records; discard only that tail
      // with the old sessions after commit. Preserve pending as the historical skipped count.
      if (db.query("SELECT 1 FROM sources WHERE pending > 0 AND projection NOT IN (1, 2) LIMIT 1").get())
        throw new Error("非 JSONL 统计来源存在未完整入账标记，拒绝清理");
      const incomplete = db.query("SELECT COUNT(*) AS sources, COALESCE(SUM(pending), 0) AS lines FROM sources WHERE pending > 0").get() as { sources: number; lines: number };
      if (incomplete.sources) console.log(`保留 ${incomplete.sources} 个旧 JSONL 来源的已入账统计；${incomplete.lines} 个不完整尾行随旧会话清理，跳过数量保留在账本及升级基线中。`);
    } finally { db.close(); }
    await publishJson(receipt, { format: 1, digest: statsDigest(join(groups, "stats.sqlite")),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, at: new Date().toISOString() });
  } finally { await releaseGroups?.(); await release(); }
}

if (import.meta.main) {
  const args = process.argv.slice(2), option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const receipt = option("--receipt"), groups = option("--groups");
  if (!receipt || !groups) throw new Error("stats-freeze requires --groups and --receipt");
  await freezeSourceStats(process.cwd(), resolve(groups), resolve(receipt));
}
