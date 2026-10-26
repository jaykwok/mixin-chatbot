// One Durable Harness per space, opened paused, as a bounded cache: all direct chats share
// `data/conversations/direct/durable.sqlite`, each group has `data/conversations/groups/<groupSegment>/durable.sqlite`.
//
// A space in use or with durable work stays open; only idle spaces beyond `maxIdle` are closed, least recently used
// first. Closing a Harness writes no task outcome (its tasks stay live in storage), but nothing would resume them until
// the space is opened again, so a space with live tasks or unsettled submissions is never evicted, and an eviction that
// races a task the Harness created on its own reopens the space. `discover()` opens every space that has work, so a
// restart resumes all of them, not only the spaces the next message happens to reach.
//
// Every connection is tracked from the moment it starts opening until it is closed, so `closeAll()` reaches connections
// still opening, being inspected or prepared, not only cached ones. A database's recorded space is read before a Harness
// opens it, because opening recovers interrupted tasks, which is a write.
//
// Discovery skips only what is known not to exist. Anything else it cannot check (an unreadable path, an I/O error, a
// symbolic link, a database path that is not a file) fails it, so a space with work is never silently left behind.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel, withoutAbortSignal } from "@earendil-works/chord/context";
import { createSession, Harness, type HarnessOptions, type Storage } from "@earendil-works/pi-durable";
import { scopeKey, spaceDatabase, spacePath, type Layout, type Scope } from "../core/layout.ts";
import { claimSpace, databaseSpace } from "./identity.ts";
import { missing, spaceDirectories } from "./space-databases.ts";
import { openGroupStorage } from "./sqlite.ts";
import { DurableStorageFailure, guardStorage } from "./storage-failure.ts";
import { LIVE_TASK_STATES } from "./task-states.ts";

const UNSETTLED_SUBMISSIONS = ["queued", "placed"] as const;

/** Live tasks or unsettled submissions in storage; reads only. */
async function storedWork(storage: Storage, context: Context): Promise<boolean> {
  for (const status of LIVE_TASK_STATES) if ((await storage.scanTasks({ status }, 1, undefined, context)).items.length) return true;
  for (const status of UNSETTLED_SUBMISSIONS) if ((await storage.scanSubmissions({ status }, 1, undefined, context)).items.length) return true;
  return false;
}

/** Any record at all; reads only. A database without a recorded space is new only while this is false. */
async function storedData(storage: Storage, context: Context): Promise<boolean> {
  if ((await storage.scanConversations({}, 1, undefined, context)).items.length) return true;
  if ((await storage.scanTasks({}, 1, undefined, context)).items.length) return true;
  if ((await storage.scanSubmissions({}, 1, undefined, context)).items.length) return true;
  return (await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 1, undefined, context)).items.length > 0;
}

/**
 * The error that failed the Harness's Session, if one did. pi-durable (since 1.2.0, rechecked on 1.4.0) marks `failure` internal on the Session but
 * documents it as what close listeners read when a failure closes the Session (session.d.ts `fail`, `subscribeClose`);
 * the fail-stop test in tests/durable/spaces.test.ts depends on it.
 */
function sessionFailure(harness: Harness): { readonly error: unknown } | undefined {
  return (harness as unknown as { readonly failure?: { readonly error: unknown } }).failure;
}

export interface SpaceHarnessesOptions {
  layout: Pick<Layout, "conversations">;
  /** Options for each Harness opened (a fresh registry and models view per Harness), for the space it serves. */
  harnessOptions: (scope: Scope) => HarnessOptions | Promise<HarnessOptions>;
  /**
   * Runs after the space is claimed and before anyone gets the Harness; a throw closes it. Its
   * context is cancelled by `closeAll()`, which closes the Harness without waiting for the callback (see there).
   */
  prepare?: (harness: Harness, scope: Scope, context: Context) => Promise<void>;
  /** Durable work that Harness inspection does not show (admissions, outbox). Context as `prepare`. */
  pendingWork?: (harness: Harness, scope: Scope, context: Context) => Promise<boolean>;
  /** Idle spaces without work kept open; default 16. */
  maxIdle?: number;
  context?: Context;
  /** Failures that do not fail the calling operation (closing an evicted space, a database without a space). */
  onReport?: (error: unknown) => void;
  /** An uncertain storage outcome: synchronously fence the service and let the process owner exit nonzero. */
  onFatal?: (error: DurableStorageFailure) => void;
  /** Every connection closure, including discovery, failed preparation and shutdown; the exact closed instance. */
  onClosed?: (scope: Scope, harness?: Harness) => void | Promise<void>;
}

export interface SpaceHandle {
  readonly scope: Scope;
  readonly harness: Harness;
  /** Idempotent. The space stays open while any handle is held. */
  release(): void;
}

/** One database connection, tracked from before it opens until it is closed. */
type Connection = {
  scope?: Scope;
  storage?: Storage;
  /** The database file, once opening began. */
  path?: string;
  harness?: Harness;
  /** The internal step in progress (opening or reading the database, opening the Harness); closing waits for it. */
  step: Promise<unknown>;
  closing?: Promise<void>;
};

type Entry = { scope: Scope; connection: Connection; opening: Promise<Harness>; harness?: Harness; users: number; lastUsed: number; closing?: Promise<void> };

/** The space Harness cache of the service (src/durable/service.ts). Entries are keyed by `scopeKey`. */
export class SpaceHarnesses {
  readonly #options: SpaceHarnessesOptions;
  /** Every operation's context; `closeAll()` cancels it. */
  readonly #context: Context;
  readonly #cancel: (reason?: unknown) => void;
  /** Closing is never cut short by a cancelled context: `closeAll()` must not return before the connections are closed. */
  readonly #cleanup: Context;
  readonly #maxIdle: number;
  readonly #entries = new Map<string, Entry>();
  readonly #known = new Map<string, Scope>();
  readonly #connections = new Set<Connection>();
  #stopped: Error | undefined;
  #uses = 0;
  #sweeping: Promise<void> = Promise.resolve();
  #discovering: Promise<void> = Promise.resolve();

  constructor(options: SpaceHarnessesOptions) {
    this.#options = options;
    const parent = options.context ?? BACKGROUND_CONTEXT;
    const cancellable = withCancel(parent);
    this.#context = cancellable.context;
    this.#cancel = cancellable.cancel;
    this.#cleanup = withoutAbortSignal(parent);
    this.#maxIdle = options.maxIdle ?? 16;
  }

  /** Keys (`scopeKey`) of the spaces whose Harness is open or opening, sorted. */
  get openSpaces(): string[] {
    return [...this.#entries.keys()].sort();
  }

  /** Validated identities survive connection eviction, so cold spaces still receive maintenance. Sorted by key. */
  get knownSpaces(): Scope[] { return [...this.#known.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, scope]) => scope); }

  /** The space's Harness, opened (paused) and claimed on first use. Release the handle when done. */
  async acquire(scope: Scope): Promise<SpaceHandle> {
    // Discovery opens databases before it knows their space; opening the same one here meanwhile would double it.
    await this.#discovering;
    const key = scopeKey(scope);
    for (;;) {
      this.#assertRunning();
      const entry = this.#entries.get(key);
      // A failed close is reported by whoever closed it; this caller only waits to reopen.
      if (entry?.closing) { await entry.closing.catch(() => {}); continue; }
      const current = entry ?? this.#openEntry(scope);
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
        scope: current.scope, harness,
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
   * Open every space under the conversations root that has a database with work and keep it open; close the others.
   * Returns the spaces left open for work, sorted by key. A database whose recorded space does not match its directory
   * is refused; one without a recorded space is reported and left alone. Only a database that does not exist is skipped:
   * when the root or a database path cannot be checked, this rejects instead of returning an incomplete list (spaces it
   * opened before stay open, closed by `closeAll()`).
   */
  async discover(): Promise<Scope[]> {
    this.#assertRunning();
    const discovering = this.#discovering.then(() => this.#discover());
    this.#discovering = discovering.then(() => {}, () => {});
    return discovering;
  }

  async #discover(): Promise<Scope[]> {
    const busy: Scope[] = [];
    const root = this.#options.layout.conversations;
    for (const directory of await spaceDirectories(root)) {
      this.#assertRunning();
      const path = join(root, directory, "durable.sqlite");
      const info = await lstat(path).catch((error: unknown) => {
        if (missing(error)) return undefined;
        throw new Error(`无法确认会话库是否存在，发现不完整：${path}`, { cause: error });
      });
      if (info === undefined) continue;
      if (!info.isFile()) throw new Error(`会话库路径不是普通文件，发现不完整：${path}`);
      // Already open through acquire(): never put a second connection on the same database.
      const open = [...this.#entries.values()].find((entry) => spacePath(entry.scope) === directory);
      if (open) {
        const harness = await open.opening.catch(() => undefined);
        if (harness !== undefined && open.closing === undefined && await this.#hasWork(harness, open.scope)) busy.push(open.scope);
        continue;
      }
      const scope = await this.#discoverDatabase(path, directory);
      if (scope !== undefined) busy.push(scope);
    }
    // A shutdown during the last database must not look like a complete discovery.
    this.#assertRunning();
    return busy.sort((a, b) => scopeKey(a) < scopeKey(b) ? -1 : 1);
  }

  /** Close idle spaces without work beyond `maxIdle`, least recently used first. */
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
  async closeAll(reason = new Error("会话存储正在关闭")): Promise<void> {
    this.#stopped ??= reason;
    this.#cancel(this.#stopped);
    const results = await Promise.allSettled([...this.#connections].map((connection) => this.#closeConnection(connection)));
    this.#entries.clear();
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "关闭会话存储失败");
  }

  #assertRunning(): void {
    if (this.#stopped) throw this.#stopped;
  }

  #assertOpen(connection: Connection): void {
    if (connection.closing) throw this.#stopped ?? new Error("会话库连接已关闭");
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
        try { if (connection.scope !== undefined) await this.#options.onClosed?.(connection.scope, connection.harness); }
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
    connection.path = path;
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

  /**
   * The recorded space, read without a Harness: a bare Session only reads (closing it would close the storage). It is
   * never closed, so it keeps no document: with the default retention (ten minutes since pi-durable 1.2.0, rechecked on 1.4.0) its eviction
   * timer would hold the Session, and through the storage's failure callback the evicted Harness.
   */
  #recordedSpace(connection: Connection, storage: Storage): Promise<Scope | undefined> {
    return this.#step(connection, () => databaseSpace(createSession(storage, { documentRetentionMs: 0 }), this.#context));
  }

  /** The options come from the application and may take any time; closing meanwhile closes the database under them. */
  async #openHarness(connection: Connection, scope: Scope): Promise<Harness> {
    connection.scope = scope;
    const options = await this.#options.harnessOptions(scope);
    await this.#step(connection, async () => { connection.harness = await Harness.open(connection.storage!, options, this.#context); });
    // A Session that failed (a storage error, or a throw in the Harness's own bookkeeping) never runs or commits again:
    // the process stops, as for a storage failure the guard saw first (./storage-failure.ts). The stop is decided when
    // the failure closes the Session (its close listeners run synchronously, the failure already set), not when `closed`
    // settles: that waits for the running tools to end, which may take any time, and meanwhile other spaces would open.
    // `closed` still reports a failure that comes later, such as a Storage that cannot close.
    const harness = connection.harness!;
    const path = connection.path ?? scopeKey(scope);
    const failed = (error: unknown) => this.#fatal(new DurableStorageFailure(path, error, "session"));
    harness.subscribeClose(() => {
      const failure = sessionFailure(harness);
      if (failure !== undefined) failed(failure.error);
    });
    void harness.closed.then((end) => { if (end.reason === "failed") failed(end.error); }, () => {});
    return harness;
  }

  #openEntry(scope: Scope): Entry {
    const connection = this.#connect();
    return this.#start(scope, connection, this.#open(scope, connection));
  }

  #start(scope: Scope, connection: Connection, opening: Promise<Harness>): Entry {
    const key = scopeKey(scope);
    const entry: Entry = { scope, connection, opening, users: 0, lastUsed: 0 };
    this.#entries.set(key, entry);
    opening.then((harness) => { entry.harness = harness; },
      () => { if (this.#entries.get(key) === entry) this.#entries.delete(key); });
    return entry;
  }

  async #open(scope: Scope, connection: Connection): Promise<Harness> {
    const path = spaceDatabase(this.#options.layout, scope);
    try {
      const storage = await this.#openStorage(connection, path);
      const recorded = await this.#recordedSpace(connection, storage);
      if (recorded !== undefined && scopeKey(recorded) !== scopeKey(scope)) throw new Error("会话库属于另一个空间，已拒绝读取和写入");
      // Only a database that holds nothing is new; one with data but no recorded space is refused, never claimed.
      if (recorded === undefined && await this.#step(connection, () => storedData(storage, this.#context))) {
        throw new Error(`会话库有数据但没有登记空间，已拒绝读取和写入：${path}`);
      }
      const harness = await this.#openHarness(connection, scope);
      if (recorded === undefined) await claimSpace(harness, scope, this.#context);
      this.#known.set(scopeKey(scope), scope);
      await this.#options.prepare?.(harness, scope, this.#context);
      this.#assertOpen(connection);
      return harness;
    } catch (error) {
      await this.#discard(connection);
      // Once closeAll has begun, a callback failing on its closed Harness is a consequence: report the shutdown.
      throw this.#stopped ?? error;
    }
  }

  /** Open a database found by discovery and keep it open, returning its space, only if it has work. */
  async #discoverDatabase(path: string, directory: string): Promise<Scope | undefined> {
    const connection = this.#connect();
    let scope: Scope | undefined;
    try {
      const storage = await this.#openStorage(connection, path);
      scope = await this.#recordedSpace(connection, storage);
      if (scope !== undefined) {
        if (spacePath(scope) !== directory) throw new Error(`会话库登记的空间与所在目录不符，已拒绝：${path}`);
        this.#known.set(scopeKey(scope), scope);
        const harness = await this.#openHarness(connection, scope);
        if (await this.#hasWork(harness, scope)) {
          this.#assertOpen(connection);
          await this.#options.prepare?.(harness, scope, this.#context);
          this.#assertOpen(connection);
          this.#start(scope, connection, Promise.resolve(harness)).lastUsed = ++this.#uses;
          return scope;
        }
      }
    } catch (error) {
      await this.#discard(connection);
      // Once closeAll has begun, a callback failing on its closed Harness is a consequence: report the shutdown.
      throw this.#stopped ?? error;
    }
    if (scope === undefined) this.#options.onReport?.(new Error(`会话库没有登记空间：${path}`));
    await this.#closeConnection(connection);
    return undefined;
  }

  async #hasWork(harness: Harness, scope: Scope): Promise<boolean> {
    const inspection = await harness.inspect(this.#context);
    if (inspection.tasks.length > 0 || inspection.submissions.length > 0) return true;
    return (await this.#options.pendingWork?.(harness, scope, this.#context)) ?? false;
  }

  async #sweep(): Promise<void> {
    // Most recently used first: the first `maxIdle` idle spaces without work stay, the rest close.
    const idle = [...this.#entries.values()]
      .filter((entry) => entry.users === 0 && entry.harness !== undefined && entry.closing === undefined)
      .sort((a, b) => b.lastUsed - a.lastUsed);
    if (idle.length <= this.#maxIdle) return;
    let kept = 0;
    for (const entry of idle) {
      if (this.#stopped) return;
      if (await this.#hasWork(entry.harness!, entry.scope)) continue;
      // Re-check after the await: a new handle or a shutdown may have arrived meanwhile.
      if (entry.users > 0 || entry.closing !== undefined || this.#stopped) continue;
      if (kept < this.#maxIdle) { kept++; continue; }
      await this.#evict(entry);
    }
  }

  async #evict(entry: Entry): Promise<void> {
    const path = spaceDatabase(this.#options.layout, entry.scope), key = scopeKey(entry.scope);
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
          this.#entries.delete(key);
          const reopened = this.#openEntry(entry.scope);
          reopened.lastUsed = ++this.#uses;
          await reopened.opening;
        }
      } catch (error) {
        if (error !== this.#stopped) this.#options.onReport?.(error);
      } finally {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
      }
    })();
    return entry.closing;
  }
}
