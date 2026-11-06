// macOS spike (2026-11-06): settles the unverified facts of docs/dev/macos-inventory-20261104.md on a real arm64 Mac
// (GitHub Actions runner). Every probe records its result or its error; nothing here is product code.
import { dlopen, FFIType, ptr, read, CString, toArrayBuffer } from "bun:ffi";
import { Database, constants as sqlite } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const report: Record<string, unknown> = {};
async function probe(name: string, body: () => unknown | Promise<unknown>) {
  try { report[name] = await body(); }
  catch (error) { report[name] = { error: String(error instanceof Error ? error.stack ?? error.message : error) }; }
  console.log(`== ${name}\n${JSON.stringify(report[name], null, 2)}`);
}
const sh = (command: string) => {
  const result = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8" });
  return { code: result.status, out: (result.stdout + result.stderr).trim() };
};
const cstr = (text: string) => Buffer.from(text + "\0");
const work = realpathSync(mkdtempSync(join(tmpdir(), "spike-")));

const { i32, u32, u64, i64, ptr: P, cstring } = FFIType;
const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  __error: { args: [], returns: P },
  strerror: { args: [i32], returns: cstring },
  flock: { args: [i32, i32], returns: i32 },
  open: { args: [P, i32, i32], returns: i32 },
  openat: { args: [i32, P, i32, i32], returns: i32 },
  close: { args: [i32], returns: i32 },
  getsid: { args: [i32], returns: i32 },
  getpgid: { args: [i32], returns: i32 },
  getpid: { args: [], returns: i32 },
  proc_pidinfo: { args: [i32, i32, u64, P, i32], returns: i32 },
  proc_pidfdinfo: { args: [i32, i32, i32, P, i32], returns: i32 },
  proc_listallpids: { args: [P, i32], returns: i32 },
  sysctlbyname: { args: [P, P, P, P, u64], returns: i32 },
  sysctl: { args: [P, u32, P, P, P, u64], returns: i32 },
  renameatx_np: { args: [i32, P, i32, P, u32], returns: i32 },
  mkdirat: { args: [i32, P, u32], returns: i32 },
  unlinkat: { args: [i32, P, i32], returns: i32 },
  fstatat: { args: [i32, P, P, i32], returns: i32 },
  fstat: { args: [i32, P], returns: i32 },
  fchmod: { args: [i32, u32], returns: i32 },
  fdopendir: { args: [i32], returns: P },
  readdir: { args: [P], returns: P },
  closedir: { args: [P], returns: i32 },
  dup: { args: [i32], returns: i32 },
  fcntl: { args: [i32, i32, P], returns: i32 },
  pathconf: { args: [P, i32], returns: i64 },
  kill: { args: [i32, i32], returns: i32 },
}).symbols;
const errno = () => read.i32(libc.__error()!, 0);
const failure = (what: string) => { const e = errno(); return `${what}: errno ${e} ${libc.strerror(e)}`; };

const O = { RDONLY: 0, WRONLY: 1, RDWR: 2, NONBLOCK: 0x4, EXLOCK: 0x20, NOFOLLOW: 0x100, CREAT: 0x200, EXCL: 0x800, DIRECTORY: 0x100000, CLOEXEC: 0x1000000 };
const AT = { FDCWD: -2, SYMLINK_NOFOLLOW: 0x20, REMOVEDIR: 0x80 };

await probe("environment", () => ({
  uname: sh("uname -a").out, arch: process.arch, sw_vers: sh("sw_vers").out, bun: Bun.version, revision: Bun.revision,
  uid: process.getuid?.(), tmpdir: tmpdir(), work,
  realpaths: { tmp: realpathSync("/tmp"), var: realpathSync("/var") },
  bash: sh("/bin/bash --version | head -1").out,
  brewBash: sh("ls -l /opt/homebrew/bin/bash 2>&1; /opt/homebrew/bin/bash --version 2>&1 | head -1").out,
  brew: sh("brew --prefix 2>&1; brew list --versions bash coreutils gnu-sed findutils 2>&1").out,
  gnu: sh("for t in gstat gsed greadlink gdate grealpath gsha256sum flock setsid timeout gtimeout uv python3 soffice; do printf '%s=%s\\n' $t \"$(command -v $t)\"; done").out,
  locales: sh("locale -a | grep -iE '^(c|en_us|zh_cn)\\.utf-?8$'").out,
  ulimit: sh("ulimit -n; ulimit -Hn; sysctl -n kern.maxfiles kern.maxfilesperproc").out,
  path: process.env.PATH,
}));

await probe("bash32", () => ({
  emptyArgsUnderSetU: sh("/bin/bash -c 'set -u; f() { echo \"n=$# [$*]\"; }; f \"$@\"' x").out,
  emptyArrayUnderSetU: sh("/bin/bash -c 'set -u; a=(); echo \"${a[@]}\" ok' 2>&1").out,
  emptyArrayGuarded: sh("/bin/bash -c 'set -u; a=(); echo ${a[@]+\"${a[@]}\"} ok' 2>&1").out,
  bsdSed: sh("printf 'token=abc\\n' | sed -E 's/(token=)[^ ]+/\\1***/'").out,
  bsdSedInPlace: sh(`f=${work}/sed.txt; echo a > $f; sed -i '' 's/a/b/' $f && cat $f`).out,
  realpathM: sh("realpath -m /nonexistent/x 2>&1; echo code=$?").out,
  statFormat: sh(`stat -f '%u %g %p' ${work}`).out,
  shasum: sh("printf x | shasum -a 256").out,
}));

await probe("errnoAndFlock", async () => {
  const path = join(work, "lock"); writeFileSync(path, "");
  const holder = spawn(process.execPath, ["-e", `
    const { dlopen, FFIType } = require("bun:ffi");
    const c = dlopen("/usr/lib/libSystem.B.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols;
    const fd = require("fs").openSync(${JSON.stringify(path)}, "r+");
    console.log("held", c.flock(fd, 2)); setTimeout(() => {}, 20000);`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((done) => holder.stdout!.once("data", () => done()));
  const fd = openSync(path, "r+");
  const rc = libc.flock(fd, 2 | 4), e = errno();
  // O_EXLOCK|O_NONBLOCK at open: the FFI-free alternative.
  const exlock = libc.open(cstr(path), O.RDWR | O.EXLOCK | O.NONBLOCK, 0), e2 = errno();
  holder.kill("SIGKILL"); await new Promise((done) => holder.once("exit", done));
  const after = libc.flock(fd, 2 | 4);
  const exlockAfter = libc.open(cstr(path), O.RDWR | O.EXLOCK | O.NONBLOCK, 0);
  closeSync(fd); if (exlockAfter >= 0) libc.close(exlockAfter);
  return { contended: { rc, errno: e, text: libc.strerror(e) }, exlockContended: { fd: exlock, errno: e2 }, afterHolderDied: after, exlockAfter: exlockAfter >= 0 };
});

await probe("variadicOpenMode", () => {
  // open/openat take their mode as a variadic argument: Apple arm64 passes it on the stack.
  const results: Record<string, string> = {};
  for (const [name, call] of [
    ["open", (p: Buffer) => libc.open(p, O.WRONLY | O.CREAT | O.EXCL, 0o600)],
    ["openat", (p: Buffer) => libc.openat(AT.FDCWD, p, O.WRONLY | O.CREAT | O.EXCL, 0o600)],
  ] as const) {
    for (let i = 0; i < 3; i++) {
      const path = join(work, `${name}-${i}`), fd = call(cstr(path));
      results[`${name}-${i}`] = fd < 0 ? failure(name) : (statSync(path).mode & 0o7777).toString(8);
      if (fd >= 0) libc.close(fd);
    }
  }
  return { umask: process.umask().toString(8), requested: "600", got: results };
});

await probe("statLayout", () => {
  const path = join(work, "variadicOpenMode-probe"); writeFileSync(path, "12345");
  const buf = new Uint8Array(256), rc = libc.fstatat(AT.FDCWD, cstr(path), ptr(buf), AT.SYMLINK_NOFOLLOW);
  if (rc !== 0) return failure("fstatat");
  const v = new DataView(buf.buffer), s = statSync(path, { bigint: true });
  return {
    dev: [v.getInt32(0, true), Number(s.dev)], mode: [v.getUint16(4, true), Number(s.mode)], nlink: [v.getUint16(6, true), Number(s.nlink)],
    ino: [v.getBigUint64(8, true).toString(), s.ino.toString()], uid: [v.getUint32(16, true), Number(s.uid)], gid: [v.getUint32(20, true), Number(s.gid)],
    size: [v.getBigInt64(96, true).toString(), s.size.toString()],
  };
});

await probe("processIdentity", async () => {
  const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
  await Bun.sleep(300);
  const pid = child.pid!, buf = new Uint8Array(136);
  const n = libc.proc_pidinfo(pid, 3 /* PROC_PIDTBSDINFO */, 0n, ptr(buf), 136);
  const v = new DataView(buf.buffer);
  const uuid = new Uint8Array(64), size = new BigUint64Array([64n]);
  const rc = libc.sysctlbyname(cstr("kern.bootsessionuuid"), ptr(uuid), ptr(size), null, 0n);
  const out = {
    bytes: n, pid: [v.getUint32(12, true), pid], ppid: [v.getUint32(16, true), process.pid], status: v.getUint32(4, true),
    comm: new TextDecoder().decode(buf.slice(48, 64)).replace(/\0.*$/s, ""), pgid: v.getUint32(100, true),
    start: { sec: v.getBigUint64(120, true).toString(), usec: v.getBigUint64(128, true).toString(), now: Date.now() },
    ps: sh(`ps -o lstart=,sess=,pgid= -p ${pid}`).out,
    bootSession: rc === 0 ? new TextDecoder().decode(uuid.slice(0, Number(size[0]))).replace(/\0.*$/s, "") : failure("sysctlbyname"),
    detachedIsSessionLeader: { getsid: libc.getsid(pid), getpgid: libc.getpgid(pid), pid },
  };
  child.kill("SIGKILL"); await new Promise((done) => child.once("exit", done));
  return out;
});

await probe("sessionSweep", async () => {
  // A detached helper (session leader) whose tree has a background child, a grandchild and a setsid() escapee.
  const script = `/bin/sleep 300 & ( /bin/sleep 301 & wait ) & /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec "/bin/sleep", "302"' & wait`;
  const leader = spawn("/bin/bash", ["-c", script], { detached: true, stdio: "ignore" });
  await Bun.sleep(700);
  const sid = libc.getsid(leader.pid!);
  const max = 8192, pids = new Int32Array(max), count = libc.proc_listallpids(ptr(pids), max * 4);
  const members: number[] = [], getsidErrors: string[] = [];
  for (const pid of pids.slice(0, count)) {
    if (pid <= 0) continue;
    const s = libc.getsid(pid);
    if (s < 0) { if (getsidErrors.length < 3) getsidErrors.push(`${pid}: ${failure("getsid")}`); continue; }
    if (s === sid) members.push(pid);
  }
  const ps = sh(`ps -axo pid=,ppid=,sess=,pgid=,stat=,command= | grep -E 'sleep 30[012]|bash -c' | grep -v grep`).out;
  // KERN_PROC_SESSION through sysctl: kinfo_proc entries (size per entry reported by the call).
  const mib = new Int32Array([1, 14, 3, sid]), len = new BigUint64Array([0n]);
  const sizeRc = libc.sysctl(ptr(mib), 4, null, ptr(len), null, 0n);
  for (const pid of members) libc.kill(pid, 9);
  await Bun.sleep(300);
  const left = sh(`ps -axo pid=,sess=,command= | grep -E 'sleep 30[012]' | grep -v grep`).out;
  sh("pkill -9 -f 'sleep 302'");
  return { leader: leader.pid, sid, listed: count, members, getsidErrors, ps, kernProcSession: { rc: sizeRc, bytes: len[0].toString(), err: sizeRc ? failure("sysctl") : "" }, leftAfterSweep: left };
});

await probe("devFdAndDirectories", () => {
  const dir = join(work, "held"); mkdirSync(dir); writeFileSync(join(dir, "child"), "x");
  const fd = libc.open(cstr(dir), O.RDONLY | O.DIRECTORY | O.CLOEXEC, 0);
  if (fd < 0) return failure("open dir");
  const viaDevFd = { childPath: existsSync(`/dev/fd/${fd}/child`), devFdStat: (() => { try { return statSync(`/dev/fd/${fd}`).isDirectory(); } catch (e) { return String(e); } })() };
  let dupWrap: unknown;
  try { const wrapped = openSync(`/dev/fd/${fd}`, "r"); dupWrap = { wrapped, same: fstatSync(wrapped).ino === statSync(dir).ino }; closeSync(wrapped); } catch (e) { dupWrap = String(e); }
  // fd-relative calls.
  const made = libc.mkdirat(fd, cstr("sub"), 0o700);
  const created = libc.openat(fd, cstr("sub/file"), O.WRONLY | O.CREAT | O.EXCL | O.NOFOLLOW, 0o600);
  const chmod = created >= 0 ? libc.fchmod(created, 0o600) : -1; if (created >= 0) libc.close(created);
  const renamed = libc.renameatx_np(fd, cstr("child"), fd, cstr("sub/file"), 0x4 /* RENAME_EXCL */), renameErr = errno();
  const renamedOk = libc.renameatx_np(fd, cstr("child"), fd, cstr("moved"), 0x4);
  const unlinked = libc.unlinkat(fd, cstr("moved"), 0);
  // F_GETPATH (50) is variadic too; proc_pidfdinfo PROC_PIDFDVNODEPATHINFO (2) is not.
  const pathBuf = new Uint8Array(1024), getPath = libc.fcntl(fd, 50, ptr(pathBuf));
  const info = new Uint8Array(1200), n = libc.proc_pidfdinfo(libc.getpid(), fd, 2, ptr(info), 1200);
  // fdopendir takes over a dup.
  const listFd = libc.dup(fd), dirp = libc.fdopendir(listFd), names: string[] = [];
  if (dirp) {
    for (let entry = libc.readdir(dirp); entry; entry = libc.readdir(dirp)) {
      const namlen = read.u16(entry, 18), name = new TextDecoder().decode(new Uint8Array(toArrayBuffer(entry, 21, namlen)));
      names.push(`${name}:${read.u8(entry, 20)}`);
    }
    libc.closedir(dirp);
  }
  libc.close(fd);
  return {
    viaDevFd, dupWrap, mkdirat: made, openatCreate: created >= 0, fchmod: chmod, modeAfterFchmod: (statSync(join(dir, "sub/file")).mode & 0o777).toString(8),
    renameExclOntoExisting: { rc: renamed, errno: renameErr }, renameExcl: renamedOk, unlinkat: unlinked,
    fGetPath: { rc: getPath, path: new CString(ptr(pathBuf)).toString() },
    pidfdinfo: { bytes: n, path: new TextDecoder().decode(info.slice(176, 176 + 1024)).replace(/\0.*$/s, "") },
    readdir: names.sort(),
  };
});

await probe("caseSensitivity", () => {
  writeFileSync(join(work, "Case.txt"), "x");
  return { pathconf: Number(libc.pathconf(cstr(work), 11 /* _PC_CASE_SENSITIVE */)), lowerExists: existsSync(join(work, "case.txt")), volume: sh(`diskutil info / | grep -iE 'Personality|Case'`).out };
});

await probe("sqlite", () => {
  const out: Record<string, unknown> = {};
  const memory = new Database(":memory:");
  out.version = memory.query("select sqlite_version() v").get();
  out.options = memory.query("pragma compile_options").all().map((row: any) => row.compile_options).filter((o: string) => /WAL|THREAD|FTS|JSON|MAX_|DQS|ENABLE_/.test(o)).slice(0, 40);
  memory.close();
  const sidecars = (path: string) => ["-wal", "-shm"].filter((suffix) => existsSync(path + suffix));
  for (const mode of ["plain", "fileControl"] as const) {
    const path = join(work, `${mode}.sqlite`), db = new Database(path);
    db.exec("pragma journal_mode=wal; create table t (x); insert into t values (1);");
    let control: unknown = null;
    if (mode === "fileControl") { try { control = db.fileControl(sqlite.SQLITE_FCNTL_PERSIST_WAL, 0); } catch (e) { control = String(e); } }
    db.close();
    out[mode] = { control, sidecarsAfterClose: sidecars(path) };
  }
  try { const db = new Database(join(work, "plain.sqlite")); out.serialize = db.serialize().byteLength; db.close(); } catch (e) { out.serialize = String(e); }
  // Read-only open of a closed WAL database in a read-only directory.
  const roDir = join(work, "ro"); mkdirSync(roDir); const roPath = join(roDir, "db.sqlite");
  { const db = new Database(roPath); db.exec("pragma journal_mode=wal; create table t (x);"); db.fileControl(sqlite.SQLITE_FCNTL_PERSIST_WAL, 0); db.close(); }
  sh(`chmod 555 ${roDir}`);
  try { const db = new Database(roPath, { readonly: true }); out.readonlyDir = db.query("select count(*) n from t").get(); db.close(); } catch (e) { out.readonlyDir = String(e); }
  sh(`chmod 755 ${roDir}`);
  out.persistWalConstant = sqlite.SQLITE_FCNTL_PERSIST_WAL;
  return out;
});

await probe("fonts", () => sh("find /System/Library/Fonts /Library/Fonts /System/Library/AssetsV2 -maxdepth 4 \\( -iname '*pingfang*' -o -iname '*hiragino*' -o -iname '*songti*' -o -iname '*stheiti*' -o -iname '*heiti*' \\) 2>/dev/null | head -20").out);

await probe("lowPort", () => new Promise((done) => {
  const server = createServer(); server.once("error", (e) => done(String(e)));
  server.listen(1011, "127.0.0.1", () => { server.close(); done("bound 1011 as uid " + process.getuid?.()); });
}));

console.log("REPORT_JSON " + JSON.stringify(report));
writeFileSync(process.env.SPIKE_REPORT ?? join(work, "report.json"), JSON.stringify(report, null, 2));
rmSync(work, { recursive: true, force: true });
process.exit(0);
