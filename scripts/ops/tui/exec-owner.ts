// Used by the reclaim thread (exec-reaper.ts), never by the UI thread: opening a process can block for
// seconds. Each host supervises its descendants; killing a Windows host closes its KILL_ON_JOB_CLOSE handle.
import { readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { WindowsHandles, type WindowsHandle } from "../../../src/core/windows-handles.ts";

export interface QueryOwner {
  stop(): Promise<void>;
}

/** Resource cleanup is independent of whether the process exit was confirmed. Keep both causes for the reaper. */
export class QueryHandleCleanupError extends AggregateError {
  constructor(readonly cleanupError: unknown, readonly reclaimError?: unknown) {
    super([...(reclaimError === undefined ? [] : [reclaimError]), cleanupError], "查询进程句柄关闭失败", { cause: reclaimError });
  }
}

/** Wait for the spawner's exit ack before opening the process at all. */
const ACK_GRACE_MS = 300;
/** Counted from the termination request, not from opening the process (which can block for seconds). */
const TERMINATION_WAIT_MS = 30_000;
/** After a failed fallback, for an ack already queued behind it. QueryPool's final drain covers all three. */
const LATE_ACK_MS = 1_000;

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
type Loaded = ReturnType<typeof windowsApi>;
type Native = { [Name in keyof Loaded]: (...args: Parameters<Loaded[Name]>) => ReturnType<Loaded[Name]> };
let win: Loaded | undefined;

/** `native` replaces single kernel32 calls, e.g. to inject a blocking OpenProcess. */
export function ownQueryHost(pid: number, exited: Promise<void>, expectedBirth?: string, native?: Partial<Native>): QueryOwner {
  if (!["win32", "linux"].includes(process.platform)) throw new Error(`不支持查询进程监督: ${process.platform}`);
  // The host reports its own creation time before receiving execution permission. A handle is opened
  // and verified only for the lost-ack fallback, so ownership grants never wait for cold FFI setup.
  if (process.platform === "win32" && !expectedBirth) throw new Error("查询进程缺少身份信息");
  let api: Native | undefined;
  let handle: ReturnType<Native["OpenProcess"]>;
  let owned: WindowsHandle | undefined, failure: unknown;
  const birth = process.platform === "linux" ? linuxIdentity(pid)?.birth : undefined;
  const alive = (): boolean => {
    if (process.platform === "linux") {
      const identity = linuxIdentity(pid);
      return !!identity && identity.birth === birth && !identity.zombie;
    }
    if (!api) {
      api = { ...(win ??= windowsApi()), ...native };
      // The TUI owns the terminal: stderr would draw over the alternate screen. Failures still throw.
      const resources = new WindowsHandles({ observe: () => {}, closeNative: { CloseHandle: value => api!.CloseHandle(BigInt(value)), GetLastError: () => api!.GetLastError() } });
      resources.record({ phase: "open", operation: "OpenProcess", path: `query:${pid}` });
      handle = api.OpenProcess(0x100000 | 0x1000 | 1, 0, pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION | TERMINATE
      if (!handle) {
        const nativeError = api.GetLastError();
        if (nativeError === 87) return false; // process already gone
        throw new Error(`无法持有查询进程 (${nativeError})`);
      }
      owned = resources.own(BigInt(handle), `query:${pid}`, "OpenProcess");
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
  // The spawner's exit acknowledgement is proof on its own: the host has exited, and with its job or
  // subreaper the tree is gone. It is final, whatever the native fallback reports before or after it. It
  // settles only the process question: handle cleanup below still runs, and its failure is still reported.
  let acknowledged = false;
  void exited.then(() => { acknowledged = true; });
  const acknowledgedWithin = async (ms: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    } finally { clearTimeout(timer); }
  };
  let stopping: Promise<void> | undefined;
  return {
    stop: () => stopping ??= (async () => {
      // EOF normally lets the host reap and the spawner acknowledge its exit promptly. Open the
      // process only when that ack is late: the spawner may be blocked in a spawn or gone.
      if (await acknowledgedWithin(ACK_GRACE_MS)) return;
      // Opening the Windows handle can itself block for seconds under endpoint security, and a host blocked
      // in its own process creation dies only once that returns. The deadline therefore bounds only the
      // wait after termination, is checked at least once, and covers several such stalls.
      let deadline: number | undefined;
      for (;;) {
        if (acknowledged || !alive()) return;
        if (deadline === undefined) {
          if (api) {
            if (!api.TerminateProcess(handle!, 130)) {
              const nativeError = api.GetLastError();
              if (alive()) throw new Error(`无法终止查询进程 (${nativeError})`);
            }
          } else {
            try { process.kill(pid, "SIGTERM"); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
          deadline = Date.now() + TERMINATION_WAIT_MS;
        } else if (Date.now() >= deadline) {
          // Linux must keep its subreaper alive until detached descendants are reaped.
          throw new Error("等待查询进程树回收超时");
        }
        await Bun.sleep(10);
      }
    })().catch(async error => {
      // The acknowledgement travels on another channel and can be queued behind the native call that failed.
      // Bounded: a spawner that is gone never sends one, and the original error is then reported.
      if (await acknowledgedWithin(LATE_ACK_MS)) return;
      failure = error;
      throw error;
    }).finally(() => {
      try { owned?.close(); }
      catch (error) { throw new QueryHandleCleanupError(error, failure); }
    }),
  };
}
