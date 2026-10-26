// 发送图片消息必须带宽高：从文件头读取 PNG、JPEG、GIF、WebP、BMP 的尺寸。
import { open } from "node:fs/promises";

export interface ImageInfo {
  readonly width: number;
  readonly height: number;
  /** 扩展名，不带点。 */
  readonly format: "png" | "jpg" | "gif" | "webp" | "bmp";
}

const HEADER_BYTES = 512 * 1024;

/** 读不出尺寸时返回 undefined（不是支持的图片格式，或文件头损坏）。 */
export async function imageInfo(path: string): Promise<ImageInfo | undefined> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await file.read(buffer, 0, HEADER_BYTES, 0);
    return parseImageHeader(buffer.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

export function parseImageHeader(bytes: Buffer): ImageInfo | undefined {
  const valid = (info: ImageInfo) => info.width > 0 && info.height > 0 ? info : undefined;
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR")
    return valid({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: "png" });
  if (bytes.length >= 10 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a"))
    return valid({ width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), format: "gif" });
  if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM")
    return valid({ width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)), format: "bmp" });
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return valid({ width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3), format: "webp" });
    if (chunk === "VP8 " && bytes.length >= 30) return valid({ width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, format: "webp" });
    if (chunk === "VP8L" && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return valid({ width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: "webp" });
    }
    return undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0–SOF15，除去 DHT(C4)、JPG(C8)、DAC(CC)。
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return valid({ height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7), format: "jpg" });
      offset += 2 + length;
    }
  }
  return undefined;
}
