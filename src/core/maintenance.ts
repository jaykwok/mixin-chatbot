import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { STATE_DIR } from "./storage.ts";
import { lock } from "proper-lockfile";
import { move } from "fs-extra";

/** Atomically publish a staged file; retry brief Windows sharing locks without deleting the destination. */
export async function replaceFile(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, destination); return; }
    catch (error) {
      if (process.platform !== "win32" || attempt >= 6 ||
          !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await sleep(25 * 2 ** attempt);
    }
  }
}

/** Preserve recoverability, including data on a different drive or bind mount. */
export async function archiveFile(path: string): Promise<string | null> {
  const source = resolve(path);
  try { await lstat(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const backupId = process.env.BOT_DEPLOY_BACKUP_ID;
  const trash = resolve("backup", "rm", backupId && /^deploy-[a-zA-Z0-9-]+$/.test(backupId) ? backupId : ".");
  if (source === trash || source.startsWith(trash + "/") || source.startsWith(trash + "\\")) {
    throw new Error("不能归档回收区本身");
  }
  await mkdir(trash, { recursive: true });
  const target = join(trash, `${Date.now()}-${randomUUID()}-${basename(source)}`);
  try { await move(source, target, { overwrite: false }); return target; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export interface LeaseOptions {
  /**
   * Called once when the heartbeat finds the lease gone or taken over (another owner after a stall longer than `stale`).
   * The owner must stop writing at once: the service exits without its normal shutdown, whose cleanup writes
   * (src/server/app.ts). Without it a lost lease throws from a timer and ends the process.
   */
  onLost?: (error: Error) => void;
  /**
   * Heartbeat timing, shortened only by tests (proper-lockfile minimums: stale 2 s, update 1 s). Every holder judges
   * staleness with its own `stale`, so all holders of one lease must use the same values: a shorter one would take over
   * a live lease. Production holders (the service, the verification instance, mcp login, the data-current runner and
   * withMaintenance) all keep the defaults.
   */
  stale?: number;
  update?: number;
  retries?: number;
}

async function holdLock(path: string, options: LeaseOptions): Promise<() => Promise<void>> {
  const stale = options.stale ?? 30000;
  let lost = false;
  const release = await lock(path, { realpath: false, stale, update: options.update ?? 5000,
    retries: { retries: options.retries ?? Math.ceil(stale / 1000) + 5, minTimeout: 1000, maxTimeout: 1000, factor: 1 },
    ...(options.onLost === undefined ? {} : { onCompromised: (error: Error) => { lost = true; options.onLost!(error); } }) });
  // After a loss the directory may belong to the next owner; releasing must not touch it.
  return async () => { if (!lost) await release(); };
}

/** Pi uses proper-lockfile too: atomic directory locks, heartbeat, and stale-owner recovery. */
export async function acquireLease(role: string, path = join(STATE_DIR, "service"), options: LeaseOptions = {}): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  try {
    return await holdLock(path, options);
  } catch (error) {
    throw new Error("无法取得 " + role + " 互斥锁；请先停止机器人，异常退出后等待 30 秒再重试", { cause: error });
  }
}

/** Offline maintenance excludes the service and other maintenance through the service lease of this checkout. */
export async function withMaintenance<T>(task: () => Promise<T>): Promise<T> {
  const release = await acquireLease("maintenance");
  try { return await task(); } finally { await release(); }
}
