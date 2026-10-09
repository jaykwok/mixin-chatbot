// Windows: turn an existing, empty directory into a junction in place (FSCTL_SET_REPARSE_POINT), as another writer
// with only FILE_WRITE_ATTRIBUTES on it can (no rename, no removal, no elevation; no share mode denies attribute
// access). NTFS refuses it for a directory that is not empty (ERROR_DIR_NOT_EMPTY, 145).
import { dlopen, FFIType, ptr } from "bun:ffi";
import { WindowsHandles } from "../../src/core/windows-handles.ts";
const resources = new WindowsHandles();

let kernel32: ReturnType<typeof load> | undefined;
function load() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    DeviceIoControl: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  }).symbols;
}

function utf16(text: string): Buffer {
  const bytes = Buffer.alloc(Buffer.byteLength(text, "utf16le"));
  bytes.write(text, 0, "utf16le");
  return bytes;
}

/** Make directory `path` a junction to `target` (an absolute Win32 path); the Win32 error when refused. */
export function junctionInPlace(path: string, target: string, observer = resources): { set: true } | { set: false; error: number } {
  const k = kernel32 ??= load();
  // FILE_WRITE_ATTRIBUTES; share read, write and delete; OPEN_EXISTING; backup semantics, the reparse point itself.
  const handle = k.CreateFileW(ptr(utf16(`${path}\0`)), 0x100, 0x7, null, 3, 0x02000000 | 0x00200000, null) as bigint;
  if (handle === -1n) return { set: false, error: k.GetLastError() };
  const owner = observer.own(handle, path, "CreateFileW(junction-test)");
  let failure: unknown;
  try {
    const slash = String.fromCharCode(92);
    const substitute = utf16(`${slash}??${slash}${target}\0`);
    const print = utf16(`${target}\0`);
    // REPARSE_DATA_BUFFER for IO_REPARSE_TAG_MOUNT_POINT.
    const data = Buffer.alloc(16 + substitute.length + print.length);
    data.writeUInt32LE(0xa0000003, 0);
    data.writeUInt16LE(data.length - 8, 4);
    data.writeUInt16LE(0, 8);
    data.writeUInt16LE(substitute.length - 2, 10);
    data.writeUInt16LE(substitute.length, 12);
    data.writeUInt16LE(print.length - 2, 14);
    substitute.copy(data, 16);
    print.copy(data, 16 + substitute.length);
    const returned = Buffer.alloc(4);
    if (k.DeviceIoControl(handle, 0x900a4, ptr(data), data.length, null, 0, ptr(returned), null)) return { set: true };
    const error = k.GetLastError();
    owner.record("result", "DeviceIoControl(junction-test)", { success: false, win32: error });
    failure = Object.assign(new Error(`junction test refused: Windows error ${error}`), { win32: error });
    return { set: false, error };
  } catch (error) { failure = error; throw error;
  } finally {
    try { owner.close(); }
    catch (error) { throw new AggregateError([error], "junction test handle cleanup failed", { cause: failure }); }
  }
}
