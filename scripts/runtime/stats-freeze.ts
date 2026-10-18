// Reset preserves the existing statistics ledger exactly. Old sessions are discarded, never opened or projected.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { statsDigest } from "./data-reset.ts";
import { publishJson } from "../lib/atomic-file.ts";
import { readMetadata } from "../../src/core/data-version.ts";
import { acquireLease, acquireGroupRootLease } from "../../src/core/maintenance.ts";

export async function freezeStats(project: string, groups: string, receipt: string): Promise<void> {
  const release = await acquireLease("stats-freeze", join(project, "data/state/service"));
  let releaseGroups: (() => Promise<void>) | undefined;
  try {
    releaseGroups = await acquireGroupRootLease("stats-freeze", groups);
    // Read-only integrity/schema validation; never create, migrate or backfill a ledger.
    const digest = statsDigest(join(groups, "stats.sqlite"));
    if (readdirSync(groups, { withFileTypes: true }).some(entry => entry.isSymbolicLink()))
      throw new Error("群根含链接，拒绝越过路径边界清理");
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const frozen = readMetadata(receipt) as { format?: number; digest?: string; timezone?: string } | null;
    if (frozen) {
      if (frozen.format !== 1 || frozen.digest !== digest || frozen.timezone !== timezone)
        throw new Error("统计冻结后发生变化，请回滚后重新升级");
      return;
    }
    await publishJson(receipt, { format: 1, digest, timezone, at: new Date().toISOString() });
    console.log("已冻结现有统计账本；旧会话、未入账消息和待处理任务不再读取，随重置清理。");
  } finally { await releaseGroups?.(); await release(); }
}

if (import.meta.main) {
  const args = process.argv.slice(2), option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const receipt = option("--receipt"), groups = option("--groups");
  if (!receipt || !groups) throw new Error("stats-freeze requires --groups and --receipt");
  await freezeStats(process.cwd(), resolve(groups), resolve(receipt));
}
