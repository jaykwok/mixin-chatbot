// 通讯录接口：部门与成员分页、按手机号查 imUserId。响应是 decryptV2 密文，签名用 AppID 派生的密钥校验。
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AsyncSemaphore } from "../../core/async-semaphore.ts";
import { accepted, PlatformRequestError, responseData, type ApiResponse, type PlatformClient } from "./client.ts";

export const ROOT_DEPARTMENT = "1";
export const DEPARTMENT_PAGE_SIZE = 32;
export const MEMBER_PAGE_SIZE = 100;

const sha512Base64 = (value: string) => createHash("sha512").update(value, "utf8").digest("base64");
const contentKey = (appSecret: string, timeStamp: string, nonce: string) =>
  createHash("sha256").update(`${sha512Base64(appSecret)}:${timeStamp}:${nonce}`, "utf8").digest();

export function signV2(appId: string, timeStamp: string, nonce: string, encrypt: string): string {
  return createHmac("sha256", sha512Base64(appId)).update(timeStamp + nonce + encrypt, "utf8").digest("hex");
}

export function decryptV2(appSecret: string, timeStamp: string, nonce: string, encrypt: string): string {
  // 平台示例用 URL 安全字母表，实际密文也含 + 和 /；base64url 解码两种都接受。
  const buffer = Buffer.from(encrypt, "base64url");
  if (buffer.length < 32 || (buffer.length - 16) % 16 !== 0) throw new Error("密文长度不合法");
  const decipher = createDecipheriv("aes-256-cbc", contentKey(appSecret, timeStamp, nonce), buffer.subarray(0, 16));
  return Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString("utf8");
}

export interface DirectoryMember {
  readonly phone: string;
  readonly name: string;
}

/** 部门的展示信息（管理员选择同步范围时用）。 */
export interface DepartmentInfo {
  readonly id: string;
  readonly name: string;
  /** 部门完整路径（只有部门详情接口返回）。 */
  readonly fullName?: string;
  /** 上级部门 ID，根部门为 "0"（只有部门详情接口返回）。 */
  readonly parentId?: string;
  /** 部门人数；平台隐藏人数时没有。 */
  readonly count?: number;
}

/** 带上级链的部门详情：ancestors 从一级部门到直属上级，不含根部门（1 或组织根部门自己的 ID）；上级链读不到时没有。 */
export interface DepartmentDetail extends DepartmentInfo {
  readonly ancestors?: readonly { readonly id: string; readonly name: string }[];
}

/** 一组部门的详情；平台明确拒绝的部门（见 departmentRefusal）单列，不影响其余部门。 */
export interface DepartmentDescription {
  readonly departments: readonly DepartmentDetail[];
  readonly unavailable: readonly { readonly id: string; readonly message: string }[];
}

/** 比任何真实组织都深的上级链：更长的视为响应有误（或成环），不给上级链。 */
const MAX_DEPARTMENT_DEPTH = 32;
/** 查部门详情时同时进行的请求数；同一服务里的各次查询共用。 */
const DESCRIBE_CONCURRENCY = 4;

/**
 * 部门详情接口对部门本身的明确拒绝。真实平台对不是本组织部门的 ID（含不存在的）答复 422010「部门不属于当前组织」，
 * 文档里没有这个码（2026-10-26 实测）；文档列出的 404002 没有见到，照样认。网络、token、限流、5xx、验签或格式问题，
 * 以及其他错误码，只说明这一次没查成，不说明部门本身。用 Map：平台给的码是任意字符串，普通对象会命中 toString 等继承属性。
 */
const DEPARTMENT_REFUSALS: ReadonlyMap<string, string> = new Map([
  ["422010", "部门不属于当前组织"], ["404002", "部门不存在"], ["400002", "部门 ID 格式无效"],
]);

/** 平台明确拒绝这个部门时的原因；其他失败为 undefined。 */
function departmentRefusal(error: unknown): string | undefined {
  if (!(error instanceof PlatformRequestError) || error.kind !== "rejected" || error.code === undefined) return undefined;
  const reason = DEPARTMENT_REFUSALS.get(error.code);
  return reason && `${reason}（code=${error.code}）`;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly totalPages: number;
  /** Members listed without a phone (member pages only). */
  readonly unidentified?: number;
}

export interface PhoneDetail {
  readonly imUserId: string;
  readonly phone: string;
  readonly name: string;
}

export class DirectoryClient {
  readonly #lookups = new AsyncSemaphore(DESCRIBE_CONCURRENCY);
  constructor(private readonly client: PlatformClient) {}

  async departments(deptId: string, page: number, signal?: AbortSignal): Promise<Page<string>> {
    const { items, totalPages } = await this.#children(deptId, page, signal);
    return { items: items.map(item => item.id), totalPages };
  }

  /** 直属子部门的全部分页，带名称和人数。 */
  async childDepartments(deptId: string, signal?: AbortSignal): Promise<DepartmentInfo[]> {
    const first = await this.#children(deptId, 1, signal);
    const rest = [];
    for (let page = 2; page <= first.totalPages; page++) rest.push(await this.#children(deptId, page, signal));
    return [first, ...rest].flatMap(page => [...page.items]);
  }

  /** 部门详情；部门不存在或不在应用可见范围内时平台拒绝。 */
  async department(deptId: string, signal?: AbortSignal): Promise<DepartmentInfo> {
    const plain = await this.#open("/open/v2/dept/get", { dept_id: deptId }, "app", signal);
    const info = departmentInfo(plain);
    if (!info || info.id !== deptId) throw new PlatformRequestError("部门详情与查询不符", "rejected");
    const parent = plain.parent_id;
    return { ...info, ...(typeof plain.full_name === "string" && plain.full_name ? { fullName: plain.full_name } : {}),
      ...((typeof parent === "string" && parent) || typeof parent === "number" ? { parentId: String(parent) } : {}) };
  }

  /**
   * 部门详情及其上级链（显示同步范围用）。上级沿 parent_id 逐级查详情，到根部门为止；真实平台上一级部门的 parent_id
   * 是组织根部门自己的 ID（子部门接口里的 1，它的 parent_id 为 "0"），根部门不算在上级链里。同一次查询里共同的上级只查一次。
   * 平台明确拒绝的部门单列；其他失败（见 departmentRefusal）使整次查询失败，其余查询随即取消，错误里带部门 ID。
   * 上级读不到、链条成环或过深时只缺这个部门的上级链。取消时抛出 signal 的原因，不交回部分结果。
   */
  async describe(ids: readonly string[], signal?: AbortSignal): Promise<DepartmentDescription> {
    const batch = new AbortController(), requested = new Set(ids);
    const scoped = signal ? AbortSignal.any([signal, batch.signal]) : batch.signal;
    const cache = new Map<string, Promise<DepartmentInfo>>();
    const lookup = (id: string): Promise<DepartmentInfo> => {
      let pending = cache.get(id);
      if (!pending) {
        pending = this.#lookups.acquire(scoped).then(async release => {
          try { return await this.department(id, scoped); }
          catch (error) {
            // A requested department that failed other than by a refusal voids the batch before its slot goes back, so no queued lookup starts.
            if (requested.has(id) && !scoped.aborted && !departmentRefusal(error)) {
              batch.abort(new Error(`部门 ${id}：${error instanceof Error ? error.message : String(error)}`, { cause: error }));
            }
            throw error;
          } finally { release(); }
        });
        pending.catch(() => {});
        cache.set(id, pending);
      }
      return pending;
    };
    const ancestors = async (info: DepartmentInfo): Promise<DepartmentDetail["ancestors"]> => {
      const chain: { id: string; name: string }[] = [];
      for (let parent = info.parentId; parent !== "0" && parent !== ROOT_DEPARTMENT;) {
        if (parent === undefined || parent === info.id || chain.some(item => item.id === parent) || chain.length >= MAX_DEPARTMENT_DEPTH) return undefined;
        let above: DepartmentInfo;
        try { above = await lookup(parent); }
        catch (error) { if (scoped.aborted) throw error; return undefined; }
        // The organisation's own root department (parent "0") is what the children API calls 1: the top, not part of the path.
        if (above.parentId === "0") break;
        chain.push({ id: above.id, name: above.name });
        parent = above.parentId;
      }
      return chain.reverse();
    };
    try {
      const results = await Promise.all(ids.map(async id => {
        let info: DepartmentInfo;
        try { info = await lookup(id); }
        catch (error) {
          const refusal = scoped.aborted ? undefined : departmentRefusal(error);
          if (refusal) return { unavailable: { id, message: refusal } };
          throw error;
        }
        const chain = await ancestors(info);
        return { department: { ...info, ...(chain ? { ancestors: chain } : {}) } };
      }));
      return { departments: results.flatMap(result => result.department ? [result.department] : []),
        unavailable: results.flatMap(result => result.unavailable ? [result.unavailable] : []) };
    } catch (error) {
      batch.abort(error);
      throw signal?.aborted ? signal.reason : batch.signal.reason;
    }
  }

  /**
   * 保存同步范围前逐个核对部门：都存在且应用可见才返回详情。失败时说明是哪个部门，并分清平台明确拒绝与没核对成；
   * 取消时抛出 signal 的原因。
   */
  async verify(ids: readonly string[], signal?: AbortSignal): Promise<DepartmentInfo[]> {
    const checked = [];
    for (const id of ids) {
      try { checked.push(await this.department(id, signal)); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        const refusal = departmentRefusal(error);
        throw new Error(refusal ? `部门 ${id}：${refusal}；范围未改`
          : `没能向平台核对部门 ${id}（${error instanceof Error ? error.message : String(error)}）；范围未改`, { cause: error });
      }
    }
    return checked;
  }

  async #children(deptId: string, page: number, signal?: AbortSignal): Promise<Page<DepartmentInfo>> {
    const path = "/open/v2/dept/children";
    const plain = await this.#open(path, { dept_id: deptId, page_num: page, page_size: DEPARTMENT_PAGE_SIZE }, "app", signal);
    const { list, totalPages } = pageOf(plain, "departments", path);
    const items = list.map(departmentInfo).filter(item => item !== undefined);
    if (items.length !== list.length) throw new PlatformRequestError("部门列表含无效 ID", "rejected");
    return { items, totalPages };
  }

  async members(deptId: string, page: number, signal?: AbortSignal): Promise<Page<DirectoryMember>> {
    const path = "/open/v2/dept/users/list";
    const plain = await this.#open(path, { dept_id: deptId, page_num: page, page_size: MEMBER_PAGE_SIZE }, "app", signal);
    const { list, totalPages } = pageOf(plain, "users", path);
    let unidentified = 0;
    const items = list.flatMap(value => {
      const user = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      if (!user) throw new PlatformRequestError(`通讯录 ${path} 的成员列表含无效项`, "rejected");
      if (typeof user.phone === "string" && user.phone) return [{ phone: user.phone, name: typeof user.name === "string" ? user.name : "" }];
      // Listed without a phone: cannot be matched to a mapping, so the scan may not treat anyone as absent.
      unidentified++;
      return [];
    });
    return { items, totalPages, ...(unidentified ? { unidentified } : {}) };
  }

  /** 返回该手机号当前的 imUserId；平台返回的手机号或登录号与查询不符时视为失败。 */
  async detailByPhone(phone: string, signal?: AbortSignal): Promise<PhoneDetail> {
    const plain = await this.#open("/open/applied/v1/user/detailByPhone", { loginId: phone }, "address", signal);
    const imUserId = plain.imUserId;
    if (typeof imUserId !== "string" || !imUserId) throw new PlatformRequestError("detailByPhone 未返回 imUserId", "rejected");
    if (plain.phone !== phone && plain.loginId !== phone) throw new PlatformRequestError("detailByPhone 返回的手机号与查询不符", "rejected");
    return { imUserId, phone, name: typeof plain.userName === "string" ? plain.userName : "" };
  }

  async #open(path: string, body: unknown, token: "app" | "address", signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.client.request("POST", path, { body, token, idempotent: true, signal, label: `通讯录 ${path}` });
    return this.decode(response, path);
  }

  /** 验签并解密；任何不一致都抛错，不返回部分结果。 */
  decode(response: ApiResponse, path: string): Record<string, unknown> {
    if (!accepted(response)) {
      const code = response.json?.code;
      throw new PlatformRequestError(`通讯录 ${path} 失败：HTTP ${response.status} code=${String(code)}`, "rejected", response.status,
        typeof code === "number" || typeof code === "string" ? String(code) : undefined);
    }
    const data = responseData(response);
    const { encrypt, sign, timeStamp, nonce } = data;
    if (typeof encrypt !== "string" || typeof sign !== "string" || typeof timeStamp !== "string" || typeof nonce !== "string")
      throw new PlatformRequestError(`通讯录 ${path} 响应缺少密文字段`, "rejected");
    const expected = Buffer.from(signV2(this.client.config.appId, timeStamp, nonce, encrypt), "utf8");
    const actual = Buffer.from(sign.toLowerCase(), "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new PlatformRequestError(`通讯录 ${path} 验签失败`, "rejected");
    let plain: unknown;
    try { plain = JSON.parse(decryptV2(this.client.config.appSecret, timeStamp, nonce, encrypt)); }
    catch { throw new PlatformRequestError(`通讯录 ${path} 解密失败`, "rejected"); }
    if (!plain || typeof plain !== "object" || Array.isArray(plain)) throw new PlatformRequestError(`通讯录 ${path} 明文不是对象`, "rejected");
    return plain as Record<string, unknown>;
  }
}

function departmentInfo(value: unknown): DepartmentInfo | undefined {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const id = item?.dept_id;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const count = item!.hide_count === 1 ? undefined : Number(item!.count);
  return { id: String(id), name: typeof item!.name === "string" ? item!.name : "",
    ...(count !== undefined && Number.isSafeInteger(count) && count >= 0 ? { count } : {}) };
}

/** More pages than any real directory has (a million members, 320 000 departments): a larger count is a broken response. */
const MAX_PAGES = 10_000;

/** The list and page count of one page. The scan revokes members it did not see, so only an explicit empty page counts as
 * empty: an array, or (should the platform omit an empty list) no list together with `total: 0`. A missing or mistyped
 * list and a missing, fractional or out-of-range page count are refused, so the round stays incomplete. */
function pageOf(plain: Record<string, unknown>, field: string, path: string): { list: unknown[]; totalPages: number } {
  const value = plain[field];
  let list: unknown[];
  if (Array.isArray(value)) list = value;
  else if ((value === undefined || value === null) && count(plain.total) === 0) list = [];
  else throw new PlatformRequestError(`通讯录 ${path} 响应缺少 ${field} 列表`, "rejected");
  const totalPages = count(plain.total_pages);
  if (totalPages === undefined || totalPages > MAX_PAGES)
    throw new PlatformRequestError(`通讯录 ${path} 响应的总页数无效：${JSON.stringify(plain.total_pages) ?? "缺失"}`, "rejected");
  if (totalPages === 0 && list.length) throw new PlatformRequestError(`通讯录 ${path} 响应总页数为 0 却有 ${list.length} 项`, "rejected");
  return { list, totalPages };
}

/** A non-negative integer the platform sent as a number or as a string of digits; anything else is undefined. */
function count(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
