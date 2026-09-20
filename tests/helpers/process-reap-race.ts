// Preload only in the isolated supervisor regression process.
import * as ffi from "bun:ffi";
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";

const nativeDlopen = ffi.dlopen;
mock.module("bun:ffi", () => ({
  ...ffi,
  dlopen(...args: Parameters<typeof ffi.dlopen>) {
    const library = nativeDlopen(...args);
    const waitpid = library.symbols.waitpid as unknown as (pid: number, status: ffi.Pointer | null, options: number) => number;
    if (!waitpid) return library;
    let first = true;
    return { ...library, symbols: { ...library.symbols,
      waitpid(pid: number, status: ffi.Pointer | null, options: number) {
        // Block only the first reap, after SIGKILL. The real kernel call then
        // collects the direct child before Bun's exit watcher can run, reliably
        // producing ECHILD there while an adopted grandchild still needs cleanup.
        const blocking = first;
        first = false;
        const result = waitpid(pid, status, blocking ? 0 : options);
        if (blocking) writeFileSync(process.argv[2], String(result));
        return result;
      },
    } };
  },
}));
