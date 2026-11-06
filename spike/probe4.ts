// macOS spike 4 (2026-11-07): what an open directory descriptor reports once its directory was removed by name, against
// one that was only moved, to find a proof of removal (st_nlink stays 2 on APFS, spike 3).
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { fstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { i32, u32, u64, ptr: P } = FFIType;
const lib = "/usr/lib/libSystem.B.dylib";
const c = dlopen(lib, {
  __error: { args: [], returns: P },
  open: { args: [P, i32, i32], returns: i32 },
  close: { args: [i32], returns: i32 },
  mkdirat: { args: [i32, P, u32], returns: i32 },
  unlinkat: { args: [i32, P, i32], returns: i32 },
  fstatat: { args: [i32, P, P, i32], returns: i32 },
  proc_pidfdinfo: { args: [i32, i32, i32, P, i32], returns: i32 },
  fgetattrlist: { args: [i32, P, P, u64, u32], returns: i32 },
  fdopendir: { args: [i32], returns: P },
  readdir: { args: [P], returns: P },
  closedir: { args: [P], returns: i32 },
}).symbols;
const padded = dlopen(lib, { openat: { args: [i32, P, i32, u64, u64, u64, u64, u64, u64], returns: i32 } }).symbols;
const errno = () => read.i32(c.__error()!, 0);
const cstr = (text: string) => Buffer.from(text + "\0");
const O_RDONLY = 0, O_DIRECTORY = 0x100000, O_CLOEXEC = 0x1000000, O_WRONLY = 1, O_CREAT = 0x200, O_EXCL = 0x800;
const work = realpathSync(mkdtempSync(join(tmpdir(), "spike4-")));

function observe(fd: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out.nlink = fstatSync(fd).nlink;
  const buffer = new Uint8Array(1200), size = c.proc_pidfdinfo(process.pid, fd, 2, ptr(buffer), buffer.byteLength);
  out.pidfdinfo = size === buffer.byteLength ? Buffer.from(buffer.subarray(176, 176 + buffer.subarray(176).indexOf(0))).toString() : `size ${size} errno ${errno()}`;
  const dot = padded.openat(fd, cstr("."), O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0n, 0n, 0n, 0n, 0n, 0n);
  out.openDot = dot >= 0 ? "ok" : `errno ${errno()}`; if (dot >= 0) c.close(dot);
  const up = padded.openat(fd, cstr(".."), O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0n, 0n, 0n, 0n, 0n, 0n);
  out.openDotDot = up >= 0 ? "ok" : `errno ${errno()}`; if (up >= 0) c.close(up);
  const stat = new Uint8Array(144);
  out.fstatatDot = c.fstatat(fd, cstr("."), ptr(stat), 0x20) === 0 ? `nlink ${new DataView(stat.buffer).getUint16(6, true)}` : `errno ${errno()}`;
  out.mkdirat = c.mkdirat(fd, cstr("probe"), 0o700) === 0 ? "created" : `errno ${errno()}`;
  if (out.mkdirat === "created") c.unlinkat(fd, cstr("probe"), 0x80);
  const file = padded.openat(fd, cstr("probe-file"), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0n, 0n, 0n, 0n, 0n, 0o600n);
  out.createFile = file >= 0 ? "created" : `errno ${errno()}`;
  if (file >= 0) { c.close(file); c.unlinkat(fd, cstr("probe-file"), 0); }
  // getattrlist: ATTR_CMN_OBJID | ATTR_CMN_PAROBJID (commonattr 0x20 | 0x80), ATTR_CMN_FILEID 0x02000000, PARENTID 0x04000000.
  const list = new Uint8Array(24); const view = new DataView(list.buffer);
  view.setUint16(0, 5, true); view.setUint32(4, 0x02000000 | 0x04000000, true);
  const attrs = new Uint8Array(64);
  out.getattrlist = c.fgetattrlist(fd, ptr(list), ptr(attrs), BigInt(attrs.byteLength), 0) === 0
    ? { length: new DataView(attrs.buffer).getUint32(0, true), fileid: String(new DataView(attrs.buffer).getBigUint64(4, true)), parentid: String(new DataView(attrs.buffer).getBigUint64(12, true)) }
    : `errno ${errno()}`;
  const own = padded.openat(fd, cstr("."), O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0n, 0n, 0n, 0n, 0n, 0n);
  if (own >= 0) { const stream = c.fdopendir(own); let n = 0; for (let e = c.readdir(stream!); e; e = c.readdir(stream!)) n++; c.closedir(stream!); out.entries = n; }
  return out;
}

const report: Record<string, unknown> = {};
for (const mode of ["kept", "moved", "removed", "removedNested"] as const) {
  const parent = join(work, mode); mkdirSync(parent); const path = join(parent, "held"); mkdirSync(path);
  if (mode === "removedNested") { mkdirSync(join(path, "sub")); rmdirSync(join(path, "sub")); }
  const fd = c.open(cstr(path), O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
  if (mode === "moved") renameSync(path, join(work, "moved-away"));
  if (mode.startsWith("removed")) rmdirSync(path);
  report[mode] = observe(fd);
  c.close(fd);
}
console.log(JSON.stringify(report, null, 2));
await Bun.write(process.env.SPIKE_REPORT4 ?? join(work, "report4.json"), JSON.stringify(report, null, 2));
