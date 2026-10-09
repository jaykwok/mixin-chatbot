// Durable records of a codemode script's sub-calls (D0 contract 2.8; D2-3 adjustments in docs/dev/pi-1.0.2-d2-3-*.md).
//
// Each codemode call that makes a sub-call gets a directory in the calling member's tmp, `codemode/<task>-<call>/`,
// which the member's read tool can open and no other member can: `index.txt` (one line per sub-call event, appended and
// synced before the event is committed) and the result files. A sub-call's result whose text (or JSON of the
// structured value) exceeds PREVIEW_LIMIT characters is saved whole as `<n>.txt` / `<n>.json`; images as
// `<n>-<i>.<ext>`. `n` is fixed when the sub-call starts, so parallel calls never share a file. The script's own output
// goes to the same directory: its full text when it exceeds the output budget (`output.txt`), and each distinct image
// it showed with `image()` (`output-<k>.<ext>`; coding-agent 1.0.3 saves them so the model can reach their bytes). A
// call with neither sub-calls nor such output has no directory. A file is written to a
// temporary name, synced and renamed into place, so a reference never names a partial file; references carry the size
// and a sha256 prefix, so a reader can tell whether the file still holds that result.
//
// Where the files go: the member's own tools (bash) can put links in its tmp, rename directories in it, remove them
// and turn them into links, also while a call writes; read only opens files whose real path is in that tmp. So the
// call directory is held from its first file until the call ends (./directory.ts): `codemode/` and the call directory
// are made below the member's tmp through their held parents, a link or junction in their place is refused, and every
// file is created, renamed into place and, after a failure, removed through the held directory, never through a path
// resolved again (D23-R2-1). A directory swapped for a link meanwhile never receives a file: on Windows the held
// directories cannot be renamed or removed, and one made a junction in place cannot be created in; on Linux the writes
// stay in the moved directory. The index and temporary files are created new, never through an entry that is already
// there; a result file is renamed over whatever has its name (a link is replaced, not followed).
//
// A path is only given out (in a reference, the details or an index line's commit) while it names the file written
// and is in the member's real tmp, as read requires (D23-R3-3): the directory's path is checked before each write, a
// file's after it is in place, the index's after each line. Once a check finds the directory moved, nothing more is
// written or given out for the call: its result no longer names the index. The script's own output files are checked
// once more after the last of them, and a result names only those still in place (D23-R3-2). Files are 0600 and
// directories 0700 (as coding-agent 1.0.3 writes its output files; on Windows the mode sets only the read-only flag).
// The member's tmp itself is the member's storage identity, checked by the service (D3).
//
// The model-visible line of a finished sub-call (also the index line): its whole result up to PREVIEW_LIMIT
// characters, or a preview with the file of the full text; image files at the end.
import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { isPathInside } from "../../agent/paths.ts";
import { type Entries, type HeldDirectory, holdDirectory, type Identity, type NewFile, sameIdentity } from "./directory.ts";
import type { DirectoryRemoval } from "../../core/held-directory.ts";
import { configuredRootlessTasks, type IsolatedTask, type TaskReservation } from "../../core/rootless-tasks.ts";

export const PREVIEW_LIMIT = 300;
/** sha256 hex characters shown in references. */
const HASH_PREFIX = 16;

export type ResultFile = { path: string; sha256: string; bytes: number; mimeType: string };
/** A value handed to a script: its length, the first PREVIEW_LIMIT characters and the files holding the rest. */
export type SubCallResult = { chars: number; preview: string; files: ResultFile[] };

const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Directory name of one codemode call: unique per task in the group's database; the call ID made path-safe. */
export function resultsDirName(taskId: number, callId: string): string {
  return `${taskId}-${callId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80)}`;
}

/** Results root of a member: codemode call directories live directly under it. */
export function resultsRoot(tempDir: string): string {
  return join(tempDir, "codemode");
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function gone(path: string): Error {
  return new Error(`${path} no longer names what this call wrote there (moved or replaced): results are only written inside the caller's tmp`);
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The files and index of one codemode call in a member's tmp. The directory is created and held with the first index
 * or file, until `release`.
 */
export class SubCallFiles {
  readonly dir: string;
  readonly index: string;
  #held: Promise<HeldDirectory> | undefined;
  #released = false;
  #releasing: Promise<void> | undefined;
  #index: Promise<NewFile> | undefined;
  /** Index writes in call order; each line is synced before its append resolves. */
  #appends: Promise<unknown> = Promise.resolve();
  #indexClosed = false;
  #closingIndex: Promise<void> | undefined;
  #indexLost = false;
  /** Set when a check found the directory's path no longer naming the held directory: nothing more is written. */
  #lost: Error | undefined;
  /** The script's own output files, by path: checked once more before the result names them. */
  readonly #outputs = new Map<string, Identity>();
  readonly #reservation: TaskReservation | undefined;
  #isolated: IsolatedTask | undefined;

  constructor(private readonly tempDir: string, private readonly name: string, private readonly register?: (taskId?: string) => Promise<void>) {
    this.#reservation = configuredRootlessTasks()?.reserve(tempDir, "results");
    this.dir = this.#reservation?.path ?? join(resultsRoot(tempDir), name);
    this.index = join(this.dir, "index.txt");
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

  /** Create the directory and a new index with its first line, and keep it open. Idempotent; a failure stays. */
  open(header: string): Promise<void> {
    this.#index ??= this.#use(async (entries) => {
      const file = await entries.create("index.txt", true);
      try {
        // writeFile writes the whole line (write may write part of it); the handle appends.
        await file.handle.writeFile(`${header}\n`);
        await file.handle.sync();
        await this.#expectIndex(file.identity);
        return file;
      } catch (error) {
        await file.close();
        throw error;
      }
    });
    return this.#index.then(() => undefined);
  }

  /** Append one line to the index (opened first), sync it, and check that the index path still names the file. */
  append(line: string): Promise<void> {
    const index = this.#index;
    if (index === undefined) return Promise.reject(new Error("the sub-call index is not open"));
    if (this.#indexClosed) return Promise.reject(new Error("the sub-call index is closed"));
    const appended = this.#appends.then(async () => {
      const file = await index;
      await file.handle.writeFile(`${line}\n`);
      await file.handle.sync();
      await this.#expectIndex(file.identity);
    });
    this.#appends = appended.catch(() => {});
    return appended;
  }

  /** The index path no longer names the index, or the directory was found moved: a result must not name it. */
  get indexLost(): boolean {
    return this.#indexLost || this.#lost !== undefined;
  }

  async #expectIndex(identity: Identity): Promise<void> {
    try {
      await this.#expectNamed(this.index, identity);
    } catch (error) {
      this.#indexLost = true;
      throw error;
    }
  }

  /**
   * Close the index after the appends already made, checking once more that its path names it; later appends fail.
   * Idempotent.
   */
  closeIndex(): Promise<void> {
    this.#closingIndex ??= (async () => {
      this.#indexClosed = true;
      await this.#appends;
      const file = await this.#index?.catch(() => undefined);
      if (file === undefined) return;
      await file.close();
      await this.#expectIndex(file.identity).catch(() => {});
    })();
    return this.#closingIndex;
  }

  /**
   * After the call's last file: check once more every path its result would give, the index and the script's own
   * output files. Returns, by path, why each output file can no longer be named; the index is left out of the result
   * through `indexLost`. Checking is separate from closing: it runs whether or not the index was closed.
   */
  async recheck(): Promise<Map<string, string>> {
    const stale = new Map<string, string>();
    const held = await this.#held?.catch(() => undefined);
    if (held === undefined) return stale;
    await this.#expectDirectory(held).catch(() => {});
    const index = await this.#index?.catch(() => undefined);
    if (index !== undefined) await this.#expectIndex(index.identity).catch(() => {});
    for (const [path, identity] of this.#outputs) {
      await this.#expectNamed(path, identity).catch((error: Error) => stale.set(path, error.message));
    }
    return stale;
  }

  /** Close the index and release the directory after the work running in it; later work fails. Idempotent. */
  release(): Promise<void> {
    this.#releasing ??= (async () => {
      this.#released = true;
      const errors: unknown[] = [];
      await this.closeIndex().catch(error => errors.push(error));
      const held = await this.#held?.catch(() => undefined);
      await held?.release().catch(error => errors.push(error));
      await this.#isolated?.seal().catch(error => errors.push(error));
      if (errors.length) throw new AggregateError(errors, "结果目录释放失败，保留回执");
    })();
    return this.#releasing;
  }

  /** Save a result file under `name`: new temporary file, sync, rename over the name; all in the held directory. */
  async save(name: string, data: Buffer, mimeType: string): Promise<ResultFile> {
    return (await this.#save(name, data, mimeType)).file;
  }

  async #save(name: string, data: Buffer, mimeType: string): Promise<{ file: ResultFile; identity: Identity }> {
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
      return { file: { path, sha256: digest(data), bytes: data.length, mimeType }, identity: file.identity };
    });
  }

  /** Save the script's full output text as `output.txt`; returns its path. */
  saveOutputText(text: string): Promise<string> {
    return this.#saveOutput("output.txt", Buffer.from(text, "utf8"), "text/plain");
  }

  /** Save image `k` of the script's own output as `output-<k>.<ext>`; returns its path. */
  saveOutputImage(k: number, data: Buffer, mimeType: string): Promise<string> {
    return this.#saveOutput(`output-${k}.${IMAGE_EXTENSIONS[mimeType] ?? "bin"}`, data, mimeType);
  }

  async #saveOutput(name: string, data: Buffer, mimeType: string): Promise<string> {
    const { file, identity } = await this.#save(name, data, mimeType);
    this.#outputs.set(file.path, identity);
    return file.path;
  }

  /**
   * Bound the value a script receives from sub-call `n`: its full text (a structured value as JSON) is saved when longer
   * than PREVIEW_LIMIT characters; images are always saved.
   */
  async bound(n: number, text: string, structured: boolean, images: readonly ImageContent[]): Promise<SubCallResult> {
    const files: ResultFile[] = [];
    if (text.length > PREVIEW_LIMIT) {
      files.push(await this.save(`${n}.${structured ? "json" : "txt"}`, Buffer.from(text, "utf8"), structured ? "application/json" : "text/plain"));
    }
    for (const [index, image] of images.entries()) {
      const extension = IMAGE_EXTENSIONS[image.mimeType] ?? "bin";
      files.push(await this.save(`${n}-${index + 1}.${extension}`, Buffer.from(image.data, "base64"), image.mimeType));
    }
    return { chars: text.length, preview: text.slice(0, PREVIEW_LIMIT), files };
  }
}

function reference(file: ResultFile): string {
  return `[${file.mimeType} ${file.bytes} B: ${file.path} sha256:${file.sha256.slice(0, HASH_PREFIX)}]`;
}

/** ` -> <value>` for a line: the whole value, or a preview and the file with the full text; then the image files. */
export function describeResult(result: SubCallResult): string {
  const spilled = result.chars > PREVIEW_LIMIT;
  const textFile = spilled ? result.files[0] : undefined;
  const images = spilled ? result.files.slice(1) : result.files;
  const body = textFile === undefined
    ? ` -> ${JSON.stringify(result.preview)}`
    : ` -> ${JSON.stringify(`${result.preview}…`)} (first ${PREVIEW_LIMIT} of ${result.chars} characters; full text: ${reference(textFile)})`;
  return `${body}${images.map((file) => ` ${reference(file)}`).join("")}`;
}

/**
 * Remove a member's codemode call directories last changed before `before` (epoch ms; `Infinity` removes all, for
 * `/clear`). Only directories named like `resultsDirName` directly under the results root; links are not followed.
 * Returns the removed directory names.
 * The service calls it from /clear and the retention sweep (src/durable/service.ts), after excluding the directories of calls
 * still running: removing one fails only after some of its files are gone.
 */
export async function removeCodemodeResults(tempDir: string, before: number, policy?: {
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
      if (!/^\d+-[A-Za-z0-9_.-]+$/.test(name) || policy.protected.has(name) || policy.isolated?.has(name) || seen.has(name)) continue;
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
    results.push(...await root.use((entries) => entries.removeDirectories({
      select: (name) => {
        seen.add(name);
        return /^\d+-[A-Za-z0-9_.-]+$/.test(name)
          && (!policy || policy.registered.has(name) && !policy.protected.has(name) && !policy.isolated?.has(name));
      },
      beforeRemove: async (name, changedAt) => {
        if (changedAt >= before) return false;
        // The child stays held across the expiry commit and deletion, even if its path changes in the meantime.
        await policy?.expire([name]);
        return true;
      },
    })));
    return finish();
  } finally { await root.release(); }
}
