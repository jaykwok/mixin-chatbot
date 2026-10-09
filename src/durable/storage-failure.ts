// StorageRejected alone proves that a batch did not commit; every other commit failure is uncertain.
import { StorageRejected, type Storage } from "@earendil-works/pi-durable";

export class DurableStorageFailure extends Error {
  constructor(readonly path: string, cause: unknown) {
    super(`群数据库提交结果无法确认，需重启服务：${path}`, { cause });
  }
}

/** Do not reopen a live Harness. Fence the poisoned storage and synchronously notify the process owner. */
export function guardStorage(storage: Storage, path: string, onFailure: (error: DurableStorageFailure) => void): Storage {
  let failure: DurableStorageFailure | undefined;
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(storage, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (methods.has(key)) return methods.get(key);
      const method = key === "commit" ? async (...args: unknown[]) => {
        if (failure) throw failure;
        try { return await value.apply(target, args); }
        catch (error) {
          if (error instanceof StorageRejected) throw error;
          failure ??= new DurableStorageFailure(path, error);
          try { onFailure(failure); } catch {}
          throw failure;
        }
      } : (...args: unknown[]) => {
        if (failure && key !== "close") return Promise.reject(failure);
        return value.apply(target, args);
      };
      methods.set(key, method);
      return method;
    },
  });
}
