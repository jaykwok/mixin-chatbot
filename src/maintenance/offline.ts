// macOS offline deletion of member entries that member commands could also have written (old shared directories and
// result directories). Nothing fences a writer there, so the service account proves for itself that none is left: no other
// process of its account runs (the service is down and nothing it started survived), and the deployment core still holds
// deploy.lock around this step. Unproven means refused, and the scene stays as it is. Resumption follows the journal.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { publishJson } from "../lib/atomic-file.ts";
import { decodeOfflineJournal, type OfflineJournal, type TreeEvidence } from "../contracts/maintenance.ts";
import { holdDirectory, sameIdentity } from "../core/held-directory.ts";
import { RemovalPermit } from "../core/reclamation.ts";
import { reclamationEvidence } from "../core/reclamation-files.ts";
import { STATE_DIR } from "../core/storage.ts";
import { accountProcesses, AT_FDCWD, close, isDirectory, O, openAt, selfAndAncestors, statAt, tryLock, unlinkAt } from "../lib/darwin.ts";
import { reclaimWindows } from "./windows.ts";

/** Windows (held handles) and macOS (offline proof) delete shared entries themselves, each with its own journal; Linux needs the privileged backend. */
export const journaledDeletion = () => process.platform === "win32" || process.platform === "darwin";
export const removeJournaled = (path: string, proof: TreeEvidence, directory: string, operation: string, offline: OfflineProof = offlineRefusal) =>
  process.platform === "win32" ? reclaimWindows(path, proof, directory, operation) : reclaimOffline(path, proof, directory, operation, offline);
/** Why no writer can be ruled out, or null. Only tests stand in for offlineRefusal; the tools never do. */
export type OfflineProof = () => string | null;

/** Why no writer can be ruled out now, or null when it can. */
export function offlineRefusal(lock = join(STATE_DIR, "deploy.lock")): string | null {
  if (process.platform !== "darwin") return "离线删除证明只适用于 macOS";
  const others = [...accountProcesses(process.getuid!()).keys()].filter(pid => !selfAndAncestors().has(pid));
  if (others.length) return `服务账户还有 ${others.length} 个其他进程（机器人或它留下的进程），不能排除写入者`;
  let fd: number;
  try { fd = openAt(AT_FDCWD, lock, O.RDONLY | O.NOFOLLOW | O.NONBLOCK); }
  catch (error) { return `无法打开部署锁（${(error as NodeJS.ErrnoException).code ?? "未知错误"}），不能确认部署核心在持锁`; }
  try { if (tryLock(fd)) return "部署锁无人持有：离线删除只在部署核心停机持锁时进行"; }
  finally { close(fd); }
  return null;
}

/** Removes `path` exactly as reviewed, after offlineRefusal() returned null for this step. */
export async function reclaimOffline(path: string, proof: TreeEvidence, directory: string, operation: string, offline: OfflineProof = offlineRefusal): Promise<void> {
  if (process.platform !== "darwin" || !/^[a-f\d-]{36}-\d+$/.test(operation)) throw new Error("离线回收操作无效");
  const refusal = offline();
  if (refusal) throw new Error(refusal + "；保留现场");
  const journalPath = join(directory, operation + ".json");
  let journal: OfflineJournal | undefined;
  const file = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (file) {
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("离线回收事务不是有界普通文件");
      journal = decodeOfflineJournal(JSON.parse(await file.readFile("utf8")), path, proof);
    } finally { await file.close(); }
    if (journal.phase === "removed") return;
  }
  const expected = { dev: BigInt(proof.dev), ino: BigInt(proof.ino) }, name = basename(path);
  /** Intent before the first unlink; a resumed deletion only needs the same entity, whose content it already started to remove. */
  const begin = async () => {
    if (journal) return;
    const current = await reclamationEvidence(path);
    if (current.fingerprint !== proof.fingerprint || !sameIdentity(await lstat(path, { bigint: true }), expected)) throw new Error("离线回收内容在预览后改变");
    journal = { version: 1, path, proof, phase: "deleting" };
    await publishJson(journalPath, journal);
  };
  const parent = openAt(AT_FDCWD, dirname(path), O.RDONLY | O.DIRECTORY | O.NOFOLLOW);
  let entry: ReturnType<typeof statAt>;
  try { entry = statAt(parent, name); } finally { close(parent); }
  // An absent entry after a crash is deliberately deferred: absence alone cannot prove the old entity was deleted.
  if (!entry || !sameIdentity(entry, expected)) throw new Error("离线回收对象已不是预览时的实体，保留待核对");
  if (isDirectory(entry)) {
    const held = await holdDirectory(dirname(path), [], false);
    const permit = new RemovalPermit(held.identity, expected);
    try {
      const results = await held.use(entries => entries.removeDirectories({ candidates: [name], select: candidate => candidate === name, permit, requireRemoval: true,
        beforeRemove: async (_name, _time, _entries, identity) => { if (!sameIdentity(identity, expected)) return false; await begin(); return true; } }));
      if (results[0]?.status !== "removed") throw new Error(`离线回收未确认删除：${results[0]?.reason ?? "目录已变化"}`);
    } finally { permit.revoke(); await held.release(); }
  } else {
    await begin();
    const again = openAt(AT_FDCWD, dirname(path), O.RDONLY | O.DIRECTORY | O.NOFOLLOW);
    try {
      const current = statAt(again, name);
      if (!current || !sameIdentity(current, expected)) throw new Error("离线回收对象在删除前被替换，保留待核对");
      unlinkAt(again, name);
    } finally { close(again); }
  }
  await publishJson(journalPath, { ...journal!, phase: "removed" });
}
