// Result directories in a member's tmp: the files a tool call hands to the member (codemode's full output and images,
// MCP's large results and images, generated images).
//
// Each call that saves a file gets a directory `codemode/<task>-<call>/` in the calling member's tmp (the root keeps its
// historical name: maintenance, references and existing data all use it), which the member's read tool can open and no
// other member can. Its ownership is committed (./ownership.ts) before the first file becomes visible. A file is written
// to a temporary name, synced and renamed into place, so a path never names a partial file.
//
// Where the files go: the member's own tools (bash) can put links in its tmp, rename directories in it, remove them
// and turn them into links, also while a call writes; read only opens files whose real path is in that tmp. So the
// call directory is held from its first file until the call ends (src/core/held-directory.ts): `codemode/` and the call
// directory are made below the member's tmp through their held parents, a link or junction in their place is refused,
// and every file is created, renamed into place and, after a failure, removed through the held directory, never through
// a path resolved again. A directory swapped for a link meanwhile never receives a file: on Windows the held
// directories cannot be renamed or removed, and one made a junction in place cannot be created in; on Linux the writes
// stay in the moved directory. Temporary files are created new, never through an entry that is already there; a result
// file is renamed over whatever has its name (a link is replaced, not followed).
//
// A path is only given out while it names the file written and is in the member's real tmp, as read requires: the
// directory's path is checked before each write, a file's after it is in place. Once a check finds the directory moved,
// nothing more is written or given out for the call. The output files are checked once more after the last of them
// (`recheck`), and a result names only those still in place. Files are 0600 and directories 0700 (on Windows the mode
// sets only the read-only flag). The member's tmp itself is the member's storage identity, checked by the service.
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPathInside } from "../../contracts/paths.ts";
import { type DirectoryRemoval, type Entries, type HeldDirectory, holdDirectory, type Identity, sameIdentity } from "../../core/held-directory.ts";
import type { IsolatedTask, TaskReservation } from "../../core/rootless-tasks.ts";
import { configuredRootlessTasks } from "../../core/task-backend.ts";

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Directory name of one call: unique per task in the space's database; the call ID made path-safe. */
export function resultsDirName(taskId: number, callId: string): string {
  return `${taskId}-${callId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)}`;
}

/** Whether `name` is a result directory name (`resultsDirName`). */
export function isResultsDirName(name: string): boolean {
  return /^\d+-[A-Za-z0-9_.-]+$/.test(name);
}

/** Results root of a member: the call directories live directly under it. */
export function resultsRoot(tempDir: string): string {
  return join(tempDir, "codemode");
}

function gone(path: string): Error {
  return new Error(`${path} no longer names what this call wrote there (moved or replaced): results are only written inside the caller's tmp`);
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The files of one call in a member's tmp. The directory is created and held with the first file, until `release`. */
export class ResultFiles {
  readonly dir: string;
  #held: Promise<HeldDirectory> | undefined;
  #released = false;
  #releasing: Promise<void> | undefined;
  /** Set when a check found the directory's path no longer naming the held directory: nothing more is written. */
  #lost: Error | undefined;
  /** The output files, by path: checked once more before the result names them. */
  readonly #outputs = new Map<string, Identity>();
  readonly #reservation: TaskReservation | undefined;
  #isolated: IsolatedTask | undefined;

  constructor(private readonly tempDir: string, readonly name: string, private readonly register?: (taskId?: string) => Promise<void>) {
    this.#reservation = configuredRootlessTasks()?.reserve(tempDir, "results", name);
    this.dir = this.#reservation?.path ?? join(resultsRoot(tempDir), name);
  }

  /**
   * Run `work` with the entries of the call directory (held from the first use; a failure to hold it stays), after
   * checking that the directory's path still names it: once it was moved, nothing more is written for this call.
   */
  async #use<T>(work: (entries: Entries) => Promise<T>): Promise<T> {
    if (this.#released) throw new Error("the call's results directory is no longer held");
    this.#held ??= (async () => {
      if (this.#reservation) {
        this.#isolated = await this.#reservation.create();
        await this.register?.(this.#isolated.id);
        return holdDirectory(this.#isolated.path, [], false);
      }
      await this.register?.(); return holdDirectory(this.tempDir, ["codemode", this.name]);
    })();
    const held = await this.#held;
    return held.use(async (entries) => {
      await this.#expectDirectory(held);
      return work(entries);
    });
  }

  /** The directory's path names the held directory, as `codemode/<name>` of the member's real tmp (no link on the way). */
  async #expectDirectory(held: HeldDirectory): Promise<void> {
    if (this.#lost !== undefined) throw this.#lost;
    const tmp = await realpath(this.tempDir).catch(() => undefined);
    const info = await stat(this.dir, { bigint: true }).catch(() => undefined);
    const real = await realpath(this.dir).catch(() => undefined);
    if (tmp === undefined || info === undefined || real === undefined || !sameIdentity(info, held.identity)
      || !samePath(real, this.#reservation ? join(tmp, ".isolated-work", this.#reservation.id, "work") : join(tmp, "codemode", this.name))) {
      this.#lost = gone(this.dir);
      throw this.#lost;
    }
  }

  /** `path`, as given out, names the file written (`identity`), and its real path is in the member's real tmp. */
  async #expectNamed(path: string, identity: Identity): Promise<void> {
    if (this.#lost !== undefined) throw this.#lost;
    const tmp = await realpath(this.tempDir).catch(() => undefined);
    const info = await stat(path, { bigint: true }).catch(() => undefined);
    const real = await realpath(path).catch(() => undefined);
    if (tmp === undefined || info === undefined || real === undefined || !sameIdentity(info, identity) || !isPathInside(real, tmp)) {
      throw gone(path);
    }
  }

  /**
   * After the call's last file: check once more every output file. Returns, by path, why each can no longer be named.
   */
  async recheck(): Promise<Map<string, string>> {
    const stale = new Map<string, string>();
    const held = await this.#held?.catch(() => undefined);
    if (held === undefined) return stale;
    await this.#expectDirectory(held).catch(() => {});
    for (const [path, identity] of this.#outputs) {
      await this.#expectNamed(path, identity).catch((error: Error) => stale.set(path, error.message));
    }
    return stale;
  }

  /** Release the directory after the work running in it; later work fails. Idempotent. */
  release(): Promise<void> {
    this.#releasing ??= (async () => {
      this.#released = true;
      const errors: unknown[] = [];
      const held = await this.#held?.catch(() => undefined);
      await held?.release().catch(error => errors.push(error));
      await this.#isolated?.seal().catch(error => errors.push(error));
      if (errors.length) throw new AggregateError(errors, "结果目录释放失败，保留回执");
    })();
    return this.#releasing;
  }

  /**
   * Save an output file under `name` (a plain file name): new temporary file, sync, rename over the name; all in the
   * held directory. Returns its path, checked to name the file written.
   */
  async saveOutput(name: string, data: Uint8Array): Promise<string> {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(name) || name.startsWith(".") || name.endsWith(".tmp")) throw new Error(`invalid result file name ${JSON.stringify(name)}`);
    return this.#use(async (entries) => {
      const file = await entries.create(`${name}.${randomBytes(6).toString("hex")}.tmp`);
      let placed = false;
      try {
        await file.handle.writeFile(data);
        await file.handle.sync();
        await file.rename(name);
        placed = true;
      } finally {
        await file.close(!placed);
      }
      const path = join(this.dir, name);
      await this.#expectNamed(path, file.identity);
      this.#outputs.set(path, file.identity);
      return path;
    });
  }

  /** Save the full output text as `output.txt`; returns its path. */
  saveOutputText(text: string): Promise<string> {
    return this.saveOutput("output.txt", Buffer.from(text, "utf8"));
  }

  /** Save image `k` of the output as `output-<k>.<ext>`; returns its path. */
  saveOutputImage(k: number, data: Buffer, mimeType: string): Promise<string> {
    return this.saveOutput(`output-${k}.${IMAGE_EXTENSIONS[mimeType] ?? "bin"}`, data);
  }
}

/**
 * Remove a member's result directories last changed before `before` (epoch ms; `Infinity` removes all, for `/clear`).
 * Only directories named like `resultsDirName` directly under the results root; links are not followed. Returns the
 * removed directory names. The service calls it from /clear and the retention sweep (./maintenance.ts), after excluding
 * the directories of calls still running: removing one fails only after some of its files are gone.
 */
export async function removeResultDirectories(tempDir: string, before: number, policy?: {
  registered: ReadonlySet<string>; protected: ReadonlySet<string>; expire(names: string[]): Promise<void>;
  record?(results: DirectoryRemoval[]): Promise<void>;
  isolated?: ReadonlyMap<string, string>;
}): Promise<string[]> {
  const results: DirectoryRemoval[] = [];
  const seen = new Set<string>();
  const backend = configuredRootlessTasks();
  for (const [name, id] of policy?.isolated ?? []) {
    if (!policy!.registered.has(name) || policy!.protected.has(name)) continue;
    try {
      if (!backend) { results.push({ name, status: "deferred", reason: "isolated-backend-unavailable" }); continue; }
      if ((await backend.describe(id, tempDir)).createdAt >= before) continue;
      await policy!.expire([name]);
      results.push({ ...await backend.reclaim(id, tempDir), name });
    } catch (error) { results.push({ name, status: "refused", reason: String(error) }); }
  }
  const finish = async () => {
    if (process.platform === "linux" && policy) for (const name of policy.registered) {
      if (!isResultsDirName(name) || policy.protected.has(name) || policy.isolated?.has(name) || seen.has(name)) continue;
      await policy.expire([name]);
      results.push({ name, status: "deferred", reason: "shared-name-missing-or-unavailable-is-not-removal-proof" });
    }
    await policy?.record?.(results);
    return results.filter(result => result.status === "removed").map(result => result.name);
  };
  let root: HeldDirectory;
  try {
    root = await holdDirectory(tempDir, ["codemode"], false);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return finish();
    throw error;
  }
  try {
    await root.use(async entries => {
      for (const name of await entries.names()) {
        seen.add(name);
        if (!isResultsDirName(name)
          || policy && (!policy.registered.has(name) || policy.protected.has(name) || policy.isolated?.has(name))) continue;
        try {
          results.push(...await entries.removeDirectories({ candidates: [name], select: candidate => candidate === name,
            beforeRemove: async (_name, changedAt) => {
              if (changedAt >= before) return false;
              // Keep expiry commit failures outside the recoverable filesystem-error path.
              await policy?.expire([name]);
              return true;
            } }));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!code || !["EBUSY", "EPERM", "EACCES", "ENOENT", "ENOTDIR", "ENOTEMPTY"].includes(code)) throw error;
          results.push({ name, status: "deferred", reason: String(error) });
        }
      }
    });
    return finish();
  } finally { await root.release(); }
}
