// A small ZIP writer for push summaries (./summary.ts) and the workbook inside them (./xlsx.ts): deflated in-memory
// entries, stored file entries copied in chunks, UTF-8 names (flag bit 11). File entries are read twice, once for the
// CRC and once for the copy, so every local header is final and no data descriptor is needed. No ZIP64: an archive
// that would pass 4 GiB, or more than 65 535 entries, is refused.
import { deflateRawSync } from "node:zlib";
import { open, type FileHandle } from "node:fs/promises";

const LIMIT = 0xffff_ffff;
const CHUNK = 1024 * 1024;
/** CRC-32 (the ZIP polynomial), continuing from `previous`. */
const crc32 = (data: Uint8Array, previous = 0) => Bun.hash.crc32(data, previous);

type Central = { name: Buffer; crc: number; compressed: number; size: number; method: number; time: number; date: number; offset: number };

/** Local time as DOS time and date (two-second resolution, 1980 at the earliest). */
function dosTime(at: number): { time: number; date: number } {
  const d = new Date(Math.max(at, new Date(1980, 0, 1).getTime()));
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

export class ZipTooLarge extends Error { override name = "ZipTooLarge"; }

export class ZipWriter {
  readonly #entries: Central[] = [];
  readonly #names = new Set<string>();
  #offset = 0;

  private constructor(private readonly file: FileHandle, private readonly at: number) {}

  /** A new archive at `path` (must not exist). */
  static async create(path: string, at = Date.now()): Promise<ZipWriter> {
    return new ZipWriter(await open(path, "wx", 0o600), at);
  }

  async addBuffer(name: string, data: Uint8Array): Promise<void> {
    const deflated = deflateRawSync(data);
    const body = deflated.length < data.length ? deflated : data;
    await this.#entry(name, { crc: crc32(data), size: data.length, compressed: body.length, method: body === data ? 0 : 8 }, async () => { await this.#write(body); });
  }

  /** A file, stored as it is. */
  async addFile(name: string, path: string, signal?: AbortSignal): Promise<void> {
    const source = await open(path, "r");
    try {
      const size = (await source.stat()).size;
      let crc = 0;
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(size, 1)));
      for (let position = 0; position < size;) {
        signal?.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) throw new Error(`文件在打包时变短：${name}`);
        crc = crc32(buffer.subarray(0, bytesRead), crc);
        position += bytesRead;
      }
      await this.#entry(name, { crc, size, compressed: size, method: 0 }, async () => {
        for (let position = 0; position < size;) {
          signal?.throwIfAborted();
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - position), position);
          if (bytesRead === 0) throw new Error(`文件在打包时变短：${name}`);
          await this.#write(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
      });
    } finally { await source.close(); }
  }

  /** Write the central directory and close the file. */
  async close(): Promise<void> {
    try {
      const start = this.#offset;
      for (const entry of this.#entries) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(entry.method, 10);
        header.writeUInt16LE(entry.time, 12); header.writeUInt16LE(entry.date, 14); header.writeUInt32LE(entry.crc, 16);
        header.writeUInt32LE(entry.compressed, 20); header.writeUInt32LE(entry.size, 24); header.writeUInt16LE(entry.name.length, 28);
        header.writeUInt32LE(entry.offset, 42);
        await this.#write(header); await this.#write(entry.name);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(this.#entries.length, 8); end.writeUInt16LE(this.#entries.length, 10);
      end.writeUInt32LE(this.#offset - start, 12); end.writeUInt32LE(start, 16);
      await this.#write(end);
    } finally { await this.file.close(); }
  }

  /** Close without finishing (the caller removes the file). */
  async abort(): Promise<void> {
    await this.file.close().catch(() => {});
  }

  async #entry(name: string, entry: { crc: number; size: number; compressed: number; method: number }, body: () => Promise<void>): Promise<void> {
    const key = name.toLowerCase();
    if (!name || name.startsWith("/") || name.split("/").some(part => part === "" || part === "." || part === "..")) throw new Error(`压缩包条目名无效：${name}`);
    if (this.#names.has(key)) throw new Error(`压缩包条目重名：${name}`);
    if (this.#entries.length >= 0xffff) throw new ZipTooLarge("压缩包条目超过 65535 个");
    const encoded = Buffer.from(name, "utf8");
    if (this.#offset + 30 + encoded.length + entry.compressed + 46 * (this.#entries.length + 1) + 22 > LIMIT) throw new ZipTooLarge("压缩包超过 4 GiB");
    this.#names.add(key);
    const { time, date } = dosTime(this.at);
    const offset = this.#offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(time, 10); header.writeUInt16LE(date, 12); header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressed, 18); header.writeUInt32LE(entry.size, 22); header.writeUInt16LE(encoded.length, 26);
    await this.#write(header); await this.#write(encoded);
    await body();
    this.#entries.push({ name: encoded, ...entry, time, date, offset });
  }

  async #write(data: Uint8Array): Promise<void> {
    for (let written = 0; written < data.length;) {
      const { bytesWritten } = await this.file.write(data, written, data.length - written, this.#offset);
      written += bytesWritten;
      this.#offset += bytesWritten;
    }
  }
}
