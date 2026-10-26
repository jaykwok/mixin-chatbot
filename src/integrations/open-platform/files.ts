// 平台临时文件：分片上传（失败时中止）与流式下载。预签名地址只允许指向平台对象存储。
import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { log } from "../../core/log.ts";
import { accepted, PlatformRequestError, responseData, type PlatformClient } from "./client.ts";

const CHUNK_BYTES = 5 * 1024 * 1024;
const PART_TIMEOUT_MS = 120_000;
/** 下载没有总时长上限（入站不限大小）；连续这么久收不到数据才算失败。 */
const DOWNLOAD_STALL_MS = 60_000;

export interface UploadSource {
  readonly path: string;
  readonly fileName: string;
  readonly size: number;
  /** MIME 类型，如 image/png。 */
  readonly mimeType: string;
}

function storageUrl(client: PlatformClient, raw: unknown, what: string): string {
  if (typeof raw !== "string") throw new PlatformRequestError(`${what}缺少地址`, "rejected");
  let url: URL;
  try { url = new URL(raw); } catch { throw new PlatformRequestError(`${what}地址无效`, "rejected"); }
  if (!client.endpoints.storage(url)) throw new PlatformRequestError(`${what}地址不在平台对象存储（${url.hostname}）`, "rejected");
  return raw;
}

function abortReason(signal: AbortSignal | undefined, client: PlatformClient): unknown {
  return signal?.aborted ? signal.reason : client.closingSignal.aborted ? client.closingSignal.reason : undefined;
}

/** 上传本地文件，返回发送消息用的 fileId（平台称 fileKey）。任何一步失败都会尝试中止本次上传。 */
export async function uploadFile(client: PlatformClient, source: UploadSource, signal?: AbortSignal): Promise<string> {
  const init = await client.request("POST", "/open-apis/v1/files/upload/init", {
    body: { fileName: source.fileName, fileSize: source.size, mimeType: source.mimeType, chunkSize: CHUNK_BYTES, category: 1 },
    signal, label: "文件上传初始化",
  });
  const data = responseData(init);
  if (!accepted(init)) throw new PlatformRequestError(`文件上传初始化失败：HTTP ${init.status}`, "rejected", init.status);
  if (data.uploadComplete === true && typeof data.fileKey === "string" && data.fileKey) return data.fileKey;
  const uploadId = typeof data.uploadId === "string" ? data.uploadId : "";
  if (!uploadId) throw new PlatformRequestError("文件上传初始化未返回 uploadId", "rejected");
  let completed = false;
  try {
    const chunkSize = Number(data.chunkSize);
    const parts = Array.isArray(data.parts) ? data.parts as { partNumber?: unknown; uploadUrl?: unknown }[] : [];
    const expected = Math.max(1, Math.ceil(source.size / chunkSize));
    if (!(chunkSize > 0) || parts.length !== expected) throw new PlatformRequestError("文件上传初始化返回的分片信息不一致", "rejected");
    const done: { partNumber: number; etag: string; size: number }[] = [];
    // 客户端按合并时提交的 MD5 校验下载（不传则接收失败）。每片只读一次，重试复用同一份字节，哈希与实际上传一致。
    const md5 = createHash("md5");
    const file = await open(source.path, "r");
    try {
      const sorted = [...parts].sort((a, b) => Number(a.partNumber) - Number(b.partNumber));
      for (const [index, part] of sorted.entries()) {
        const number = Number(part.partNumber);
        if (number !== index + 1) throw new PlatformRequestError("分片编号无效", "rejected");
        const url = storageUrl(client, part.uploadUrl, "上传分片");
        const start = (number - 1) * chunkSize;
        const bytes = Buffer.alloc(Math.min(chunkSize, source.size - start));
        // A read may return fewer bytes than asked; only end of file means the file shrank.
        for (let filled = 0; filled < bytes.length;) {
          const { bytesRead } = await file.read(bytes, filled, bytes.length - filled, start + filled);
          if (bytesRead === 0) throw new PlatformRequestError("上传期间文件被截短", "rejected");
          filled += bytesRead;
        }
        md5.update(bytes);
        done.push({ partNumber: number, etag: await putPart(client, url, bytes, signal), size: bytes.length });
      }
    } finally {
      await file.close();
    }
    const complete = await client.request("POST", `/open-apis/v1/files/upload/${encodeURIComponent(uploadId)}/complete`, {
      body: { parts: done, fileHash: md5.digest("hex") }, signal, label: "文件上传完成",
    });
    const fileKey = responseData(complete).fileKey;
    if (!accepted(complete) || typeof fileKey !== "string" || !fileKey)
      throw new PlatformRequestError(`文件上传完成接口失败：HTTP ${complete.status}`, "rejected", complete.status);
    completed = true;
    return fileKey;
  } finally {
    if (!completed) {
      // 中止不跟随调用方的取消，只受自身超时约束。
      await client.request("DELETE", `/open-apis/v1/files/upload/${encodeURIComponent(uploadId)}`, { idempotent: true, label: "中止文件上传" })
        .then(response => { if (!accepted(response)) log.warn(`中止文件上传返回 HTTP ${response.status}`); })
        .catch(error => log.warn(`中止文件上传失败：${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

async function putPart(client: PlatformClient, url: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.any([client.closingSignal, AbortSignal.timeout(PART_TIMEOUT_MS), ...(signal ? [signal] : [])]),
      });
      await response.arrayBuffer().catch(() => undefined);
      const etag = response.headers.get("etag");
      if (response.ok && etag) return etag;
      if (response.status < 500 || client.retryDelay(attempt) === undefined) throw new PlatformRequestError(`上传分片失败：HTTP ${response.status}`, "rejected", response.status);
    } catch (error) {
      const aborted = abortReason(signal, client);
      if (aborted !== undefined) throw aborted;
      if (error instanceof PlatformRequestError || client.retryDelay(attempt) === undefined) throw error;
    }
    await client.sleep(client.retryDelay(attempt)!, signal);
  }
}

export interface DownloadResult {
  readonly fileName: string;
  /** 实际写入的字节数。 */
  readonly size: number;
  /** 平台给出的扩展名（如 .jpg）；没有时为空串。 */
  readonly mimeType: string;
  readonly sha256: string;
}

export interface DownloadOptions {
  readonly signal?: AbortSignal;
  /** 无数据多久算卡死，默认 60 秒（测试缩短）。 */
  readonly stallMs?: number;
}

/** 流式下载到 destination（调用方负责改名和清理），项目不设大小上限。失败时删除写了一半的文件。 */
export async function downloadFile(client: PlatformClient, fileId: string, destination: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  const info = await client.request("GET", `/open-apis/v1/files/${encodeURIComponent(fileId)}/download`, {
    idempotent: true, signal: options.signal, label: "换取下载地址",
  });
  const data = responseData(info);
  if (!accepted(info)) throw new PlatformRequestError(`换取下载地址失败：HTTP ${info.status}`, "rejected", info.status);
  const url = storageUrl(client, data.fileUrl, "下载");
  const fileName = typeof data.fileName === "string" ? data.fileName : "";
  const mimeType = typeof data.mimeType === "string" ? data.mimeType : "";
  for (let attempt = 0; ; attempt++) {
    try {
      const { size, sha256 } = await streamTo(client, url, destination, options);
      return { fileName, size, mimeType, sha256 };
    } catch (error) {
      await rm(destination, { force: true });
      const aborted = abortReason(options.signal, client);
      if (aborted !== undefined) throw aborted;
      if ((error instanceof PlatformRequestError && error.kind === "rejected") || client.retryDelay(attempt) === undefined) throw error;
      log.warn(`下载失败，稍后重试：${error instanceof Error ? error.message : String(error)}`);
    }
    await client.sleep(client.retryDelay(attempt)!, options.signal);
  }
}

async function streamTo(client: PlatformClient, url: string, destination: string, options: DownloadOptions): Promise<{ size: number; sha256: string }> {
  const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS, stalled = new AbortController();
  const arm = () => setTimeout(() => stalled.abort(new PlatformRequestError(`下载超过 ${Math.round(stallMs / 1000)} 秒没有收到数据`, "uncertain")), stallMs);
  let timer = arm();
  const progress = () => { clearTimeout(timer); timer = arm(); };
  try {
    return await streamBody(client, url, destination, options, stalled.signal, progress);
  } catch (error) {
    throw stalled.signal.aborted && abortReason(options.signal, client) === undefined ? stalled.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

async function streamBody(client: PlatformClient, url: string, destination: string, options: DownloadOptions,
  stalled: AbortSignal, progress: () => void): Promise<{ size: number; sha256: string }> {
  const response = await fetch(url, {
    signal: AbortSignal.any([client.closingSignal, stalled, ...(options.signal ? [options.signal] : [])]),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new PlatformRequestError(`下载失败：HTTP ${response.status}`, response.status >= 500 ? "uncertain" : "rejected", response.status);
  }
  const hash = createHash("sha256");
  const file = await open(destination, "w", 0o600);
  let size = 0;
  try {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        progress();
        // A write may store only part of the buffer; the size and hash count only what reached the file.
        for (let offset = 0; offset < value.byteLength;) {
          const { bytesWritten } = await file.write(value.subarray(offset));
          if (!(bytesWritten > 0)) throw new PlatformRequestError("下载写盘没有进展", "rejected");
          offset += bytesWritten;
        }
        size += value.byteLength;
        hash.update(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    await file.sync();
  } finally {
    await file.close();
  }
  return { size, sha256: hash.digest("hex") };
}
