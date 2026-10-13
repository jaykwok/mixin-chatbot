// Host-side plan readers use only Node built-ins and the service-free contracts; TUI does not import the service or its dependencies.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodePlanSummary, decodeProgressSummary, ID_PATTERN } from "../../src/contracts/maintenance.ts";

/** Archive plans and their removal lists live with the archive; physical reclamation plans in their own directory. */
const ARCHIVE_PLANS = [".reclamation", "backup", "rm", ".tmp-plans"], RECLAIM_PLANS = [".reclamation", "plans"];

async function read(root: string, id: string, suffix: string, location = ARCHIVE_PLANS): Promise<unknown> {
  if (!ID_PATTERN.test(id)) throw new Error("归档清单 ID 无效");
  const canonical = await realpath(root);
  let directory = canonical;
  const parents: { path: string; dev: bigint; ino: bigint }[] = [];
  for (const part of location) {
    directory = join(directory, part);
    const info = await lstat(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== resolve(directory)) throw new Error("归档清单祖先不是原位普通目录");
    parents.push({ path: directory, dev: info.dev, ino: info.ino });
  }
  const file = await open(join(directory, id + suffix), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("归档清单不是普通文件或过大");
    const buffer = Buffer.alloc(info.size + 1); let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await file.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > info.size) throw new Error("归档清单读取期间增长");
    for (const parent of parents) {
      const current = await lstat(parent.path, { bigint: true });
      if (current.isSymbolicLink() || current.dev !== parent.dev || current.ino !== parent.ino) throw new Error("归档清单祖先在读取期间改变");
    }
    return JSON.parse(buffer.subarray(0, count).toString("utf8"));
  } finally { await file.close(); }
}

export async function readTmpPlan(root: string, id: string) { return decodePlanSummary(await read(root, id, ".json"), id); }
export async function readTmpProgress(root: string, id: string, digest: string) { return decodeProgressSummary(await read(root, id, ".progress.json"), digest, "archived"); }
export async function readRemovalPlan(root: string, id: string) { return decodePlanSummary(await read(root, id, ".removal.json"), id); }
export async function readRemovalProgress(root: string, id: string, digest: string) { return decodeProgressSummary(await read(root, id, ".removal-progress.json"), digest, "removed"); }
export async function readReclaimPlan(root: string, id: string) { return decodePlanSummary(await read(root, id, ".json", RECLAIM_PLANS), id); }
export async function readReclaimProgress(root: string, id: string, digest: string) { return decodeProgressSummary(await read(root, id, ".progress.json", RECLAIM_PLANS), digest, "removed"); }
