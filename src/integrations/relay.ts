// 大文件外链分发：超过 IM 单条附件上限的文件改为上传到外部存储，在群里发下载链接。
//
// 本模块只认识 WebDAV——PUT 一个文件，拼出对应的公开下载地址。它不知道后面挂的是
// alist、Nextcloud 还是别的东西；后端选型完全落在 data/config/relay.json 里，那个文件
// 不存在时整个特性关闭，send_file 的行为与未引入本模块时完全一致。
//
// 有意只支持本地文件：让机器人把任意 http(s) 地址镜像成一条公开链接，等于把它变成
// 一个开放的转载器；而且远程响应不一定给 Content-Length，拿不到可靠的大小。超限的
// 远程文件仍按原样报错，模型可以先用 bash 下载到自己的 tmp 再发。
import { createHmac, randomUUID } from "node:crypto";
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
  /**
   * 链接有效期（小时）。缺省表示永不过期，行为与未引入该字段时一致。
   *
   * 到期后发生什么取决于有没有配 signSecret：
   * - 没配：对象被 DELETE 掉，文件真的从后端消失，事后无法补救。
   * - 配了：只是签名失效，文件留在后端，再发一次即可拿到新链接且无需重传。
   */
  expireHours?: number;
  /**
   * 签名密钥。配了它，公开地址会带上一个有时效的 `?sign=`，到期后后端自己拒绝下载，
   * 于是「链接失效」和「文件保留」可以同时成立。
   *
   * 这是本模块唯一一处对后端实现有假设的地方：签名格式是
   * `base64(HMAC-SHA256(secret, "<虚拟路径>:<到期秒时间戳>")) + ":" + <到期秒时间戳>`。
   * 后端不认这套格式就别配它——链接会带上一个被忽略的参数，等于没配。
   */
  signSecret?: string;
  /**
   * 参与签名的虚拟路径前缀（以 / 开头和结尾），缺省从 publicBaseUrl 推导。
   * 只在推导不出来时才需要手写，见 deriveSignPathPrefix。
   */
  signPathPrefix?: string;
}

/** 默认外链上限；再大的文件多半是误发，也会长时间占住一次工具调用。 */
const DEFAULT_RELAY_MAX_BYTES = 2 * 1024 ** 3;
/** expireHours 的上限，够用且能拦住把毫秒当小时填进来的手误。 */
const MAX_RELAY_EXPIRE_HOURS = 24 * 365;

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

/** 前后都补上 /，签名串里路径的形状必须是稳定的。 */
function normalizeSignPathPrefix(value: string): string {
  const trimmed = value.trim();
  const withLead = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLead.endsWith("/") ? withLead : `${withLead}/`;
}

/**
 * 从公开下载基址推出参与签名的虚拟路径前缀。
 *
 * 签名覆盖的是后端里的虚拟路径（/relay/xxx.pdf），而公开地址在它前面还多一段下载路由
 * （惯例是 /d 或 /p）。这里取从左往右第一个 d/p 段，其后即为虚拟路径——
 * `https://files.example.com/d/relay/` 推出 `/relay/`，绝大多数部署就是这个形状。
 *
 * 反向代理把后端挂在子路径下（`/store/d/relay/`）之类的情形推不对，也推不出来时返回
 * null，由配置校验要求显式写 signPathPrefix：宁可拒绝启动，也不要签出一批必然 403 的
 * 链接——那种失败要等到群里有人点开才会暴露。
 */
function deriveSignPathPrefix(publicBaseUrl: string): string | null {
  let segments: string[];
  try {
    segments = new URL(publicBaseUrl).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  const route = segments.findIndex((segment) => segment === "d" || segment === "p");
  if (route < 0) return null;
  // 后端按解码后的路径验签，所以这里也要解码。
  const rest = segments.slice(route + 1).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  return rest.length === 0 ? "/" : `/${rest.join("/")}/`;
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

  let expireHours: number | undefined;
  if (fields.expireHours !== undefined && fields.expireHours !== null) {
    if (
      typeof fields.expireHours !== "number" ||
      !Number.isFinite(fields.expireHours) ||
      fields.expireHours <= 0 ||
      fields.expireHours > MAX_RELAY_EXPIRE_HOURS
    ) {
      throw new Error(
        `${path} 的 expireHours 必须是 0 到 ${MAX_RELAY_EXPIRE_HOURS} 之间的正数（小时）`
      );
    }
    expireHours = fields.expireHours;
  }

  const publicBaseUrl = requireHttpUrl(fields.publicBaseUrl, "publicBaseUrl", path);

  const signSecret = optionalString(fields.signSecret, "signSecret", path)?.trim() || undefined;
  let signPathPrefix: string | undefined;
  if (signSecret !== undefined) {
    const explicit = optionalString(fields.signPathPrefix, "signPathPrefix", path)?.trim();
    const derived = explicit ? normalizeSignPathPrefix(explicit) : deriveSignPathPrefix(publicBaseUrl);
    if (!derived) {
      throw new Error(
        `${path} 配了 signSecret，但无法从 publicBaseUrl（${publicBaseUrl}）推出参与签名的路径前缀，` +
          "请显式填写 signPathPrefix，例如 \"/relay/\""
      );
    }
    signPathPrefix = derived;
  } else if (fields.signPathPrefix !== undefined && fields.signPathPrefix !== null) {
    // 单独一个 signPathPrefix 什么也做不了。静默忽略只会让人以为签名已经生效。
    throw new Error(`${path} 的 signPathPrefix 只在同时配置 signSecret 时有意义`);
  }

  return {
    webdavUrl: requireHttpUrl(fields.webdavUrl, "webdavUrl", path),
    publicBaseUrl,
    ...(username === undefined ? {} : { username, password }),
    maxBytes,
    ...(expireHours === undefined ? {} : { expireHours }),
    ...(signSecret === undefined ? {} : { signSecret, signPathPrefix }),
  };
}

let cachedConfig: RelayConfig | null | undefined;

/** 在开放 HTTP 端口前校验外链配置，避免配置写错要等到第一个大文件才暴露。 */
export function initializeRelay(): void {
  cachedConfig = loadRelayConfig();
  if (cachedConfig) {
    // 到期是删文件还是只让链接失效，是运维最需要一眼看清的一件事，写进启动日志。
    const expiry = !cachedConfig.expireHours
      ? "永不过期"
      : cachedConfig.signSecret
        ? `签名 ${cachedConfig.expireHours} 小时后失效，文件保留`
        : `${cachedConfig.expireHours} 小时后删除文件`;
    log.info(
      `大文件外链分发已启用（上限 ${formatSize(cachedConfig.maxBytes)}，下载基址 ${cachedConfig.publicBaseUrl}，${expiry}）`
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
 * 的保护；日期前缀让人工排查时能按天定位（到期回收走索引，见
 * sweepExpiredRelayObjects）。
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

function buildAuthHeaders(config: RelayConfig): Record<string, string> {
  if (config.username === undefined) return {};
  const credentials = `${config.username}:${config.password ?? ""}`;
  return {
    Authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`,
  };
}

/**
 * 把后端的失败翻成管理员能照着动手的一句话。
 *
 * 这条消息会经模型转述进群里，而群成员对「HTTP 500」无能为力——真正需要被叫醒的是
 * 管理员。最常见的情况恰恰不是本项目的问题：网盘挂载在后端侧的授权（token/cookie）
 * 过期了，WebDAV 这层凭据完全正常，表现为 5xx。所以按状态码分类给出具体去哪儿修，
 * 并附上后端自己的原文，管理员据此能直接定位。
 */
function describeBackendFailure(status: number, detail: string): string {
  const suffix = detail ? `（后端返回：${detail}）` : "";
  if (status === 401 || status === 403) {
    return `外链后端拒绝了上传凭据 HTTP ${status}${suffix}。请管理员检查 data/config/relay.json 中的账号密码，以及该账号对上传目录的写权限。`;
  }
  if (status === 404) {
    return `外链后端找不到上传目录 HTTP 404${suffix}。请管理员确认 relay.json 的 webdavUrl 指向的目录确实存在。`;
  }
  if (status === 507) {
    return `外链后端存储空间不足 HTTP 507${suffix}。请管理员清理后端空间后重试。`;
  }
  if (status >= 500) {
    return `外链后端故障 HTTP ${status}${suffix}。最常见的原因是后端挂载的网盘授权（token / cookie）已过期，需要管理员登录后端重新授权；本项目的 WebDAV 凭据正常与否与此无关。`;
  }
  return `外链上传失败 HTTP ${status}${suffix}。请管理员检查外链后端状态。`;
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
    ...buildAuthHeaders(config),
  };

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
    throw new Error(`${filename} 未能分发：${describeBackendFailure(response.status, detail)}`);
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
 * 从存下来的公开地址反推对象名。上传时公开地址就是
 * `publicBaseUrl + encodeURIComponent(objectName)`，这里原样倒推回去。
 *
 * 配置改过（换了后端或换了目录）之后，旧记录的前缀对不上，我们就没有能力再管理那个
 * 对象了，返回 null 让调用方丢弃索引记录并明确告警——留着一条永远删不掉的记录，只会
 * 让过期清理看起来在工作而实际没有。
 */
function objectNameFromPublicUrl(config: RelayConfig, url: string): string | null {
  const base = config.publicBaseUrl.endsWith("/")
    ? config.publicBaseUrl
    : `${config.publicBaseUrl}/`;
  if (!url.startsWith(base)) return null;
  const encoded = url.slice(base.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * 后端用的是 Go 的 `base64.URLEncoding`：URL 字母表 **且带 `=` 填充**。Node 的
 * `digest("base64url")` 不带填充，直接拿来用会让每一条链接都验签失败，而且失败要等到
 * 群里有人点开才会暴露。所以在标准 base64 上换字母表，把填充留着。
 */
function paddedBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

/**
 * 为一个对象签一个到期时间。expiresAt 传 0 表示永不过期（后端约定），用于配了
 * signSecret 但没配 expireHours 的情况——那时签名的作用只是通过后端的强制验签。
 */
function signObjectName(config: RelayConfig, objectName: string, expiresAt: number): string {
  const data = `${config.signPathPrefix ?? "/"}${objectName}`;
  const expire = String(expiresAt);
  const mac = createHmac("sha256", config.signSecret ?? "").update(`${data}:${expire}`).digest();
  return `${paddedBase64Url(mac)}:${expire}`;
}

/**
 * 把索引里存的裸地址变成这一刻可用的公开地址。
 *
 * 索引存的始终是不带签名的地址：签名有时效，存进去第二天就是一条死链，而裸地址是这个
 * 对象的恒定身份，`objectNameFromPublicUrl` 也要靠它反推对象名。每次要给出去的时候现签
 * 一个，于是命中去重时不用重传就能拿到一条寿命完整的新链接。
 */
export function publicUrlFor(config: RelayConfig, storedUrl: string): string {
  if (!config.signSecret) return storedUrl;
  const objectName = objectNameFromPublicUrl(config, storedUrl);
  // 前缀对不上（换过后端或目录）时签了也是错的，原样返回，让调用方那边的探测去发现问题。
  if (!objectName) return storedUrl;
  const expiresAt = config.expireHours
    ? Math.floor(Date.now() / 1000) + Math.round(config.expireHours * 3600)
    : 0;
  const url = new URL(storedUrl);
  url.searchParams.set("sign", signObjectName(config, objectName, expiresAt));
  return url.toString();
}

/**
 * 群消息里那句有效期提示。
 *
 * 只说链接的有效期——文件在后端是留着还是被删了属于运维细节，群成员该做的事在两种模式下
 * 都一样，就是在期限内下载。唯一的区别是删文件那种模式过期后真的没有补救途径，所以那句
 * 多一层提醒。
 */
export function describeRelayExpiry(config: RelayConfig): string {
  if (!config.expireHours) return "";
  if (config.signSecret) {
    return `\n⏳ 链接 ${config.expireHours} 小时后失效，请及时下载。`;
  }
  return `\n⏳ 链接 ${config.expireHours} 小时后失效，届时文件会被删除，请及时下载。`;
}

/** DELETE 一个对象。已经不存在（404/410）按成功处理——目标状态就是「它没了」。 */
async function deleteObject(
  config: RelayConfig,
  objectName: string,
  signal?: AbortSignal
): Promise<void> {
  const timeout = AbortSignal.timeout(RELAY_PROBE_TIMEOUT);
  const response = await fetch(joinUrl(config.webdavUrl, objectName), {
    method: "DELETE",
    headers: buildAuthHeaders(config),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  await response.body?.cancel().catch(() => {});
  if (response.ok || response.status === 404 || response.status === 410) return;
  throw new Error(`HTTP ${response.status}`);
}

/** 删一条索引记录背后的对象。调用方必须已持有该 key 的上传锁。 */
type PurgeOutcome = "deleted" | "orphaned" | "failed";

async function deleteIndexedObject(
  config: RelayConfig,
  index: RelayIndex,
  key: string
): Promise<PurgeOutcome> {
  const current = index.get(key);
  if (!current) return "deleted";

  const objectName = objectNameFromPublicUrl(config, current.url);
  if (!objectName) {
    // 换过后端或换过目录之后，我们已经没有能力再删那个对象了。留着一条永远删不掉的
    // 记录只会让清理看起来在工作，所以丢掉记录并明确说需要人工处理。
    log.warn(
      `外链索引记录与当前 publicBaseUrl 对不上，已丢弃记录但无法删除远端对象（需人工清理）: ${current.url}`
    );
    await index.forget(key);
    return "orphaned";
  }
  try {
    await deleteObject(config, objectName);
    await index.forget(key);
    return "deleted";
  } catch (error) {
    // 保留记录，留给下一轮重试——后端临时不可达就把记录丢掉的话，那个对象就再也没人
    // 管了，变成网盘上永久的孤儿。
    log.warn(`外链对象删除失败，索引记录已保留以便重试: ${current.url} (${String(error)})`);
    return "failed";
  }
}

/**
 * 删除已过期的对象。有效期是滑动的：命中去重会刷新 at，所以「最后一次分享后 N 小时」
 * 才算过期。
 */
export async function sweepExpiredRelayObjects(
  /** 覆盖默认的进程级配置与索引，供测试注入。 */
  overrides?: { config?: RelayConfig | null; index?: RelayIndex }
): Promise<void> {
  // 用 === undefined 而不是 ??：显式传 null 的意思是「就当没配置」，`??` 会把它当成
  // 「没传」再去读进程级配置，那样签名里的 `| null` 就是句空话。
  const config = overrides?.config === undefined ? getRelayConfig() : overrides.config;
  if (!config?.expireHours) return;
  // 配了签名就不再删文件：到期靠签名自己失效，对象留在后端。下次再发同一份内容会命中
  // 去重、现签一条新链接，一个字节都不用重传——删掉它只会逼着下一次重新上传一遍。
  // 代价是后端占用只增不减，清理走 relay-purge。
  if (config.signSecret) return;
  const ttl = config.expireHours * 60 * 60_000;
  const index = overrides?.index ?? (await getRelayIndex());

  let removed = 0;
  for (const entry of index.entries()) {
    const at = Date.parse(entry.at);
    // 时间戳读不出来的记录无法参与「多久没被分享」的判断。留着它等于让这份内容永不
    // 过期，与配置了有效期的初衷相悖，所以按过期处理。
    if (!Number.isNaN(at) && Date.now() - at < ttl) continue;

    await withUploadLock(entry.key, async () => {
      // 双重检查：排队等锁期间这份内容可能刚被人分享过并刷新了时间戳。
      const current = index.get(entry.key);
      if (!current) return;
      const currentAt = Date.parse(current.at);
      if (!Number.isNaN(currentAt) && Date.now() - currentAt < ttl) return;

      if ((await deleteIndexedObject(config, index, entry.key)) === "deleted") removed++;
    });
  }
  if (removed > 0) log.info(`外链过期清理完成，已删除 ${removed} 个对象`);
}

/** 索引里一条外链的只读视图，供运维命令展示。 */
export interface RelayObject {
  url: string;
  name: string;
  size: number;
  /** 最后一次分发这份内容的时间（ISO）。过期计时从这里开始算。 */
  at: string;
}

/** 列出索引里仍在册的外链，按最后分发时间从旧到新——最该被清掉的排在最前面。 */
export async function listRelayObjects(options?: {
  config?: RelayConfig | null;
  index?: RelayIndex;
}): Promise<RelayObject[]> {
  // 同 sweep/purge：显式传 null 表示「就当没配置」，用 === undefined 区分「没传」。
  const config = options?.config === undefined ? getRelayConfig() : options.config;
  const target = options?.index ?? (await getRelayIndex());
  // 配了签名的话列出来的地址得是现签的，否则管理员照着复制一条只会得到 403。
  return target
    .entries()
    .map(({ url, name, size, at }) => ({
      url: config ? publicUrlFor(config, url) : url,
      name,
      size,
      at,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export interface RelayPurgeResult {
  matched: number;
  deleted: number;
  /** 后端删除失败，索引记录已保留，可以重试。 */
  failed: number;
  /** 地址与当前 publicBaseUrl 对不上，记录已丢弃但远端对象需要人工清理。 */
  orphaned: number;
}

/**
 * 手动清理：删除匹配的对象并丢弃对应的索引记录。
 *
 * 与过期清理共用同一条删除路径，区别只是不看时间。允许在机器人运行时执行：删除后端对象
 * 才是决定性的动作，索引本身会自愈——机器人那份内存副本即使还留着记录，下次命中时的
 * HEAD 探测会 404，于是丢弃记录并重传。
 */
export async function purgeRelayObjects(options?: {
  /** 只清理文件名或地址包含该子串的条目；缺省表示全部。 */
  match?: string;
  config?: RelayConfig | null;
  index?: RelayIndex;
}): Promise<RelayPurgeResult> {
  const config = options?.config === undefined ? getRelayConfig() : options.config;
  if (!config) throw new Error("未配置外链分发（data/config/relay.json 不存在），没有可清理的对象");
  const index = options?.index ?? (await getRelayIndex());
  const match = options?.match?.trim();

  const result: RelayPurgeResult = { matched: 0, deleted: 0, failed: 0, orphaned: 0 };
  for (const entry of index.entries()) {
    if (match && !entry.name.includes(match) && !entry.url.includes(match)) continue;
    result.matched++;
    // 与上传、过期清理共用同一把锁：正在被上传或清理的条目不会被并发删两次。
    await withUploadLock(entry.key, async () => {
      switch (await deleteIndexedObject(config, index, entry.key)) {
        case "deleted":
          result.deleted++;
          break;
        case "orphaned":
          result.orphaned++;
          break;
        default:
          result.failed++;
      }
    });
  }
  return result;
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
      // 探测也要带签名：后端开了强制验签时，不带签名的 HEAD 一律 401，会被当成「对象没了」
      // 而每次都重传，去重就彻底失效了。
      const probeUrl = publicUrlFor(config, cached.url);
      if (await remoteStillExists(probeUrl, cached.size, signal)) {
        // 探测确认对象还在，才刷新时间戳：这样过期计时是「最后一次分享后 N 小时」，
        // 第二个人拿到的链接也有完整寿命，而且一个字节都不用重传。
        await index.remember({ ...cached, at: new Date().toISOString() });
        log.info(`外链命中去重索引，跳过上传: ${filename} -> ${cached.url}`);
        // 现签一条：命中缓存复用的是后端那个对象，不是当初那条已经在倒计时的链接。
        return publicUrlFor(config, cached.url);
      }
      log.warn(`外链索引记录的地址已不可访问，重新上传: ${filename} (${cached.url})`);
      await index.forget(key);
    }

    signal?.throwIfAborted();
    const url = await putObject(config, localPath, size, filename, signal);
    // 索引存裸地址，签名是给出去的那一刻才现签的，见 publicUrlFor。
    await index.remember({
      key,
      url,
      name: filename,
      size,
      at: new Date().toISOString(),
    });
    return publicUrlFor(config, url);
  });
}
