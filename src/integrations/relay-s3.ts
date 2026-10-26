// S3 Signature V4 comes from Bun; HTTP stays here so cancellation covers every request.
import { readFileSync } from "node:fs";
import { S3Client } from "bun";
import { NATIVE_FILE_MAX_BYTES, RELAY_HTTP_TIMEOUT, RELAY_PROBE_TIMEOUT } from "../core/transfer-limits.ts";

export interface RelayConfig {
  provider: "s3";
  /** Service endpoint, without bucket, object path or query. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** "" for the bucket root, otherwise a directory ending in "/". */
  prefix: string;
  forcePathStyle: boolean;
  maxBytes: number;
  expireHours: number;
  cleanupGraceMinutes: number;
}

export const DEFAULT_RELAY_MAX_BYTES = 2 * 1024 ** 3;
export const DEFAULT_RELAY_EXPIRE_HOURS = 2;
export const DEFAULT_RELAY_CLEANUP_GRACE_MINUTES = 30;

function required(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${path} 的 ${field} 必须是非空字符串，且不能含控制字符或首尾空格`);
  }
  return value;
}

/** The one reader of relay.json: the service, configuration checks and reset accept exactly the same files. */
export function readRelayConfigFile(path: string): RelayConfig | null {
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

export function validateRelayConfig(doc: unknown, path = "data/config/relay.json"): RelayConfig {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${path} 必须是 JSON 对象`);
  const f = doc as Record<string, unknown>;
  if (f.provider !== "s3") throw new Error(`${path} 的 provider 必须是 s3`);
  const raw = required(f.endpoint, "endpoint", path);
  let endpoint: URL;
  try { endpoint = new URL(raw); } catch { throw new Error(`${path} 的 endpoint 必须是完整的 http:// 或 https:// URL`); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error(`${path} 的 endpoint 必须是服务地址，不能包含桶路径、账号、查询参数或片段`);
  }
  const bucket = required(f.bucket, "bucket", path);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw new Error(`${path} 的 bucket 格式无效`);
  const region = required(f.region, "region", path);
  if (!/^[a-zA-Z0-9_-]+$/.test(region)) throw new Error(`${path} 的 region 格式无效`);
  // Objects sit at the bucket root unless a directory is configured; "/" also means the root.
  const directory = f.prefix === undefined || f.prefix === "" ? "" : required(f.prefix, "prefix", path).replace(/\/+$/, "");
  const prefix = directory && directory + "/";
  if (prefix.startsWith("/") || prefix.split("/").slice(0, -1).some(p => !p || p === "." || p === "..") ||
      /[\\?#%]/.test(prefix) || Buffer.byteLength(prefix) > 256) throw new Error(`${path} 的 prefix 必须为空（桶根目录）或对象目录，不能包含空段、路径穿越、反斜杠、?、# 或 %`);
  if (f.forcePathStyle !== undefined && typeof f.forcePathStyle !== "boolean") throw new Error(`${path} 的 forcePathStyle 必须是布尔值`);
  const forcePathStyle = f.forcePathStyle === true;
  if (!forcePathStyle && (endpoint.hostname === "localhost" || endpoint.hostname.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(endpoint.hostname))) {
    throw new Error(`${path} 的 IP / localhost 端点需要 forcePathStyle: true`);
  }
  // Consoles often show the bucket domain; virtual-hosted signing would prepend the bucket a second time.
  if (!forcePathStyle && endpoint.hostname.startsWith(bucket + ".")) {
    throw new Error(`${path} 的 endpoint 已包含桶名；Virtual hosted 会自动在服务端点前加桶名，请填写 ${endpoint.protocol}//${endpoint.hostname.slice(bucket.length + 1)}`);
  }
  const maxBytes = f.maxBytes === undefined ? DEFAULT_RELAY_MAX_BYTES : f.maxBytes;
  // Single PUT is intentionally bounded: no multipart uploads to strand or abort on another API.
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= NATIVE_FILE_MAX_BYTES || maxBytes > 5 * 1024 ** 3) {
    throw new Error(`${path} 的 maxBytes 必须是大于 ${NATIVE_FILE_MAX_BYTES} 且不超过 5 GiB 的整数`);
  }
  const expireHours = f.expireHours === undefined ? DEFAULT_RELAY_EXPIRE_HOURS : f.expireHours;
  if (typeof expireHours !== "number" || !Number.isFinite(expireHours) || expireHours * 3600 < 1 || expireHours > 168) {
    throw new Error(`${path} 的 expireHours 必须在 1 秒到 168 小时之间`);
  }
  const cleanupGraceMinutes = f.cleanupGraceMinutes === undefined ? DEFAULT_RELAY_CLEANUP_GRACE_MINUTES : f.cleanupGraceMinutes;
  if (typeof cleanupGraceMinutes !== "number" || !Number.isInteger(cleanupGraceMinutes) || cleanupGraceMinutes < 1 || cleanupGraceMinutes > 1440) {
    throw new Error(`${path} 的 cleanupGraceMinutes 必须是 1 到 1440 之间的整数（分钟）`);
  }
  return { provider: "s3", endpoint: endpoint.origin, region, bucket, prefix, forcePathStyle, maxBytes, expireHours, cleanupGraceMinutes,
    accessKeyId: required(f.accessKeyId, "accessKeyId", path), secretAccessKey: required(f.secretAccessKey, "secretAccessKey", path),
    ...(f.sessionToken === undefined ? {} : { sessionToken: required(f.sessionToken, "sessionToken", path) }) };
}

function client(config: RelayConfig): S3Client {
  const endpoint = new URL(config.endpoint);
  if (!config.forcePathStyle) endpoint.hostname = config.bucket + "." + endpoint.hostname;
  return new S3Client({ endpoint: endpoint.origin, bucket: config.bucket, region: config.region,
    accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
    // An absent token must not inherit unrelated AWS/S3 credentials from the environment.
    sessionToken: config.sessionToken ?? "", virtualHostedStyle: !config.forcePathStyle });
}

function signed(config: RelayConfig, objectName: string, method: "GET" | "HEAD" | "PUT" | "DELETE", expiresIn: number): string {
  return client(config).presign(config.prefix + objectName, { method, expiresIn });
}

export function objectBaseUrl(config: RelayConfig): string {
  const url = new URL(signed(config, "identity", "GET", 1));
  url.search = "";
  return url.href.slice(0, -"identity".length);
}

/** Decode only our random two-segment object layout, never a prefix, directory or foreign URL. */
export function objectNameFromUrl(config: RelayConfig, storedUrl: string): string | null {
  const base = objectBaseUrl(config);
  if (!storedUrl.startsWith(base)) return null;
  const parts = storedUrl.slice(base.length).split("/");
  if (parts.length !== 2 || !/^\d{8}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parts[0]!)) return null;
  try {
    const name = decodeURIComponent(parts[1]!);
    if (!name || name === "." || name === ".." || /[/\\\x00-\x1f\x7f]/.test(name) || /[?#]/.test(parts[1]!)) return null;
    return parts[0] + "/" + name;
  } catch { return null; }
}

export function storedObjectUrl(config: RelayConfig, objectName: string): string {
  const url = new URL(signed(config, objectName, "GET", 1));
  url.search = "";
  return url.href;
}

/** A stored link that can no longer be sent: retrying does not help, the file has to be sent again. */
export class LinkUnavailable extends Error {}

export function downloadUrl(config: RelayConfig, storedUrl: string, expiresAt: string): string {
  const objectName = objectNameFromUrl(config, storedUrl);
  if (!objectName) throw new LinkUnavailable("外链账本与当前 S3 后端不匹配");
  const seconds = Math.min(604800, Math.floor(Date.parse(expiresAt) / 1000) - Math.floor(Date.now() / 1000));
  if (!(seconds >= 1)) throw new LinkUnavailable("附件下载链接已过期，请重新发送文件");
  return signed(config, objectName, "GET", seconds);
}

async function request(config: RelayConfig, objectName: string, method: "PUT" | "HEAD" | "DELETE", signal?: AbortSignal, localPath?: string): Promise<Response> {
  const timeout = method === "PUT" ? RELAY_HTTP_TIMEOUT : RELAY_PROBE_TIMEOUT;
  const combined = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  try {
    // Signature lifetime includes five minutes of clock/network margin; request timeout stays bounded.
    const response = await fetch(signed(config, objectName, method, Math.ceil(timeout / 1000) + 300), {
      method, redirect: "error", signal: combined,
      ...(localPath ? { body: Bun.file(localPath), headers: {
        "Content-Type": "application/octet-stream", "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(objectName.split("/").at(-1)!).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase()),
      } } : {}),
    });
    await response.body?.cancel().catch(() => {});
    combined.throwIfAborted();
    return response;
  } catch {
    combined.throwIfAborted();
    // Network errors can include the signed request URL. Never forward that credential to logs or IM.
    throw new Error(`S3 ${method} 请求失败，请检查端点、网络和区域；不支持重定向`);
  }
}

export class S3RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function failure(method: string, status: number): Error {
  const reason = status === 401 || status === 403 ? "请检查系统时钟、密钥、区域、签名兼容性及对象读写删除权限；HEAD 403 也可能表示对象不存在且没有 ListBucket 权限"
    : status === 404 ? "请检查桶和端点是否正确" : "请检查对象存储服务状态";
  return new S3RequestError(`S3 ${method} HTTP ${status}：${reason}`, status);
}

export async function putObject(config: RelayConfig, objectName: string, localPath: string, signal: AbortSignal): Promise<void> {
  const response = await request(config, objectName, "PUT", signal, localPath);
  if (!response.ok) throw failure("上传", response.status);
}

export async function remoteStillExists(config: RelayConfig, storedUrl: string, size: number, signal?: AbortSignal): Promise<boolean> {
  const objectName = objectNameFromUrl(config, storedUrl);
  if (!objectName) throw new Error("外链账本与当前 S3 后端不匹配");
  const response = await request(config, objectName, "HEAD", signal);
  if (response.status === 404) return false;
  if (response.status !== 200) throw failure("探测", response.status);
  const length = response.headers.get("content-length");
  if (length === null || !/^\d+$/.test(length) || Number(length) !== size) throw new Error("S3 对象大小与外链账本不一致");
  return true;
}

export async function deleteObject(config: RelayConfig, objectName: string, signal?: AbortSignal): Promise<void> {
  const response = await request(config, objectName, "DELETE", signal);
  if (!response.ok && response.status !== 404) throw failure("删除", response.status);
}
