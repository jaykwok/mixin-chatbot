// macOS spike 2 (2026-11-07): ways to create a file with an exact mode relative to a held directory, and to use the
// descriptor through Bun's FileHandle and readdir.
import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { i32, u32, u64, ptr: P } = FFIType;
const lib = "/usr/lib/libSystem.B.dylib";
const c = dlopen(lib, {
  __error: { args: [], returns: P },
  open: { args: [P, i32, i32], returns: i32 },
  close: { args: [i32], returns: i32 },
  fstat: { args: [i32, P], returns: i32 },
  mkstempsat_np: { args: [i32, P, i32], returns: i32 },
  mkostempsat_np: { args: [i32, P, i32, i32], returns: i32 },
  renameatx_np: { args: [i32, P, i32, P, u32], returns: i32 },
  fdopendir: { args: [i32], returns: P },
  readdir: { args: [P], returns: P },
  closedir: { args: [P], returns: i32 },
}).symbols;
// openat(int, const char *, int, ...): the first variadic argument is read from the stack on Apple arm64. Eight
// integer arguments fill x0–x7, so a ninth lands at [sp], where va_arg reads the mode.
const padded = dlopen(lib, { openat: { args: [i32, P, i32, u64, u64, u64, u64, u64, u64], returns: i32 } }).symbols;
const plain = dlopen(lib, { openat: { args: [i32, P, i32, u32], returns: i32 } }).symbols;
const errno = () => read.i32(c.__error()!, 0);
const cstr = (text: string) => Buffer.from(text + "\0");
const work = realpathSync(mkdtempSync(join(tmpdir(), "spike2-")));
const report: Record<string, unknown> = {};
const O = { RDONLY: 0, WRONLY: 1, RDWR: 2, NONBLOCK: 4, APPEND: 8, NOFOLLOW: 0x100, CREAT: 0x200, EXCL: 0x800, DIRECTORY: 0x100000, CLOEXEC: 0x1000000 };
const mode = (path: string) => (statSync(path).mode & 0o7777).toString(8);

const dir = c.open(cstr(work), O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0);
process.umask(0o022);
for (const [label, want] of [["600", 0o600], ["644", 0o644], ["640", 0o640]] as const) {
  const name = `padded-${label}`;
  const fd = padded.openat(dir, cstr(name), O.WRONLY | O.CREAT | O.EXCL | O.CLOEXEC, 0n, 0n, 0n, 0n, 0n, BigInt(want));
  report[name] = fd < 0 ? `errno ${errno()}` : mode(join(work, name));
  if (fd >= 0) c.close(fd);
}
{
  const fd = plain.openat(dir, cstr("plain-600"), O.WRONLY | O.CREAT | O.EXCL, 0o600);
  report["plain-600"] = fd < 0 ? `errno ${errno()}` : mode(join(work, "plain-600"));
  if (fd >= 0) c.close(fd);
}
// Repeated padded calls under load: the stack slot must hold the mode every time.
{
  const modes = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const fd = padded.openat(dir, cstr(`many-${i}`), O.WRONLY | O.CREAT | O.EXCL, 0n, 0n, 0n, 0n, 0n, 0o600n);
    modes.add(fd < 0 ? `errno ${errno()}` : mode(join(work, `many-${i}`)));
    if (fd >= 0) c.close(fd);
  }
  report.padded200 = [...modes];
}
{
  const template = cstr("tmpl-XXXXXX");
  const fd = c.mkstempsat_np(dir, ptr(template), 0);
  const name = template.toString("utf8", 0, template.length - 1);
  report.mkstempsat = fd < 0 ? `errno ${errno()}` : { name, mode: mode(join(work, name)) };
  if (fd >= 0) c.close(fd);
}
// A raw descriptor wrapped as a Bun FileHandle through /dev/fd/N; appending through it.
{
  const fd = padded.openat(dir, cstr("wrapped"), O.WRONLY | O.APPEND | O.CREAT | O.EXCL | O.CLOEXEC, 0n, 0n, 0n, 0n, 0n, 0o600n);
  try {
    const handle = await open(`/dev/fd/${fd}`, "a");
    c.close(fd);
    await handle.write("one\n"); await handle.write("two\n"); await handle.sync();
    const s = await handle.stat({ bigint: true });
    await handle.close();
    report.wrapped = { content: await Bun.file(join(work, "wrapped")).text(), ino: [String(s.ino), String(statSync(join(work, "wrapped"), { bigint: true }).ino)], mode: mode(join(work, "wrapped")) };
  } catch (error) { report.wrapped = String(error); }
}
{
  try {
    const handle = await open(`/dev/fd/${dir}`, "r");
    report.wrappedDirStat = (await handle.stat()).isDirectory();
    await handle.close();
  } catch (error) { report.wrappedDirStat = String(error); }
  try { report.readdirDevFd = (await readdir(`/dev/fd/${dir}`)).length; } catch (error) { report.readdirDevFd = String(error); }
  const own = padded.openat(dir, cstr("."), O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0n, 0n, 0n, 0n, 0n, 0n);
  const stream = c.fdopendir(own);
  let count = 0;
  for (let entry = c.readdir(stream!); entry; entry = c.readdir(stream!)) count++;
  c.closedir(stream!);
  report.fdopendirDot = count;
}
// A file opened only for reading through the held directory, wrapped.
{
  writeFileSync(join(work, "small.txt"), "hello");
  const fd = padded.openat(dir, cstr("small.txt"), O.RDONLY | O.NOFOLLOW | O.NONBLOCK | O.CLOEXEC, 0n, 0n, 0n, 0n, 0n, 0n);
  const handle = await open(`/dev/fd/${fd}`, "r");
  c.close(fd);
  report.readWrapped = await handle.readFile("utf8");
  await handle.close();
}
c.close(dir);
console.log(JSON.stringify(report, null, 2));
await Bun.write(process.env.SPIKE_REPORT2 ?? join(work, "report2.json"), JSON.stringify(report, null, 2));
