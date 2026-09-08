import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { STATE_DIR } from "./storage.ts";
import { lock } from "proper-lockfile";
import { move } from "fs-extra";

/** Preserve recoverability, including group data on a different drive or bind mount. */
export async function archiveFile(path: string): Promise<string | null> {
  const source = resolve(path);
  const trash = resolve("agents", "rm");
  if (source === trash || source.startsWith(trash + "/") || source.startsWith(trash + "\\")) {
    throw new Error("不能归档回收区本身");
  }
  await mkdir(trash, { recursive: true });
  const target = join(trash, `${Date.now()}-${randomUUID()}-${basename(source)}`);
  try { await move(source, target, { overwrite: false }); return target; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Pi uses proper-lockfile too: atomic directory locks, heartbeat, and stale-owner recovery. */
export async function acquireLease(role: string, path = join(STATE_DIR, "service")): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  try {
    return await lock(path, { realpath: false, stale: 30000, update: 5000,
      retries: { retries: 35, minTimeout: 1000, maxTimeout: 1000, factor: 1 } });
  } catch (error) {
    throw new Error("无法取得 " + role + " 互斥锁；请先停止机器人，异常退出后等待 30 秒再重试", { cause: error });
  }
}

export async function withMaintenance<T>(task: () => Promise<T>): Promise<T> {
  const release = await acquireLease("maintenance");
  try { return await task(); } finally { await release(); }
}
