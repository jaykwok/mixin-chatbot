// One Durable Harness per group (`GROUP_DATA_ROOT/<groupSegment>/durable.sqlite`), opened paused, as a bounded cache.
//
// A group in use or with durable work stays open; only idle groups beyond `maxIdle` are closed, least recently used
// first. Closing a Harness writes no task outcome (its tasks stay live in storage), but nothing would resume them until
// the group is opened again, so a group with live tasks or unsettled submissions is never evicted, and an eviction that
// races a task the Harness created on its own reopens the group. `discover()` opens every group that has work, so a
// restart resumes all of them, not only the groups the next message happens to reach.
//
// Every connection is tracked from the moment it starts opening until it is closed, so `closeAll()` reaches connections
// still opening, being inspected or prepared, not only cached ones. A database's recorded group is read before a Harness
// opens it, because opening recovers interrupted tasks, which is a write.
//
// Discovery skips only what is known not to exist. Anything else it cannot check (an unreadable path, an I/O error, a
// symbolic link, a database path that is not a file) fails it, so a group with work is never silently left behind.
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel, withoutAbortSignal } from "@earendil-works/chord/context";
import { createSession, Harness, type HarnessOptions, type Storage } from "@earendil-works/pi-durable";
import { assertDataDirectory } from "../../scripts/lib/group-data.ts";
import { groupSegment } from "../agent/paths.ts";
import { claimGroup, databaseGroup } from "./identity.ts";
import { openGroupStorage } from "./sqlite.ts";
import { DurableStorageFailure, guardStorage } from "./storage-failure.ts";

export const GROUP_DATABASE = "durable.sqlite";

export function groupDatabasePath(root: string, groupId: string): string {
  return join(root, groupSegment(groupId), GROUP_DATABASE);
}

const LIVE_TASKS = ["pending", "running", "waiting", "completing"] as const;
const UNSETTLED_SUBMISSIONS = ["queued", "placed"] as const;

/** Live tasks or unsettled submissions in storage; reads only. */
async function storedWork(storage: Storage, context: Context): Promise<boolean> {
  for (const status of LIVE_TASKS) if ((await storage.scanTasks({ status }, 1, undefined, context)).items.length) return true;
  for (const status of UNSETTLED_SUBMISSIONS) if ((await storage.scanSubmissions({ status }, 1, undefined, context)).items.length) return true;
  return false;
}

/** Any record at all; reads only. A database without a recorded group is new only while this is false. */
async function storedData(storage: Storage, context: Context): Promise<boolean> {
  if ((await storage.scanConversations({}, 1, undefined, context)).items.length) return true;
  if ((await storage.scanTasks({}, 1, undefined, context)).items.length) return true;
  if ((await storage.scanSubmissions({}, 1, undefined, context)).items.length) return true;
  return (await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 1, undefined, context)).items.length > 0;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/**
 * The group directories under the root, sorted. A missing root has none; an unsafe or unreadable root, or a symbolic
 * link in it, fails: a group behind it cannot be checked, and the admin tools refuse to follow one too.
 */
async function groupDirectories(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    await assertDataDirectory(root, root);
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const names: string[] = [];
  for (const entry of entries) {
    // Group segments never start with a dot (src/agent/paths.ts); the group root lease directory does.
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error(`群数据根下有符号链接，无法确认其中的群数据库，发现不完整：${join(root, entry.name)}`);
    if (entry.isDirectory()) names.push(entry.name);
  }
  return names.sort();
}

export interface GroupHarnessesOptions {
  root: string;
  /** Options for each Harness opened (a fresh registry and models view per Harness), for the group it serves. */
  harnessOptions: (groupId: string) => HarnessOptions | Promise<HarnessOptions>;
  /**
   * Runs after the group is claimed and before anyone gets the Harness (the startup gate, D3); a throw closes it. Its
   * context is cancelled by `closeAll()`, which closes the Harness without waiting for the callback (see there).
   */
  prepare?: (harness: Harness, groupId: string, context: Context) => Promise<void>;
  /** Durable work of the application that Harness inspection does not show (admissions, outbox; D3). Context as `prepare`. */
  pendingWork?: (harness: Harness, groupId: string, context: Context) => Promise<boolean>;
  /** Idle groups without work kept open; default 16. */
  maxIdle?: number;
  context?: Context;
  /** Failures that do not fail the calling operation (closing an evicted group, a database without a group). */
  onReport?: (error: unknown) => void;
  /** An uncertain storage outcome: synchronously fence the service and let the process owner exit nonzero. */
  onFatal?: (error: DurableStorageFailure) => void;
  /** Every connection closure, including discovery, failed preparation and shutdown; the exact closed instance. */
  onClosed?: (groupId: string, harness?: Harness) => void | Promise<void>;
}

export interface GroupHandle {
  readonly groupId: string;
  readonly harness: Harness;
  /** Idempotent. The group stays open while any handle is held. */
  release(): void;
}

/** One database connection, tracked from before it opens until it is closed. */
type Connection = {
  groupId?: string;
  storage?: Storage;
  harness?: Harness;
  /** The internal step in progress (opening or reading the database, opening the Harness); closing waits for it. */
  step: Promise<unknown>;
  closing?: Promise<void>;
};

type Entry = { groupId: string; connection: Connection; opening: Promise<Harness>; harness?: Harness; users: number; lastUsed: number; closing?: Promise<void> };

/** The group Harness cache of the service (src/durable/service.ts). */
export class GroupHarnesses {
  readonly #options: GroupHarnessesOptions;
  /** Every operation's context; `closeAll()` cancels it. */
  readonly #context: Context;
  readonly #cancel: (reason?: unknown) => void;
  /** Closing is never cut short by a cancelled context: `closeAll()` must not return before the connections are closed. */
  readonly #cleanup: Context;
  readonly #maxIdle: number;
  readonly #entries = new Map<string, Entry>();
  readonly #connections = new Set<Connection>();
  #stopped: Error | undefined;
  #uses = 0;
  #sweeping: Promise<void> = Promise.resolve();
  #discovering: Promise<void> = Promise.resolve();

  constructor(options: GroupHarnessesOptions) {
    this.#options = options;
    const parent = options.context ?? BACKGROUND_CONTEXT;
    const cancellable = withCancel(parent);
    this.#context = cancellable.context;
    this.#cancel = cancellable.cancel;
    this.#cleanup = withoutAbortSignal(parent);
    this.#maxIdle = options.maxIdle ?? 16;
  }

  /** Groups whose Harness is open or opening. */
  get openGroups(): string[] {
    return [...this.#entries.keys()].sort();
  }

  /** The group's Harness, opened (paused) and claimed on first use. Release the handle when done. */
  async acquire(groupId: string): Promise<GroupHandle> {
    // Discovery opens databases before it knows their group; opening the same one here meanwhile would double it.
    await this.#discovering;
    for (;;) {
      this.#assertRunning();
      const entry = this.#entries.get(groupId);
      // A failed close is reported by whoever closed it; this caller only waits to reopen.
      if (entry?.closing) { await entry.closing.catch(() => {}); continue; }
      const current = entry ?? this.#openEntry(groupId);
      current.users++;
      let harness: Harness;
      try {
        harness = await current.opening;
        this.#assertRunning();
      } catch (error) {
        current.users--;
        throw error;
      }
      let released = false;
      return {
        groupId, harness,
        release: () => {
          if (released) return;
          released = true;
          current.users--;
          current.lastUsed = ++this.#uses;
          void this.sweep();
        },
      };
    }
  }

  /**
   * Open every group under the root that has a database with work and keep it open; close the others. Returns the groups
   * left open for work, sorted. A database whose recorded group does not match its directory is refused; one without a
   * recorded group is reported and left alone. Only a database that does not exist is skipped: when the root or a
   * database path cannot be checked, this rejects instead of returning an incomplete list (groups it opened before stay
   * open, closed by `closeAll()`).
   */
  async discover(): Promise<string[]> {
    this.#assertRunning();
    const discovering = this.#discovering.then(() => this.#discover());
    this.#discovering = discovering.then(() => {}, () => {});
    return discovering;
  }

  async #discover(): Promise<string[]> {
    const busy: string[] = [];
    for (const segment of await groupDirectories(this.#options.root)) {
      this.#assertRunning();
      const path = join(this.#options.root, segment, GROUP_DATABASE);
      const info = await lstat(path).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw new Error(`无法确认群数据库是否存在，发现不完整：${path}`, { cause: error });
      });
      if (info === undefined) continue;
      if (!info.isFile()) throw new Error(`群数据库路径不是普通文件，发现不完整：${path}`);
      // Already open through acquire(): never put a second connection on the same database.
      const open = [...this.#entries.values()].find((entry) => groupSegment(entry.groupId) === segment);
      if (open) {
        const harness = await open.opening.catch(() => undefined);
        if (harness !== undefined && open.closing === undefined && await this.#hasWork(harness, open.groupId)) busy.push(open.groupId);
        continue;
      }
      const groupId = await this.#discoverDatabase(path, segment);
      if (groupId !== undefined) busy.push(groupId);
    }
    // A shutdown during the last database must not look like a complete discovery.
    this.#assertRunning();
    return busy.sort();
  }

  /** Close idle groups without work beyond `maxIdle`, least recently used first. */
  sweep(): Promise<void> {
    this.#sweeping = this.#sweeping.then(() => this.#sweep()).catch((error) => this.#options.onReport?.(error));
    return this.#sweeping;
  }

  /**
   * Shutdown: refuse new opens, cancel the context the callbacks received, and close every connection, including those
   * still opening, being inspected or prepared. Returns once each is closed, so no commit can follow it. A commit
   * already admitted settles first: a callback blocked inside a commit holds this until it ends (the service's shutdown
   * deadline bounds that wait); a callback blocked anywhere else does not, its Harness closes and its later commits
   * reject.
   */
  async closeAll(reason = new Error("群存储正在关闭")): Promise<void> {
    this.#stopped ??= reason;
    this.#cancel(this.#stopped);
    const results = await Promise.allSettled([...this.#connections].map((connection) => this.#closeConnection(connection)));
    this.#entries.clear();
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "关闭群存储失败");
  }

  #assertRunning(): void {
    if (this.#stopped) throw this.#stopped;
  }

  #assertOpen(connection: Connection): void {
    if (connection.closing) throw this.#stopped ?? new Error("群数据库连接已关闭");
  }

  /** Track a new connection before anything opens; refused once shutdown has begun. */
  #connect(): Connection {
    this.#assertRunning();
    const connection: Connection = { step: Promise.resolve() };
    this.#connections.add(connection);
    return connection;
  }

  /**
   * Run an internal step of an opening connection. Closing waits for the step to end, so a database is never closed
   * under one; no step starts once closing has begun, and none continues after it.
   */
  async #step<T>(connection: Connection, work: () => Promise<T>): Promise<T> {
    this.#assertOpen(connection);
    const run = work();
    connection.step = run.catch(() => {});
    const result = await run;
    this.#assertOpen(connection);
    return result;
  }

  /** Close a connection after its current step: the Harness if one opened (it closes the storage), else the storage. */
  #closeConnection(connection: Connection): Promise<void> {
    connection.closing ??= (async () => {
      try {
        await connection.step;
        if (connection.harness) await connection.harness.close(this.#cleanup);
        else await connection.storage?.close(this.#cleanup);
      } finally {
        try { if (connection.groupId !== undefined) await this.#options.onClosed?.(connection.groupId, connection.harness); }
        finally { this.#connections.delete(connection); }
      }
    })();
    return connection.closing;
  }

  /** Close a connection after a failure: the failure is what the caller rethrows, a close failure goes to onReport. */
  async #discard(connection: Connection): Promise<void> {
    await this.#closeConnection(connection).catch((error) => this.#options.onReport?.(error));
  }

  async #openStorage(connection: Connection, path: string): Promise<Storage> {
    await this.#step(connection, async () => {
      const storage = await openGroupStorage(path, (error) => this.#fatal(new DurableStorageFailure(path, error)));
      connection.storage = guardStorage(storage, path, (error) => this.#fatal(error));
    });
    return connection.storage!;
  }

  #fatal(error: DurableStorageFailure): void {
    if (this.#stopped) return;
    this.#stopped = error;
    this.#cancel(error);
    try { this.#options.onFatal?.(error); } catch {}
  }

  /** The recorded group, read without a Harness: a bare Session only reads (closing it would close the storage). */
  #recordedGroup(connection: Connection, storage: Storage): Promise<string | undefined> {
    return this.#step(connection, () => databaseGroup(createSession(storage), this.#context));
  }

  /** The options come from the application and may take any time; closing meanwhile closes the database under them. */
  async #openHarness(connection: Connection, groupId: string): Promise<Harness> {
    connection.groupId = groupId;
    const options = await this.#options.harnessOptions(groupId);
    await this.#step(connection, async () => { connection.harness = await Harness.open(connection.storage!, options, this.#context); });
    return connection.harness!;
  }

  #openEntry(groupId: string): Entry {
    const connection = this.#connect();
    return this.#start(groupId, connection, this.#open(groupId, connection));
  }

  #start(groupId: string, connection: Connection, opening: Promise<Harness>): Entry {
    const entry: Entry = { groupId, connection, opening, users: 0, lastUsed: 0 };
    this.#entries.set(groupId, entry);
    opening.then((harness) => { entry.harness = harness; },
      () => { if (this.#entries.get(groupId) === entry) this.#entries.delete(groupId); });
    return entry;
  }

  async #open(groupId: string, connection: Connection): Promise<Harness> {
    const path = groupDatabasePath(this.#options.root, groupId);
    try {
      const storage = await this.#openStorage(connection, path);
      const recorded = await this.#recordedGroup(connection, storage);
      if (recorded !== undefined && recorded !== groupId) throw new Error("群数据库属于另一个群，已拒绝读取和写入");
      // Only a database that holds nothing is new; one with data but no recorded group is refused, never claimed.
      if (recorded === undefined && await this.#step(connection, () => storedData(storage, this.#context))) {
        throw new Error(`群数据库有数据但没有登记群标识，已拒绝读取和写入：${path}`);
      }
      const harness = await this.#openHarness(connection, groupId);
      if (recorded === undefined) await claimGroup(harness, groupId, this.#context);
      await this.#options.prepare?.(harness, groupId, this.#context);
      this.#assertOpen(connection);
      return harness;
    } catch (error) {
      await this.#discard(connection);
      // Once closeAll has begun, a callback failing on its closed Harness is a consequence: report the shutdown.
      throw this.#stopped ?? error;
    }
  }

  /** Open a database found by discovery and keep it open, returning its group, only if it has work. */
  async #discoverDatabase(path: string, segment: string): Promise<string | undefined> {
    const connection = this.#connect();
    let groupId: string | undefined;
    try {
      const storage = await this.#openStorage(connection, path);
      groupId = await this.#recordedGroup(connection, storage);
      if (groupId !== undefined) {
        if (groupSegment(groupId) !== segment) throw new Error(`群数据库登记的群与所在目录不符，已拒绝：${path}`);
        const harness = await this.#openHarness(connection, groupId);
        if (await this.#hasWork(harness, groupId)) {
          this.#assertOpen(connection);
          await this.#options.prepare?.(harness, groupId, this.#context);
          this.#assertOpen(connection);
          this.#start(groupId, connection, Promise.resolve(harness)).lastUsed = ++this.#uses;
          return groupId;
        }
      }
    } catch (error) {
      await this.#discard(connection);
      // Once closeAll has begun, a callback failing on its closed Harness is a consequence: report the shutdown.
      throw this.#stopped ?? error;
    }
    if (groupId === undefined) this.#options.onReport?.(new Error(`群数据库没有登记群标识：${path}`));
    await this.#closeConnection(connection);
    return undefined;
  }

  async #hasWork(harness: Harness, groupId: string): Promise<boolean> {
    const inspection = await harness.inspect(this.#context);
    if (inspection.tasks.length > 0 || inspection.submissions.length > 0) return true;
    return (await this.#options.pendingWork?.(harness, groupId, this.#context)) ?? false;
  }

  async #sweep(): Promise<void> {
    // Most recently used first: the first `maxIdle` idle groups without work stay, the rest close.
    const idle = [...this.#entries.values()]
      .filter((entry) => entry.users === 0 && entry.harness !== undefined && entry.closing === undefined)
      .sort((a, b) => b.lastUsed - a.lastUsed);
    if (idle.length <= this.#maxIdle) return;
    let kept = 0;
    for (const entry of idle) {
      if (this.#stopped) return;
      if (await this.#hasWork(entry.harness!, entry.groupId)) continue;
      // Re-check after the await: a new handle or a shutdown may have arrived meanwhile.
      if (entry.users > 0 || entry.closing !== undefined || this.#stopped) continue;
      if (kept < this.#maxIdle) { kept++; continue; }
      await this.#evict(entry);
    }
  }

  async #evict(entry: Entry): Promise<void> {
    const path = groupDatabasePath(this.#options.root, entry.groupId);
    entry.closing = (async () => {
      try {
        await this.#closeConnection(entry.connection);
        if (this.#stopped) return;
        // The Harness may have created a task on its own (a retry, a compaction) after the check: reopen for it.
        const check = this.#connect();
        let work = false;
        try {
          const storage = await this.#openStorage(check, path);
          work = await this.#step(check, () => storedWork(storage, this.#context));
        } finally { await this.#discard(check); }
        if (work && !this.#stopped) {
          this.#entries.delete(entry.groupId);
          this.#openEntry(entry.groupId).lastUsed = ++this.#uses;
        }
      } catch (error) {
        if (error !== this.#stopped) this.#options.onReport?.(error);
      } finally {
        if (this.#entries.get(entry.groupId) === entry) this.#entries.delete(entry.groupId);
      }
    })();
    return entry.closing;
  }
}
