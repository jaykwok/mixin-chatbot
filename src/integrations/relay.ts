// Temporary S3 distribution for local files above the IM attachment limit.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { application, KeyedQueue } from "../core/lifecycle.ts";
import { RELAY_HTTP_TIMEOUT } from "../core/config.ts";
import { log } from "../core/log.ts";
import { RELAY_CONFIG_PATH, RELAY_INDEX_PATH } from "../core/storage.ts";
import { openRelayIndex, relayCacheKey, type RelayIndex, type RelayIndexEntry } from "./relay-index.ts";
import { deleteObject, downloadUrl, objectBaseUrl, objectNameFromUrl, putObject, remoteStillExists,
  storedObjectUrl, validateRelayConfig, S3RequestError, type RelayConfig } from "./relay-s3.ts";
export { DEFAULT_RELAY_MAX_BYTES, DEFAULT_RELAY_EXPIRE_HOURS, DEFAULT_RELAY_CLEANUP_GRACE_MINUTES, validateRelayConfig, type RelayConfig } from "./relay-s3.ts";

export function loadRelayConfig(path = RELAY_CONFIG_PATH): RelayConfig | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(path + " 无法读取");
  }
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { throw new Error(path + " 不是有效 JSON"); }
  return validateRelayConfig(doc, path);
}

let cachedConfig: RelayConfig | null | undefined;
export async function initializeRelay(): Promise<void> {
  cachedConfig = loadRelayConfig();
  // Validate the ledger under the service lease, before the HTTP listener accepts work.
  if (cachedConfig) await getRelayIndex();
  if (cachedConfig) log.info("大文件 S3 外链已启用（上限 " + formatSize(cachedConfig.maxBytes) + "，桶 " + cachedConfig.bucket +
    "，" + cachedConfig.expireHours + " 小时后失效，再保留 " + cachedConfig.cleanupGraceMinutes + " 分钟后清理）");
  else log.info("未配置 " + RELAY_CONFIG_PATH + "，超过附件上限的文件仍按报错处理");
}
export function getRelayConfig(): RelayConfig | null {
  if (cachedConfig === undefined) cachedConfig = loadRelayConfig();
  return cachedConfig ?? null;
}

export function relayBackendId(config: RelayConfig): string {
  return createHash("sha256").update(JSON.stringify(["s3", config.endpoint, config.region, config.bucket, config.prefix, config.forcePathStyle])).digest("hex");
}
const backend = relayBackendId;

/** Durable references contain neither signing credentials nor transient query parameters. */
export interface RelayReference { backend: string; url: string; name: string; size: number; }
export function relayReference(config: RelayConfig, url: string, name: string, size: number): RelayReference {
  const stored = new URL(url);
  stored.search = "";
  stored.hash = "";
  return { backend: backend(config), url: stored.href, name, size };
}

function isExpired(entry: RelayIndexEntry): boolean {
  return !entry.expiresAt || !(Date.parse(entry.expiresAt) - Date.now() >= 1000);
}

export async function refreshRelayReference(reference: RelayReference, signal?: AbortSignal,
  config = getRelayConfig(), suppliedIndex?: RelayIndex): Promise<{ url: string; expiry: string }> {
  if (!config || reference.backend !== backend(config) || !objectNameFromUrl(config, reference.url)) {
    throw new Error("附件后端已变更，待补发记录已保留，请联系管理员；旧 WebDAV 附件需重新发送");
  }
  const index = suppliedIndex ?? await getRelayIndex();
  const entry = index.findUploaded(reference.url);
  if (!entry || (reference.size >= 0 && entry.size !== reference.size)) throw new Error("附件已不在外链账本中，待补发记录已保留，请重新生成文件");
  return withUploadLock(entry.key, async () => {
    const current = index.get(entry.key);
    if (!current || current.url !== reference.url || current.state !== "uploaded" || isExpired(current)) {
      throw new Error("附件下载链接已过期，待补发记录已保留，请重新发送文件");
    }
    if (!await remoteStillExists(config, current.url, current.size, signal)) throw new Error("附件已从后端删除，待补发记录已保留，请重新生成文件");
    const url = downloadUrl(config, current.url, current.expiresAt!);
    return { url, expiry: describeRelayExpiry(config, url) };
  }, signal);
}

/** A reused object keeps its original deadline, including the initial send tool's note. */
export function describeRelayExpiry(config: RelayConfig, url?: string): string {
  if (!url) return "\n⏳ 链接最长 " + config.expireHours + " 小时内有效，到期后文件将被清理，请及时下载。";
  const parsed = new URL(url);
  const stamp = parsed.searchParams.get("X-Amz-Date") ?? "";
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  const seconds = Number(parsed.searchParams.get("X-Amz-Expires"));
  if (!match || !Number.isFinite(seconds)) throw new Error("S3 下载签名缺少有效期");
  const deadline = new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!) + seconds * 1000);
  const local = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(deadline);
  return "\n⏳ 链接有效至 " + local + "（北京时间 UTC+8），到期后文件将被清理，请及时下载。";
}

type PurgeOutcome = "deleted" | "orphaned" | "failed";
const warnedBackends = new WeakMap<RelayIndex, Set<string>>();
async function deleteIndexedObject(config: RelayConfig, index: RelayIndex, key: string, signal?: AbortSignal): Promise<PurgeOutcome> {
  const current = index.get(key);
  if (!current) return "deleted";
  const objectName = objectNameFromUrl(config, current.url);
  if (!objectName || !key.startsWith(backend(config) + ":")) {
    const warned = warnedBackends.get(index) ?? new Set<string>();
    warnedBackends.set(index, warned);
    const pair = backend(config) + ":" + key.split(":")[0];
    if (!warned.has(pair)) {
      warned.add(pair);
      log.warn("外链账本含其他后端的对象，已保留；请切回原后端清理或在云端清理。本次运行对同一后端只提示一次。");
    }
    return "orphaned";
  }
  try {
    await deleteObject(config, objectName, signal);
    await index.forget(key);
    return "deleted";
  } catch (error) {
    signal?.throwIfAborted();
    log.warn("外链对象删除失败，账本已保留以便重试: " + current.name + " (" + String(error) + ")");
    return "failed";
  }
}

export async function sweepExpiredRelayObjects(overrides?: { config?: RelayConfig | null; index?: RelayIndex }): Promise<void> {
  const config = overrides?.config === undefined ? getRelayConfig() : overrides.config;
  if (!config) return;
  const index = overrides?.index ?? await getRelayIndex();
  const expired = (entry: RelayIndexEntry) => entry.state === "planned"
    ? !(Date.now() - Date.parse(entry.at) < RELAY_HTTP_TIMEOUT + 60_000)
    : !entry.deleteAfter || !(Date.parse(entry.deleteAfter) > Date.now());
  let removed = 0;
  for (const entry of index.entries()) {
    application.signal.throwIfAborted();
    if (!expired(entry)) continue;
    await withUploadLock(entry.key, async () => {
      const current = index.get(entry.key);
      if (current && expired(current) && await deleteIndexedObject(config, index, entry.key, application.signal) === "deleted") removed++;
    });
  }
  if (removed) log.info("外链过期清理完成，已删除 " + removed + " 个对象");
}

export interface RelayObject {
  url: string; name: string; size: number; state: "planned" | "uploaded"; at: string;
  expiresAt?: string | null;
  deleteAfter?: string | null;
}
export async function listRelayObjects(options?: { config?: RelayConfig | null; index?: RelayIndex }): Promise<RelayObject[]> {
  const config = options?.config === undefined ? getRelayConfig() : options.config;
  const index = options?.index ?? await getRelayIndex();
  return index.entries().map(({ key, url, name, size, at, state, expiresAt, deleteAfter }) => ({
    url: config && key.startsWith(backend(config) + ":") && state === "uploaded" && expiresAt &&
      Date.parse(expiresAt) - Date.now() >= 1000 && objectNameFromUrl(config, url) ? downloadUrl(config, url, expiresAt) : url,
    name, size, at, state, expiresAt, deleteAfter,
  }));
}

export interface RelayPurgeResult { matched: number; deleted: number; failed: number; orphaned: number; }
export async function purgeRelayObjects(options?: { match?: string; config?: RelayConfig | null; index?: RelayIndex }): Promise<RelayPurgeResult> {
  const config = options?.config === undefined ? getRelayConfig() : options.config;
  if (!config) throw new Error("未配置外链分发（data/config/relay.json 不存在），没有可清理的对象");
  const index = options?.index ?? await getRelayIndex();
  const match = options?.match?.trim();
  const result: RelayPurgeResult = { matched: 0, deleted: 0, failed: 0, orphaned: 0 };
  for (const entry of index.entries()) {
    application.signal.throwIfAborted();
    if (match && !entry.name.includes(match) && !entry.url.includes(match)) continue;
    result.matched++;
    await withUploadLock(entry.key, async () => { result[await deleteIndexedObject(config, index, entry.key, application.signal)]++; });
  }
  return result;
}

const uploadLocks = new KeyedQueue();
function withUploadLock<T>(key: string, task: () => Promise<T>, signal: AbortSignal = application.signal): Promise<T> {
  return uploadLocks.run(key, task, signal);
}
let indexPromise: Promise<RelayIndex> | undefined;
function getRelayIndex(): Promise<RelayIndex> { return indexPromise ??= openRelayIndex(RELAY_INDEX_PATH); }

export interface RelayRequest {
  tempDir?: string; config: RelayConfig; localPath: string; size: number; filename: string; signal?: AbortSignal; index?: RelayIndex;
}

export async function relayFile(request: RelayRequest): Promise<string> {
  const { config, localPath, filename } = request;
  const signal = AbortSignal.any([application.signal, AbortSignal.timeout(RELAY_HTTP_TIMEOUT), ...(request.signal ? [request.signal] : [])]);
  signal.throwIfAborted();
  if (!filename || filename === "." || filename === ".." || /[/\\\x00-\x1f\x7f]/.test(filename) || Buffer.byteLength(filename) > 512) throw new Error("外链文件名无效");
  if (request.size > config.maxBytes) throw new Error(filename + " 超过外链分发上限 " + formatSize(config.maxBytes));
  const tempDir = resolve(request.tempDir ?? "data/runtime/tmp/relay");
  await mkdir(tempDir, { recursive: true });
  const snapshot = join(tempDir, ".relay-" + randomUUID());
  let size = 0;
  const hash = createHash("sha256");
  try {
    await pipeline(createReadStream(localPath), new Transform({ transform(chunk: Buffer, _encoding, next) {
      size += chunk.length;
      if (size > config.maxBytes) next(new Error("源文件增长超过外链上限"));
      else { hash.update(chunk); next(null, chunk); }
    } }), createWriteStream(snapshot, { flags: "wx" }), { signal });
    if (size !== request.size) throw new Error("源文件在同步时大小发生变化，请重新发送文件");
    const index = request.index ?? await getRelayIndex();
    const key = backend(config) + ":" + relayCacheKey(hash.digest("hex"), filename, objectBaseUrl(config));
    return await withUploadLock(key, async () => {
      signal.throwIfAborted();
      let cached = index.get(key);
      // Fresh shares get at least 90% of the configured TTL; retired links keep their original deadlines.
      const reusable = (entry: RelayIndexEntry) => !!entry.expiresAt &&
        Date.parse(entry.expiresAt) - Date.now() >= Math.max(1000, Math.ceil(config.expireHours * 3600 * 0.9) * 1000);
      if (cached?.state === "uploaded") {
        let exists = false;
        if (reusable(cached)) {
          try { exists = await remoteStillExists(config, cached.url, cached.size, signal); }
          catch (error) {
            // Without ListBucket, a missing AWS object is indistinguishable from denied HEAD.
            // Try a fresh unique object; its PUT and strict post-upload HEAD still must succeed.
            if (!(error instanceof S3RequestError && error.status === 403)) throw error;
          }
        }
        if (exists && reusable(cached)) return downloadUrl(config, cached.url, cached.expiresAt!);
        cached = undefined;
      }
      const objectName = cached ? objectNameFromUrl(config, cached.url)
        : new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomUUID() + "/" + filename;
      if (!objectName) throw new Error("外链账本与配置不匹配，记录已保留，请联系管理员");
      const retiredKey = !cached && index.get(key) ? key + ":retired:" + randomUUID() : undefined;
      const entry: RelayIndexEntry = cached ?? { key, url: storedObjectUrl(config, objectName), name: filename, size,
        at: new Date().toISOString(), state: "planned", expiresAt: null };
      // Before PUT: interrupted or ambiguously successful uploads always have a deletion record.
      await index.remember({ ...entry, ...(entry.state === "planned" ? { at: new Date().toISOString() } : {}) }, retiredKey);
      await putObject(config, objectName, snapshot, signal);
      if (!await remoteStillExists(config, entry.url, size, signal)) throw new Error("S3 上传后未找到对象，不发送下载链接");
      const expiresAt = entry.expiresAt ?? new Date(Date.now() + Math.floor(config.expireHours * 3600) * 1000).toISOString();
      const completed = { ...entry, state: "uploaded" as const, expiresAt,
        deleteAfter: entry.deleteAfter ?? new Date(Date.parse(expiresAt) + config.cleanupGraceMinutes * 60_000).toISOString() };
      await index.remember(completed);
      log.info("外链上传完成: " + filename + " (" + formatSize(size) + ")，到期时间 " + completed.expiresAt);
      return downloadUrl(config, completed.url, completed.expiresAt);
    }, signal);
  } finally { await rm(snapshot, { force: true }); }
}
