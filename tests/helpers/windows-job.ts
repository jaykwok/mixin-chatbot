import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

const HANDLE = FFIType.u64;
// Loaded with the module: with some security software, the first process calls after loading take seconds.
const kernel32 = process.platform === "win32" ? dlopen("kernel32.dll", {
  CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: HANDLE },
  SetInformationJobObject: { args: [HANDLE, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  AssignProcessToJobObject: { args: [HANDLE, HANDLE], returns: FFIType.i32 },
  TerminateJobObject: { args: [HANDLE, FFIType.u32], returns: FFIType.i32 },
  QueryInformationJobObject: { args: [HANDLE, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, HANDLE], returns: HANDLE },
  InitializeProcThreadAttributeList: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  UpdateProcThreadAttribute: { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
  CreateProcessW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  ResumeThread: { args: [HANDLE], returns: FFIType.u32 },
  TerminateProcess: { args: [HANDLE, FFIType.u32], returns: FFIType.i32 },
  WaitForSingleObject: { args: [HANDLE, FFIType.u32], returns: FFIType.u32 },
  GetExitCodeProcess: { args: [HANDLE, FFIType.ptr], returns: FFIType.i32 },
  CloseHandle: { args: [HANDLE], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
}).symbols : undefined;

/** A command started inside a job object of its own. */
export interface JobCommand {
  readonly pid: number;
  /** The command's own exit code. */
  readonly exited: Promise<number>;
  /** What the command wrote to stdout and stderr until it exited. */
  output(): Promise<{ out: string; err: string }>;
  /** Ends the command itself. */
  kill(): void;
  /** Whether any process of the job still runs, descendants of an exited command included. */
  running(): boolean;
  /** Ends every process of the job. */
  killTree(): void;
  close(): void;
}

const wide = (text: string) => Buffer.from(text + "\0", "utf16le");

/** Quotes one argument as libuv (and so Bun.spawn) does, for the MSVCRT rules most programs parse with. */
function quote(arg: string) {
  if (arg === "") return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  let quoted = '"', backslashes = 0;
  for (const char of arg) {
    if (char === "\\") { backslashes++; continue; }
    quoted += "\\".repeat(char === '"' ? backslashes * 2 + 1 : backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** Names are case-insensitive on Windows: a later name overrides an earlier one in another case. */
function environment(env: Record<string, string | undefined>) {
  const entries = new Map<string, [string, string]>();
  for (const [name, value] of Object.entries(env)) {
    const key = name.toUpperCase();
    entries.delete(key);
    if (value !== undefined) entries.set(key, [name, value]);
  }
  return entries;
}

/**
 * Starts a command suspended, puts it into a new job object and only then lets it run, so the command and every
 * process it starts belong to the job from their first instruction; a process never leaves its job, and its children
 * are created in it. stdin comes from NUL or `input`; stdout and stderr go to files in `ioDir`, which are the only
 * handles the command inherits. `afterCreate` runs while the command exists but has not run, for tests of that order.
 */
export function startInJob(args: string[], options: { cwd: string; env: Record<string, string | undefined>; input?: string; ioDir: string; afterCreate?: (pid: number) => void }): JobCommand {
  const k = kernel32!;
  const fail = (what: string) => new Error(`${what}（Windows 错误 ${k.GetLastError()}）`);
  const env = environment(options.env);
  const program = Bun.which(args[0]!, { PATH: env.get("PATH")?.[1] ?? "", cwd: options.cwd });
  if (!program) throw new Error(`找不到命令：${args[0]}`);
  const name = join(options.ioDir, randomUUID());
  const files = { out: name + ".out", err: name + ".err", in: options.input === undefined ? undefined : name + ".in" };
  if (files.in) writeFileSync(files.in, options.input!);

  const job = k.CreateJobObjectW(null, null);
  if (!job) throw fail("无法创建作业对象");
  // Anything still in the job when its last handle closes, because the test process itself ended, is ended too.
  const limits = new BigUint64Array(18); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION; LimitFlags at byte 16
  new DataView(limits.buffer).setUint32(16, 0x2000 /* JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE */, true);
  k.SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, ptr(limits), limits.byteLength);

  const inheritable = new Uint8Array(24); // SECURITY_ATTRIBUTES with bInheritHandle
  new DataView(inheritable.buffer).setUint32(0, 24, true);
  new DataView(inheritable.buffer).setUint32(16, 1, true);
  const handles: bigint[] = [];
  const open = (path: string, write: boolean) => {
    const file = wide(path);
    const handle = k.CreateFileW(ptr(file), write ? 0x40000000 : 0x80000000, 7 /* share read, write, delete */, ptr(inheritable),
      write ? 2 /* CREATE_ALWAYS */ : 3 /* OPEN_EXISTING */, 0x80, 0n) as bigint;
    if (handle === 0xffffffffffffffffn) throw fail(`无法打开 ${path}`);
    handles.push(handle);
    return handle;
  };
  const information = new BigUint64Array(3); // PROCESS_INFORMATION: hProcess, hThread, dwProcessId
  try {
    const stdio = new BigUint64Array([open(files.in ?? "NUL", false), open(files.out, true), open(files.err, true)]);
    const size = new BigUint64Array(1);
    k.InitializeProcThreadAttributeList(null, 1, 0, ptr(size));
    const attributes = new Uint8Array(Number(size[0]));
    if (!k.InitializeProcThreadAttributeList(ptr(attributes), 1, 0, ptr(size))) throw fail("无法初始化进程属性");
    try {
      if (!k.UpdateProcThreadAttribute(ptr(attributes), 0, 0x20002n /* PROC_THREAD_ATTRIBUTE_HANDLE_LIST */, ptr(stdio), BigInt(stdio.byteLength), null, null)) {
        throw fail("无法设置继承的句柄");
      }
      const startup = new DataView(new ArrayBuffer(112)); // STARTUPINFOEXW
      startup.setUint32(0, 112, true);
      startup.setUint32(60, 0x100 /* STARTF_USESTDHANDLES */ | 0x1 /* STARTF_USESHOWWINDOW */, true);
      startup.setUint16(64, 0 /* SW_HIDE */, true);
      startup.setBigUint64(80, stdio[0]!, true); startup.setBigUint64(88, stdio[1]!, true); startup.setBigUint64(96, stdio[2]!, true);
      startup.setBigUint64(104, BigInt(ptr(attributes)), true);
      const block = [...env.values()].sort(([a], [b]) => a.toUpperCase() < b.toUpperCase() ? -1 : 1).map(([key, value]) => `${key}=${value}\0`).join("");
      const flags = 0x4 /* CREATE_SUSPENDED */ | 0x400 /* CREATE_UNICODE_ENVIRONMENT */ | 0x80000 /* EXTENDED_STARTUPINFO_PRESENT */ | 0x08000000 /* CREATE_NO_WINDOW */;
      // Held in variables until the call returns: a buffer known only by its address could be collected meanwhile.
      const application = wide(program), commandLine = wide(args.map(quote).join(" ")), environmentBlock = wide(block), directory = wide(options.cwd);
      const startupBytes = new Uint8Array(startup.buffer);
      if (!k.CreateProcessW(ptr(application), ptr(commandLine), null, null, 1, flags, ptr(environmentBlock), ptr(directory), ptr(startupBytes), ptr(information))) {
        throw fail(`无法启动 ${program}`);
      }
    } finally { k.DeleteProcThreadAttributeList(ptr(attributes)); }
  } catch (error) {
    k.CloseHandle(job);
    throw error;
  } finally {
    for (const handle of handles) k.CloseHandle(handle);
  }

  const [processHandle, thread] = [information[0]!, information[1]!];
  const pid = Number(information[2]! & 0xffffffffn);
  try {
    options.afterCreate?.(pid);
    if (!k.AssignProcessToJobObject(job, processHandle)) throw fail(`无法把进程 ${pid} 放入作业对象`);
    if (k.ResumeThread(thread) === 0xffffffff) throw fail(`无法让进程 ${pid} 开始运行`);
  } catch (error) {
    k.TerminateProcess(processHandle, 1);
    for (const handle of [thread, processHandle, job]) k.CloseHandle(handle);
    throw error;
  }
  k.CloseHandle(thread);

  let exitedAlready = false, closed = false;
  // The process handle stays open until the exit is seen, so the PID cannot name another process meanwhile.
  const exited = (async () => {
    while (k.WaitForSingleObject(processHandle, 0) === 0x102 /* WAIT_TIMEOUT */) await Bun.sleep(5);
    const code = new Uint32Array(1);
    k.GetExitCodeProcess(processHandle, ptr(code));
    exitedAlready = true;
    k.CloseHandle(processHandle);
    return code[0]!;
  })();
  // Read as soon as the command exits, before anything that ends the scenario can remove the files.
  const output = exited.then(() => {
    const result = { out: readFileSync(files.out, "utf8"), err: readFileSync(files.err, "utf8") };
    for (const file of Object.values(files)) if (file) rmSync(file, { force: true });
    return result;
  });
  const accounting = new Uint32Array(12); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION; ActiveProcesses at byte 40
  return {
    pid, exited,
    output: () => output,
    kill() { if (!exitedAlready) k.TerminateProcess(processHandle, 1); },
    running() {
      if (closed) return false;
      if (!k.QueryInformationJobObject(job, 1 /* JobObjectBasicAccountingInformation */, ptr(accounting), accounting.byteLength, null)) {
        throw fail(`无法查询进程 ${pid} 的作业对象`);
      }
      return accounting[10]! > 0;
    },
    killTree() { if (!closed) k.TerminateJobObject(job, 1); },
    close() { if (!closed) { closed = true; k.CloseHandle(job); } },
  };
}
