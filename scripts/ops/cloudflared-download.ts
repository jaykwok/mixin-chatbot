// Download a stable, checksummed candidate. Native wrappers own service control and publication.
import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";

const UPDATE_ENDPOINT = "https://update.argotunnel.com";
const MAX_METADATA = 64 * 1024;
const MAX_BINARY = 128 * 1024 * 1024;
const ASSET_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

interface DownloadOptions {
  currentVersion: string;
  os: "windows" | "linux";
  arch: "amd64" | "386" | "arm" | "arm64";
  output: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  progress?: (message: string) => void;
}

function versionParts(version: string): number[] {
  if (!/^\d{4}\.\d{1,2}\.\d{1,3}$/.test(version)) throw new Error("cloudflared 版本格式无效");
  return version.split(".").map(Number);
}

function newerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate), old = versionParts(current);
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== old[i]) return next[i]! > old[i]!;
  }
  return false;
}

function safeAssetUrl(raw: string, initial = false): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !ASSET_HOSTS.has(url.hostname)) {
    throw new Error("cloudflared 下载地址不是官方 HTTPS 发布源");
  }
  if (initial && (url.hostname !== "github.com" || !url.pathname.startsWith("/cloudflare/cloudflared/releases/download/"))) {
    throw new Error("cloudflared 下载地址不属于官方发布仓库");
  }
  return url;
}

async function limitedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("cloudflared 更新响应为空");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error("cloudflared 更新响应超出大小限制");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, size);
}

export async function prepareCloudflaredUpdate(options: DownloadOptions): Promise<{ version: string; updated: boolean }> {
  versionParts(options.currentVersion);
  if (!["windows", "linux"].includes(options.os) || !["amd64", "386", "arm", "arm64"].includes(options.arch)) {
    throw new Error("cloudflared 更新不支持此平台");
  }
  const request = options.fetch ?? fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
  const endpoint = new URL(UPDATE_ENDPOINT);
  endpoint.search = new URLSearchParams({ os: options.os, arch: options.arch, clientVersion: options.currentVersion }).toString();
  options.progress?.("查询 Cloudflare 官方稳定版更新…");
  signal.throwIfAborted();
  const metadataResponse = await request(endpoint, { signal, redirect: "error" });
  if (!metadataResponse.ok) throw new Error(`cloudflared 更新查询失败（HTTP ${metadataResponse.status}）`);
  const metadata: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await limitedBody(metadataResponse, MAX_METADATA)));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("cloudflared 更新元数据无效");
  const value = metadata as Record<string, unknown>;
  if (value.error || typeof value.shouldUpdate !== "boolean") throw new Error("cloudflared 官方更新查询未返回有效结果");
  if (!value.shouldUpdate) return { version: options.currentVersion, updated: false };
  if (typeof value.version !== "string" || !newerVersion(value.version, options.currentVersion)) {
    throw new Error("cloudflared 官方更新版本没有高于当前版本，拒绝降级或覆盖");
  }
  if (typeof value.url !== "string" || typeof value.checksum !== "string" || !/^[a-fA-F0-9]{64}$/.test(value.checksum)
    || value.compressed !== false) throw new Error("cloudflared 更新缺少有效 SHA-256 或未压缩文件");
  let asset = safeAssetUrl(value.url, true);
  const expectedName = `cloudflared-${options.os}-${options.arch}${options.os === "windows" ? ".exe" : ""}`;
  if (asset.pathname !== `/cloudflare/cloudflared/releases/download/${value.version}/${expectedName}` || asset.search || asset.hash) {
    throw new Error("cloudflared 官方发布文件与版本或平台不匹配");
  }
  options.progress?.(`下载 cloudflared ${value.version}，完成后校验 SHA-256…`);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    response = await request(asset, { signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 5) throw new Error("cloudflared 下载重定向无效或过多");
    asset = safeAssetUrl(new URL(location, asset).href);
  }
  if (!response?.ok || !response.body) throw new Error(`cloudflared 下载失败（HTTP ${response?.status ?? "未知"}）`);
  const lengthText = response.headers.get("content-length");
  const length = lengthText === null ? null : Number(lengthText);
  if (length !== null && (!Number.isSafeInteger(length) || length <= 0 || length > MAX_BINARY)) {
    await response.body.cancel(); throw new Error("cloudflared 下载大小无效或超出限制");
  }
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const reader = response.body.getReader();
  let size = 0, lastProgress = 0;
  try {
    file = await open(options.output, "wx", 0o700);
    const hash = createHash("sha256");
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BINARY) throw new Error("cloudflared 下载超出大小限制");
      hash.update(part.value);
      let offset = 0;
      while (offset < part.value.byteLength) {
        const written = await file.write(part.value, offset, part.value.byteLength - offset);
        if (written.bytesWritten === 0) throw new Error("cloudflared 文件写入失败");
        offset += written.bytesWritten;
      }
      if (size - lastProgress >= 8 * 1024 * 1024) {
        lastProgress = size; options.progress?.(`已下载 ${(size / 1024 / 1024).toFixed(0)} MiB…`);
      }
    }
    signal.throwIfAborted();
    if (!size || (length !== null && length !== size)) throw new Error("cloudflared 下载不完整");
    if (hash.digest("hex") !== value.checksum.toLowerCase()) throw new Error("cloudflared SHA-256 校验失败，原程序和隧道未改动");
    await file.sync();
    await file.close(); file = undefined;
    options.progress?.("官方文件 SHA-256 校验通过。");
    return { version: value.version, updated: true };
  } catch (error) {
    // An existing output belongs to someone else; only remove a file we created.
    if (file) { await file.close().catch(() => {}); await unlink(options.output).catch(() => {}); }
    throw error;
  } finally { await reader.cancel().catch(() => {}); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1];
      if (!["--version", "--os", "--arch", "--output"].includes(key) || !value || values.has(key)) throw new Error("cloudflared 下载参数无效");
      values.set(key, value);
    }
    if (values.size !== 4) throw new Error("请指定 --version、--os、--arch、--output");
    const result = await prepareCloudflaredUpdate({ currentVersion: values.get("--version")!, os: values.get("--os")! as DownloadOptions["os"],
      arch: values.get("--arch")! as DownloadOptions["arch"], output: values.get("--output")!, progress: message => console.error(message) });
    if (!result.updated) { console.error(`cloudflared ${result.version} 已是官方稳定版。`); process.exitCode = 3; }
    else console.log(result.version);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
