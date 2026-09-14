// Private, persistent query process. It cannot execute a command until the UI has
// acknowledged ownership. Never use this process for maintenance or browser launch.
import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";
import { readdir, readFile } from "node:fs/promises";
import type { FromHost, ToHost } from "./exec-protocol.ts";

if (!import.meta.main) throw new Error("exec-host must run as a separate process");

let reap = async (): Promise<void> => {};
let hasDescendants = () => false;
let exit = () => process.exit(130);
let birth: string | undefined;
if (process.platform === "win32") {
  // FFI initialization can itself block on Windows, so it belongs in this host.
  // The handle is non-inheritable. Even a forced host kill closes the last handle
  // and kills the entire query tree, including detached grandchildren.
  const { symbols: win } = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const times = new BigUint64Array(4);
  if (!win.GetProcessTimes(win.GetCurrentProcess(), ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) {
    throw new Error(`无法读取查询进程身份 (${win.GetLastError()})`);
  }
  birth = String(times[0]);
  const job = win.CreateJobObjectW(null, null);
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, 0x2000, true); // KILL_ON_JOB_CLOSE; no breakaway
  if (!job || !win.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength) ||
      !win.AssignProcessToJobObject(job, win.GetCurrentProcess())) {
    throw new Error(`无法启用查询进程作业监督 (${win.GetLastError()})`);
  }
  hasDescendants = () => {
    const info = new Uint8Array(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    if (!win.QueryInformationJobObject(job, 1, ptr(info), info.byteLength, null)) throw new Error("无法读取查询进程状态");
    return new DataView(info.buffer).getUint32(40, true) > 1;
  };
  exit = () => { win.TerminateJobObject(job, 130); process.exit(130); };
} else if (process.platform === "linux") {
  const { symbols: libc } = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  if (libc.prctl(36, 1, 0, 0, 0) !== 0 || libc.prctl(1, 15, 0, 0, 0) !== 0) {
    throw new Error("无法启用查询子进程回收监督");
  }
  // PDEATHSIG is not retroactive if the parent died before prctl.
  if (process.ppid !== Number(process.argv[2])) process.exit(130);
  let reaping: Promise<void> | undefined;
  reap = () => reaping ??= (async () => {
    for (;;) {
      const tids = await readdir("/proc/self/task");
      const lists = await Promise.all(tids.map(async tid => {
        try { return await readFile(`/proc/self/task/${tid}/children`, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
      }));
      // Detached grandchildren are adopted here. Inspect every Bun thread, not
      // only the main task, and keep reaping until waitpid proves ECHILD.
      const children = new Set(lists.flatMap(list => list.trim().split(/\s+/).filter(Boolean)));
      for (const child of children) { try { process.kill(Number(child), "SIGKILL"); } catch {} }
      let status: number;
      do { status = libc.waitpid(-1, null, 1); } while (status > 0);
      if (status === -1 && ffiRead.i32(libc.__errno_location()!) === 10) return;
      await Bun.sleep(10);
    }
  })().finally(() => { reaping = undefined; });
}

let closing = false;
function stop(): void {
  if (closing) return;
  closing = true;
  void reap().then(exit, error => { console.error(error); exit(); });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("SIGHUP", stop);
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);
process.stdin.on("end", stop);
process.stdin.on("error", stop);

// A Worker which dies between spawn and publishing the PID leaves only this idle
// host; it self-exits without ever having permission to start a query.
const ownershipDeadline = setTimeout(stop, 5000);
let owned = false;
let busy = false;
const send = (message: FromHost): void => { process.stdout.write(JSON.stringify(message) + "\n"); };
async function handle(message: ToHost): Promise<void> {
  if (closing) return;
  if (message.type === "owned") { owned = true; clearTimeout(ownershipDeadline); return; }
  if (!owned || busy) throw new Error("查询进程未取得执行许可");
  busy = true;
  const { id, command, args, env, input } = message.request;
  try {
    const child = Bun.spawn([command, ...args], {
      cwd: process.cwd(), env, windowsHide: true,
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe", stderr: "pipe",
    });
    send({ type: "started", id, at: Date.now() });
    const read = async (stream: "stdout" | "stderr"): Promise<string> => {
      const decoder = new TextDecoder();
      let output = "";
      const append = (text: string) => {
        output += text;
        if (text) send({ type: "output", id, stream, text });
      };
      for await (const chunk of child[stream]) append(decoder.decode(chunk, { stream: true }));
      append(decoder.decode());
      return output;
    };
    // Attach rejection handlers immediately, while child.exited and reaping run.
    const output = Promise.all([read("stdout"), read("stderr")])
      .then(value => ({ value }), error => ({ error }));
    const code = await child.exited;
    await reap();
    const result = await output;
    if ("error" in result) throw result.error;
    const [stdout, stderr] = result.value;
    // Windows Job accounting and short-lived command helpers can lag child.exited.
    // Give them a bounded drain period before deciding a host has stray descendants.
    const deadline = Date.now() + 100;
    let remaining = hasDescendants();
    while (remaining && !closing && Date.now() < deadline) { await Bun.sleep(5); remaining = hasDescendants(); }
    if (!closing) send({ type: "result", id, retire: remaining, outcome: { result: { code, stdout, stderr, timedOut: false } } });
  } catch (error) {
    await reap();
    if (!closing) send({ type: "result", id, outcome: { error: String(error instanceof Error ? error.message : error) } });
  } finally { busy = false; }
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += String(chunk);
  for (let newline; (newline = buffer.indexOf("\n")) >= 0;) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try { void handle(JSON.parse(line) as ToHost).catch(stop); } catch { stop(); }
  }
});
send({ type: "ready", birth });
