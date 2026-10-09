// A directory held while a codemode call writes in it, so that a change of its path cannot send the writes elsewhere
// (D23-R2-1). A process with the member's file-system rights (its own bash) may rename the directory, or one above
// it, remove it, or turn it into a link in place, and a path resolved after that leads wherever the link points. So
// each directory below the base is made and opened through its held parent, and every file is created, renamed and
// removed through the held directory, never through a path resolved again:
//
// - Linux: each directory is open (O_DIRECTORY; a link as the last component is refused), and its entries are reached
//   as /proc/self/fd/<fd>/<name>, which the kernel resolves through the open directory wherever it now is. After a swap
//   the files go on into the moved directory, never into the link's target. Without /proc nothing is held.
// - Windows: Bun opens files and directories sharing delete access and resolves the whole path on every call. So the
//   base is opened with kernel32 CreateFileW, and each directory below it and each file with ntdll NtCreateFile relative
//   to its parent's handle; no handle shares delete access, and a reparse point is opened as itself and refused. While
//   they are open, none of them can be renamed or removed. An empty held directory can still be made a junction in
//   place (FSCTL_SET_REPARSE_POINT needs only FILE_WRITE_ATTRIBUTES, which no share mode denies): a create relative to
//   it then fails (STATUS_REPARSE_POINT_NOT_RESOLVED), and once it holds a file of the call it cannot be
//   (ERROR_DIR_NOT_EMPTY). The writes and syncs go through a Bun handle opened by the file's path while the file is
//   held, without creating, after checking that it is the file created (volume and file index): Bun's own I/O is
//   asynchronous, a write or flush through the system handle would stop the service's thread. Renames and removals go
//   through the handle that created it.
// Other platforms have neither and are refused.
//
// Errors name entries by their path below the base, not by /proc/self/fd or a handle. A directory is released only
// after the operations running through it: a closed descriptor's number is reused, and /proc/self/fd/<fd> would then
// name another file. A handle or descriptor is owned from the moment it is open, before any check of it, so a failure
// anywhere while holding closes every one opened so far (D23-R4-1: a failed metadata read used to leave one open).
import { ptr } from "bun:ffi";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { finishWindows, type WindowsHandle, WindowsHandles } from "./windows-handles.ts";
import type { RemovalPermit } from "./reclamation.ts";

/** Device and inode (Windows: volume serial and file index) as Bun reports them with `bigint: true`. */
export type Identity = { dev: bigint; ino: bigint };

export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const REFUSED = "results are only written inside the caller's tmp";

/** A file created new in a held directory and open for writing. */
export interface NewFile {
  /** Writes and syncs go through it. */
  readonly handle: FileHandle;
  readonly identity: Identity;
  /** Rename it within its directory over whatever has `name` (a link there is replaced, not followed). */
  rename(name: string): Promise<void>;
  /** Close it; `remove` (after a failure) removes it first, best effort. Idempotent. */
  close(remove?: boolean): Promise<void>;
}

/** The entries of a held directory, reached through it. */
export interface Entries {
  /** Read a regular file through this held entity; refuse links. Missing means undefined. */
  read(name: string): Promise<string | undefined>;
  names(): Promise<string[]>;
  /** Create `name` new (0600) and open it for writing; with `append`, every write goes to its end. */
  create(name: string, append?: boolean): Promise<NewFile>;
  /** Hold each selected child before checking its age/committing expiry, then remove it without following links. */
  removeDirectories(policy: RemovalPolicy): Promise<DirectoryRemoval[]>;
}

export interface DirectoryRemoval {
  name: string; status: "removed" | "deferred" | "refused";
  identity?: { dev: string; ino: string }; reason?: string;
}
type RemovalPolicy = {
  /** Keep the caller's recovery record if the held root was moved and cannot be unlinked by its original entry. */
  requireRemoval?: boolean;
  /** Only the isolated management backend issues this after all writers have exited. Never inferred from mode 0700. */
  permit?: RemovalPermit;
  select(name: string): boolean;
  beforeRemove(name: string, changedAt: number, entries: Pick<Entries, "read" | "names">, identity: Identity): Promise<boolean>;
};

/** A directory held open; `use` gives its entries. */
export class HeldDirectory {
  #users = 0;
  #idle: (() => void) | undefined;
  #released = false;
  #releasing: Promise<void> | undefined;

  constructor(
    readonly identity: Identity,
    private readonly entries: Entries,
    private readonly close: () => Promise<void>,
  ) {}

  /** Run `work` with the entries of this directory; fails once the directory is released. */
  async use<T>(work: (entries: Entries) => Promise<T>): Promise<T> {
    if (this.#released) throw new Error("the call's results directory is no longer held");
    this.#users++;
    try {
      return await work(this.entries);
    } finally {
      if (--this.#users === 0) this.#idle?.();
    }
  }

  /** Release the directory after the running `use`s; later ones fail. Idempotent. */
  release(): Promise<void> {
    this.#releasing ??= (async () => {
      this.#released = true;
      if (this.#users > 0) await new Promise<void>((resolve) => { this.#idle = resolve; });
      await this.close();
    })();
    return this.#releasing;
  }
}

/**
 * Hold `base` (as its path resolves now; the member's tmp, whose identity the service checks) and below it each of
 * `names` in turn, made a directory (0700) if missing. A link or a non-directory in place of one of `names` is refused.
 * Returns the last directory, held. With `create = false`, every directory must already exist.
 */
export async function holdDirectory(base: string, names: readonly string[], create = true, windows = defaultWindows): Promise<HeldDirectory> {
  if (process.platform === "linux") return holdLinux(base, names, create);
  if (process.platform === "win32") return holdWindows(base, names, create, windows);
  throw new Error(`codemode result files need Linux or Windows, not ${process.platform}`);
}

function refused(path: string, why: string): Error {
  return Object.assign(new Error(`${path} ${why}: ${REFUSED}`), { code: "ENOTDIR" });
}

/** Doing `what` (naming entries by their paths below the base) failed with `code`; the cause keeps the original. */
function failed(what: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(`could not ${what}: ${code}`, { cause }), { code });
}

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
}

// Linux.

async function holdLinux(base: string, names: readonly string[], create: boolean): Promise<HeldDirectory> {
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = constants;
  let held: FileHandle = await open(base, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  let path = base;
  try {
    // Every entry is reached through /proc/self/fd: without it nothing can be written where it was checked.
    const [own, named] = await Promise.all([held.stat({ bigint: true }), stat(`/proc/self/fd/${held.fd}`, { bigint: true }).catch(() => undefined)]);
    if (named === undefined || !sameIdentity(own, named)) {
      throw new Error(`codemode result files need /proc mounted (procfs): /proc/self/fd does not name the open directory ${base}`);
    }
    for (const name of names) {
      path = join(path, name);
      const child = `/proc/self/fd/${held.fd}/${name}`;
      if (create) await mkdir(child, { mode: DIR_MODE }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw failed(`make directory ${path}`, codeOf(error), error);
      });
      const next = await open(child, O_RDONLY | O_DIRECTORY | O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
        // A symbolic link as the last component: ELOOP, or ENOTDIR with O_DIRECTORY.
        if (error.code === "ELOOP" || error.code === "ENOTDIR") throw refused(path, "is a link or not a directory");
        throw failed(`open directory ${path}`, codeOf(error), error);
      });
      // `next` is owned before the parent closes, so a failing close still has it closed below.
      const parent = held;
      held = next;
      await parent.close();
    }
    const info = await held.stat({ bigint: true });
    const fd = held.fd;
    const final = held;
    const directory = path;
    const entry = (name: string) => `/proc/self/fd/${fd}/${name}`;
    return new HeldDirectory({ dev: info.dev, ino: info.ino }, {
      read: (name) => readLinux(entry(name)),
      names: () => readdir(entry(".")),
      create: (name, append) => createLinux(entry, directory, name, append),
      removeDirectories: (policy) => removeLinuxDirectories(final, directory, policy),
    }, () => final.close());
  } catch (error) {
    await held.close();
    throw error;
  }
}

/** Open only the directory observed at this entry, never a symlink substituted for it. */
async function existingLinuxDirectory(path: string): Promise<FileHandle | undefined> {
  const observed = await lstat(path, { bigint: true }).catch((error) => {
    if (codeOf(error) !== "ENOENT") throw error;
  });
  if (!observed?.isDirectory()) return;
  const held = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch((error) => {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(codeOf(error))) throw error;
  });
  if (!held) return;
  try {
    if (sameIdentity(observed, await held.stat({ bigint: true }))) return held;
  } catch (error) {
    await held.close();
    throw error;
  }
  await held.close();
}

/** Every recursion is through a held descriptor. unlink/rmdir never recurse or follow a final symlink. */
async function checkLinuxDevices(held: FileHandle, device: bigint): Promise<void> {
  for (const name of await readdir(`/proc/self/fd/${held.fd}`)) {
    const path = `/proc/self/fd/${held.fd}/${name}`;
    if ((await lstat(path, { bigint: true })).dev !== device) throw failed("reclaim across devices", "EXDEV");
    const child = await existingLinuxDirectory(path);
    if (child) { try { await checkLinuxDevices(child, device); } finally { await child.close(); } }
  }
}

async function emptyLinuxDirectory(held: FileHandle): Promise<void> {
  const root = `/proc/self/fd/${held.fd}`;
  for (const name of await readdir(root)) {
    const path = `${root}/${name}`;
    const child = await existingLinuxDirectory(path);
    if (child) {
      try {
        await emptyLinuxDirectory(child);
        await unlinkLinuxDirectory(path, child);
      } finally { await child.close(); }
    } else {
      // A concurrent replacement by a directory fails closed; unlink cannot descend into it.
      await unlink(path).catch((error) => { if (codeOf(error) !== "ENOENT") throw error; });
    }
  }
}

async function unlinkLinuxDirectory(path: string, held: FileHandle): Promise<boolean> {
  const named = await lstat(path, { bigint: true }).catch((error) => { if (codeOf(error) !== "ENOENT") throw error; });
  if (named && sameIdentity(named, await held.stat({ bigint: true }))) {
    // Reached only with a management permit: the parent is protected and every isolated writer has exited.
    await rmdir(path).catch((error) => { if (!["ENOENT", "ENOTDIR"].includes(codeOf(error))) throw error; });
  }
  return (await held.stat()).nlink === 0;
}

async function removeLinuxDirectories(root: FileHandle, directory: string, policy: RemovalPolicy): Promise<DirectoryRemoval[]> {
  const removed: DirectoryRemoval[] = [], entry = (name: string) => `/proc/self/fd/${root.fd}/${name}`;
  for (const name of (await readdir(`/proc/self/fd/${root.fd}`)).sort()) {
    if (!policy.select(name)) continue;
    const child = await existingLinuxDirectory(entry(name));
    if (!child) { removed.push({ name, status: "refused", reason: "entry-is-not-the-held-directory" }); continue; }
    try {
      const info = await child.stat();
      const index = await lstat(`/proc/self/fd/${child.fd}/index.txt`).catch((error) => {
        if (codeOf(error) !== "ENOENT") throw error;
      });
      const identity = await child.stat({ bigint: true });
      if (!await policy.beforeRemove(name, Math.max(info.mtimeMs, index?.isFile() ? index.mtimeMs : 0), {
        read: (file) => readLinux(`/proc/self/fd/${child.fd}/${file}`),
        names: () => readdir(`/proc/self/fd/${child.fd}`),
      }, identity)) continue;
      const recorded = { dev: String(identity.dev), ino: String(identity.ino) };
      // Defer before entering the subtree: nested name-based removals have the same last-comparison window.
      if (!policy.permit?.permits(await root.stat({ bigint: true }), identity)) {
        removed.push({ name, status: "deferred", identity: recorded, reason: "exclusive-writers-not-proven" }); continue;
      }
      await checkLinuxDevices(child, identity.dev);
      await emptyLinuxDirectory(child);
      const unlinked = await unlinkLinuxDirectory(entry(name), child);
      if (policy.requireRemoval && !unlinked) throw failed(`unlink moved directory ${join(directory, name)}`, "EBUSY");
      removed.push({ name, status: unlinked ? "removed" : "deferred", identity: recorded, ...(!unlinked ? { reason: "held-directory-moved" } : {}) });
    } catch (error) { throw failed(`remove directory ${join(directory, name)}`, codeOf(error), error); }
    finally { await child.close(); }
  }
  return removed;
}

async function createLinux(entry: (name: string) => string, directory: string, name: string, append = false): Promise<NewFile> {
  const handle = await open(entry(name), append ? "ax" : "wx", FILE_MODE).catch((error) => {
    throw failed(`create ${join(directory, name)}`, codeOf(error), error);
  });
  let current = name;
  let closing: Promise<void> | undefined;
  try {
    const info = await handle.stat({ bigint: true });
    return {
      handle,
      identity: { dev: info.dev, ino: info.ino },
      rename: async (to) => {
        await rename(entry(current), entry(to)).catch((error) => {
          throw failed(`rename ${join(directory, current)} to ${to}`, codeOf(error), error);
        });
        current = to;
      },
      close: (remove = false) => closing ??= (async () => {
        if (remove) await rm(entry(current), { force: true }).catch(() => {});
        await handle.close();
      })(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Windows.

/** FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE. */
const DIRECTORY_ACCESS = 0x1 | 0x20 | 0x80 | 0x100000;
async function readLinux(path: string): Promise<string | undefined> {
  // Obtain the handle without waiting for a FIFO writer, then check and read that same entity.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (codeOf(error) !== "ENOENT") throw error;
  });
  if (!file) return;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`not a small regular file: ${path}`);
    return await file.readFile("utf8");
  } finally { await file.close(); }
}

/** GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE: written through Bun, renamed and removed through this handle. */
const FILE_ACCESS = 0x80000000 | 0x40000000 | 0x10000 | 0x100000;
/** FILE_SHARE_READ | FILE_SHARE_WRITE: not FILE_SHARE_DELETE. */
const SHARE_READ_WRITE = 0x1 | 0x2;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_ATTRIBUTE_NORMAL = 0x80;
/** NtCreateFile dispositions and options. */
const FILE_CREATE = 2;
const FILE_OPEN = 1;
const FILE_OPEN_IF = 3;
const FILE_DIRECTORY_FILE = 0x1;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
const FILE_NON_DIRECTORY_FILE = 0x40;
const FILE_OPEN_REPARSE_POINT = 0x00200000;
/** OBJECT_ATTRIBUTES.Attributes: names compare as Win32 compares them. */
const OBJ_CASE_INSENSITIVE = 0x40;
/** FILE_INFORMATION_CLASS values for NtSetInformationFile. */
const FILE_RENAME_INFORMATION = 10;
const FILE_DISPOSITION_INFORMATION = 13;
/** sizeof(BY_HANDLE_FILE_INFORMATION). */
const FILE_INFORMATION_BYTES = 52;
const STATUS_REPARSE_POINT_NOT_RESOLVED = 0xc0000280;
const STATUS_NOT_A_DIRECTORY = 0xc0000103;
/** Win32 errors as Bun reports them. */
const WIN32_CODES: Record<number, string> = {
  2: "ENOENT", 3: "ENOENT", 5: "EPERM", 32: "EBUSY", 33: "EBUSY", 80: "EEXIST", 112: "ENOSPC", 145: "ENOTEMPTY",
  183: "EEXIST", 267: "ENOTDIR", 1921: "ELOOP",
};

const defaultWindows = new WindowsHandles();

/** UTF-16LE bytes of `text` in their own buffer (never a pooled slice: its address goes to the system). */
function utf16(text: string): Buffer {
  const bytes = Buffer.alloc(Buffer.byteLength(text, "utf16le"));
  bytes.write(text, 0, "utf16le");
  return bytes;
}

/** Doing `what` failed with NTSTATUS `status`. */
function ntFailed(resources: WindowsHandles, what: string, status: number): Error {
  const hex = `NTSTATUS 0x${(status >>> 0).toString(16)}`;
  if (status >>> 0 === STATUS_REPARSE_POINT_NOT_RESOLVED) {
    return Object.assign(new Error(`could not ${what}: its directory was made a link (${hex}): ${REFUSED}`), { code: "ELOOP", ntstatus: status >>> 0 });
  }
  const win32 = resources.native.RtlNtStatusToDosError(status);
  const code = WIN32_CODES[win32] ?? hex;
  return Object.assign(new Error(`could not ${what}: ${code} (${hex})`), { code, win32, ntstatus: status >>> 0 });
}

/** Attributes and identity of an open handle. */
function describe(handle: WindowsHandle, path: string): { attributes: number; identity: Identity; mtimeMs: number } {
  const info = new Uint8Array(FILE_INFORMATION_BYTES);
  const result = handle.resources.native.GetFileInformationByHandle(handle.value, ptr(info));
  const win32 = result ? undefined : handle.resources.native.GetLastError();
  handle.record("result", "GetFileInformationByHandle", { success: !!result, win32 });
  if (!result) throw handle.resources.error("read", path, win32!);
  const view = new DataView(info.buffer);
  const identity = { dev: BigInt(view.getUint32(28, true)), ino: (BigInt(view.getUint32(44, true)) << 32n) | BigInt(view.getUint32(48, true)) };
  handle.identify(identity);
  return {
    attributes: view.getUint32(0, true),
    identity,
    mtimeMs: Number(view.getBigUint64(20, true) / 10000n - 11644473600000n),
  };
}

/** Refuse `handle` if its attributes say it is a link (reparse point) or not a directory. Closing is the owner's. */
function expectDirectory(handle: WindowsHandle, path: string): void {
  const { attributes } = describe(handle, path);
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0 || (attributes & FILE_ATTRIBUTE_DIRECTORY) === 0) {
    throw refused(path, "is a link or not a directory");
  }
}

/** A Win32 path as Bun's realpath writes it: without `\\?\` (`\\?\UNC\` back to `\\`). */
function plainPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

/** A Win32 path without the MAX_PATH limit: `\\?\D:\...` or `\\?\UNC\server\share\...`. */
function longPath(path: string): string {
  if (path.startsWith("\\\\?\\")) return path;
  return path.startsWith("\\\\") ? `\\\\?\\UNC\\${path.slice(2)}` : `\\\\?\\${path}`;
}

/**
 * Open the base directory `path` (a real path) without FILE_SHARE_DELETE; it must still be what `path` names. The handle
 * goes into `owned` as soon as it is open, before any check, and whoever owns `owned` closes it, also when a check fails.
 */
function openBase(path: string, owned: WindowsHandle[], resources: WindowsHandles): WindowsHandle {
  resources.record({ phase: "open", operation: "CreateFileW", path });
  const value = resources.native.CreateFileW(ptr(utf16(`${longPath(path)}\0`)), DIRECTORY_ACCESS, SHARE_READ_WRITE, null, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null) as bigint;
  if (value === -1n) {
    const error = resources.native.GetLastError();
    resources.record({ phase: "result", operation: "CreateFileW", path, success: false, win32: error });
    throw resources.error("hold directory", path, error);
  }
  const handle = resources.own(value, path, "CreateFileW");
  owned.push(handle);
  expectDirectory(handle, path);
  // A directory above it replaced between the realpath and the open would have led elsewhere.
  const name = new Uint16Array(32768);
  const length = resources.native.GetFinalPathNameByHandleW(handle.value, ptr(name), name.length, 0);
  const win32 = length === 0 ? resources.native.GetLastError() : undefined;
  handle.record("result", "GetFinalPathNameByHandleW", { success: length > 0 && length < name.length, win32 });
  if (length === 0) throw resources.error("read final path of", path, win32!);
  const final = length === 0 || length >= name.length ? "" : plainPath(new TextDecoder("utf-16le").decode(name.subarray(0, length)));
  if (final.toLowerCase() !== path.toLowerCase()) throw refused(path, `was moved while it was being held (now ${final || "unknown"})`);
  return handle;
}

/** NtCreateFile of `name` relative to the directory `root`; returns the status and the handle. */
function createAt(root: WindowsHandle, name: string, access: number, disposition: number, options: number): { status: number; handle?: WindowsHandle } {
  const resources = root.resources, path = join(root.path, name);
  resources.record({ phase: "open", operation: "NtCreateFile", path });
  const text = utf16(name);
  const unicode = Buffer.alloc(16);
  unicode.writeUInt16LE(text.length, 0);
  unicode.writeUInt16LE(text.length, 2);
  unicode.writeBigUInt64LE(BigInt(ptr(text)), 8);
  const attributes = Buffer.alloc(48);
  attributes.writeUInt32LE(attributes.length, 0);
  attributes.writeBigInt64LE(root.value, 8);
  attributes.writeBigUInt64LE(BigInt(ptr(unicode)), 16);
  attributes.writeUInt32LE(OBJ_CASE_INSENSITIVE, 24);
  const out = Buffer.alloc(8);
  const status = resources.native.NtCreateFile(ptr(out), access, ptr(attributes), ptr(Buffer.alloc(16)), null, FILE_ATTRIBUTE_NORMAL,
    SHARE_READ_WRITE, disposition, options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, null, 0);
  if (status >= 0) return { status, handle: resources.own(out.readBigInt64LE(), path, "NtCreateFile", status >>> 0) };
  const win32 = resources.native.RtlNtStatusToDosError(status);
  resources.record({ phase: "result", operation: "NtCreateFile", path, success: false, ntstatus: status >>> 0, win32 });
  return { status };
}

/** Make (if missing) and open directory `name` below the held directory `parent`; the handle goes into `owned` as `openBase`'s. */
function openChild(parent: WindowsHandle, name: string, path: string, owned: WindowsHandle[], create: boolean): WindowsHandle {
  const { status, handle } = createAt(parent, name, DIRECTORY_ACCESS, create ? FILE_OPEN_IF : FILE_OPEN, FILE_DIRECTORY_FILE);
  if (status >>> 0 === STATUS_NOT_A_DIRECTORY) throw refused(path, "is a link or not a directory");
  if (status < 0) throw ntFailed(parent.resources, `make or open directory ${path}`, status);
  owned.push(handle!);
  expectDirectory(handle!, path);
  return handle!;
}

/** Rename the file open as `file` to `name` in the directory `root`, over whatever has that name. */
function renameAt(file: WindowsHandle, root: WindowsHandle, name: string): number {
  const text = utf16(name);
  // FILE_RENAME_INFORMATION: ReplaceIfExists, RootDirectory, FileNameLength, FileName.
  const information = Buffer.alloc(Math.max(24, 20 + text.length));
  information[0] = 1;
  information.writeBigInt64LE(root.value, 8);
  information.writeUInt32LE(text.length, 16);
  text.copy(information, 20);
  const status = file.resources.native.NtSetInformationFile(file.value, ptr(Buffer.alloc(16)), ptr(information), information.length, FILE_RENAME_INFORMATION);
  file.record("result", "NtSetInformationFile(rename)", { success: status >= 0, ntstatus: status >>> 0,
    win32: status < 0 ? file.resources.native.RtlNtStatusToDosError(status) : undefined });
  return status;
}

/** Mark the file open as `file` for removal when its last handle closes. */
function removeOnClose(file: WindowsHandle): void {
  const status = file.resources.native.NtSetInformationFile(file.value, ptr(Buffer.alloc(16)), ptr(Buffer.from([1])), 1, FILE_DISPOSITION_INFORMATION);
  file.record("result", "NtSetInformationFile(remove)", { success: status >= 0, ntstatus: status >>> 0,
    win32: status < 0 ? file.resources.native.RtlNtStatusToDosError(status) : undefined });
  if (status < 0) throw ntFailed(file.resources, `remove ${file.path}`, status);
}

async function holdWindows(base: string, names: readonly string[], create: boolean, resources: WindowsHandles): Promise<HeldDirectory> {
  // Held from the real path down: while a directory is held, its path cannot change.
  let path = await realpath(base);
  // Every handle opened, in order; each goes in as soon as it is open, so a failed check still has it closed here.
  const handles: WindowsHandle[] = [];
  const close = () => resources.closeAll(handles);
  try {
    let parent = openBase(path, handles, resources);
    for (const name of names) {
      path = join(path, name);
      parent = openChild(parent, name, path, handles, create);
    }
    const directory = parent;
    const final = path;
    return new HeldDirectory(describe(directory, final).identity, {
      read: (name) => readWindows(directory, final, name),
      names: () => readdir(final),
      create: (name, append) => createWindows(directory, final, name, append),
      removeDirectories: (policy) => removeWindowsDirectories(directory, final, policy),
    }, close);
  } catch (error) {
    await resources.closeAll(handles, error);
    throw error;
  }
}

function existingWindowsEntry(parent: WindowsHandle, name: string, path: string, remove: boolean): WindowsHandle | undefined {
  const { status, handle } = createAt(parent, name, DIRECTORY_ACCESS | (remove ? 0x10000 : 0), FILE_OPEN, 0);
  if (status < 0) {
    const error = ntFailed(parent.resources, `open ${path}`, status);
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
  return handle;
}

async function emptyWindowsDirectory(directory: WindowsHandle, path: string): Promise<void> {
  // Ancestors cannot move while held. If an empty directory becomes a junction in place, relative opens below it
  // fail with STATUS_REPARSE_POINT_NOT_RESOLVED; no deletion is ever issued against the re-resolved path.
  for (const name of await readdir(path)) {
    const childPath = join(path, name), child = existingWindowsEntry(directory, name, childPath, true);
    if (child === undefined) continue;
    await withWindowsHandle(child, async () => {
      const { attributes } = describe(child, childPath);
      if ((attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) === 0) {
        await emptyWindowsDirectory(child, childPath);
      }
      removeOnClose(child);
    });
  }
}

async function removeWindowsDirectories(root: WindowsHandle, path: string, policy: RemovalPolicy): Promise<DirectoryRemoval[]> {
  const removed: DirectoryRemoval[] = [];
  for (const name of (await readdir(path)).sort()) {
    if (!policy.select(name)) continue;
    const childPath = join(path, name), child = existingWindowsEntry(root, name, childPath, true);
    if (child === undefined) continue;
    let identity: Identity | undefined;
    const deleted = await withWindowsHandle(child, async () => {
      const info = describe(child, childPath);
      identity = info.identity;
      if ((info.attributes & FILE_ATTRIBUTE_DIRECTORY) === 0 || (info.attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) return false;
      const indexPath = join(childPath, "index.txt"), index = existingWindowsEntry(child, "index.txt", indexPath, false);
      let changedAt = info.mtimeMs;
      if (index !== undefined) {
        await withWindowsHandle(index, async () => {
          const info = describe(index, indexPath);
          if ((info.attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) === 0) changedAt = Math.max(changedAt, info.mtimeMs);
        });
      }
      if (!await policy.beforeRemove(name, changedAt, {
        read: (file) => readWindows(child, childPath, file),
        names: () => readdir(childPath),
      }, info.identity)) return false;
      await emptyWindowsDirectory(child, childPath);
      removeOnClose(child);
      return true;
    });
    // A name is confirmed removed only after its deletion handle closed successfully.
    if (deleted) removed.push({ name, status: "removed", identity: { dev: String(identity!.dev), ino: String(identity!.ino) } });
  }
  return removed;
}

async function readWindows(directory: WindowsHandle, directoryPath: string, name: string): Promise<string | undefined> {
  const path = join(directoryPath, name), native = existingWindowsEntry(directory, name, path, false);
  if (native === undefined) return;
  let file: FileHandle | undefined;
  let failure: unknown;
  try {
    const { attributes, identity } = describe(native, path);
    if ((attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) !== 0) throw refused(path, "is not a regular file");
    file = await open(path, "r");
    const info = await file.stat({ bigint: true });
    if (!sameIdentity(info, identity) || info.size > 1024n * 1024n) throw refused(path, "changed while reading");
    return await file.readFile("utf8");
  } catch (error) { failure = error; throw error; }
  finally { await finishWindows([() => file?.close(), () => native.close()], failure); }
}

async function createWindows(directory: WindowsHandle, directoryPath: string, name: string, append = false): Promise<NewFile> {
  const path = join(directoryPath, name);
  const created = createAt(directory, name, FILE_ACCESS, FILE_CREATE, FILE_NON_DIRECTORY_FILE);
  if (created.status < 0) throw ntFailed(directory.resources, `create ${path}`, created.status);
  const file = created.handle!;
  let handle: FileHandle | undefined;
  try {
    const { identity } = describe(file, path);
    // Opened by its path while it is held: its directory can neither move nor become a link, and the check decides.
    // Never created by this open (no O_CREAT), so a path that led elsewhere could not make a file there either.
    handle = await open(path, append ? constants.O_RDWR | constants.O_APPEND : constants.O_RDWR).catch((error) => {
      throw failed(`open ${path}`, codeOf(error), error);
    });
    const info = await handle.stat({ bigint: true });
    if (!sameIdentity(info, identity)) throw refused(path, "is not the file this call created");
    const opened = handle;
    let current = name;
    let closing: Promise<void> | undefined;
    return {
      handle: opened,
      identity,
      rename: async (to) => {
        const status = renameAt(file, directory, to);
        if (status < 0) throw ntFailed(file.resources, `rename ${join(directoryPath, current)} to ${to}`, status);
        current = to;
      },
      close: (remove = false) => closing ??= (async () => {
        await finishWindows([...(remove ? [() => removeOnClose(file)] : []), () => opened.close(), () => file.close()]);
      })(),
    };
  } catch (error) {
    await finishWindows([() => handle?.close(), () => removeOnClose(file), () => file.close()], error);
    throw error;
  }
}

async function withWindowsHandle<T>(handle: WindowsHandle, work: () => Promise<T>): Promise<T> {
  let value: T;
  try { value = await work(); }
  catch (error) { await finishWindows([() => handle.close()], error); throw error; }
  await finishWindows([() => handle.close()]);
  return value;
}
