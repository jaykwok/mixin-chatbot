// Permanent reclamation of member tmp entries: preview saves the exact list, apply deletes only listed entries.
// Per item: protected references → fresh evidence → saved intent (`started`) → platform removal → saved outcome; the
// member's removed owners are then settled in its source transaction. A failed item is recorded and the member goes on,
// except a pending privileged backend, which stops the batch (its tree stays frozen until the same plan is replayed).
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { publishJson } from "../../scripts/lib/atomic-file.ts";
import { scanTmp, type UserTmp } from "../../scripts/lib/tmp-scan.ts";
import type { GroupSelection } from "../../scripts/lib/group-data.ts";
import { memberTmpDir, decodeReclaimPlan, decodeReclaimProgress, DIGEST_PATTERN, finishedEarlier, ID_PATTERN, journalRecordsDeletion, planDigest, RESULT_NAME,
  type ReclaimItem as Item, type ReclaimOutcome as Outcome, type ReclaimProgress as Progress, type ReclamationPlan,
  type ResultOwnership } from "../contracts/maintenance.ts";
import type { RootlessTasks } from "../core/rootless-tasks.ts";
import { reclamationEvidence } from "../core/reclamation-files.ts";
import { taskOwner } from "../core/task-owner.ts";
import { finishLegacy, legacyBlocker, legacyJournalRoot, legacyParent, LegacyReclamationPending, reclaimLegacy, unfinishedLegacy,
  unfinishedLegacyError } from "./legacy.ts";
import { legacyInventory } from "./legacy-inventory.ts";
import { directoryEntity, exists, memberIndexes, readPlanFile } from "./plans.ts";
import type { MemberScope, MemberView } from "./scope.ts";
import { reclaimWindows } from "./windows.ts";

export interface ReclamationOptions { root: string; state: string; directory: string; scope: MemberScope;
  backend?: Pick<RootlessTasks, "inventory" | "reclaim">;
  /** Explicit host command: root-owned journal, never inferred from a stale lease. */
  legacy?: boolean; recordedRoot?: string; }

const identity = (path: string) => directoryEntity(path, "回收根不是普通目录");
const readPrivate = (path: string) => readPlanFile(path, { private: true, message: "回收清单/进度不是当前身份的私有普通文件，或超过 32 MiB" });

async function plansRoot(options: ReclamationOptions): Promise<string> {
  const directory = resolve(options.directory);
  if (options.legacy) return legacyJournalRoot(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await identity(directory);
  if (await realpath(directory) !== directory) throw new Error("回收清单目录不能经过链接");
  const info = await lstat(directory);
  if (process.platform === "linux" && (info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)) throw new Error("回收清单目录必须属于当前身份且权限为 0700");
  if (process.platform === "linux") taskOwner(directory);
  return directory;
}

/** The member's candidate items under one protected view: isolated tasks, result directories, then old shared entries. */
async function memberItems(options: ReclamationOptions, user: UserTmp, view: MemberView, before: number, preview: boolean): Promise<Item[]> {
  const common = { space: user.space, user: user.user }, items: Item[] = [];
  // Old shared directories are only removable by a platform backend that can fence them.
  const sharedReady = !!options.legacy || process.platform === "win32", sharedReason = "旧共享目录需要宿主特权离线回收";
  const add = async (item: Item, createdAt: number) => {
    if (view.protectedPath(item.path)) { item.status = "kept"; item.reason = view.liveWork ? "群库有可恢复任务或未结算输入" : "当前上下文或待交付内容引用"; }
    else if (Number.isFinite(createdAt) && createdAt >= before) { item.status = "kept"; item.reason = "未到保留期限"; }
    try { item.evidence = await reclamationEvidence(item.path); }
    catch (error) { if (item.status !== "kept") { item.status = "deferred"; item.reason = String(error); } }
    items.push(item);
  };
  // One ownership index per view: task id → result names that claim it.
  const taskOwners = new Map<string, [string, ResultOwnership][]>();
  for (const [name, call] of Object.entries(view.calls)) {
    if (call.isolatedTask === undefined) continue;
    const owned = taskOwners.get(call.isolatedTask) ?? []; owned.push([name, call]); taskOwners.set(call.isolatedTask, owned);
  }
  const inventory = await options.backend?.inventory(user.dir, preview);
  for (const error of inventory?.refused ?? []) items.push({ ...common, path: user.dir, task: error.id, status: "deferred", reason: error.reason });
  for (const task of inventory?.items ?? []) {
    const owned = taskOwners.get(task.id) ?? [];
    if (owned.length > 1) throw new Error("隔离任务有重复的结果归属");
    const [result, owner] = owned[0] ?? [];
    await add({ ...common, path: task.path, task: task.id, token: task.token, ...(owner ? { result, owner } : {}), status: "ready" }, task.createdAt);
  }
  for (const [name, call] of Object.entries(view.calls)) {
    if (call.isolatedTask) continue;
    if (!RESULT_NAME.test(name)) throw new Error("结果归属路径无效");
    await add({ ...common, path: join(user.dir, "codemode", name), result: name, owner: call, token: JSON.stringify([name, call.phone, call.createdAt]),
      status: sharedReady ? "ready" : "deferred", ...(!sharedReady ? { reason: sharedReason } : {}) }, call.createdAt);
  }
  for (const entry of await legacyInventory(options.root, user, options.recordedRoot)) {
    await add({ ...common, ...entry, status: sharedReady && entry.token ? "ready" : "deferred",
      reason: entry.reason ?? (sharedReady ? undefined : sharedReason) }, entry.createdAt);
  }
  return items;
}

/** Caller holds service/group leases. Exact digest is required again for permanent deletion. */
export async function previewReclamation(options: ReclamationOptions, days: number, user?: string, group?: string, selection: GroupSelection = "auto",
  requestedId?: string): Promise<ReclamationPlan> {
  if (requestedId !== undefined && !ID_PATTERN.test(requestedId)) throw new Error("回收清单 ID 无效");
  if (!Number.isFinite(days) || days < 0) throw new Error("回收天数必须不小于 0");
  const directory = await plansRoot(options), root = await realpath(options.root), createdAt = Date.now(), items: Item[] = [], seen = new Set<string>();
  const before = createdAt - days * 86_400_000;
  if (!Number.isFinite(before)) throw new Error("回收期限超出范围");
  for (const member of await scanTmp(root, user, group, selection)) {
    try {
      await options.scope.withMember({ ...options, root }, member, { exclusive: false, requireGroup: true }, async view => {
        for (const item of await memberItems({ ...options, root }, member, view, before, true)) if (!seen.has(item.path)) { seen.add(item.path); items.push(item); }
      });
    } catch (error) { items.push({ space: member.space, user: member.user, path: member.dir, status: "deferred", reason: String(error) }); }
  }
  // Privileged reclamation: an entry whose parent (or itself) an unfinished operation still holds waits for that
  // operation's original plan. Apply checks again before any new journal.
  if (options.legacy) {
    const unfinished = await unfinishedLegacy(directory);
    for (const item of items) {
      if (item.status !== "ready" || item.task !== undefined || !item.evidence) continue;
      let blocker: string | undefined;
      try { blocker = legacyBlocker(unfinished, await legacyParent(dirname(item.path)), item.evidence); } catch (error) { blocker = String(error); }
      if (blocker) { item.status = "deferred"; item.reason = blocker; }
    }
  }
  const value = { version: 1 as const, id: requestedId ?? randomUUID(), root, recordedRoot: options.recordedRoot ?? root, rootIdentity: await identity(root), legacy: !!options.legacy, createdAt, before, items };
  const plan: ReclamationPlan = { ...value, digest: planDigest(value) };
  if (Buffer.byteLength(JSON.stringify(plan)) > 32 * 1024 * 1024) throw new Error("回收清单超过 32 MiB，请限定群或成员");
  // A caller-chosen ID (the TUI reads the plan back by it) never replaces an existing plan.
  if (requestedId !== undefined && await exists(join(directory, plan.id + ".json"))) throw new Error("回收清单 ID 已存在");
  await publishJson(join(directory, plan.id + ".json"), plan); return plan;
}

/** Interrupted deletion resumes only from its own durable backend intent. */
export async function applyReclamation(options: ReclamationOptions, id: string, expectedDigest: string): Promise<Progress> {
  if (!ID_PATTERN.test(id) || !DIGEST_PATTERN.test(expectedDigest)) throw new Error("回收清单 ID 或摘要无效");
  const directory = await plansRoot(options), root = await realpath(options.root);
  const plan = decodeReclaimPlan(await readPrivate(join(directory, id + ".json")),
    { id, digest: expectedDigest, root, recordedRoot: options.recordedRoot ?? root, legacy: !!options.legacy });
  if (plan.rootIdentity !== await identity(options.root)) throw new Error("回收清单、摘要或数据目录实体已变化，拒绝执行：rootIdentity");
  const progressPath = join(directory, id + ".progress.json");
  let progress: Progress;
  try { progress = decodeReclaimProgress(await readPrivate(progressPath), plan); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; progress = { version: 1, plan: expectedDigest, outcomes: {}, started: [] }; }
  const save = () => publishJson(progressPath, progress);
  const unchanged = (item: Item) => ({ status: item.status === "kept" ? "kept" as const : "deferred" as const, bytes: 0, reason: item.reason });
  for (const indexes of memberIndexes(plan.items)) {
    if (indexes.every(index => plan.items[index]!.status !== "ready")) {
      for (const index of indexes) progress.outcomes[String(index)] = unchanged(plan.items[index]!);
      await save(); continue;
    }
    const first = plan.items[indexes[0]!]!, dir = memberTmpDir(options.root, first.space, first.user);
    // Reconstruction includes a member whose previous successful deletion emptied tmp.
    const member: UserTmp = { space: first.space, user: first.user, dir, entries: [], bytes: 0, files: 0, newest: 0 };
    await options.scope.withMember(options, member, { exclusive: true, requireGroup: true }, async view => {
      // Fresh evidence and receipts, indexed once for this view (first entry wins, as in plan order).
      const fresh = new Map<string, Item>();
      for (const candidate of await memberItems(options, member, view, plan.before, false)) {
        const key = JSON.stringify([candidate.path, candidate.token]); if (!fresh.has(key)) fresh.set(key, candidate);
      }
      const inventory = await options.backend?.inventory(dir), receipts = new Map<string, NonNullable<typeof inventory>["items"][number]>();
      for (const task of inventory?.items ?? []) { const key = JSON.stringify([task.id, task.token]); if (!receipts.has(key)) receipts.set(key, task); }
      const owners = new Map<string, ResultOwnership>();
      for (const index of indexes) {
        const item = plan.items[index]!, key = String(index);
        if (progress.outcomes[key]?.status === "removed") {
          // Removed content does not prove the parent was handed back; only this operation's own journal is completed.
          // The outcome stays removed, so a replay only finishes again and never resumes a deletion at this name.
          if (options.legacy && !item.task && item.evidence) {
            try { await finishLegacy(item.path, item.evidence, directory, id + "-" + key); }
            catch (error) { throw unfinishedLegacyError(error); }
          }
          if (item.result && item.owner) owners.set(item.result, item.owner);
          continue;
        }
        if (item.status !== "ready" || !item.evidence || !item.token) { progress.outcomes[key] = unchanged(item); continue; }
        try {
          // Protected references.
          if (view.protectedPath(item.path)) throw new Error("当前有引用或可恢复任务，保留待核对");
          // Evidence: a started item resumes only from its backend's own durable intent.
          const current = fresh.get(JSON.stringify([item.path, item.token]));
          const receipt = item.task === undefined ? undefined : receipts.get(JSON.stringify([item.task, item.token])), started = progress.started.includes(key);
          let legacyResume = false;
          if (started && !item.task && (options.legacy || process.platform === "win32")) {
            try {
              legacyResume = journalRecordsDeletion(await readPrivate(join(directory, id + "-" + key + ".json")), item.path, item.evidence);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
          const resuming = started && (item.task ? receipt && ["reclaiming", "removed"].includes(receipt.phase) : legacyResume);
          if (item.task && (!receipt || resolve(dir, ".isolated-work", item.task, "work") !== item.path)) throw new Error("回收任务归属或路径已变化");
          if (!resuming && (current?.status !== "ready" || current.evidence?.fingerprint !== item.evidence.fingerprint
            || current.evidence.dev !== item.evidence.dev || current.evidence.ino !== item.evidence.ino)) throw new Error("预览后归属、内容或实体已变化；请重新预览");
          // Intent.
          if (!started) { progress.started.push(key); await save(); }
          // Platform removal and confirmation.
          let outcome: Outcome;
          if (item.task) {
            const result = await options.backend!.reclaim(item.task, dir);
            outcome = result.status !== "removed" ? { status: "deferred", bytes: 0, reason: result.reason }
              : result.completedEarlier ? finishedEarlier() : { status: "removed", bytes: item.evidence.bytes };
          } else {
            if (process.platform === "win32") await reclaimWindows(item.path, item.evidence, directory, id + "-" + key);
            else {
              if (!options.legacy) throw new Error("旧共享目录未启用宿主特权离线后端");
              await reclaimLegacy(item.path, item.evidence, directory, id + "-" + key);
            }
            outcome = { status: "removed", bytes: item.evidence.bytes };
          }
          progress.outcomes[key] = outcome; await save();
          if (outcome.status === "removed" && item.result && item.owner) owners.set(item.result, item.owner);
        } catch (error) {
          progress.outcomes[key] = { status: "failed", bytes: 0, reason: String(error) }; await save();
          if (error instanceof LegacyReclamationPending) throw error;
        }
      }
      // Settlement. Physical receipts persist before this transaction; a failed DB commit is retried from the same plan.
      if (owners.size) await view.settle(owners);
      await save();
    });
  }
  return progress;
}
