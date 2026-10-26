import { constants } from "node:fs";
import { copyFile, mkdir, open, stat, unlink, realpath, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { isPathInside } from "../contracts/paths.ts";
import { type Deliverable, openPart, type RequestRecord } from "../durable/records.ts";

/** Streaming, abortable digest: large relay files do not occupy the JavaScript heap. */
export async function fileDigest(path: string, signal?: AbortSignal, maxBytes = Number.MAX_SAFE_INTEGER): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("文件不是普通文件或超过交付大小上限");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("文件增长超过交付大小上限");
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally { await file.close(); }
}

/** Copy before recording; check both sides so later edits cannot change a registered version. */
export async function freezeFile(sourcePath: string, tempDir: string, requestId: string, maxBytes: number, signal?: AbortSignal, sourceDigest?: string) {
  const sha256 = sourceDigest ?? await fileDigest(sourcePath, signal, maxBytes);
  const parent = await realpath(tempDir), root = join(parent, ".deliverables");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error("交付快照目录不能是链接");
  const dir = join(root, createHash("sha256").update(requestId).digest("hex").slice(0, 24), randomUUID());
  await mkdir(dir, { recursive: true });
  if (await realpath(dir) !== dir) throw new Error("交付快照目录越界");
  const name = basename(sourcePath), path = join(dir, name);
  try {
    await copyFile(sourcePath, path, constants.COPYFILE_EXCL);
    if (sha256 !== await fileDigest(path, signal, maxBytes)) throw new Error("复制期间源文件变化，请完成生成后重新登记");
    return { sourcePath, path, name, sha256, size: (await stat(path)).size, format: extname(name).slice(1).toLowerCase() };
  } catch (error) { await unlink(path).catch(() => {}); throw error; }
}

/** Structural completeness only; never a claim that content or layout has been reviewed. */
export async function completeFile(path: string, format: string): Promise<boolean> {
  const f = await open(path, "r");
  try {
    const { size } = await f.stat();
    if (!size) return false;
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await f.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    if (format === "pdf") return (await read(0, 5)).toString() === "%PDF-" &&
      (await read(Math.max(0, size - 1024), Math.min(size, 1024))).includes(Buffer.from("%%EOF"));
    const main = ({ docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml" } as Record<string, string>)[format];
    if (!main) return true;
    const tail = await read(Math.max(0, size - 65557), Math.min(size, 65557));
    let end = -1;
    for (let n = tail.length - 22; n >= 0; n--) if (tail.readUInt32LE(n) === 0x06054b50 && n + 22 + tail.readUInt16LE(n + 20) === tail.length) { end = n; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) return false;
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    // ZIP64 / multi-disk files are not treated as complete by this inexpensive check.
    if (count === 0xffff || length > 16 * 1024 * 1024 || offset + length > size - tail.length + end) return false;
    const directory = await read(offset, length), names = new Set<string>();
    let pos = 0;
    for (let i = 0; i < count; i++) {
      if (pos + 46 > directory.length || directory.readUInt32LE(pos) !== 0x02014b50) return false;
      const nameLength = directory.readUInt16LE(pos + 28), extra = directory.readUInt16LE(pos + 30), comment = directory.readUInt16LE(pos + 32);
      if (directory.readUInt32LE(pos + 42) >= offset || pos + 46 + nameLength + extra + comment > directory.length) return false;
      names.add(directory.subarray(pos + 46, pos + 46 + nameLength).toString()); pos += 46 + nameLength + extra + comment;
    }
    return pos === directory.length && names.has("[Content_Types].xml") && names.has(main);
  } catch { return false; } finally { await f.close(); }
}

/** At most 3 deliverables (slots) and 8 versions per request. */
export function registerDeliverable(record: RequestRecord, entry: Omit<Deliverable, "id" | "seq" | "at">, now = Date.now()): Deliverable {
  const previous = record.deliverables;
  if (previous.length >= 8) throw new Error("本任务最多登记 8 个版本，请发送已登记的最佳版本");
  if (!previous.some(each => each.slot === entry.slot) && new Set(previous.map(each => each.slot)).size >= 3) throw new Error("本任务最多登记 3 个交付物");
  const next: Deliverable = { ...entry, id: randomUUID(), seq: previous.length + 1, at: now };
  previous.push(next);
  return next;
}

/** The best complete, not rejected version of every slot: checked before draft, newest first. */
export function deliverableCandidates(record: Pick<RequestRecord, "deliverables">): Deliverable[] {
  const all = record.deliverables, rejected = new Set(all.filter(x => x.status === "rejected").map(x => x.sha256));
  return [...new Set(all.map(x => x.slot))].flatMap(slot => {
    const versions = all.filter(x => x.slot === slot && x.complete && !rejected.has(x.sha256)).reverse();
    const best = versions.find(x => x.status === "checked") ?? versions.find(x => x.status === "draft");
    return best ? [best] : [];
  });
}

/** Snapshots of a closed request that no delivery part still to be sent needs. */
export function releasableSnapshots(record: Readonly<RequestRecord>): string[] {
  const open = record.delivery?.abandoned === undefined ? record.delivery?.parts.filter(openPart) ?? [] : [];
  const keep = new Set(open.filter(part => part.kind === "file").map(part => part.file!.path));
  const paths = new Set([...record.deliverables.map(x => x.path), ...record.files.map(x => x.path)]);
  return [...paths].filter(path => !keep.has(path));
}

/** Delete snapshot files; only inside the member tmp `.deliverables` directory, missing files are fine. */
export async function deleteSnapshots(paths: readonly string[], tempDir: string): Promise<void> {
  let root: string | undefined;
  for (const path of paths) {
    try {
      root ??= join(await realpath(tempDir), ".deliverables");
      const actual = await realpath(path);
      if (actual === root || !isPathInside(actual, root)) throw new Error("交付快照清理路径越界");
      await unlink(actual);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
