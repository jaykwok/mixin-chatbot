import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { STATE_DIR } from "./storage.ts";
import { GROUP_ROOT_LEASE } from "./data-version.ts";
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

/** Preserve recoverability, including group data on a different drive or bind mount. */
export async function archiveFile(path: string): Promise<string | null> {
  const source = resolve(path);
  try { await lstat(source); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const backupId = process.env.BOT_DEPLOY_BACKUP_ID;
  const trash = resolve("backup", "rm", backupId && /^(deploy|tunnel)-[a-zA-Z0-9-]+$/.test(backupId) ? backupId : ".");
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
   * a live lease. The migration runner hard-codes the same defaults.
   */
  stale?: number;
  update?: number;
  retries?: number;
}

async function holdLock(path: string, options: LeaseOptions, lockfilePath?: string): Promise<() => Promise<void>> {
  const stale = options.stale ?? 30000;
  let lost = false;
  const release = await lock(path, { realpath: false, stale, update: options.update ?? 5000,
    ...(lockfilePath === undefined ? {} : { lockfilePath }),
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

/**
 * Exclusive ownership of a group data root. The service lease lives in one checkout's data/state; this one lives inside
 * the root itself, so checkouts or containers that share a GROUP_DATA_ROOT exclude each other whatever path each uses
 * for it. The root must already exist: a mistyped GROUP_DATA_ROOT is refused, never created. Like every mtime lease it
 * cannot stop a process that stalls past `stale` from writing until its next heartbeat reports the loss.
 */
export async function acquireGroupRootLease(role: string, root: string, options: LeaseOptions = {}): Promise<() => Promise<void>> {
  const path = resolve(root);
  try {
    if (!(await stat(path)).isDirectory()) throw new Error("不是目录");
  } catch (error) {
    throw new Error(`群数据根不可用：${path}；请检查 GROUP_DATA_ROOT，或先通过升级登记数据`, { cause: error });
  }
  try {
    return await holdLock(path, options, join(path, GROUP_ROOT_LEASE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
      throw new Error(`无法在群数据根 ${path} 建立 ${role} 互斥锁：${(error as Error).message}`, { cause: error });
    }
    throw new Error(`无法取得群数据根 ${path} 的 ${role} 互斥锁；可能有另一份部署正在使用同一群数据根。请先停止它，异常退出后等待 30 秒再重试`, { cause: error });
  }
}

/** Maintenance that touches group data passes the root, so a checkout sharing it cannot run meanwhile. */
export async function withMaintenance<T>(task: () => Promise<T>, groups?: string): Promise<T> {
  const release = await acquireLease("maintenance");
  try {
    const releaseGroups = groups === undefined ? undefined : await acquireGroupRootLease("maintenance", groups);
    try { return await task(); } finally { await releaseGroups?.(); }
  } finally { await release(); }
}
