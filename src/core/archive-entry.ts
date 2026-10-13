import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { archiveWindowsEntry, type Identity, sameIdentity } from "./held-directory.ts";

let native: ReturnType<typeof loadNative> | undefined;
function loadNative() {
  return dlopen("libc.so.6", {
    renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;
}

/** A same-device, no-replace rename. Never copies, recursively removes or follows the selected entry.
 * Linux cannot bind renameat2 to an inode. A swapped entry is preserved at the journaled destination
 * and reported as a mismatch; the caller must not settle ownership or claim success in that case.
 */
export async function archiveEntry(source: string, destination: string, expected: Identity): Promise<void> {
  if (resolve(source) !== source || resolve(destination) !== destination) throw new Error("归档需要绝对路径");
  if (process.platform === "win32") return archiveWindowsEntry(source, destination, expected);
  if (process.platform !== "linux") throw new Error("安全归档只支持 Linux 和 Windows");
  const from = await open(dirname(source), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let to;
  try {
    to = await open(dirname(destination), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const entry = `/proc/self/fd/${from.fd}/${basename(source)}`;
    if (!sameIdentity(await lstat(entry, { bigint: true }), expected)) throw new Error("归档源实体已变化");
    if ((await to.stat({ bigint: true })).dev !== expected.dev) throw new Error("归档目标不在同一文件系统；请指定同盘的 backup/rm，拒绝退化为复制后删除");
    const lib = native ??= loadNative();
    const oldName = Buffer.from(basename(source) + "\0"), newName = Buffer.from(basename(destination) + "\0");
    if (lib.renameat2(from.fd, ptr(oldName), to.fd, ptr(newName), 1) !== 0) {
      const address = lib.__errno_location();
      if (!address) throw new Error("原子归档失败，无法读取 errno");
      const errno = new Int32Array(toArrayBuffer(address, 0, 4))[0]!;
      throw Object.assign(new Error(`原子归档失败，errno=${errno}`), { code: ({ 2: "ENOENT", 17: "EEXIST", 18: "EXDEV" } as Record<number, string>)[errno] ?? "EIO" });
    }
    await from.sync(); await to.sync();
    if (!sameIdentity(await lstat(`/proc/self/fd/${to.fd}/${basename(destination)}`, { bigint: true }), expected)) {
      throw new Error("归档时源实体被换入；内容保留在清单中的目标，未删除或结算，请核对清单");
    }
  } finally { try { await to?.close(); } finally { await from.close(); } }
}
