// Private helper process. Windows jobs include descendants even after detached spawn;
// Linux subreaping lets us collect descendants which create their own process groups.
// Never import this module into the HTTP process: supervision must have its own lifetime.
import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createReadStream, writeSync } from "node:fs";
import { assertReceiptDirectory, writeProcessReceipt, type ProcessReceipt } from "./process-receipt.ts";

const startedAt = performance.now();
function event(phase: string, data: Record<string, unknown> = {}) {
  if (process.env.MIXIN_PROCESS_EVENTS !== "1") return;
  try { writeSync(3, JSON.stringify({ phase, elapsedMs: performance.now() - startedAt, ...data }) + "\n"); } catch {}
}

let terminate: (code: number) => Promise<never>;
/** macOS: called before a command may exit on its own, which would take its setsid descendants out of reach. */
let remember = () => {};
const receipt: ProcessReceipt | undefined = process.env.MIXIN_PROCESS_REAP_RECEIPT && process.env.MIXIN_PROCESS_EVENTS === "1"
  ? JSON.parse(process.env.MIXIN_PROCESS_REAP_RECEIPT) : undefined;
if (receipt) assertReceiptDirectory(receipt);
if (process.platform === "win32") {
  const { symbols: win } = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    GetLastError: { args: [], returns: FFIType.u32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const name = process.env.MIXIN_PROCESS_EVENTS === "1" ? Buffer.from(process.env.MIXIN_PROCESS_JOB + "\0", "utf16le") : null;
  const job = win.CreateJobObjectW(null, name ? ptr(name) : null);
  const limits = new Uint8Array(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64/arm64.
  new DataView(limits.buffer).setUint32(16, 0x2000, true); // KILL_ON_JOB_CLOSE; no breakaway.
  if (!job || !win.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength) ||
      !win.AssignProcessToJobObject(job, win.GetCurrentProcess())) {
    throw new Error(`无法启用 Windows 进程作业监督 (${win.GetLastError()})`);
  }
  terminate = async (code) => {
    event("reaping", { code });
    if (!win.TerminateJobObject(job, code)) throw new Error(`TerminateJobObject failed (${win.GetLastError()})`);
    process.exit(code);
  };
} else if (process.platform === "linux") {
  const { symbols: libc } = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  if (libc.prctl(36, 1, 0, 0, 0) !== 0 || libc.prctl(1, 15, 0, 0, 0) !== 0) {
    throw new Error("无法启用 Linux 子进程回收监督");
  }
  terminate = async (code) => {
    // Kill direct children repeatedly: grandchildren are adopted here as their parents exit.
    for (let round = 0; round < 100; round++) {
      // Bun may spawn from a worker thread. Each /proc task lists only its own
      // children, so reading the main thread alone can miss live descendants.
      const tids = await readdir("/proc/self/task");
      const lists = await Promise.all(tids.map(async (tid) => {
        try { return await readFile(`/proc/self/task/${tid}/children`, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
      }));
      const children = new Set(lists.flatMap((list) => list.trim().split(/\s+/).filter(Boolean)));
      for (const value of children) {
        try { process.kill(Number(value), "SIGKILL"); } catch {}
      }
      let waiting: number;
      do { waiting = libc.waitpid(-1, null, 1); } while (waiting > 0);
      // A /proc snapshot can omit children during exit/adoption. Only ECHILD
      // proves there is nothing left; 0 means a child is still running.
      if (waiting === -1 && ffiRead.i32(libc.__errno_location()!) === 10) {
        if (receipt) writeProcessReceipt(receipt, "reaped");
        event("reaped", { code }); process.exit(code);
      }
      await Bun.sleep(10);
    }
    process.stderr.write("子进程回收超过 1 秒，监督进程失败退出\n");
    process.exit(125);
  };
} else if (process.platform === "darwin") {
  // No subreaper: the helper leads a session of its own and kills its session and its descendants by parent
  // links (src/lib/darwin.ts killDescendants) until none is left. A descendant that called setsid() and whose parent
  // has already exited is not reached, so this never writes a reap receipt (src/lib/process-receipt.ts accepts none off
  // Linux).
  const { descendants, dropIdentity, killDescendants, leadSession, reapChildren } = await import("./darwin.ts");
  leadSession();
  if (process.env.MIXIN_PROCESS_IDENTITY) {
    const [uid, gid] = process.env.MIXIN_PROCESS_IDENTITY.split(":").map(Number);
    dropIdentity(uid!, gid!);
  }
  const sid = process.pid;
  let known: ReadonlyMap<number, string> = new Map();
  remember = () => { known = descendants(sid); };
  terminate = async (code) => {
    for (let round = 0; round < 100; round++) {
      const signalled = killDescendants(sid, known);
      const childless = reapChildren();
      if (signalled === 0 && childless) { event("reaped", { code }); process.exit(code); }
      await Bun.sleep(10);
    }
    process.stderr.write("子进程回收超过 1 秒，监督进程失败退出\n");
    process.exit(125);
  };
} else {
  throw new Error(`不支持受监督的命令执行平台: ${process.platform}`);
}

event("supervisor-ready", { pid: process.pid, detail: `jit=${process.env.BUN_JSC_jitMemoryReservationSize ?? "default"}` });
let finishing = false;
const stdioMode = process.argv[2] === "--stdio";
let stdioChild: ReturnType<typeof spawn> | undefined;
function finish(code: number): void {
  if (finishing) return;
  finishing = true;
  void terminate(code).catch((error) => { console.error(String(error)); process.exit(125); });
}
// Keep handlers installed throughout asynchronous reaping. A second signal must
// not restore the default termination action and strand the remaining descendants.
process.on("SIGTERM", () => finish(143));
process.on("SIGINT", () => finish(130));
process.stdin.once("end", () => {
  if (!stdioChild) return finish(143);
  // MCP EOF is graceful for a short interval; the same job/subreaper still owns every descendant.
  remember();
  stdioChild.stdin?.end();
  setTimeout(() => finish(143), 500);
}); // Parent died or cancelled, including forced parent exit.
process.stdin.once("error", () => finish(143));

let input = Buffer.alloc(0);
let started = false;
process.stdin.on("data", (chunk) => {
  if (started || finishing) return;
  input = Buffer.concat([input, chunk]);
  if (input.length > 2 * 1024 * 1024) return finish(125);
  const newline = input.indexOf(10);
  if (newline < 0) return;
  started = true;
  try {
    const request = JSON.parse(input.subarray(0, newline).toString("utf8")) as {
      command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdinBytes?: number;
    };
    input = Buffer.alloc(0);
    if (request.stdinBytes !== undefined && (!Number.isSafeInteger(request.stdinBytes) || request.stdinBytes < 0 || request.stdinBytes > 40 * 1024 * 1024)) {
      throw new Error("Invalid command input length");
    }
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: request.env, shell: false, windowsHide: true,
      stdio: [request.stdinBytes === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
    if (request.stdinBytes !== undefined) {
      // fd 0 stays responsive to parent death even while a slow command backpressures fd 4.
      const source = createReadStream("", { fd: 4, autoClose: true });
      let remaining = request.stdinBytes;
      source.on("data", chunk => {
        if (finishing) return;
        const bytes = chunk as Buffer;
        if (bytes.length > remaining) return finish(125);
        remaining -= bytes.length;
        if (!child.stdin!.write(bytes)) source.pause();
      });
      child.stdin!.on("drain", () => source.resume());
      child.stdin!.on("error", error => {
        source.destroy();
        if (!finishing && !["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"].includes((error as NodeJS.ErrnoException).code ?? "")) finish(125);
      });
      source.once("end", () => {
        if (remaining !== 0) return finish(125);
        child.stdin!.end();
      });
      source.once("error", () => { if (!finishing) finish(125); });
    }
    child.once("spawn", () => event("spawned", { pid: child.pid }));
    child.once("error", (error) => {
      // Our waitpid loop can reap this child before Bun's exit watcher does.
      // During cleanup, its ECHILD must not write to a dead parent's stderr:
      // the resulting EPIPE would exit us before adopted descendants are reaped.
      if (finishing) return;
      event("spawn-error", { detail: String(error), pid: child.pid });
      process.stderr.write(String(error));
      finish(127);
    });
    child.once("exit", (code, signal) => { event("command-exit", { code, signal, pid: child.pid }); finish(code ?? 1); });
  } catch (error) {
    process.stderr.write(String(error));
    finish(125);
  }
});

if (stdioMode) {
  const command = process.argv[3];
  if (!command) throw new Error("stdio supervisor needs a command");
  started = true;
  // The JIT region is this supervisor's own (SUPERVISOR_ENV): the server runs with the value its configuration gave, or Bun's default.
  const { BUN_JSC_jitMemoryReservationSize: _, MIXIN_STDIO_COMMAND_JIT: jit, ...env } = process.env;
  stdioChild = spawn(command, process.argv.slice(4), { cwd: process.cwd(), env: jit === undefined ? env : { ...env, BUN_JSC_jitMemoryReservationSize: jit },
    shell: false, windowsHide: true, stdio: ["pipe", "inherit", "inherit"] });
  stdioChild.once("error", error => { if (!finishing) { process.stderr.write(String(error)); finish(127); } });
  stdioChild.once("exit", code => finish(code ?? 1));
  stdioChild.stdin?.on("error", () => finish(143));
  process.stdin.pipe(stdioChild.stdin!);
}
