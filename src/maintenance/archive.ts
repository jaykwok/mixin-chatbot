// Reversible archival of member tmp entries into backup/rm, and the later permanent removal of archived entries.
// Archival per item: protected references and unchanged ownership → fresh evidence → saved intent (`started`) → move
// (task backend or same-disk rename) → destination evidence → saved outcome; owners settle per member. A failed item
// is recorded and the member goes on, but a failed member settlement marks its unarchived items failed and stops the
// batch. Removal proves each entry by the archive plan that moved it, never by the removal list alone, and deletes only
// through a backend that binds the reviewed entity to the deletion: Windows deletion handles (any kind of entry), the
// Linux privileged backend for entries of the old shared identity (a same-UID writer could swap a name between a check
// and an unlink), and the task backend, whose own deletion journal decides how an interrupted deletion resumes.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { publishJson } from "../../scripts/lib/atomic-file.ts";
import { scanTmp, type UserTmp } from "../../scripts/lib/tmp-scan.ts";
import type { GroupSelection } from "../../scripts/lib/group-data.ts";
import { isPathInside } from "../contracts/paths.ts";
import { memberTmpDir, decodeArchivePlan, decodeArchiveProgress, decodeRemovalPlan, decodeRemovalProgress, DIGEST_PATTERN, finishedEarlier, ID_PATTERN, planDigest, sameOwnership,
  type ArchiveItem, type ArchiveRemovalPlan, type ArchiveRemovalProgress, type RemovalItem, type ResultOwnership, type TmpArchivePlan,
  type TmpArchiveProgress, type TreeEvidence } from "../contracts/maintenance.ts";
import { archiveEntry } from "../core/archive-entry.ts";
import { reclamationEvidence } from "../core/reclamation-files.ts";
import type { RootlessTasks } from "../core/rootless-tasks.ts";
import { describeUnfinished, existingLegacyJournalRoot, finishLegacy, legacyBlocker, legacyParent, LegacyReclamationPending, legacyJournalSaved,
  reclaimLegacy, unfinishedLegacy, unfinishedLegacyError } from "./legacy.ts";
import { directoryEntity, exists, memberIndexes, readPlanFile } from "./plans.ts";
import type { MemberScope } from "./scope.ts";
import { reclaimWindows } from "./windows.ts";

export interface TmpArchiveOptions { root: string; state: string; archive: string; scope: MemberScope; recordedRoot?: string;
  backend?: Pick<RootlessTasks, "inventory" | "archive">; }
const entity = (path: string) => directoryEntity(path, "归档根必须是普通目录");
const matches = (a: TreeEvidence, b: TreeEvidence) => a.dev === b.dev && a.ino === b.ino && a.fingerprint === b.fingerprint;
const readJson = (path: string) => readPlanFile(path, { private: false, message: "归档清单不是普通文件或过大" });

async function location(options: TmpArchiveOptions): Promise<{ archive: string; plans: string }> {
  const archive = resolve(options.archive);
  if (basename(archive) !== "rm" || basename(dirname(archive)) !== "backup") throw new Error("归档目录必须以 backup/rm 结尾");
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await entity(archive);
  if (await realpath(archive) !== archive) throw new Error("归档根不能经过链接");
  const plans = join(archive, ".tmp-plans");
  await mkdir(plans, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  await entity(plans);
  if (await realpath(plans) !== plans) throw new Error("归档清单目录不能经过链接");
  return { archive, plans };
}

/** A new plan file; an existing one is never replaced. */
async function createPlanFile(path: string, plan: unknown) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(plan) + "\n"); await file.sync(); } finally { await file.close(); }
}

/** Candidate sources of one member: direct entries, and isolated tasks one by one (only with a verifiable receipt). */
async function archiveCandidates(options: TmpArchiveOptions, member: UserTmp): Promise<{ path: string; task?: string; reason?: string }[]> {
  const candidates: { path: string; task?: string; reason?: string }[] = [];
  for (const entry of member.entries) {
    if (entry.name === ".office-jobs") { candidates.push({ path: entry.path, reason: "Office 回执关联系统临时目录，请用 reclaim 预览和回收" }); continue; }
    if (entry.name !== ".isolated-work") { candidates.push({ path: entry.path }); continue; }
    const info = await lstat(entry.path);
    if (!info.isDirectory() || info.isSymbolicLink()) { candidates.push({ path: entry.path, reason: "隔离工作根不是普通目录" }); continue; }
    const inventory = await options.backend?.inventory(member.dir, true);
    const tasks = new Map(inventory?.items.map(task => [task.id, task]));
    for (const name of await readdir(entry.path)) {
      const task = tasks.get(name);
      candidates.push({ path: join(entry.path, name), ...(task ? { task: task.id } : { reason: "隔离任务缺少可验证的管理回执" }) });
    }
    if (inventory?.refused.length) candidates.push({ path: entry.path, reason: `有 ${inventory.refused.length} 份回执无效，未据此授权归档` });
  }
  return candidates;
}

/** Read-only reference checks; the saved plan is the exact list used by apply. */
export async function previewTmpArchive(options: TmpArchiveOptions, days: number, user?: string, group?: string, selection: GroupSelection = "auto", requestedId?: string): Promise<TmpArchivePlan> {
  if (!Number.isFinite(days) || days < 0) throw new Error("归档天数无效");
  if (requestedId !== undefined && !ID_PATTERN.test(requestedId)) throw new Error("归档清单 ID 无效");
  const root = await realpath(options.root), { archive, plans } = await location(options), id = requestedId ?? randomUUID(), createdAt = Date.now();
  const before = days === 0 ? Infinity : createdAt - days * 86_400_000;
  const items: ArchiveItem[] = [];
  for (const member of await scanTmp(root, user, group, selection)) {
    try {
      await options.scope.withMember({ ...options, root }, member, { exclusive: false, requireGroup: false }, async view => {
        // The path each ownership record covers, computed once for this view.
        const owned = Object.entries(view.calls).map(([name, owner]) =>
          [name, owner, owner.isolatedTask ? join(member.dir, ".isolated-work", owner.isolatedTask) : join(member.dir, "codemode", name)] as const);
        for (const candidate of await archiveCandidates(options, member)) {
          const item: ArchiveItem = { space: member.space, user: member.user, source: candidate.path,
            destination: join(archive, `tmp-${id}-${items.length}`), owners: {}, ...(candidate.task ? { task: candidate.task } : {}),
            status: candidate.reason ? "deferred" : "ready", ...(candidate.reason ? { reason: candidate.reason } : {}) };
          for (const [name, owner, path] of owned) if (isPathInside(path, item.source)) item.owners[name] = owner;
          try {
            item.evidence = await reclamationEvidence(item.source);
            if (view.protectedPath(item.source)) { item.status = "kept"; item.reason = "当前上下文、待交付内容或可恢复任务仍需要此项"; }
            else if (item.evidence.newest > before) { item.status = "kept"; item.reason = "近期仍有改动"; }
            else if (item.evidence.dev !== (await lstat(archive, { bigint: true })).dev.toString()) { item.status = "deferred"; item.reason = "backup/rm 不在源文件系统；请指定同盘归档目录"; }
          } catch (error) { item.status = "deferred"; item.reason = String(error); }
          items.push(item);
        }
      });
    } catch (error) { items.push({ space: member.space, user: member.user, source: member.dir, destination: join(archive, `tmp-${id}-${items.length}`), owners: {}, status: "deferred", reason: String(error) }); }
  }
  const value = { version: 1 as const, id, root, rootIdentity: await entity(root), archive, recordedRoot: options.recordedRoot ?? root,
    createdAt, before: Number.isFinite(before) ? before : Number.MAX_VALUE, items };
  const plan = { ...value, digest: planDigest(value) };
  if (Buffer.byteLength(JSON.stringify(plan)) > 32 * 1024 * 1024) throw new Error("归档清单过大，请限定群或成员");
  await createPlanFile(join(plans, id + ".json"), plan);
  return plan;
}

/** Paths as the plan recorded them. A plan made in the service container names container paths; the host
 * maintenance identity reaches the same root (same entity) under another name. */
type PlanView = { root: string; archive: string; recordedRoot?: string };

/** The saved plan, checked against its digest, the current root and archive. */
async function readArchivePlan(options: TmpArchiveOptions, view: PlanView, plans: string, id: string, expectedDigest: string): Promise<TmpArchivePlan> {
  const plan = decodeArchivePlan(await readJson(join(plans, id + ".json")), { id, digest: expectedDigest, ...view });
  if (plan.rootIdentity !== await entity(options.root)) throw new Error("归档清单、摘要或实体已变化：rootIdentity");
  return plan;
}

/** Saved outcomes of a plan; missing means nothing ran yet. */
async function readArchiveProgress(plans: string, plan: TmpArchivePlan): Promise<TmpArchiveProgress | undefined> {
  let saved: unknown;
  try { saved = await readJson(join(plans, plan.id + ".progress.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return decodeArchiveProgress(saved, plan);
}

/** Lease required. Revalidate references and content; preserve a durable intent before the only filesystem mutation. */
export async function applyTmpArchive(options: TmpArchiveOptions, id: string, expectedDigest: string): Promise<TmpArchiveProgress> {
  if (!ID_PATTERN.test(id) || !DIGEST_PATTERN.test(expectedDigest)) throw new Error("归档清单 ID 或摘要无效");
  const { archive, plans } = await location(options), root = await realpath(options.root);
  const plan = await readArchivePlan(options, { root, archive, recordedRoot: options.recordedRoot ?? root }, plans, id, expectedDigest);
  const progressPath = join(plans, id + ".progress.json");
  const progress: TmpArchiveProgress = await readArchiveProgress(plans, plan) ?? { version: 1, digest: expectedDigest, started: [], outcomes: {} };
  const save = () => publishJson(progressPath, progress);
  for (const indexes of memberIndexes(plan.items)) {
    if (indexes.every(index => plan.items[index]!.status !== "ready")) {
      for (const index of indexes) {
        const item = plan.items[index]!;
        progress.outcomes[index] = { status: item.status === "kept" ? "kept" : "deferred", bytes: 0, reason: item.reason };
      }
      await save(); continue;
    }
    const first = plan.items[indexes[0]!]!, member: UserTmp = { space: first.space, user: first.user,
      dir: memberTmpDir(plan.root, first.space, first.user), entries: [], bytes: 0, files: 0, newest: 0 };
    try {
      await options.scope.withMember(options, member, { exclusive: true, requireGroup: false }, async view => {
        const owners = new Map<string, ResultOwnership>();
        for (const index of indexes) {
          const item = plan.items[index]!;
          // Final: the destination may since have been discarded. Replays only repeat the (idempotent) ownership settlement.
          if (progress.outcomes[index]?.status === "archived") { for (const [name, owner] of Object.entries(item.owners)) owners.set(name, owner); continue; }
          if (item.status !== "ready" || !item.evidence) { progress.outcomes[index] = { status: item.status === "kept" ? "kept" : "deferred", bytes: 0, reason: item.reason }; continue; }
          try {
            // Protected references and unchanged ownership.
            if (view.protectedPath(item.source)) throw new Error("预览后增加了引用或可恢复任务，保留");
            for (const [name, owner] of Object.entries(item.owners)) {
              const current = view.calls[name];
              if (current && !sameOwnership(current, owner)) throw new Error("预览后结果归属已改变，保留");
            }
            // A destination proves an earlier move only with this operation's saved intent; a new source beside it stays.
            const started = progress.started.includes(index), target = await exists(item.destination);
            if (target && !started) throw new Error("归档目标已存在，但没有本操作的持久意图");
            if (target && await exists(item.source)) throw new Error("归档源和目标同时存在；保留同名新源及其归属，请核对清单");
            // Evidence, then intent.
            if (!target) {
              const current = await reclamationEvidence(item.source);
              if (!matches(current, item.evidence) || current.newest > plan.before) throw new Error("预览后内容、实体或修改时间变化");
              if (!started) { progress.started.push(index); await save(); }
            }
            // Move and confirmation.
            if (item.task) {
              if (!options.backend || item.source !== join(member.dir, ".isolated-work", item.task)) throw new Error("隔离归档缺少管理后端或路径不符");
              await options.backend.archive(item.task, member.dir, item.destination, item.evidence);
            } else if (!target) await archiveEntry(item.source, item.destination, { dev: BigInt(item.evidence.dev), ino: BigInt(item.evidence.ino) });
            if (!matches(await reclamationEvidence(item.destination), item.evidence)) throw new Error("归档后的内容或实体不符，保留目标并报告失败");
            progress.outcomes[index] = { status: "archived", bytes: item.evidence.bytes }; await save();
            for (const [name, owner] of Object.entries(item.owners)) owners.set(name, owner);
          } catch (error) { progress.outcomes[index] = { status: "failed", bytes: 0, reason: String(error) }; await save(); }
        }
        // Settlement.
        if (owners.size) await view.settle(owners);
      });
    } catch (error) {
      for (const index of indexes) {
        if (progress.outcomes[index]?.status !== "archived") progress.outcomes[index] = { status: "failed", bytes: 0, reason: String(error) };
      }
      await save();
      // Even already moved bytes may still own a DB record; a failed commit requires retrying this plan.
      throw new Error("归档账本结算未完成，请使用原清单重试", { cause: error });
    }
    await save();
  }
  return progress;
}

/** Permanent deletion of archived entries, proven by the archive plans that moved them there. */
export interface ArchiveRemovalOptions extends TmpArchiveOptions {
  backend?: Pick<RootlessTasks, "inventory" | "archive" | "discardArchive" | "discardStarted" | "forgetDiscard">;
  /** Linux shared-identity entries: root-owned private journal for the fenced privileged backend. */
  legacy?: boolean; journal?: string;
}
/** Host maintenance names the container's group root with `recordedRoot`; both names must reach the same entity (checked by the plan's root identity). */
async function removalSource(options: ArchiveRemovalOptions, archive: string, plans: string, id: string, expectedDigest?: string): Promise<TmpArchivePlan> {
  const saved = await readJson(join(plans, id + ".json")), root = await realpath(options.root), inside = relative(root, archive);
  let view: PlanView = { root, archive };
  if (saved?.root !== root) {
    if (!options.recordedRoot || saved?.root !== options.recordedRoot || !inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("归档清单属于另一数据目录；宿主维护请用 --recorded-root 指定服务看到的数据目录");
    view = { root: options.recordedRoot, archive: join(options.recordedRoot, inside) };
  }
  return readArchivePlan(options, view, plans, id, expectedDigest ?? (typeof saved?.digest === "string" ? saved.digest : ""));
}
const kindOf = async (path: string) => {
  const info = await lstat(path);
  return info.isSymbolicLink() ? "link" as const : info.isDirectory() ? "directory" as const : "file" as const;
};

/** Read-only apart from the saved list: archived entries whose content and identity still equal their plan's evidence. */
export async function previewArchiveRemoval(options: ArchiveRemovalOptions, requestedId?: string): Promise<ArchiveRemovalPlan> {
  if (requestedId !== undefined && !ID_PATTERN.test(requestedId)) throw new Error("删除清单 ID 无效");
  const { archive, plans } = await location(options), id = requestedId ?? randomUUID(), items: RemovalItem[] = [], skipped: ArchiveRemovalPlan["skipped"] = [];
  // Privileged removal: while an operation of the journal root still holds the archive, its entries wait for that
  // operation's original list (also one whose entry is already gone, but whose parent was not handed back yet).
  const privileged = !!options.legacy && process.platform === "linux";
  const legacyRoot = privileged && options.journal ? await existingLegacyJournalRoot(options.journal) : undefined;
  const unfinished = legacyRoot ? await unfinishedLegacy(legacyRoot) : [], archiveRecord = privileged ? await legacyParent(archive) : undefined;
  for (const entry of unfinished) {
    if (entry.error || entry.entities.has(`${archiveRecord!.dev}:${archiveRecord!.ino}`)) skipped.push({ plan: entry.operation.replace(/-\d+$/, ""), reason: describeUnfinished(entry) });
  }
  for (const name of (await readdir(plans)).sort()) {
    const planId = /^(.+)\.json$/.exec(name)?.[1];
    if (!planId || !ID_PATTERN.test(planId)) continue;
    let plan: TmpArchivePlan, progress: TmpArchiveProgress | undefined;
    try {
      plan = await removalSource(options, archive, plans, planId);
      progress = await readArchiveProgress(plans, plan);
    } catch (error) { skipped.push({ plan: planId, reason: String(error) }); continue; }
    for (const [key, outcome] of Object.entries(progress?.outcomes ?? {})) {
      const index = Number(key), item = plan.items[index]!;
      if (outcome.status !== "archived" || !item.evidence) continue;
      const destination = join(archive, basename(item.destination));
      // A task deletion that already started is resumed from the backend's journal, whatever is left of the tree.
      let resumable = false;
      try { resumable = !!item.task && !options.legacy && !!options.backend && await options.backend.discardStarted(item.task, destination, item.evidence); }
      catch (error) { skipped.push({ plan: plan.id, reason: `${index}: ${String(error)}` }); continue; }
      const present = await exists(destination);
      if (!present && !resumable) continue; // Already discarded, or moved back by hand: nothing left to free.
      const entry: RemovalItem = { plan: plan.id, planDigest: plan.digest, index, destination, ...(item.task ? { task: item.task } : {}),
        evidence: item.evidence, kind: present ? await kindOf(destination) : "directory", status: "ready" };
      try {
        if (resumable) { /* The backend checks the remaining entries against its journal. */ }
        else if (!matches(await reclamationEvidence(destination), item.evidence)) { entry.status = "kept"; entry.reason = "归档后内容或实体已变化，保留并人工核对"; }
        else if (process.platform !== "win32" && !item.task && !options.legacy) {
          entry.status = "deferred"; entry.reason = "旧共享身份的归档项需要宿主特权离线后端（--legacy --journal）";
        } else if (item.task && (options.legacy || !options.backend)) {
          entry.status = "deferred"; entry.reason = "隔离任务的归档由任务管理后端删除，请以服务身份运行（不带 --legacy）";
        } else if (privileged && !item.task) {
          const blocker = legacyBlocker(unfinished, archiveRecord!, item.evidence);
          if (blocker) { entry.status = "deferred"; entry.reason = blocker; }
        }
      } catch (error) { entry.status = "kept"; entry.reason = String(error); }
      items.push(entry);
    }
  }
  const value = { version: 1 as const, id, archive, archiveIdentity: await entity(archive), createdAt: Date.now(), items, skipped };
  const plan: ArchiveRemovalPlan = { ...value, digest: planDigest(value) };
  if (Buffer.byteLength(JSON.stringify(plan)) > 32 * 1024 * 1024) throw new Error("删除清单过大");
  await createPlanFile(join(plans, id + ".removal.json"), plan);
  return plan;
}

/** Lease required. Each entry is rechecked against both the removal list and its archive plan before deletion. */
export async function applyArchiveRemoval(options: ArchiveRemovalOptions, id: string, expectedDigest: string): Promise<ArchiveRemovalProgress> {
  if (!ID_PATTERN.test(id) || !DIGEST_PATTERN.test(expectedDigest)) throw new Error("删除清单 ID 或摘要无效");
  const { archive, plans } = await location(options);
  const removal = decodeRemovalPlan(await readJson(join(plans, id + ".removal.json")), { id, digest: expectedDigest, archive });
  if (removal.archiveIdentity !== await entity(archive)) throw new Error("删除清单、摘要或归档根已变化：archiveIdentity");
  const progressPath = join(plans, id + ".removal-progress.json");
  let progress: ArchiveRemovalProgress;
  try { progress = decodeRemovalProgress(await readJson(progressPath), removal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; progress = { version: 1, digest: expectedDigest, started: [], outcomes: {} }; }
  const save = () => publishJson(progressPath, progress), journals = join(plans, "removal");
  if (process.platform === "win32") {
    await mkdir(journals, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    await entity(journals);
    if (await realpath(journals) !== journals) throw new Error("删除事务目录不能经过链接");
  }
  const sources = new Map<string, TmpArchivePlan>();
  for (const [index, item] of removal.items.entries()) {
    if (progress.outcomes[index]?.status === "removed") {
      // Removed content does not prove the parent was handed back: an older version may have unlinked the entry by path
      // and left this operation's privileged journal with the archive fenced. Only that journal is completed here. The
      // outcome stays removed, so a replay only finishes again and never resumes a deletion at this name.
      if (process.platform === "linux" && options.legacy && options.journal && !item.task) {
        try { await finishLegacy(item.destination, item.evidence, options.journal, `${id}-${index}`); }
        catch (error) { throw unfinishedLegacyError(error); }
      }
      continue;
    }
    if (item.status !== "ready") { progress.outcomes[index] = { status: item.status === "kept" ? "kept" : "deferred", bytes: 0, reason: item.reason }; await save(); continue; }
    try {
      // The archive plan, not this list, proves the entry was moved here by one of our archives.
      let source = sources.get(item.plan);
      if (!source) { source = await removalSource(options, archive, plans, item.plan, item.planDigest); sources.set(item.plan, source); }
      const archived = source.items[item.index], outcome = (await readArchiveProgress(plans, source))?.outcomes[item.index];
      if (!archived || outcome?.status !== "archived" || basename(archived.destination) !== basename(item.destination) || archived.task !== item.task
        || JSON.stringify(archived.evidence) !== JSON.stringify(item.evidence)) throw new Error("归档清单不再证明此项");
      const started = progress.started.includes(index);
      if (item.task && !options.backend) throw new Error("隔离任务归档需要任务管理后端");
      // Backends keep their own journal; only they may resume after the content changed or the root is gone.
      const journaled = item.task ? await options.backend!.discardStarted(item.task, item.destination, item.evidence)
        : started && (process.platform === "win32"
          || !!options.legacy && !!options.journal && await legacyJournalSaved(options.journal, `${id}-${index}`, item.destination, item.evidence));
      const present = await exists(item.destination);
      if (!present && !journaled) { progress.outcomes[index] = { status: "missing", bytes: 0, reason: "归档目标已不存在；无法证明由本操作删除" }; await save(); continue; }
      if (present && !journaled && !matches(await reclamationEvidence(item.destination), item.evidence)) throw new Error("预览后归档内容或实体变化，保留");
      if (!started) { progress.started.push(index); await save(); }
      if (item.task) {
        const result = await options.backend!.discardArchive(item.task, item.destination, item.evidence);
        progress.outcomes[index] = result.status !== "removed" ? { status: "deferred", bytes: 0, reason: result.reason }
          : result.completedEarlier ? finishedEarlier() : { status: "removed", bytes: item.evidence.bytes };
        await save();
        // A journal left behind (this failed) is finished again by a later preview and removal; the outcome stands.
        if (result.status === "removed") await options.backend!.forgetDiscard(item.task, item.destination, item.evidence).catch(() => {});
        continue;
      }
      if (process.platform === "win32") await reclaimWindows(item.destination, item.evidence, journals, `${id}-${index}`);
      else if (options.legacy && options.journal) await reclaimLegacy(item.destination, item.evidence, options.journal, `${id}-${index}`);
      else throw new Error("旧共享身份的归档项需要宿主特权离线后端（--legacy --journal）");
      progress.outcomes[index] = { status: "removed", bytes: item.evidence.bytes };
      await save();
    } catch (error) {
      progress.outcomes[index] = { status: "failed", bytes: 0, reason: String(error) }; await save();
      if (error instanceof LegacyReclamationPending) throw error;
    }
  }
  return progress;
}
