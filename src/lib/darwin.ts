// libSystem through bun:ffi on macOS (Apple Silicon). Facts measured on macOS 15 and 26 (docs/dev/macos-spike-20261106.md):
//
// - errno is read through __error().
// - A variadic argument is read from the stack on Apple arm64, but bun:ffi passes every declared argument in registers
//   first. So only non-variadic functions are bound as declared. openat(int, const char *, int, ...) gets five unused
//   integer arguments to fill x3–x7, which puts the mode in the first stack slot, where va_arg reads it (verified: the
//   plain binding created files 0150, the padded one exactly the requested mode, 200 of 200 times).
// - fcntl(F_GETPATH) is variadic too; a descriptor's path comes from proc_pidfdinfo.
// - `/dev/fd/N/<name>` does not resolve through the directory, but opening `/dev/fd/N` gives a new descriptor of the same
//   open file, so a raw descriptor can become a Bun FileHandle. `readdir("/dev/fd/N")` is refused (ENOTDIR): directories
//   are listed with fdopendir on a fresh openat(".").
import { dlopen, FFIType, ptr, read, toArrayBuffer } from "bun:ffi";

const { i32, u32, u64, i64, ptr: P } = FFIType;

function load() {
  const lib = "/usr/lib/libSystem.B.dylib";
  const symbols = dlopen(lib, {
    __error: { args: [], returns: P },
    close: { args: [i32], returns: i32 },
    fsync: { args: [i32], returns: i32 },
    flock: { args: [i32, i32], returns: i32 },
    fstat: { args: [i32, P], returns: i32 },
    fstatat: { args: [i32, P, P, i32], returns: i32 },
    fchmod: { args: [i32, u32], returns: i32 },
    mkdirat: { args: [i32, P, u32], returns: i32 },
    unlinkat: { args: [i32, P, i32], returns: i32 },
    renameatx_np: { args: [i32, P, i32, P, u32], returns: i32 },
    fdopendir: { args: [i32], returns: P },
    readdir: { args: [P], returns: P },
    closedir: { args: [P], returns: i32 },
    getsid: { args: [i32], returns: i32 },
    setsid: { args: [], returns: i32 },
    setgroups: { args: [i32, P], returns: i32 },
    setgid: { args: [u32], returns: i32 },
    setuid: { args: [u32], returns: i32 },
    waitpid: { args: [i32, P, i32], returns: i32 },
    proc_pidinfo: { args: [i32, i32, u64, P, i32], returns: i32 },
    proc_pidfdinfo: { args: [i32, i32, i32, P, i32], returns: i32 },
    proc_listallpids: { args: [P, i32], returns: i32 },
    proc_listpids: { args: [u32, u32, P, i32], returns: i32 },
    sysctlbyname: { args: [P, P, P, P, u64], returns: i32 },
    pathconf: { args: [P, i32], returns: i64 },
  }).symbols;
  const variadic = dlopen(lib, { openat: { args: [i32, P, i32, u64, u64, u64, u64, u64, u64], returns: i32 } }).symbols;
  return { ...symbols, openat: (dir: number, name: Uint8Array, flags: number, mode = 0) => variadic.openat(dir, name, flags, 0n, 0n, 0n, 0n, 0n, BigInt(mode)) };
}
let loaded: ReturnType<typeof load> | undefined;
/** The bindings; loads libSystem on first use and throws on any other platform. */
export function darwin(): ReturnType<typeof load> {
  if (process.platform !== "darwin") throw new Error(`libSystem 只在 macOS 上可用，当前平台 ${process.platform}`);
  return loaded ??= load();
}

export const O = {
  RDONLY: 0, WRONLY: 1, RDWR: 2, NONBLOCK: 0x4, APPEND: 0x8, NOFOLLOW: 0x100, CREAT: 0x200, EXCL: 0x800,
  DIRECTORY: 0x100000, CLOEXEC: 0x1000000,
} as const;
export const AT_FDCWD = -2, AT_SYMLINK_NOFOLLOW = 0x20, AT_REMOVEDIR = 0x80, RENAME_EXCL = 0x4;
export const LOCK_EX = 2, LOCK_NB = 4;

const ERRNO: Record<number, string> = {
  1: "EPERM", 2: "ENOENT", 3: "ESRCH", 4: "EINTR", 5: "EIO", 9: "EBADF", 10: "ECHILD", 13: "EACCES", 16: "EBUSY", 17: "EEXIST",
  18: "EXDEV", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 24: "EMFILE", 28: "ENOSPC", 30: "EROFS", 35: "EAGAIN", 62: "ELOOP",
  63: "ENAMETOOLONG", 66: "ENOTEMPTY",
};
export const EAGAIN = 35, ECHILD = 10;

export function errno(): number {
  return read.i32(darwin().__error()!, 0);
}

/** An error carrying the errno name as `code`, as node:fs errors do. */
export function systemError(what: string, number = errno()): NodeJS.ErrnoException {
  const code = ERRNO[number] ?? `E${number}`;
  return Object.assign(new Error(`${what}: ${code}`), { code, errno: -number });
}

export const cString = (text: string): Uint8Array => {
  if (text.includes("\0")) throw Object.assign(new Error("路径含 NUL"), { code: "EINVAL" });
  return Buffer.from(text + "\0");
};

/** The fields of struct stat that identity, type and age checks use (layout of <sys/stat.h> on arm64). */
export interface DarwinStat { dev: bigint; ino: bigint; mode: number; nlink: number; uid: number; gid: number; size: bigint; mtimeMs: number }
const S_IFMT = 0o170000;
export const isDirectory = (stat: DarwinStat) => (stat.mode & S_IFMT) === 0o040000;
export const isFile = (stat: DarwinStat) => (stat.mode & S_IFMT) === 0o100000;

function decodeStat(buffer: Uint8Array): DarwinStat {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return {
    dev: BigInt(view.getInt32(0, true)), mode: view.getUint16(4, true), nlink: view.getUint16(6, true), ino: view.getBigUint64(8, true),
    uid: view.getUint32(16, true), gid: view.getUint32(20, true),
    mtimeMs: Number(view.getBigInt64(48, true)) * 1000 + Math.floor(Number(view.getBigInt64(56, true)) / 1e6),
    size: view.getBigInt64(96, true),
  };
}

export function fstat(fd: number): DarwinStat {
  const buffer = new Uint8Array(144);
  if (darwin().fstat(fd, ptr(buffer)) !== 0) throw systemError("fstat");
  return decodeStat(buffer);
}

/** The entry `name` of the directory `dir` itself (a link is described, not followed); undefined when missing. */
export function statAt(dir: number, name: string): DarwinStat | undefined {
  const buffer = new Uint8Array(144);
  if (darwin().fstatat(dir, cString(name), ptr(buffer), AT_SYMLINK_NOFOLLOW) === 0) return decodeStat(buffer);
  const number = errno();
  if (number === 2) return undefined;
  throw systemError(`stat ${name}`, number);
}

/** openat relative to `dir`; throws a coded error. With O.CREAT the mode is exact (see the header). */
export function openAt(dir: number, name: string, flags: number, mode = 0): number {
  const fd = darwin().openat(dir, cString(name), flags | O.CLOEXEC, mode);
  if (fd < 0) throw systemError(`open ${name}`);
  return fd;
}

export function close(fd: number): void {
  if (darwin().close(fd) !== 0) throw systemError("close");
}

export function sync(fd: number): void {
  if (darwin().fsync(fd) !== 0) throw systemError("fsync");
}

export function mkdirAt(dir: number, name: string, mode: number): void {
  if (darwin().mkdirat(dir, cString(name), mode) !== 0) throw systemError(`mkdir ${name}`);
}

export function unlinkAt(dir: number, name: string, directory = false): void {
  if (darwin().unlinkat(dir, cString(name), directory ? AT_REMOVEDIR : 0) !== 0) throw systemError(`unlink ${name}`);
}

/** rename within or across held directories; `exclusive` refuses an existing target (EEXIST) instead of replacing it. */
export function renameAt(fromDir: number, from: string, toDir: number, to: string, exclusive = false): void {
  if (darwin().renameatx_np(fromDir, cString(from), toDir, cString(to), exclusive ? RENAME_EXCL : 0) !== 0) throw systemError(`rename ${from} to ${to}`);
}

/** The names in the directory `dir` (without . and ..), through its own open file so `dir`'s offset is untouched. */
export function namesAt(dir: number): string[] {
  return entriesAt(dir).filter(name => name !== "." && name !== "..");
}

/**
 * Whether the held directory `dir` was removed. On APFS st_nlink of a removed directory stays 2, but listing it gives
 * no entry at all, not even `.` and `..`, while a directory that was only moved still lists both (measured on macOS 15
 * and 26, docs/dev/macos-spike-20261106.md).
 */
export function directoryRemoved(dir: number): boolean {
  return entriesAt(dir).length === 0;
}

function entriesAt(dir: number): string[] {
  const native = darwin(), own = openAt(dir, ".", O.RDONLY | O.DIRECTORY);
  const stream = native.fdopendir(own);
  if (!stream) { const error = systemError("fdopendir"); native.close(own); throw error; }
  const names: string[] = [];
  try {
    // struct dirent (64-bit inodes): d_namlen at 18 (u16), d_name at 21.
    for (let entry = native.readdir(stream); entry; entry = native.readdir(stream)) {
      const name = Buffer.from(toArrayBuffer(entry, 21, read.u16(entry, 18))).toString("utf8");
      names.push(name);
    }
  } finally { native.closedir(stream); }
  return names;
}

/** The current path of an open descriptor (PROC_PIDFDVNODEPATHINFO: vnode_fdinfowithpath, path at 176). */
export function descriptorPath(fd: number): string {
  const buffer = new Uint8Array(1200), size = darwin().proc_pidfdinfo(process.pid, fd, 2, ptr(buffer), buffer.byteLength);
  if (size !== buffer.byteLength) throw systemError("proc_pidfdinfo");
  const path = buffer.subarray(176, 176 + 1024);
  return Buffer.from(path.subarray(0, path.indexOf(0))).toString("utf8");
}

/** Non-blocking exclusive flock: false when another open file description holds it. */
export function tryLock(fd: number): boolean {
  if (darwin().flock(fd, LOCK_EX | LOCK_NB) === 0) return true;
  const number = errno();
  if (number === EAGAIN) return false;
  throw systemError("flock", number);
}

let boot: string | undefined;
/** kern.bootsessionuuid: changes at every boot. */
export function bootSession(): string {
  if (boot) return boot;
  const value = new Uint8Array(64), size = new BigUint64Array([64n]);
  if (darwin().sysctlbyname(cString("kern.bootsessionuuid"), ptr(value), ptr(size), null, 0n) !== 0) throw systemError("sysctl kern.bootsessionuuid");
  return boot = Buffer.from(value.subarray(0, value.indexOf(0) < 0 ? Number(size[0]) : value.indexOf(0))).toString("utf8");
}

/** proc_bsdinfo of a live process; undefined when there is none (or it can no longer be inspected). */
export function processInfo(pid: number): { ppid: number; pgid: number; zombie: boolean; start: string } | undefined {
  const buffer = new Uint8Array(136);
  if (darwin().proc_pidinfo(pid, 3, 0n, ptr(buffer), buffer.byteLength) !== buffer.byteLength) return undefined; // PROC_PIDTBSDINFO
  const view = new DataView(buffer.buffer);
  // pbi_status 5 is SZOMB; pbi_start_tvsec/usec at 120/128.
  return { ppid: view.getUint32(16, true), pgid: view.getUint32(100, true), zombie: view.getUint32(4, true) === 5,
    start: `${view.getBigUint64(120, true)}.${String(view.getBigUint64(128, true)).padStart(6, "0")}` };
}

/** A process's identity across PID reuse: the boot plus its start time. Undefined when it is gone. */
export function processIncarnation(pid: number): string | undefined {
  const info = processInfo(pid);
  return info && !info.zombie ? `${bootSession()}:${info.start}` : undefined;
}

/** Every process now in session `sid` or below `root` by parent links (`root` itself excluded), with its start time. */
export function descendants(sid: number, root = process.pid): Map<number, string> {
  const native = darwin(), live = new Map<number, { ppid: number; start: string }>();
  let capacity = 4096, pids: Int32Array, count: number;
  for (;;) {
    pids = new Int32Array(capacity); count = native.proc_listallpids(ptr(pids), pids.byteLength);
    if (count < 0) throw systemError("proc_listallpids");
    if (count < capacity) break;
    capacity *= 2;
  }
  for (const pid of pids.subarray(0, count)) {
    if (pid <= 1 || pid === root) continue;
    const info = processInfo(pid);
    if (info && !info.zombie) live.set(pid, info);
  }
  const found = new Map<number, string>(), children = new Map<number, number[]>();
  for (const [pid, info] of live) {
    (children.get(info.ppid) ?? children.set(info.ppid, []).get(info.ppid)!).push(pid);
    if (native.getsid(pid) === sid) found.set(pid, info.start);
  }
  const stack = [root, ...found.keys()];
  while (stack.length) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (!found.has(child)) { found.set(child, live.get(child)!.start); stack.push(child); }
    }
  }
  return found;
}

/** Makes this process the leader of a session of its own, unless it already is; the callers' reaping depends on it. */
export function leadSession(): void {
  const native = darwin();
  if (native.getsid(0) !== process.pid && native.setsid() === -1) throw systemError("setsid");
}

/**
 * One round against what this process started: every process in its session `sid` (it is the session leader) or below
 * it by parent links is stopped, from fresh snapshots until no new one appears, then killed. Returns how many were
 * signalled. A process is signalled only while its start time is the one seen, so a reused PID is left alone. A
 * descendant that left the session (setsid) is found only while its parent chain up to here is intact: once an
 * ancestor has exited, launchd adopts it and it is out of reach (the accepted limit of macOS supervision), unless it
 * is in `known`, an earlier snapshot of descendants().
 */
export function killDescendants(sid: number, known: ReadonlyMap<number, string> = new Map()): number {
  const stopped = new Map<number, string>();
  for (const [pid, start] of known) {
    const info = processInfo(pid);
    if (info && !info.zombie && info.start === start) stopped.set(pid, start);
  }
  for (let round = 0; round < 20; round++) {
    let added = 0;
    for (const [pid, start] of descendants(sid, process.pid)) {
      if (stopped.has(pid) || processInfo(pid)?.start !== start) continue;
      try { process.kill(pid, "SIGSTOP"); } catch {}
      stopped.set(pid, start); added++;
    }
    if (!added) break;
  }
  for (const [pid, start] of stopped) {
    if (processInfo(pid)?.start === start) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  return stopped.size;
}

/**
 * Every live process of the account `uid`, with its start time. A process can leave a session but not its account, so
 * for an account that runs nothing but the service this list is complete, whatever called setsid().
 */
export function accountProcesses(uid: number): Map<number, string> {
  const native = darwin(), found = new Map<number, string>();
  let capacity = 1024, pids: Int32Array, bytes: number;
  for (;;) {
    pids = new Int32Array(capacity); bytes = native.proc_listpids(4, uid, ptr(pids), pids.byteLength); // PROC_UID_ONLY
    if (bytes < 0) throw systemError("proc_listpids");
    if (bytes < pids.byteLength) break;
    capacity *= 2;
  }
  for (const pid of pids.subarray(0, bytes / 4)) {
    if (pid <= 1) continue;
    const info = processInfo(pid);
    if (info && !info.zombie) found.set(pid, info.start);
  }
  return found;
}

/** Sends SIGKILL to the listed processes of the account `uid` except `keep`, each only while its start time is the listed one; returns how many there were. */
export function killAccount(uid: number, keep: ReadonlySet<number> = new Set()): number {
  const found = accountProcesses(uid);
  for (const pid of keep) found.delete(pid);
  for (const [pid, start] of found) {
    if (processInfo(pid)?.start === start) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
  return found.size;
}

/** This process and its ancestors (the supervisor that started it): what an account check of the process itself leaves out. */
export function selfAndAncestors(): Set<number> {
  const chain = new Set<number>();
  for (let pid = process.pid; pid > 1 && !chain.has(pid);) {
    chain.add(pid);
    const parent = processInfo(pid)?.ppid;
    if (!parent) break;
    pid = parent;
  }
  return chain;
}

/** Permanently gives up root for `uid`:`gid`, with `gid` as the only group. Fails loudly: nothing may run with what it kept. */
export function dropIdentity(uid: number, gid: number): void {
  const native = darwin(), groups = new Uint32Array([gid]);
  if (native.setgroups(1, ptr(groups)) !== 0) throw systemError("setgroups");
  if (native.setgid(gid) !== 0) throw systemError("setgid");
  if (native.setuid(uid) !== 0) throw systemError("setuid");
  if (process.getuid!() !== uid || process.geteuid!() !== uid || process.getgid!() !== gid || process.getegid!() !== gid || uid !== 0 && native.setuid(0) === 0)
    throw new Error("放弃 root 身份后核对不符");
}

/** Reaps exited children of this process without blocking; returns whether none is left (ECHILD). */
export function reapChildren(): boolean {
  const native = darwin();
  let pid: number;
  do { pid = native.waitpid(-1, null, 1); } while (pid > 0); // WNOHANG
  return pid === -1 && errno() === ECHILD;
}

/** Whether names on the volume of `path` are case-sensitive (_PC_CASE_SENSITIVE); APFS by default is not. */
export function caseSensitive(path: string): boolean {
  const value = Number(darwin().pathconf(cString(path), 11));
  if (value < 0) throw systemError("pathconf");
  return value !== 0;
}
