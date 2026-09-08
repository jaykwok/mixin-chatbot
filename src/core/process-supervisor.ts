// Private helper process. Windows jobs include descendants even after detached spawn;
// Linux subreaping lets us collect descendants which create their own process groups.
// Never import this module into the HTTP process: supervision must have its own lifetime.
import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

if (!import.meta.main) throw new Error("process-supervisor must run as a separate process");

let terminate: (code: number) => Promise<never>;
if (process.platform === "win32") {
  const { symbols: win } = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    GetLastError: { args: [], returns: FFIType.u32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const job = win.CreateJobObjectW(null, null);
  const limits = new Uint8Array(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64/arm64.
  new DataView(limits.buffer).setUint32(16, 0x2000, true); // KILL_ON_JOB_CLOSE; no breakaway.
  if (!job || !win.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength) ||
      !win.AssignProcessToJobObject(job, win.GetCurrentProcess())) {
    throw new Error(`无法启用 Windows 进程作业监督 (${win.GetLastError()})`);
  }
  terminate = async (code) => { win.TerminateJobObject(job, code); process.exit(code); };
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
      if (waiting === -1 && ffiRead.i32(libc.__errno_location()!) === 10) process.exit(code);
      await Bun.sleep(10);
    }
    process.stderr.write("子进程回收超过 1 秒，监督进程失败退出\n");
    process.exit(125);
  };
} else {
  throw new Error(`不支持受监督的命令执行平台: ${process.platform}`);
}

let finishing = false;
function finish(code: number): void {
  if (finishing) return;
  finishing = true;
  void terminate(code).catch((error) => { console.error(String(error)); process.exit(125); });
}
process.once("SIGTERM", () => finish(143));
process.once("SIGINT", () => finish(130));
process.stdin.once("end", () => finish(143)); // Parent died or cancelled, including forced parent exit.
process.stdin.once("error", () => finish(143));

let input = "";
let started = false;
process.stdin.on("data", (chunk) => {
  if (started || finishing) return;
  input += String(chunk);
  if (input.length > 2 * 1024 * 1024) return finish(125);
  const newline = input.indexOf("\n");
  if (newline < 0) return;
  started = true;
  try {
    const request = JSON.parse(input.slice(0, newline)) as {
      command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
    };
    input = "";
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: request.env, shell: false, windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", (error) => { process.stderr.write(String(error)); finish(127); });
    child.once("exit", (code) => finish(code ?? 1));
  } catch (error) {
    process.stderr.write(String(error));
    finish(125);
  }
});
