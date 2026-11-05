// Only a durable job receipt authorizes cleanup. Never scan system TEMP by prefix or age.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdDirectory, type DirectoryRemoval } from "../core/held-directory.ts";
import { publishJson } from "../../scripts/lib/atomic-file.ts";

const owner = randomBytes(16).toString("hex");
const marker = ".mixin-office-owner.json";
type Receipt = { version: 1; id: string; owner: string; pid: number; incarnation?: string; tempRoot: string; systemRoot: string };
const retryAfter = new Map<string, number>();
const announced = new Map<string, number>();

async function linuxIncarnation(pid: number): Promise<string> {
  const [boot, namespace, raw] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readlink(`/proc/${pid}/ns/pid`), readFile(`/proc/${pid}/stat`, "utf8")]);
  const start = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(start ?? "")) throw new Error("无法读取 Office 所有者的进程世代");
  return `${boot.trim()}:${namespace}:${start}`;
}

async function ownerLive(receipt: Receipt): Promise<boolean> {
  try {
    if (process.platform === "linux" && receipt.incarnation !== undefined) return await linuxIncarnation(receipt.pid) === receipt.incarnation;
    // Old receipts lack a start identity; retain them when the PID is still present.
    process.kill(receipt.pid, 0); return true;
  } catch (error) { return !["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? ""); }
}
async function readRecord(root: string, name: string) {
  const held = await holdDirectory(root, [], false);
  try { return await held.use(entries => entries.read(name)); } finally { await held.release(); }
}

const JOURNAL = ".office-jobs", RECEIPT = /^[a-f0-9]{16}\.json$/;

async function journalRoot(tempDir: string) {
  const temp = await realpath(tempDir), root = join(temp, JOURNAL);
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
        candidates: [name],
        requireRemoval: true,
        select: candidate => candidate === name,
        beforeRemove: async (_name, _changedAt, child) => {
          // Authorization is read through the same held entity that deletion will use.
          const mark = await child.read(marker);
          if (!mark) {
            // mkdir, or the marker's creation, may have completed before its content. Only an otherwise empty entity is safe here.
            if ((await child.names()).some(entry => entry !== marker)) throw new Error("Office 所有权标记缺失，保留清理记录");
          } else if (JSON.stringify(JSON.parse(mark)) !== JSON.stringify(receipt)) {
            throw new Error("Office 所有权标记不匹配，保留清理记录");
          }
          return true;
        },
      });
      const selected = removed.find(item => item.name === name);
      if (selected && selected.status !== "refused") { result = selected; return; }
      // Linux refuses a link, a non-directory and a missing name alike; Windows skips them. A name still listed was not
      // removed: retain its recovery record.
      if ((await entries.names()).includes(name)) throw new Error("Office 配置目录身份已变化，保留清理记录");
      // An absent name proves the removal only off Linux (as for codemode results): the receipt has nothing left to clean.
      if (process.platform !== "linux") result = { name, status: "removed", completedEarlier: true };
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
    ...(process.platform === "linux" ? { incarnation: await linuxIncarnation(process.pid) } : {}),
    tempRoot: temp, systemRoot: await realpath(tmpdir()) };
  await writeNew(join(root, receipt.id + ".json"), receipt);
  const path = join(receipt.systemRoot, `mixin-office-${receipt.id}`);
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) {
    // Nothing was made: the receipt has nothing to clean.
    await rm(join(root, receipt.id + ".json"), { force: true });
    throw error;
  }
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
  // Receipts are written only under a journal `createOfficeProfile` made first. Without a receipt listed there is nothing
  // to recover: a space's preparation neither creates the journal in every member's tmp nor resolves it. Anything else
  // than a listing or a missing journal goes on to the checks below, which refuse it.
  const listed = await readdir(join(tempDir, JOURNAL)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : undefined);
  if (listed !== undefined && !listed.some(name => RECEIPT.test(name))) return 0;
  const { temp, root } = await journalRoot(tempDir), systemRoot = await realpath(tmpdir());
  let removed = 0, deferred = 0;
  for (const name of await readdir(root)) {
    if (!RECEIPT.test(name)) continue;
    const raw = await readRecord(root, name);
    if (raw === undefined) throw new Error("Office 清理记录已变化，保留目录");
    const receipt: Receipt = JSON.parse(raw);
    if (receipt.version !== 1 || receipt.id + ".json" !== name || !/^[a-f0-9]{32}$/.test(receipt.owner)
      || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0
      || receipt.incarnation !== undefined && (typeof receipt.incarnation !== "string" || !receipt.incarnation || receipt.incarnation.length > 256)) {
      throw new Error("Office 清理记录身份不匹配，拒绝删除");
    }
    // A restored backup can carry a receipt from a different machine/root. Keep it; it grants no authority here.
    if (receipt.tempRoot !== temp || receipt.systemRoot !== systemRoot) continue;
    if (receipt.owner === owner) { if (retryAfter.has(join(root, receipt.id))) deferred++; continue; }
    if (await ownerLive(receipt)) continue;
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
