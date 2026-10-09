// Only a durable job receipt authorizes cleanup. Never scan system TEMP by prefix or age.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdDirectory, type DirectoryRemoval } from "../core/held-directory.ts";
import { publishJson } from "../../scripts/migrations/lib/io.ts";

const owner = randomBytes(16).toString("hex");
const marker = ".mixin-office-owner.json";
type Receipt = { version: 1; id: string; owner: string; pid: number; tempRoot: string; systemRoot: string };
const retryAfter = new Map<string, number>();
const announced = new Map<string, number>();
async function readRecord(root: string, name: string) {
  const held = await holdDirectory(root, [], false);
  try { return await held.use(entries => entries.read(name)); } finally { await held.release(); }
}

async function journalRoot(tempDir: string) {
  const temp = await realpath(tempDir), root = join(temp, ".office-jobs");
  await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("Office 清理记录目录不是普通目录");
  return { temp, root };
}

async function writeNew(path: string, value: Receipt) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}

async function removeOwned(root: string, receipt: Receipt) {
  const name = `mixin-office-${receipt.id}`;
  const held = await holdDirectory(receipt.systemRoot, [], false);
  let result: DirectoryRemoval = { name, status: "deferred", reason: "recorded-entry-not-found" };
  try {
    await held.use(async entries => {
      const removed = await entries.removeDirectories({
        requireRemoval: true,
        select: candidate => candidate === name,
        beforeRemove: async (_name, _changedAt, child) => {
          // Authorization is read through the same held entity that deletion will use.
          const mark = await child.read(marker);
          if (mark === undefined) {
            // mkdir may have completed before the marker write. Only an empty entity is safe here.
            if ((await child.names()).length !== 0) throw new Error("Office 所有权标记缺失，保留清理记录");
          } else if (JSON.stringify(JSON.parse(mark)) !== JSON.stringify(receipt)) {
            throw new Error("Office 所有权标记不匹配，保留清理记录");
          }
          return true;
        },
      });
      // A link or a non-directory was skipped, not removed; retain its recovery record.
      const selected = removed.find(item => item.name === name);
      if (selected?.status === "refused" || !selected && (await entries.names()).includes(name)) throw new Error("Office 配置目录身份已变化，保留清理记录");
      if (selected) result = selected;
    });
  } finally { await held.release(); }
  if (result.status === "removed") {
    await rm(join(root, receipt.id + ".json"), { force: true });
    await rm(join(root, receipt.id + ".deferred.json"), { force: true });
  } else {
    await publishJson(join(root, receipt.id + ".deferred.json"), { version: 1, id: receipt.id, result, attemptedAt: Date.now() });
    retryAfter.set(join(root, receipt.id), Date.now() + 60_000);
  }
  return result;
}

/** Record the planned path before mkdir; the receipt lives in the caller's persistent member tmp. */
export async function createOfficeProfile(tempDir: string): Promise<{ path: string; close(): Promise<DirectoryRemoval> }> {
  const { temp, root } = await journalRoot(tempDir);
  const receipt: Receipt = { version: 1, id: randomBytes(8).toString("hex"), owner, pid: process.pid,
    tempRoot: temp, systemRoot: await realpath(tmpdir()) };
  await writeNew(join(root, receipt.id + ".json"), receipt);
  const path = join(receipt.systemRoot, `mixin-office-${receipt.id}`);
  await mkdir(path, { mode: 0o700 });
  await writeNew(join(path, marker), receipt);
  let confirmed: DirectoryRemoval | undefined, closing: Promise<DirectoryRemoval> | undefined;
  return { path, close: () => confirmed ? Promise.resolve(confirmed) : closing ??= removeOwned(root, receipt).then(result => {
    if (result.status === "removed") confirmed = result;
    return result;
  }).finally(() => { closing = undefined; }) };
}

/** Call before group scheduling resumes and during idle maintenance. Live owners and unproved paths are left alone. */
export async function recoverOfficeProfiles(tempDir: string, report?: (deferred: number) => void): Promise<number> {
  try { await lstat(tempDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  const { temp, root } = await journalRoot(tempDir), systemRoot = await realpath(tmpdir());
  let removed = 0, deferred = 0;
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9]{16}\.json$/.test(name)) continue;
    const raw = await readRecord(root, name);
    if (raw === undefined) throw new Error("Office 清理记录已变化，保留目录");
    const receipt: Receipt = JSON.parse(raw);
    if (receipt.version !== 1 || receipt.id + ".json" !== name || !/^[a-f0-9]{32}$/.test(receipt.owner)
      || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) {
      throw new Error("Office 清理记录身份不匹配，拒绝删除");
    }
    // A restored backup can carry a receipt from a different machine/root. Keep it; it grants no authority here.
    if (receipt.tempRoot !== temp || receipt.systemRoot !== systemRoot) continue;
    if (receipt.owner === owner) { if (retryAfter.has(join(root, receipt.id))) deferred++; continue; }
    try { process.kill(receipt.pid, 0); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    const key = join(root, receipt.id);
    if ((retryAfter.get(key) ?? 0) > Date.now()) { deferred++; continue; }
    try {
      const raw = await readRecord(root, receipt.id + ".deferred.json");
      if (raw === undefined) throw Object.assign(new Error("missing deferred record"), { code: "ENOENT" });
      const record = JSON.parse(raw);
      if (record.version !== 1 || record.id !== receipt.id || !Number.isFinite(record.attemptedAt)) throw new Error("Office 延后记录损坏");
      if (record.attemptedAt + 60_000 > Date.now()) { deferred++; continue; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const result = await removeOwned(root, receipt);
    if (result.status === "removed") removed++; else deferred++;
  }
  if (report && announced.get(root) !== deferred) { announced.set(root, deferred); if (deferred) report(deferred); }
  return removed;
}
