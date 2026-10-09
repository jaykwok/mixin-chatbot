import { dlopen, FFIType, ptr } from "bun:ffi";

let native: ReturnType<typeof load> | undefined;
function load() {
  return dlopen("kernel32.dll", {
    OpenJobObjectW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
}

/** Held by the parent outside the job, so helper exit alone is never proof of descendant exit. */
export function monitorJob(name: string) {
  const win = native ??= load(), wide = Buffer.from(name + "\0", "utf16le");
  const handle = win.OpenJobObjectW(0x4 | 0x8, 0, ptr(wide));
  if (!handle) throw new Error(`OpenJobObjectW failed (${win.GetLastError()})`);
  let closed = false, closeFailure: Error | undefined;
  return {
    active(): number {
      const info = new Uint8Array(48);
      if (!win.QueryInformationJobObject(handle, 1, ptr(info), info.byteLength, null)) throw new Error(`QueryInformationJobObject failed (${win.GetLastError()})`);
      return new DataView(info.buffer).getUint32(40, true);
    },
    terminate() {
      if (!win.TerminateJobObject(handle, 125)) throw new Error(`TerminateJobObject failed (${win.GetLastError()})`);
    },
    close() {
      if (closed) { if (closeFailure) throw closeFailure; return; }
      closed = true;
      if (!win.CloseHandle(handle)) { closeFailure = new Error(`CloseHandle(job) failed (${win.GetLastError()})`); throw closeFailure; }
    },
  };
}
