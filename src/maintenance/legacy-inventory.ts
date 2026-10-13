import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertDataDirectory } from "../../scripts/lib/group-data.ts";
import type { UserTmp } from "../../scripts/lib/tmp-scan.ts";
import { hashFile } from "../core/file-hash.ts";

type LegacyItem = { path: string; token?: string; createdAt: number; reason?: string };
async function json(path: string): Promise<any> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("历史回执不是有界普通文件");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
const token = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function names(path: string, root: string): Promise<string[]> {
  try { await assertDataDirectory(path, root); return (await readdir(path)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Existing durable receipts authorize candidates; a filename or age alone never does. */
export async function legacyInventory(root: string, member: UserTmp, recordedRoot = root): Promise<LegacyItem[]> {
  const items: LegacyItem[] = [];
  const inspect = async (path: string, read: () => Promise<{ token: string; createdAt: number }>) => {
    try { items.push({ path, ...await read() }); }
    catch (error) { items.push({ path, createdAt: Infinity, reason: String(error) }); }
  };
  const shared = join(root, member.group, "index", "parsed"), privateCache = join(member.dir, ".document-cache");
  for (const cache of [shared, privateCache]) for (const name of await names(cache, root)) {
    const path = join(cache, name);
    await inspect(path, async () => {
      await assertDataDirectory(path, root);
      const record = await json(join(path, "metadata.json"));
      if (!/^[a-f\d]{64}$/.test(name) || !/^[a-f\d]{64}$/.test(record.digest) || !/^[a-f\d]{64}$/.test(record.parserIdentity)
        || !/^[a-f\d]{64}$/.test(record.textHash) || !Number.isSafeInteger(record.characters) || record.characters < 0 || record.characters > 2_000_000
        || !Number.isSafeInteger(record.units) || record.units < 0 || typeof record.truncated !== "boolean") throw new Error("解析缓存归属元数据无效");
      const text = join(path, "text.txt"), info = await lstat(text);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || await hashFile(text) !== record.textHash) throw new Error("解析缓存内容校验不符");
      return { token: token(["parser", record]), createdAt: (await lstat(path)).mtimeMs };
    });
  }
  for (const name of await names(member.dir, root)) {
    if (["codemode", ".isolated-work", ".document-cache"].includes(name)) continue;
    const path = join(member.dir, name);
    if (name === ".office-jobs") {
      for (const receipt of await names(path, root)) {
        if (!/^[a-f\d]{16}\.json$/.test(receipt)) continue;
        try {
          const record = await json(join(path, receipt));
          const oldTemp = member.dir.replace(root, recordedRoot);
          if (record.version !== 1 || record.id + ".json" !== receipt || !/^[a-f\d]{32}$/.test(record.owner)
            || !Number.isSafeInteger(record.pid) || record.pid <= 0 || ![member.dir, oldTemp].includes(record.tempRoot)
            || record.systemRoot !== await realpath(tmpdir())) throw new Error("Office 回执运行环境不匹配，保留待核对");
          const target = join(record.systemRoot, "mixin-office-" + record.id);
          await inspect(target, async () => {
            const info = await lstat(target);
            if (!info.isDirectory() || info.isSymbolicLink() || JSON.stringify(await json(join(target, ".mixin-office-owner.json"))) !== JSON.stringify(record)) throw new Error("Office 目录标记与回执不符");
            return { token: token(["office", record]), createdAt: info.mtimeMs };
          });
        } catch (error) { items.push({ path: join(path, receipt), createdAt: Infinity, reason: String(error) }); }
      }
    } else if (/^document-work-[A-Za-z0-9]+$/.test(name)) {
      await inspect(path, async () => {
        await assertDataDirectory(path, root);
        const record = await json(join(path, ".reclamation.json"));
        if (record.version !== 1 || record.status !== "deferred" || record.reason !== "shared-parent-writers-not-isolated"
          || typeof record.succeeded !== "boolean" || !Number.isFinite(record.at)) throw new Error("文档作业回执无效");
        return { token: token(["document-work", record]), createdAt: record.at };
      });
    } else items.push({ path, createdAt: Infinity, reason: "没有可验证的产物归属；文件名前缀不构成删除许可" });
  }
  return items;
}
