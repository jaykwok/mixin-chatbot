#!/usr/bin/env bun
// Revision cleanup of the conversation databases (revision-chain plan §4, §8).
//   preview   read only, also while the service runs: long chains by space and kind, legacy chains, estimated time and
//             space; refused when the maintenance state would refuse ending the cleanup (a restore pending, a shrink
//             unfinished, a journal this version cannot read), so an upgrade refuses before it stops the service
//   space     read only: whether every volume has the space for --backup-bytes and --wal-bytes (not-enough-space when not)
//   status    read only: the journal of the current or last run, and the maintenance state
//   apply     clean (or resume the run the journal names), with a verified backup of each database first
//   skip      end the run without cleaning the rest (the document in flight is settled first)
//   abandon   the same before a rollback
//   restore   restore the database the journal marks for it (--space <space>) from its cleanup backup
// The offline shrink (plan §4.6, never part of an upgrade):
//   shrink-preview     read only: file size, pages in use, free pages and WAL of every database, the space a shrink needs
//   shrink             recover an unfinished replacement, then write each database (--space <space>, repeatable; default
//                      every one with at least 1 MiB free) compactly beside it and swap it in; the original stays as .old
//   shrink-status      read only: the shrink record and the originals kept
//   shrink-remove-old  list the originals finished replacements kept; with --yes remove them
// apply, skip, abandon, restore and shrink hold the maintenance lease (data/state/service), so they refuse while the
// service runs. Every action takes only its own options. Output names spaces and document kinds only, never document
// keys. --json and --shell print the result in the protocol of scripts/lib/maintenance-protocol.ts (the description then
// goes to stderr); exit status 3 when the cleanup, the shrink or the restore stopped, 4 when there is not enough space,
// 1 on refusals and other failures. Whether the bot starts again is for the caller (the ops core) to decide from the
// maintenance state it reads afterwards (src/core/maintenance-state.ts), not from this result.
import { join, resolve } from "node:path";
import { acquireLease } from "../../src/core/maintenance.ts";
import { assessMaintenanceAction, MaintenanceRefused, readMaintenanceState, type CleanupView } from "../../src/core/maintenance-state.ts";
import { readJournal, type Journal } from "../../src/durable/revision-cleanup/journal.ts";
import { RestoreRefused, RestoreStopped, restoreDatabase, type RestoreSummary } from "../../src/durable/revision-cleanup/restore.ts";
import { applyCleanup, CleanupStopped, endCleanup, estimateSeconds, NotEnoughSpace, previewCleanup, previewNeeds, previewSpace, SPACE_RESERVE,
  summarize, type Needs, type Preview, type Summary, type VolumeNeed } from "../../src/durable/revision-cleanup/run.ts";
import { applyShrink, keptOriginals, previewShrink, removeKeptOriginals, SHRINK_MINIMUM, ShrinkStopped, type KeptOriginal, type ShrinkPreview,
  type ShrinkSummary } from "../../src/durable/revision-cleanup/shrink.ts";
import { readShrinkRecord } from "../../src/durable/revision-cleanup/shrink-record.ts";
import { modeOf, parseOptions, Protocol, UsageError, type Outcome } from "../lib/maintenance-protocol.ts";
import { REVISION_SPECS as SPECS } from "../lib/revision-options.ts";
import { bytes, duration, grouped } from "../ops/shared/format.ts";

const USAGE = "用法：revision-cleanup.ts <preview|space|status|apply|skip|abandon|restore|shrink-preview|shrink|shrink-status|shrink-remove-old> " +
  "[--project <目录>]，以及各动作自己的参数：space --backup-bytes <字节> --wal-bytes <字节>；apply --transaction <ID>；restore --space <空间>；" +
  "shrink-preview、shrink --space <空间>（可重复）；shrink-remove-old --yes；--json 或 --shell 输出结构化结果";

type Need = Needs & { run?: { run: string; state: string } };

function describePreview(preview: Preview, need: Need, seconds: number): string {
  const lines = [`待整理文档 ${grouped(preview.documents)} 份，修订 ${grouped(preview.revisions)} 条，最长 ${grouped(preview.longest)} 条` +
    `（服务每 ${preview.interval} 次变更写一次基准；超过 ${grouped(preview.legacyLimit)} 条的旧长链服务不整理，只能离线整理）`];
  if (need.run) {
    lines.push(need.run.state === "stopped" ? `上次整理（运行 ${need.run.run}）已停止：只能跳过剩余整理或回滚，不能续做`
      : `上次整理（运行 ${need.run.run}）未完成：先收尾在途文档，再续做，沿用已验证的备份`);
  }
  for (const db of preview.databases) {
    const documents = Object.values(db.kinds).reduce((n, kind) => n + kind.documents, 0);
    lines.push(`  ${db.space}：${documents} 份（旧长链 ${db.legacy} 份）；文件 ${bytes(db.bytes)}，WAL ${bytes(db.walBytes)}，` +
      `使用中 ${bytes(db.usedBytes)}，空闲页 ${bytes(db.freeBytes)}`);
    for (const [kind, count] of Object.entries(db.kinds)) lines.push(`    ${kind}：${count.documents} 份，共 ${grouped(count.revisions)} 条，最长 ${grouped(count.longest)} 条`);
    for (const [kind, count] of Object.entries(db.skipped)) lines.push(`    不处理 ${kind}：${count.documents} 份，最长 ${grouped(count.longest)} 条（${count.reason}）`);
  }
  if (preview.documents) {
    lines.push(`预计用时约 ${duration(seconds * 1000)}（先备份 ${bytes(need.backupBytes)}；` +
      "按合成库实测估算，冷缓存或较慢的磁盘会更久），最大一次删除约需 WAL " + bytes(need.walBytes));
  }
  return lines.join("\n");
}

const describeVolumes = (volumes: VolumeNeed[]) => `所需空间（含保留 ${bytes(SPACE_RESERVE)}）：` +
  volumes.map(volume => `${volume.path} 需要 ${bytes(volume.need)}，可用 ${bytes(volume.free)}${volume.need > volume.free ? "（不足）" : ""}`).join("；");

const STATES = { running: "进行中", stopped: "已停止", finished: "已完成", skipped: "已跳过剩余整理", abandoned: "已放弃（回滚）" };

function describeRestore(restore: NonNullable<Journal["restore"]> | NonNullable<Summary["restore"]>): string {
  const command = `revision-cleanup restore --space ${restore.space}`;
  if (restore.state === "required") return `${restore.space} 需要从备份恢复（${command}）；恢复之前服务、回滚和其他维护都会拒绝`;
  if (restore.state === "replacing") return `从备份恢复 ${restore.space} 尚未完成，请再次运行 ${command}`;
  const kept = "kept" in restore && restore.kept ? `；被替换的库保留在 ${restore.kept}` : "";
  const reverted = "reverted" in restore && restore.reverted ? `（本次整理在这个库已整理的 ${restore.reverted} 份文档随之撤销）` : "";
  return `${restore.space} 已从备份恢复${reverted}${kept}`;
}

function describeSummary(summary: Summary): string {
  if (summary.state === "nothing") return "没有需要整理的文档";
  const lines = [`修订整理（运行 ${summary.run}）${STATES[summary.state]}：整理文档 ${grouped(summary.documents)} 份，删除旧修订 ${grouped(summary.revisions)} 条，` +
    `用时 ${duration(summary.ms)}`];
  for (const db of summary.databases) {
    lines.push(`  ${db.space}：${db.documents} 份${db.backup ? `；备份 ${bytes(db.backup.bytes)}：${db.backup.path}` : ""}` +
      `${db.checkpoint && db.checkpoint.busy ? `；WAL 未能重置（busy ${db.checkpoint.busy}）` : ""}`);
  }
  if (summary.restore) lines.push(describeRestore(summary.restore));
  if (summary.databases.some(db => db.backup)) lines.push("备份保留到确认删除为止；删除前请确认机器人运行正常。");
  return lines.join("\n");
}

function describeCleanupView(view: CleanupView, journal: Journal | undefined): string {
  if (view.status === "absent") return "没有修订整理日志";
  if (view.status === "unreadable") return view.reason;
  const lines = [`修订整理（运行 ${view.run}）${STATES[view.state]}${view.stop ? `：${view.stop}` : ""}` +
    `${journal?.superseded ? `（未续做：${journal.superseded}）` : ""}` +
    `${journal?.current ? `；在途文档：${journal.current.space} 的 ${journal.current.document.kind}` : ""}`];
  if (journal?.restore) lines.push(describeRestore(journal.restore));
  return lines.join("\n");
}

const describeKept = (kept: KeptOriginal[]) => kept.length
  ? [`收缩保留的原库 ${kept.length} 个，共 ${bytes(kept.reduce((n, item) => n + item.bytes, 0))}（确认机器人运行正常后可删除）：`,
    ...kept.map(item => `  ${item.space}：${bytes(item.bytes)}：${item.path}`)].join("\n")
  : "没有收缩保留的原库";

function describeShrinkPreview(preview: ShrinkPreview, spaces: string[]): string {
  const chosen = preview.databases.filter(db => db.shrink && (!spaces.length || spaces.includes(db.space)));
  const lines = [`会话库 ${preview.databases.length} 个，可收缩 ${chosen.length} 个（空闲页不足 ${bytes(SHRINK_MINIMUM)} 的不收缩），` +
    `可回收 ${bytes(chosen.reduce((n, db) => n + db.freeBytes, 0))}（删除保留的原库之后）`];
  for (const db of preview.databases) {
    lines.push(`  ${chosen.includes(db) ? "收缩" : "不动"} ${db.space}：文件 ${bytes(db.bytes)}，使用中 ${bytes(db.usedBytes)}，空闲页 ${bytes(db.freeBytes)}，WAL ${bytes(db.walBytes)}`);
  }
  if (chosen.length) lines.push(describeVolumes(preview.volumes));
  if (preview.unfinished) lines.push(`先恢复：${preview.unfinished}`);
  if (preview.blocked) lines.push(`不能收缩：${preview.blocked}`);
  return lines.join("\n");
}

const RECOVERED = {
  shrink: { void: "未换上的副本已删除，原库未动", restored: "原库已放回原路径", done: "已完成替换" },
  restore: { void: "未换上的副本已删除，会话库未动", restored: "被替换的库已放回原路径", done: "已完成替换" },
};

function describeShrink(summary: ShrinkSummary): string {
  const lines = summary.recovered ? [`上次未完成的收缩已恢复：${RECOVERED.shrink[summary.recovered]}`] : [];
  if (!summary.done.length) lines.push("没有需要收缩的会话库");
  else {
    lines.push(`会话库收缩（运行 ${summary.run}）已完成：${summary.done.length} 个库，` +
      `${bytes(summary.done.reduce((n, db) => n + db.before, 0))} → ${bytes(summary.done.reduce((n, db) => n + db.after, 0))}`);
    for (const db of summary.done) lines.push(`  ${db.space}：${bytes(db.before)} → ${bytes(db.after)}，用时 ${duration(db.ms)}；原库保留在 ${db.kept}`);
    lines.push("原库保留到确认删除为止；确认机器人运行正常后可删除。");
  }
  return lines.join("\n");
}

function describeRestoreSummary(summary: RestoreSummary): string {
  const lines = summary.recovered ? [`上次未完成的恢复：${RECOVERED.restore[summary.recovered]}`] : [];
  lines.push(`${summary.space} 已从备份恢复（运行 ${summary.run}）：${summary.backup}` +
    `${summary.kept ? `；被替换的库保留在 ${summary.kept}` : ""}`);
  lines.push("会话库回到备份时的状态（整理前的长链）。整理运行仍为已停止：之后跳过剩余整理（revision-cleanup skip）或回滚；被替换的库确认无用后再删除。");
  return lines.join("\n");
}

/** The lease held by the service (or another maintenance action): refused, nothing changed. */
class Busy extends Error {
  override name = "Busy";
}

async function locked<T>(project: string, work: () => Promise<T>): Promise<T> {
  let release: () => Promise<void>;
  try { release = await acquireLease("revision-cleanup", join(project, "data", "state", "service")); }
  catch (error) { throw new Busy((error as Error).message); }
  try { return await work(); } finally { await release(); }
}

function count(value: string, name: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) throw new UsageError(`space：${name} 需要非负整数`);
  return number;
}

async function main(protocol: Protocol, action: string, values: Map<string, string[]>, flags: Set<string>): Promise<void> {
  const project = resolve(values.get("--project")?.[0] ?? process.cwd());
  const spaces = values.get("--space") ?? [];
  const log = (line: string) => protocol.say(line);
  switch (action) {
    case "preview": {
      // Whatever would refuse ending the cleanup comes first: before an upgrade stops the service, which then could not start.
      const assessment = assessMaintenanceAction(readMaintenanceState(project), "skip");
      if (!assessment.allowed) throw new MaintenanceRefused("skip", assessment.reasons);
      const preview = await previewCleanup({ project });
      const need = previewNeeds({ project }, preview);
      const seconds = estimateSeconds(preview, need);
      const legacy = preview.databases.reduce((n, db) => n + db.legacy, 0);
      const text = preview.documents || need.run ? describePreview(preview, need, seconds) : "没有需要整理的文档";
      if (protocol.mode === "shell") {
        // For the deployment scripts, which check the space on the host (backup/ is not mounted here).
        protocol.emit("success", { text, shell: { documents: preview.documents, revisions: preview.revisions, longest: preview.longest, legacy,
          backup_bytes: need.backupBytes, wal_bytes: need.walBytes, seconds, run_state: need.run?.state ?? "none" } });
        return;
      }
      // JSON callers (the Windows deployment entry, the shared core) check the space for their choice with `space`, which
      // describes it once; people reading the preview see it here.
      if (protocol.mode === "json") { protocol.emit("success", { text, result: { ...preview, ...need, seconds, legacy } }); return; }
      const volumes = previewSpace({ project }, need);
      protocol.emit("success", { text: `${text}\n${describeVolumes(volumes)}`, result: { ...preview, ...need, seconds, legacy, volumes } });
      return;
    }
    case "space": {
      // For the Windows deployment entry and the shared core, before the service stops: the space the cleanup needs.
      const volumes = previewSpace({ project }, { backupBytes: count(values.get("--backup-bytes")![0]!, "--backup-bytes"),
        walBytes: count(values.get("--wal-bytes")![0]!, "--wal-bytes") });
      const short = volumes.some(volume => volume.need > volume.free);
      protocol.emit(short ? "not-enough-space" : "success", { text: describeVolumes(volumes), result: { volumes }, shell: { short } });
      return;
    }
    case "status": {
      // Spaces, states and document kinds only: the journal holds digests of the document keys, which stay in it.
      const state = readMaintenanceState(project);
      const journal = state.cleanup.status === "present" ? readJournal(join(project, "data")) : undefined;
      protocol.emit("success", { text: describeCleanupView(state.cleanup, journal), result: { state, ...(journal ? { summary: summarize(journal) } : {}) } });
      return;
    }
    case "apply": {
      const summary = await locked(project, () => applyCleanup({ project, log, transaction: values.get("--transaction")?.[0] }));
      protocol.emit("success", { text: describeSummary(summary), result: summary, shell: { state: summary.state, documents: summary.documents } });
      return;
    }
    case "skip":
    case "abandon": {
      const summary = await locked(project, () => endCleanup({ project, log }, action === "skip" ? "skipped" : "abandoned"));
      protocol.emit("success", { text: summary ? describeSummary(summary) : "没有进行中的修订整理", result: summary ?? null,
        shell: { state: summary?.state ?? "none" } });
      return;
    }
    case "restore": {
      const space = values.get("--space")![0]!;
      const summary = await locked(project, () => restoreDatabase({ project, space, log }));
      protocol.emit("success", { text: describeRestoreSummary(summary), result: summary });
      return;
    }
    case "shrink-preview": {
      const preview = await previewShrink({ project, spaces: spaces.length ? spaces : undefined });
      const kept = keptOriginals(project);
      protocol.emit("success", { text: `${describeShrinkPreview(preview, spaces)}\n${describeKept(kept)}`, result: { ...preview, kept } });
      return;
    }
    case "shrink": {
      const summary = await locked(project, () => applyShrink({ project, spaces: spaces.length ? spaces : undefined, log }));
      protocol.emit("success", { text: describeShrink(summary), result: summary, shell: { databases: summary.done.length } });
      return;
    }
    case "shrink-status": {
      const record = readShrinkRecord(join(project, "data")), kept = keptOriginals(project);
      protocol.emit("success", { result: { record: record ?? null, kept }, text: [record
        ? `会话库收缩（运行 ${record.run}）${record.current ? `未完成：${record.current.space}，阶段 ${record.current.state}；请再次运行 shrink 完成恢复`
          : `已结束：${record.done.length} 个库`}`
        : "没有会话库收缩记录", describeKept(kept)].join("\n") });
      return;
    }
    case "shrink-remove-old": {
      if (!flags.has("--yes")) {
        const kept = keptOriginals(project);
        protocol.emit("success", { text: kept.length ? `${describeKept(kept)}\n确认删除请加 --yes` : describeKept(kept), result: kept });
        return;
      }
      const removed = await removeKeptOriginals(project);
      protocol.emit("success", { result: removed, text: removed.length
        ? `已删除收缩保留的原库 ${removed.length} 个，共 ${bytes(removed.reduce((n, item) => n + item.bytes, 0))}` : "没有收缩保留的原库" });
      return;
    }
  }
}

const NAMES = { cleanup: "修订整理", shrink: "会话库收缩", restore: "从备份恢复" };

function outcomeOf(error: unknown): Outcome {
  if (error instanceof MaintenanceRefused || error instanceof RestoreRefused || error instanceof Busy || error instanceof UsageError) return "refused";
  if (error instanceof CleanupStopped || error instanceof ShrinkStopped || error instanceof RestoreStopped) return "stopped";
  if (error instanceof NotEnoughSpace) return "not-enough-space";
  return "failed";
}

const [action = "", ...args] = process.argv.slice(2);
const spec = Object.hasOwn(SPECS, action) ? SPECS[action] : undefined;
// Before the options are known to be valid, a machine caller still gets its protocol: a refusal.
let protocol = new Protocol(args.includes("--json") ? "json" : args.includes("--shell") ? "shell" : "human", action);
try {
  if (!spec) throw new UsageError(action ? `未知动作 ${action}。${USAGE}` : USAGE);
  const parsed = parseOptions(action, args, spec);
  protocol = new Protocol(modeOf(parsed), action);
  try { await main(protocol, action, parsed.values, parsed.flags); }
  catch (error) {
    const outcome = outcomeOf(error);
    const name = NAMES[action.startsWith("shrink") ? "shrink" : action === "restore" ? "restore" : "cleanup"];
    const prefix = outcome === "refused" ? `${name}没有执行：` : outcome === "stopped" ? `${name}已停止：` : outcome === "failed" ? `${name}失败：` : "";
    protocol.fail(error, outcome, prefix);
    if (error instanceof NotEnoughSpace) protocol.say("可以释放空间后重试，或跳过整理");
  }
} catch (error) {
  protocol.fail(error, "refused", "");
}
