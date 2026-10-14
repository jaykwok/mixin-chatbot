// Durable (1.2.0) fails the Session on any Storage error, as its own guard decides (pi-durable session.js
// `GuardedStorage`): every commit or mintId error, and every read error except a `StorageRequestError` (an invalid
// request) or one whose caller's context was aborted. A failed Session never runs or commits again; reopening recovers
// from what was committed. The SQL worker is shared by every group of the process, so the process stops (fail-stop) and
// its owner restarts it: the same errors fence the storage here and notify the owner synchronously.
import { StorageRequestError, type Storage } from "@earendil-works/pi-durable";

const FAILURE_TEXT = { commit: "群数据库提交结果无法确认", read: "群数据库读取失败", session: "群数据库会话已失败" } as const;

export class DurableStorageFailure extends Error {
  constructor(readonly path: string, cause: unknown, operation: "commit" | "read" | "session" = "commit") {
    super(`${FAILURE_TEXT[operation]}，需重启服务：${path}`, { cause });
  }
}

/** Whether a read's error says nothing about the Storage: an invalid request, or a read its caller cancelled. */
function exempt(error: unknown, args: readonly unknown[]): boolean {
  if (error instanceof StorageRequestError) return true;
  const context = args.at(-1) as { abortSignal?: AbortSignal } | undefined;
  return typeof context === "object" && context !== null && context.abortSignal?.aborted === true;
}

/** Do not reopen a live Harness. Fence the failed storage and synchronously notify the process owner. */
export function guardStorage(storage: Storage, path: string, onFailure: (error: DurableStorageFailure) => void): Storage {
  let failure: DurableStorageFailure | undefined;
  const methods = new Map<PropertyKey, unknown>();
  const fail = (error: unknown, operation: "commit" | "read") => {
    failure ??= new DurableStorageFailure(path, error, operation);
    try { onFailure(failure); } catch {}
    return failure;
  };
  return new Proxy(storage, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (methods.has(key)) return methods.get(key);
      // Commits and IDs are never exempt: once a batch is admitted, whether it committed is unknown.
      const settle = (error: unknown, args: readonly unknown[]) => key !== "commit" && key !== "mintId" && exempt(error, args)
        ? error : fail(error, key === "commit" || key === "mintId" ? "commit" : "read");
      const method = key === "close" ? (...args: unknown[]) => value.apply(target, args) : (...args: unknown[]) => {
        if (failure) return Promise.reject(failure);
        let result: unknown;
        try { result = value.apply(target, args); }
        catch (error) { throw settle(error, args); }
        return result instanceof Promise ? result.catch((error: unknown) => { throw settle(error, args); }) : result;
      };
      methods.set(key, method);
      return method;
    },
  });
}
