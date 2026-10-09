import { dlopen, FFIType } from "bun:ffi";

type Entity = { dev: bigint; ino: bigint };
type Loaded = ReturnType<typeof loadNative>;
type Native = { [Name in keyof Loaded]: (...args: Parameters<Loaded[Name]>) => ReturnType<Loaded[Name]> };
export type HandleEvent = {
  sequence: number; pid: number; monotonicMs: number; operation: string; path: string;
  phase: "open" | "owned" | "identity" | "result" | "close-attempt" | "close-result";
  openSequence?: number; handle?: string; identity?: { dev: string; ino: string };
  success?: boolean; win32?: number; ntstatus?: number;
};

const WIN32_CODES: Record<number, string> = {
  2: "ENOENT", 3: "ENOENT", 5: "EPERM", 6: "EBADF", 32: "EBUSY", 33: "EBUSY", 80: "EEXIST", 112: "ENOSPC",
  145: "ENOTEMPTY", 183: "EEXIST", 267: "ENOTDIR", 1921: "ELOOP",
};
let sequence = 0, openSequence = 0;

function loadNative() {
  const kernel32 = dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    GetFileInformationByHandle: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    GetFinalPathNameByHandleW: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
  const ntdll = dlopen("ntdll.dll", {
    NtCreateFile: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    NtSetInformationFile: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    RtlNtStatusToDosError: { args: [FFIType.i32], returns: FFIType.u32 },
  }).symbols;
  return { ...kernel32, ...ntdll };
}

/** Explicit native dependency and observation sink; no module/global substitution is needed for fault injection. */
export class WindowsHandles {
  #native: Native | undefined;
  constructor(private readonly options: { native?: Native; closeNative?: Pick<Native, "CloseHandle" | "GetLastError">; observe?: (event: HandleEvent) => void } = {}) {}
  get native(): Native { return this.#native ??= this.options.native ?? loadNative(); }
  get closingNative(): Pick<Native, "CloseHandle" | "GetLastError"> { return this.options.closeNative ?? this.native; }

  record(event: Omit<HandleEvent, "sequence" | "pid" | "monotonicMs">): void {
    const value = { sequence: ++sequence, pid: process.pid, monotonicMs: performance.now(), ...event };
    // A broken diagnostic sink cannot interrupt adoption or cleanup of a native resource.
    try {
      if (this.options.observe) this.options.observe(value);
      else console.error(`held-directory-native ${JSON.stringify(value)}`);
    } catch (error) { console.error(`held-directory-native observer failed: ${String(error)}`); }
  }

  own(value: bigint, path: string, operation: string, ntstatus?: number): WindowsHandle {
    const handle = new WindowsHandle(this, value, path, ++openSequence);
    handle.record("owned", operation, { success: true, ntstatus });
    return handle;
  }

  error(operation: string, path: string, win32: number, ntstatus?: number): Error {
    return Object.assign(new Error(`could not ${operation} ${path} (Windows error ${win32}${ntstatus === undefined ? "" : `, NTSTATUS 0x${ntstatus.toString(16)}`})`), {
      code: WIN32_CODES[win32] ?? `WIN32_${win32}`, win32, ntstatus, operation, path,
    });
  }

  /** Close every owner, even after a failure; keep the business failure as the cause. */
  async closeAll(handles: WindowsHandle[], cause?: unknown): Promise<void> {
    const errors: unknown[] = [];
    for (const handle of handles.splice(0).reverse()) {
      try { handle.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, "Windows handle cleanup failed", { cause }), { code: "EIO" });
  }
}

/** One owner per successful open. Even a failed close is terminal: never retry a possibly reused numeric handle. */
export class WindowsHandle {
  identity: Entity | undefined;
  #attempted = false;
  #failure: unknown;
  constructor(readonly resources: WindowsHandles, private readonly rawValue: bigint, readonly path: string, readonly openSequence: number) {}
  get value(): bigint {
    if (this.#attempted) throw Object.assign(new Error(`native handle for ${this.path} is no longer owned`), { code: "EBADF", openSequence: this.openSequence });
    return this.rawValue;
  }
  record(phase: HandleEvent["phase"], operation: string, extra: Partial<HandleEvent> = {}): void {
    this.resources.record({ phase, operation, path: this.path, openSequence: this.openSequence, handle: this.rawValue.toString(),
      identity: this.identity && { dev: this.identity.dev.toString(), ino: this.identity.ino.toString() }, ...extra });
  }
  identify(identity: Entity): void { this.identity = identity; this.record("identity", "GetFileInformationByHandle"); }
  close(): void {
    if (this.#attempted) { if (this.#failure) throw this.#failure; return; }
    this.#attempted = true;
    this.record("close-attempt", "CloseHandle");
    let result: number;
    try { result = this.resources.closingNative.CloseHandle(this.rawValue); }
    catch (error) { this.#failure = error; this.record("close-result", "CloseHandle", { success: false }); throw error; }
    // Capture before the observer, error formatting, or another native operation can clobber LastError.
    const win32 = result ? undefined : this.resources.closingNative.GetLastError();
    if (!result) this.#failure = Object.assign(this.resources.error("close handle for", this.path, win32!), {
      handle: this.rawValue.toString(), openSequence: this.openSequence, identity: this.identity,
    });
    this.record("close-result", "CloseHandle", { success: !!result, win32 });
    if (this.#failure) throw this.#failure;
  }
}

/** Run all cleanup actions and preserve the original business error when any cleanup also fails. */
export async function finishWindows(actions: (() => void | Promise<void>)[], cause?: unknown): Promise<void> {
  const errors: unknown[] = [];
  for (const action of actions) { try { await action(); } catch (error) { errors.push(error); } }
  if (errors.length) throw Object.assign(new AggregateError(errors, "Windows resource cleanup failed", { cause }), { code: "EIO" });
}
