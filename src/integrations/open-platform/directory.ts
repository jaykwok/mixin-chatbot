// 通讯录接口：部门与成员分页、按手机号查 imUserId。响应是 decryptV2 密文，签名用 AppID 派生的密钥校验。
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
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
  /** 部门人数；平台隐藏人数时没有。 */
  readonly count?: number;
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
    return { ...info, ...(typeof plain.full_name === "string" && plain.full_name ? { fullName: plain.full_name } : {}) };
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
      throw new PlatformRequestError(`通讯录 ${path} 失败：HTTP ${response.status} code=${String(response.json?.code)}`, "rejected", response.status);
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
