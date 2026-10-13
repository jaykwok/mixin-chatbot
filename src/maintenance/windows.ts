import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { publishJson } from "../../scripts/migrations/lib/io.ts";
import { decodeWindowsJournal, type TreeEvidence, type WindowsJournal } from "../contracts/maintenance.ts";
import { removeWindowsTree, sameIdentity } from "../core/held-directory.ts";
import { reclamationEvidence } from "../core/reclamation-files.ts";

/** Windows holds deletion handles without sharing DELETE. Resumption keeps the originally reviewed root identity. */
export async function reclaimWindows(path: string, proof: TreeEvidence, directory: string, operation: string): Promise<void> {
  if (process.platform !== "win32" || !/^[a-f\d-]{36}-\d+$/.test(operation)) throw new Error("Windows 回收操作无效");
  const journalPath = join(directory, operation + ".json");
  let journal: WindowsJournal | undefined;
  const file = await open(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (file) {
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Windows 回收事务不是有界普通文件");
      journal = decodeWindowsJournal(JSON.parse(await file.readFile("utf8")), path, proof);
    } finally { await file.close(); }
    if (journal.phase === "removed") return;
  }
  const expected = { dev: BigInt(proof.dev), ino: BigInt(proof.ino) };
  await removeWindowsTree(path, expected, async entries => {
    if (journal) return;
    const current = await reclamationEvidence(path);
    if (current.fingerprint !== proof.fingerprint || !sameIdentity(await lstat(path, { bigint: true }), expected)) throw new Error("Windows 回收内容在预览后改变");
    journal = { version: 1, path, proof, phase: "deleting", entries };
    await publishJson(journalPath, journal);
  }, journal?.entries);
  // An absent root after a crash is deliberately deferred: absence alone cannot prove the old entity was deleted.
  await publishJson(journalPath, { ...journal!, phase: "removed" });
}
