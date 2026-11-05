// A strict ZIP reader for archive tests: the end record, every central entry and its local header must agree, and each
// entry's data must inflate (or be stored) to its declared size and CRC. No ZIP64, no data descriptors, no encryption.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; method: number; flags: number; size: number; compressed: number; data: Buffer };

export function readZip(path: string): ZipEntry[] {
  const file = readFileSync(path);
  const end = file.length - 22;
  if (end < 0 || file.readUInt32LE(end) !== 0x06054b50) throw new Error("no end-of-central-directory record at the very end (or a comment)");
  const count = file.readUInt16LE(end + 10), size = file.readUInt32LE(end + 12), offset = file.readUInt32LE(end + 16);
  if (file.readUInt16LE(end + 8) !== count || file.readUInt16LE(end + 20) !== 0) throw new Error("multi-disk archive or comment");
  if (offset + size !== end) throw new Error("central directory does not end at the end record");
  const entries: ZipEntry[] = [];
  let at = offset, nextLocal = 0;
  for (let index = 0; index < count; index++) {
    if (file.readUInt32LE(at) !== 0x02014b50) throw new Error(`central entry ${index}: bad signature`);
    const flags = file.readUInt16LE(at + 8), method = file.readUInt16LE(at + 10), crc = file.readUInt32LE(at + 16);
    const compressed = file.readUInt32LE(at + 20), length = file.readUInt32LE(at + 24);
    const nameLength = file.readUInt16LE(at + 28), extra = file.readUInt16LE(at + 30), comment = file.readUInt16LE(at + 32);
    const local = file.readUInt32LE(at + 42);
    const name = file.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extra + comment;
    if (local !== nextLocal) throw new Error(`${name}: local header not where the previous entry ended`);
    if (file.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: bad local signature`);
    if (file.readUInt16LE(local + 6) !== flags || file.readUInt16LE(local + 8) !== method || file.readUInt32LE(local + 14) !== crc
      || file.readUInt32LE(local + 18) !== compressed || file.readUInt32LE(local + 22) !== length) throw new Error(`${name}: local header differs from central entry`);
    const localName = file.readUInt16LE(local + 26), localExtra = file.readUInt16LE(local + 28);
    if (file.subarray(local + 30, local + 30 + localName).toString("utf8") !== name) throw new Error(`${name}: local name differs`);
    const start = local + 30 + localName + localExtra;
    const raw = file.subarray(start, start + compressed);
    nextLocal = start + compressed;
    if (flags & 0x0008) throw new Error(`${name}: data descriptor`);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : undefined;
    if (!data) throw new Error(`${name}: method ${method}`);
    if (data.length !== length) throw new Error(`${name}: size ${data.length}, declared ${length}`);
    if ((Bun.hash.crc32(data) >>> 0) !== crc) throw new Error(`${name}: CRC mismatch`);
    entries.push({ name, method, flags, size: length, compressed, data });
  }
  if (nextLocal !== offset) throw new Error("bytes between the last entry and the central directory");
  return entries;
}
