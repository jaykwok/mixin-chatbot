import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";

// A kernel lock has no stale timeout: a stopped/paused controller continues to own it.
// It fences cooperating controllers only. Worker retirement still requires the signed CIDs.
// Keep the fd for the entire process lifetime, including asynchronous shutdown and outstanding I/O.
const owners = new Map<string, { fd: number; epoch: string }>();
let library: ReturnType<typeof openLibrary> | undefined;
function openLibrary() {
  return dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
}

export function taskOwner(root: string): string {
  if (process.platform !== "linux") throw new Error("任务管理锁需要 Linux");
  const path = join(root, "owner.lock");
  // Linux O_CLOEXEC is not exposed by Node's fs constants typings.
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | 0x80000, 0o600);
  let retained = false;
  try {
    const held = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (!held.isFile() || held.nlink !== 1n || held.uid !== BigInt(process.getuid!()) || (held.mode & 0o077n) !== 0n
      || named.dev !== held.dev || named.ino !== held.ino) throw new Error("任务管理锁身份或权限不符");
    const key = `${held.dev}:${held.ino}`;
    const existing = owners.get(key);
    if (existing) return existing.epoch;
    // LOCK_EX | LOCK_NB. Never unlink/replace owner.lock, including when the owner exits.
    if ((library ??= openLibrary()).symbols.flock(fd, 2 | 4) !== 0) throw new Error("另一任务控制面仍持有内核锁；停止旧实例后重试");
    const epoch = randomUUID();
    owners.set(key, { fd, epoch }); retained = true;
    return epoch;
  } finally { if (!retained) closeSync(fd); }
}
