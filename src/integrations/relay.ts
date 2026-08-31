// 大文件外链分发：超过 IM 单条附件上限的文件改为上传到外部存储，在群里发下载链接。
//
// 本模块只认识 WebDAV——PUT 一个文件，拼出对应的公开下载地址。它不知道后面挂的是
// alist、Nextcloud 还是别的东西；后端选型完全落在 data/config/relay.json 里，那个文件
// 不存在时整个特性关闭，send_file 的行为与未引入本模块时完全一致。
//
// 有意只支持本地文件：让机器人把任意 http(s) 地址镜像成一条公开链接，等于把它变成
// 一个开放的转载器；而且远程响应不一定给 Content-Length，拿不到可靠的大小。超限的
// 远程文件仍按原样报错，模型可以先用 bash 下载到自己的 tmp 再发。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { formatSize } from "@earendil-works/pi-coding-agent";
import {
  MAX_ATTACHMENT_BYTES,
  RELAY_HTTP_TIMEOUT,
  RELAY_PROBE_TIMEOUT,
} from "../core/config.ts";
import { log } from "../core/log.ts";
import { RELAY_CONFIG_PATH, RELAY_INDEX_PATH } from "../core/storage.ts";
import {
  hashFile,
  openRelayIndex,
  relayCacheKey,
  type RelayIndex,
} from "./relay-index.ts";

export interface RelayConfig {
  /** WebDAV 上传基址，例如 http://127.0.0.1:5244/dav/relay/ */
  webdavUrl: string;
  /** 与 webdavUrl 指向同一目录的公开下载基址，例如 https://files.example.com/d/relay/ */
  publicBaseUrl: string;
  username?: string;
  password?: string;
  maxBytes: number;
}

/** 默认外链上限；再大的文件多半是误发，也会长时间占住一次工具调用。 */
const DEFAULT_RELAY_MAX_BYTES = 2 * 1024 ** 3;

function requireHttpUrl(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} 的 ${field} 必须是非空字符串`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${path} 的 ${field} 不是有效 URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${path} 的 ${field} 只支持 http:// 或 https://`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${path} 的 ${field} 必须是字符串`);
  }
  return value;
}

/**
 * 读取并校验外链配置。文件不存在返回 null（特性关闭）；文件存在但内容有问题一律抛错，
 * 由启动流程拒绝启动——否则运维只会在某个用户发了个 100MB 文件时才发现配置写错了。
 */
export function loadRelayConfig(path: string = RELAY_CONFIG_PATH): RelayConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path} 无法读取`, { cause: error });
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} 不是有效 JSON`, { cause: error });
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${path} 必须是 JSON 对象`);
  }
  const fields = doc as Record<string, unknown>;

  const username = optionalString(fields.username, "username", path);
  const password = optionalString(fields.password, "password", path);
  if ((username === undefined) !== (password === undefined)) {
    throw new Error(`${path} 的 username 和 password 必须同时提供或同时省略`);
  }

  let maxBytes = DEFAULT_RELAY_MAX_BYTES;
  if (fields.maxBytes !== undefined) {
    if (
      typeof fields.maxBytes !== "number" ||
      !Number.isSafeInteger(fields.maxBytes) ||
      fields.maxBytes <= 0
    ) {
      throw new Error(`${path} 的 maxBytes 必须是正整数`);
    }
    maxBytes = fields.maxBytes;
  }
  // 小于等于 IM 直传上限的话这条路永远不会被触发，几乎必然是写错了。
  if (maxBytes <= MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${path} 的 maxBytes 必须大于 IM 单条附件上限 ${MAX_ATTACHMENT_BYTES}，否则外链分发永远不会生效`
    );
  }

  return {
    webdavUrl: requireHttpUrl(fields.webdavUrl, "webdavUrl", path),
    publicBaseUrl: requireHttpUrl(fields.publicBaseUrl, "publicBaseUrl", path),
    ...(username === undefined ? {} : { username, password }),
    maxBytes,
  };
}

let cachedConfig: RelayConfig | null | undefined;

/** 在开放 HTTP 端口前校验外链配置，避免配置写错要等到第一个大文件才暴露。 */
export function initializeRelay(): void {
  cachedConfig = loadRelayConfig();
  if (cachedConfig) {
    log.info(
      `大文件外链分发已启用（上限 ${formatSize(cachedConfig.maxBytes)}，下载基址 ${cachedConfig.publicBaseUrl}）`
    );
  } else {
    log.info(`未配置 ${RELAY_CONFIG_PATH}，超过附件上限的文件仍按报错处理`);
  }
}

export function getRelayConfig(): RelayConfig | null {
  if (cachedConfig === undefined) initializeRelay();
  return cachedConfig ?? null;
}

/**
 * 拼接对象名。uuid 让链接不可枚举——公开基址上任何人拿到链接都能下载，猜不到就是唯一
 * 的保护；日期前缀让运维可以按天批量清理（本模块不做过期回收）。
 * filename 由调用方清洗过（不含分隔符），再叠一层 encodeURIComponent，路径穿越在结构上
 * 不可能：对象名永远以日期数字开头。
 */
function buildObjectName(filename: string): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${day}-${randomUUID()}-${filename}`;
}

function joinUrl(base: string, segment: string): string {
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return `${normalized}${encodeURIComponent(segment)}`;
}

/** 真正把文件 PUT 上去，返回公开下载地址。 */
async function putObject(
  config: RelayConfig,
  localPath: string,
  size: number,
  filename: string,
  signal?: AbortSignal
): Promise<string> {
  const objectName = buildObjectName(filename);
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
  };
  if (config.username !== undefined) {
    const credentials = `${config.username}:${config.password ?? ""}`;
    headers.Authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  }

  const timeout = AbortSignal.timeout(RELAY_HTTP_TIMEOUT);
  const response = await fetch(joinUrl(config.webdavUrl, objectName), {
    method: "PUT",
    headers,
    // BunFile 让 fetch 直接从磁盘流式发送并自动带上 Content-Length：整个文件不进内存，
    // WebDAV 端也不必处理 chunked 编码（部分实现对无长度的 PUT 支持很差）。
    body: Bun.file(localPath),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
    throw new Error(
      `外链上传失败 HTTP ${response.status}: ${filename}${detail ? ` - ${detail}` : ""}`
    );
  }
  await response.body?.cancel().catch(() => {});

  const url = joinUrl(config.publicBaseUrl, objectName);
  log.info(`外链上传完成: ${filename} (${formatSize(size)}) -> ${url}`);
  return url;
}

/**
 * 探测缓存里的地址是否还活着。运维按天清理、云盘侧删除都会让索引指向一个 404，
 * 而给用户一条死链比重传一次糟得多。公开基址通常是 302 到网盘直链，所以不跟随
 * 重定向。
 *
 * 状态码不够用：这类文件服务常把业务错误塞进 HTTP 200 的 JSON 里（"未授权"、
 * "对象不存在" 都是 200），只看 `status < 400` 会把错误信封当成文件还在。
 * 所以 2xx 还要求 Content-Length 与当初存下的大小一致——错误信封只有几十字节，
 * 对不上；重定向则说明服务端确实解析到了这个对象。
 * 服务端不给 Content-Length 时按「不存在」处理，代价是重传一次。
 */
async function remoteStillExists(
  url: string,
  size: number,
  signal?: AbortSignal
): Promise<boolean> {
  const timeout = AbortSignal.timeout(RELAY_PROBE_TIMEOUT);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    await response.body?.cancel().catch(() => {});
    if (response.status >= 300 && response.status < 400) return true;
    if (response.status >= 400) return false;
    return Number(response.headers.get("content-length")) === size;
  } catch {
    // 探测失败时按「不存在」处理：重传浪费一次带宽，发死链浪费的是用户的时间。
    return false;
  }
}

/**
 * 同一个内容同时只上传一次。第二个调用者排在后面，等前一个落地后直接命中索引；
 * 它不共享前一个的 AbortSignal，所以前一个被 /stop 掉不会连累后一个。
 */
const uploadLocks = new Map<string, Promise<void>>();

async function withUploadLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = uploadLocks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => {},
    () => {}
  );
  uploadLocks.set(key, settled);
  try {
    return await run;
  } finally {
    if (uploadLocks.get(key) === settled) uploadLocks.delete(key);
  }
}

let indexPromise: Promise<RelayIndex> | undefined;

function getRelayIndex(): Promise<RelayIndex> {
  indexPromise ??= openRelayIndex(RELAY_INDEX_PATH);
  return indexPromise;
}

export interface RelayRequest {
  config: RelayConfig;
  localPath: string;
  size: number;
  filename: string;
  signal?: AbortSignal;
  /** 覆盖默认的进程级去重索引（data/runtime 下那份）。 */
  index?: RelayIndex;
}

/**
 * 把一个本地文件分发成公开链接。相同内容 + 相同文件名只会真正上传一次：先算内容
 * 哈希查索引，命中且远端仍在就直接复用旧地址。
 */
export async function relayFile(request: RelayRequest): Promise<string> {
  const { config, localPath, size, filename, signal } = request;
  signal?.throwIfAborted();
  if (size > config.maxBytes) {
    throw new Error(
      `${filename}（${formatSize(size)}）超过外链分发上限 ${formatSize(config.maxBytes)}`
    );
  }

  const index = request.index ?? (await getRelayIndex());
  // 哈希要读一遍整个文件，但这远比把它再传一遍便宜。
  const key = relayCacheKey(await hashFile(localPath, signal), filename);

  return withUploadLock(key, async () => {
    signal?.throwIfAborted();
    const cached = index.get(key);
    if (cached) {
      if (await remoteStillExists(cached.url, cached.size, signal)) {
        log.info(`外链命中去重索引，跳过上传: ${filename} -> ${cached.url}`);
        return cached.url;
      }
      log.warn(`外链索引记录的地址已不可访问，重新上传: ${filename} (${cached.url})`);
      await index.forget(key);
    }

    signal?.throwIfAborted();
    const url = await putObject(config, localPath, size, filename, signal);
    await index.remember({
      key,
      url,
      name: filename,
      size,
      at: new Date().toISOString(),
    });
    return url;
  });
}
