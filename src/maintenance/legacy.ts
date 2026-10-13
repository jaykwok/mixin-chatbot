// Offline privileged backend. Changing ownership through held descriptors revokes directory
// operations even from an old writer holding a cwd/dirfd; no stale lease is a removal permit.
//
// Journal phases: fencing ─→ deleting ─→ removed ─→ restored, or fencing ─→ restored after a failed check.
// - fencing: the original metadata of each directory is saved before its ownership changes; a failure restores it.
// - deleting: saved after the reviewed content is rechecked under the fence. From here on the tree stays frozen
//   until a replay of the same plan finishes the removal; writers are never handed back an unfinished tree.
// - removed: only the parent survives; restoring it ends the operation.
// A reviewed file or link is never frozen itself: under the fenced parent the old identity can no longer rename, replace
// or remove its name, so the entity rechecked under the fence is the one unlinked. A root-owned parent that others can
// write (a sticky /tmp) does not fence a non-directory and is refused.
//
// Operations of one journal root that share a directory never overlap: a new operation does not start (or save the
// parent's metadata) while an unfinished one holds the same parent or entry; a parent is not handed back while another
// operation keeps content frozen under it. A check that fails before any deletion intent, with everything handed back,
// drops its journal so it cannot block later operations.
//
// Fence windows, whatever journal directory is used: a fenced parent always starts with a non-root owner and without
// the sticky bit. Fencing is chown(0, 0) then chmod(0700); hand-back is chmod(original) then chown(original), and a
// directory's chown never changes its mode. So every state between the two calls, in either direction, is root-owned
// and not sticky. The only legitimate root-owned parent is a sticky one (the system /tmp, never fenced). A root-owned
// parent without the sticky bit is therefore never taken over, never saved as an original, and never applied.
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { publishJson } from "../../scripts/migrations/lib/io.ts";
import { holdDirectory, sameIdentity } from "../core/held-directory.ts";
import { RemovalPermit } from "../core/reclamation.ts";
import { decodeLegacyJournal, validTreeEvidence, type FrozenDirectory as Frozen, type LegacyJournal as Journal,
  type TreeEvidence } from "../contracts/maintenance.ts";
import { reclamationEvidence } from "../core/reclamation-files.ts";
import { taskOwner } from "../core/task-owner.ts";

export class LegacyReclamationPending extends Error {}

/** A recorded removal whose journal could not be finished: the parent may still be fenced, so the whole run stops. */
export function unfinishedLegacyError(error: unknown): LegacyReclamationPending {
  return new LegacyReclamationPending("条目已删除，但特权事务未收尾；保持服务停止并使用原清单重试：" + String(error), { cause: error });
}

/** Privileged journals must live outside directories writable by the old service identity. */
export async function legacyJournalRoot(path: string): Promise<string> {
  if (process.platform !== "linux" || process.getuid!() !== 0) throw new Error("旧共享目录物理回收需要独立的 UID 0 维护进程；不会自动 sudo");
  // Rootless container UID 0 maps back to the untrusted writer. It cannot fence that identity.
  for (const name of ["uid_map", "gid_map"]) {
    if ((await readFile("/proc/self/" + name, "utf8")).trim().split(/\s+/).join(" ") !== "0 0 4294967295") {
      throw new Error("旧共享目录回收拒绝重映射的用户命名空间；请使用宿主维护身份");
    }
  }
  const root = resolve(path);
  if (root === "/") throw new Error("不能使用文件系统根保存回收事务");
  const parents: string[] = []; for (let current = root; current !== "/"; current = dirname(current)) parents.unshift(current);
  for (const current of parents) {
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("离线回收事务的全部父目录必须属于维护身份且其他身份不可写：" + current);
  }
  if (await realpath(root) !== root) throw new Error("离线回收事务不能经过链接");
  taskOwner(root);
  return root;
}

/** Previews do not create the journal root; a missing one holds no operation. */
export async function existingLegacyJournalRoot(path: string): Promise<string | undefined> {
  if (!await lstat(resolve(path)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) return undefined;
  return legacyJournalRoot(path);
}

const OPERATION = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}-\d+$/;
type Entity = { dev: string; ino: string };
const entityKey = (entity: Entity) => `${entity.dev}:${entity.ino}`;
/** A fence, or a fence or hand-back stopped between its chown and chmod (see the header). Never an original. */
const untrustedRoot = (record: Frozen) => record.uid === 0 && (record.mode & 0o1000) === 0;

/** An operation that has not handed its directories back, with every directory entity it saved (the parent first).
 * An unreadable journal cannot prove what it holds: `error` is set and it relates to every entry. */
export interface UnfinishedLegacy { operation: string; phase?: Journal["phase"]; path?: string; entities: Set<string>; error?: string }

/** A saved journal of the trusted root (root-owned, private, bounded), parsed but not yet decoded. */
async function readJournal(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o077) || info.size > 32 * 1024 * 1024) throw new Error("事务权限或大小无效");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

/** Whether this operation saved a journal for exactly this entry (any phase): only then does a started entry resume in
 * the backend, which decides from that journal, even without its original entity. No journal means nothing of this
 * operation ran (a failed check that handed everything back drops it). */
export async function legacyJournalSaved(journalRoot: string, operation: string, path: string, proof: TreeEvidence): Promise<boolean> {
  if (!OPERATION.test(operation)) throw new Error("旧目录回收操作 ID 或证据无效");
  const root = await legacyJournalRoot(journalRoot);
  let value: unknown;
  try { value = await readJournal(join(root, operation + ".json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  decodeLegacyJournal(value, path, dirname(path), proof);
  return true;
}

export async function unfinishedLegacy(root: string, except?: string): Promise<UnfinishedLegacy[]> {
  const found: UnfinishedLegacy[] = [];
  for (const name of (await readdir(root)).sort()) {
    const operation = /^(.+)\.json$/.exec(name)?.[1];
    if (!operation || !OPERATION.test(operation) || operation === except) continue;
    try {
      const value = await readJournal(join(root, name));
      const fields = value as { path?: unknown; parent?: unknown; proof?: unknown } | null;
      if (!fields || typeof fields.path !== "string" || typeof fields.parent !== "string" || !validTreeEvidence(fields.proof)) throw new Error("事务格式无效");
      const journal = decodeLegacyJournal(value, fields.path, fields.parent, fields.proof);
      if (journal.phase !== "restored") found.push({ operation, phase: journal.phase, path: journal.path, entities: new Set(journal.directories.map(entityKey)) });
    } catch (error) { found.push({ operation, entities: new Set(), error: String(error) }); }
  }
  return found;
}

/** Operator guidance naming the original list: an operation ID is `<list or plan ID>-<index>`. */
export function describeUnfinished(entry: UnfinishedLegacy): string {
  if (entry.error) return `特权事务 ${entry.operation} 无法读取，不能判断关联（${entry.error}）`;
  return `特权事务 ${entry.operation} 未完成（${entry.phase}：${entry.path}）；请保持停机，用原清单 ${entry.operation.replace(/-\d+$/, "")} 和同一事务目录续做`;
}

/** Current metadata of a parent directory, as a journal would save it. */
export async function legacyParent(directory: string): Promise<Frozen> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory()) throw new Error("旧共享条目的父路径不是普通目录");
  return { relative: "..", dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o7777n) };
}

/** Why a new operation on `target` under `parent` must not start; the original operation resumes from its own journal. */
export function legacyBlocker(unfinished: UnfinishedLegacy[], parent: Frozen, target: Entity): string | undefined {
  const keys = [entityKey(parent), entityKey(target)], blocking = unfinished.filter(entry => entry.error || keys.some(key => entry.entities.has(key)));
  if (blocking.length) return "同一父目录或条目有未完成的特权事务，不能以新清单接管：" + blocking.map(describeUnfinished).join("；");
  // Possibly fenced, fully or half way, with no journal here naming it (another journal directory, or a lost journal).
  if (untrustedRoot(parent)) return "父目录为 root 所有且无粘滞位，可能处于特权回收冻结或其中间状态；不能以新清单接管，请用原清单和原事务目录续做";
  return undefined;
}

/** One run over one reviewed tree. Every frozen directory stays held (with its saved original metadata) until the end. */
class LegacyReclamation {
  journal: Journal | undefined;
  /** The saved intent is deletion (or its save may have completed): never restore writers from here on. */
  deleting = false;
  readonly held: { record: Frozen; handle: FileHandle }[] = [];
  #recorded = new Map<string, Frozen>();
  readonly #parentEntry: string;

  /** `finishing`: the caller already recorded the entry removed; only this operation's saved journal is completed. */
  constructor(readonly path: string, readonly proof: TreeEvidence, readonly root: string, readonly operation: string, readonly parentPath: string,
    readonly name: string, readonly parent: FileHandle, readonly finishing: boolean) {
    this.#parentEntry = `/proc/self/fd/${parent.fd}`;
  }

  get journalPath() { return join(this.root, this.operation + ".json"); }

  persist() { return publishJson(this.journalPath, this.journal); }

  /** Other operations that still keep content frozen under this parent (or cannot be read). */
  async #othersHolding(parent: Frozen): Promise<UnfinishedLegacy[]> {
    return (await unfinishedLegacy(this.root, this.operation)).filter(entry => entry.error
      || (entry.phase === "fencing" || entry.phase === "deleting") && entry.entities.has(entityKey(parent)));
  }

  async #record(relative: string, handle: FileHandle): Promise<Frozen> {
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory() || String(info.dev) !== this.proof.dev) throw new Error("旧目录回收不能跨设备");
    return { relative, dev: String(info.dev), ino: String(info.ino), uid: Number(info.uid), gid: Number(info.gid), mode: Number(info.mode & 0o7777n) };
  }

  /** Hand every frozen directory back to its original owner and mode, innermost first. The parent stays fenced while
   * another operation holds content under it. `complete`: every saved directory was handed back. */
  async restore(): Promise<{ complete: boolean; parentHeld: boolean }> {
    const parent = this.held.find(entry => entry.handle === this.parent);
    const holding = parent ? (await this.#othersHolding(parent.record)).length > 0 : false;
    for (const entry of [...this.held].reverse()) {
      if (entry.handle === this.parent && (holding || untrustedRoot(entry.record))) continue;
      await entry.handle.chmod(entry.record.mode); await entry.handle.chown(entry.record.uid, entry.record.gid);
    }
    return { parentHeld: holding, complete: !holding && !!this.journal && this.journal.directories.every(record => this.held.some(entry => entry.record === record)) };
  }

  /** After the content is gone: hand the parent back, unless another operation still keeps content frozen under it. */
  async #handBack(record: Frozen) {
    const holding = await this.#othersHolding(record);
    if (holding.length) throw new LegacyReclamationPending("内容已删除；同一父目录仍有其他未完成的特权事务，暂不交还写权限：" + holding.map(describeUnfinished).join("；"));
    // An older version could save a fence (or a half-done one) as the original; applying it would undo a restoration.
    if (!untrustedRoot(record)) { await this.parent.chmod(record.mode); await this.parent.chown(record.uid, record.gid); }
  }

  /** The saved journal of this operation, or a new fencing journal holding the parent's original metadata. */
  async #openJournal(): Promise<Journal> {
    const saved = await open(this.journalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if (error.code !== "ENOENT") throw error; return undefined;
    });
    if (saved) {
      try {
        const info = await saved.stat();
        if (!info.isFile() || info.uid !== 0 || (info.mode & 0o077) || info.size > 32 * 1024 * 1024) throw new Error("旧目录回收事务权限或大小无效");
        this.journal = decodeLegacyJournal(JSON.parse(await saved.readFile("utf8")), this.path, this.parentPath, this.proof);
      } finally { await saved.close(); }
    } else {
      if (this.finishing) throw new Error("收尾只完成原操作已保存的事务");
      const parentRecord = await this.#record("..", this.parent);
      // Rechecked here under the caller's maintenance lock, not only in the preview.
      const blocker = legacyBlocker(await unfinishedLegacy(this.root, this.operation), parentRecord, this.proof);
      if (blocker) throw new Error(blocker);
      if (parentRecord.uid !== this.proof.uid && !(parentRecord.uid === 0 && (parentRecord.mode & 0o1000) !== 0)) throw new Error("旧共享父目录既不属于原服务身份，也不是带粘滞位的系统目录");
      // A fenced parent must not be sticky, or a stop between chown and chmod would look like the system /tmp.
      if (parentRecord.uid !== 0 && (parentRecord.mode & 0o1000) !== 0) throw new Error("旧共享父目录带粘滞位，不能安全冻结");
      this.journal = { version: 1, path: this.path, parent: this.parentPath, proof: this.proof, phase: "fencing", directories: [parentRecord] };
      await this.persist();
    }
    // The first saved entry of a relative path is its original metadata.
    for (const entry of this.journal.directories) if (!this.#recorded.has(entry.relative)) this.#recorded.set(entry.relative, entry);
    return this.journal;
  }

  /** Take the parent away from the old identity. A root-owned sticky /tmp already protects a root-owned child;
   * never chmod the system /tmp. */
  async #fenceParent(record: Frozen) {
    this.held.push({ record, handle: this.parent });
    if (record.uid !== 0) { await this.parent.chown(0, 0); await this.parent.chmod(0o700); }
  }

  /** Freeze one directory and, recursively, its subdirectories: register it (saved before its first ownership change),
   * hold it, then make it root-only. */
  async #freeze(location: string, relative: string, depth: number): Promise<void> {
    if (depth > 64 || this.held.length > 100_000) throw new Error("旧目录回收超过安全遍历限额");
    const directory = await open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let owned = false;
    try {
      const current = await this.#record(relative, directory);
      if (relative === "" && (current.dev !== this.proof.dev || current.ino !== this.proof.ino)) throw new Error("预览后的旧目录实体已被替换");
      let original = this.#recorded.get(relative);
      if (original) {
        if (original.dev !== current.dev || original.ino !== current.ino) throw new Error("已冻结目录的实体已变化");
      } else {
        if (current.uid !== this.proof.uid) throw new Error("未登记的目录不属于原服务身份，拒绝接管");
        original = current; this.journal!.directories.push(original); this.#recorded.set(relative, original); await this.persist();
      }
      this.held.push({ record: original, handle: directory }); owned = true;
      await directory.chown(0, 0); await directory.chmod(0o700);
      for (const child of await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true })) {
        if (child.isDirectory() && !child.isSymbolicLink()) await this.#freeze(`/proc/self/fd/${directory.fd}/${child.name}`, relative ? relative + "/" + child.name : child.name, depth + 1);
      }
    } finally { if (!owned) await directory.close(); }
  }

  /** Freeze the reviewed tree. Returns false only for a deletion whose registered top-level entry is already gone. */
  async #freezeTree(): Promise<boolean> {
    try { await this.#freeze(join(this.#parentEntry, this.name), "", 0); return true; }
    catch (error) {
      if (!this.deleting || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only the registered top-level absence completes a prior deletion intent.
      if (await lstat(join(this.#parentEntry, this.name)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw error;
      return false;
    }
  }

  /** Under the fence the content must still be exactly what was reviewed. A failed acknowledgement may still have
   * published the intent, so the run counts as deleting before the save returns. */
  async #recordIntent() {
    const current = await reclamationEvidence(join(this.#parentEntry, this.name));
    if (current.fingerprint !== this.proof.fingerprint || current.dev !== this.proof.dev || current.ino !== this.proof.ino) throw new Error("预览后旧目录内容或实体已变化，恢复权限并保留");
    this.journal!.phase = "deleting"; this.deleting = true; await this.persist();
  }

  /** A reviewed file or link: same entity, unchanged content under the fence, then unlinked through the held parent. */
  async #removeEntry(parentRecord: Frozen, observed: BigIntStats) {
    if (parentRecord.uid === 0 && (parentRecord.mode & 0o022) !== 0) throw new Error("他人可写的父目录不能隔离旧身份，文件或链接保留");
    if (!sameIdentity(observed, { dev: BigInt(this.proof.dev), ino: BigInt(this.proof.ino) })) throw new Error("预览后的旧条目实体已被替换");
    if (!this.deleting) await this.#recordIntent();
    await unlink(join(this.#parentEntry, this.name));
  }

  /** Remove exactly the reviewed inode under a permit for the held parent. */
  async #removeTree() {
    const directory = await holdDirectory(this.#parentEntry + "/.", [], false);
    const expected = { dev: BigInt(this.proof.dev), ino: BigInt(this.proof.ino) }, permit = new RemovalPermit(directory.identity, expected);
    try {
      const result = await directory.use(entries => entries.removeDirectories({ select: candidate => candidate === this.name, permit, requireRemoval: true,
        beforeRemove: async (_name, _time, _entries, identity) => sameIdentity(identity, expected) }));
      if (result[0]?.status !== "removed") throw new Error("旧目录物理回收未确认");
    } finally { permit.revoke(); await directory.release(); }
  }

  async run(): Promise<void> {
    const journal = await this.#openJournal(), parentRecord = journal.directories[0]!;
    if (parentRecord.relative !== ".." || !sameIdentity(await this.parent.stat({ bigint: true }), { dev: BigInt(parentRecord.dev), ino: BigInt(parentRecord.ino) })) throw new Error("旧目录回收父实体已变化");
    if (journal.phase === "restored") return;
    // Removed content proves nothing by itself: the list, this journal and the parent entity (checked above) do. An
    // entry present again is never deleted on this path, and the parent is left exactly as it is (it may have been
    // handed back already).
    if (this.finishing && journal.phase !== "removed"
      && await lstat(join(this.#parentEntry, this.name)).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
      throw new Error("清单已记录删除，但原位置仍有条目；收尾不重新授权删除，保留待核对");
    }
    await this.#fenceParent(parentRecord);
    if (journal.phase === "removed") { this.deleting = true; await this.#handBack(parentRecord); journal.phase = "restored"; await this.persist(); return; }
    this.deleting = journal.phase === "deleting";
    if (this.finishing) {
      this.deleting = true; journal.phase = "removed"; await this.persist();
      await this.#handBack(parentRecord); journal.phase = "restored"; await this.persist(); return;
    }
    const entry = await lstat(join(this.#parentEntry, this.name), { bigint: true }).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (entry && !entry.isDirectory()) await this.#removeEntry(parentRecord, entry);
    else if (await this.#freezeTree()) {
      if (!this.deleting) await this.#recordIntent();
      await this.#removeTree();
    }
    journal.phase = "removed"; await this.persist();
    // Only the parent survives deletion. Detached children do not need permission restoration.
    await this.#handBack(parentRecord);
    journal.phase = "restored"; await this.persist();
  }
}

/** Only the exact reviewed inode tree (or file, or link) is deleted. Partial fencing is reversible; deletion is resumable. */
export async function reclaimLegacy(path: string, proof: TreeEvidence, journalRoot: string, operation: string): Promise<void> {
  await runLegacy(path, proof, journalRoot, operation, false);
}

/** The caller recorded this entry removed, possibly by an older version that unlinked it by path and left this
 * operation's journal behind with the parent fenced. Completes only that saved journal, with the parent entity and
 * original metadata it recorded; never deletes. Returns false when the operation saved no journal. */
export async function finishLegacy(path: string, proof: TreeEvidence, journalRoot: string, operation: string): Promise<boolean> {
  if (!OPERATION.test(operation)) throw new Error("旧目录回收操作 ID 或证据无效");
  const root = await legacyJournalRoot(journalRoot);
  if (!await lstat(join(root, operation + ".json")).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) return false;
  await runLegacy(path, proof, root, operation, true);
  return true;
}

async function runLegacy(path: string, proof: TreeEvidence, journalRoot: string, operation: string, finishing: boolean): Promise<void> {
  const root = await legacyJournalRoot(journalRoot);
  if (!OPERATION.test(operation) || !validTreeEvidence(proof) || proof.uid === 0) throw new Error("旧目录回收操作 ID 或证据无效");
  const parentPath = dirname(path), name = basename(path);
  if (resolve(path) !== path || !name || name === "." || name === "..") throw new Error("旧目录回收路径无效");
  const parent = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const run = new LegacyReclamation(path, proof, root, operation, parentPath, name, parent, finishing);
  try { await run.run(); }
  catch (error) {
    if (!run.deleting) {
      let restored: { complete: boolean; parentHeld: boolean };
      try { restored = await run.restore(); }
      catch (restoreError) { throw new LegacyReclamationPending("权限恢复未完成；保持服务停止并使用原清单重试：" + String(restoreError), { cause: error }); }
      // No deletion intent and everything handed back: nothing to resume, and the journal would only block other
      // operations on this parent. If it cannot go, it keeps blocking them (the safe side) until the list is replayed.
      if (restored.complete && run.journal?.phase === "fencing") await unlink(run.journalPath).catch(() => {});
      if (restored.parentHeld) throw new LegacyReclamationPending("已恢复本操作冻结的目录；父目录仍由其他未完成的特权事务冻结，请先用其原清单续做：" + String(error), { cause: error });
      throw error;
    }
    throw new LegacyReclamationPending("旧目录回收尚未完成；保持服务停止并使用原清单重试：" + String(error), { cause: error });
  } finally {
    for (const entry of run.held.reverse()) if (entry.handle !== parent) await entry.handle.close();
    await parent.close();
  }
}
