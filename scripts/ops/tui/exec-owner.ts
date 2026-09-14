// The UI can terminate query hosts independently of the Worker. Each host supervises
// its descendants; killing a Windows host closes its KILL_ON_JOB_CLOSE handle.
import { readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";

export interface QueryOwner {
  stop(): Promise<void>;
}

function linuxIdentity(pid: number): { birth: string; zombie: boolean } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return { birth: fields[19]!, zombie: fields[0] === "Z" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function windowsApi() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
}
let win: ReturnType<typeof windowsApi> | undefined;

export function ownQueryHost(pid: number, exited: Promise<void>, expectedBirth?: string): QueryOwner {
  if (!["win32", "linux"].includes(process.platform)) throw new Error(`不支持查询进程监督: ${process.platform}`);
  // The host reports its own creation time before receiving execution permission.
  // Open/verify a stable handle only for the lost-ack fallback: cold FFI setup must
  // not block ordinary UI queries or consume the host's ownership deadline.
  if (process.platform === "win32" && !expectedBirth) throw new Error("查询进程缺少身份信息");
  let api: ReturnType<typeof windowsApi> | undefined;
  let handle: ReturnType<ReturnType<typeof windowsApi>["OpenProcess"]>;
  const birth = process.platform === "linux" ? linuxIdentity(pid)?.birth : undefined;
  const alive = (): boolean => {
    if (process.platform === "linux") {
      const identity = linuxIdentity(pid);
      return !!identity && identity.birth === birth && !identity.zombie;
    }
    if (!api) {
      api = win ??= windowsApi();
      handle = api.OpenProcess(0x100000 | 0x1000 | 1, 0, pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION | TERMINATE
      if (!handle) {
        if (api.GetLastError() === 87) return false; // process already gone
        throw new Error(`无法持有查询进程 (${api.GetLastError()})`);
      }
      const times = new BigUint64Array(4);
      if (!api.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) {
        throw new Error(`无法读取查询进程身份 (${api.GetLastError()})`);
      }
      if (String(times[0]) !== expectedBirth) return false;
    }
    const status = api.WaitForSingleObject(handle!, 0);
    if (status === 0) return false;
    if (status === 258) return true;
    throw new Error(`无法读取查询进程状态 (${api!.GetLastError()})`);
  };
  let stopping: Promise<void> | undefined;
  return {
    stop: () => stopping ??= (async () => {
      // EOF normally lets the host reap and acknowledge exit promptly. Avoid a
      // cold Windows process.kill call in the UI unless the Worker loses that ack.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const confirmed = await Promise.race([exited.then(() => true), new Promise<false>(resolve => {
          timer = setTimeout(() => resolve(false), 300);
        })]);
        if (confirmed) return;
      } finally { clearTimeout(timer); }
      const deadline = Date.now() + 5000;
      let signalled = false;
      for (;;) {
        if (!alive()) return;
        if (!signalled) {
          if (api) {
            if (!api.TerminateProcess(handle!, 130) && alive()) throw new Error(`无法终止查询进程 (${api.GetLastError()})`);
          } else {
            try { process.kill(pid, "SIGTERM"); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
          signalled = true;
        }
        // Linux must keep its subreaper alive until detached descendants are reaped.
        if (Date.now() >= deadline) throw new Error("等待查询进程树回收超时");
        await Bun.sleep(10);
      }
    })().finally(() => { if (api && handle) api.CloseHandle(handle); }),
  };
}
