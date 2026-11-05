// 通讯录同步范围：data/config/directory.json。`{"format":1,"departments":["<部门 ID>", ...]}` 只同步这些部门及其全部子部门，
// `{"format":1,"all":true}` 同步整个通讯录；文件不存在为未设置，服务不同步通讯录（部署时必须选择：scripts/config/directory-scope.ts）。
// 部署后经服务的本机控制接口修改（控制台的部门选择器、终端向导 directory-scope，或 directory-scope all；服务先向平台核对部门），
// 服务启动时读取。部门只能逐层勾选：命令行参数和 BOT_DIRECTORY_SCOPE 只接受 all，不接受手填的部门 ID。
// 这是保存的范围；名单按它建成后才生效，生效范围记在状态库里（identity-directory.ts）。
import { readFileSync } from "node:fs";
import { DIRECTORY_CONFIG_PATH } from "../../core/storage.ts";

const DEPARTMENT_ID = /^[0-9A-Za-z_-]{1,64}$/;
/** 根部门 ID：列子部门时代表整个通讯录。定义在这里而不是平台客户端旁边：控制台和向导只加载这个轻量模块。 */
export const ROOT_DEPARTMENT = "1";
export const MAX_SCOPE_DEPARTMENTS = 200;

/** 同步范围：整个通讯录，或选定的部门及其全部子部门。未设置用 undefined 表示。 */
export type DirectoryScope = { readonly kind: "all" } | { readonly kind: "departments"; readonly departments: readonly string[] };

export const WHOLE_DIRECTORY: DirectoryScope = { kind: "all" };

/**
 * 部署后怎样设置范围（未设置时的提示）。Linux 上 ops.sh directory-scope 不带参数时运行终端向导（宿主机没有 Bun 时在容器里交互执行）；
 * Windows 的 ops.ps1 不接终端，部门只在控制台里勾选。
 */
export function scopeChoiceHint(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "在控制台「通讯录」中选择，或用 directory-scope all 同步整个通讯录"
    : "在控制台「通讯录」或终端（不带参数的 directory-scope）中逐层勾选部门，或用 directory-scope all 同步整个通讯录";
}

/** 范围里的部门；整个通讯录为 undefined。 */
export function scopeDepartments(scope: DirectoryScope): readonly string[] | undefined {
  return scope.kind === "departments" ? scope.departments : undefined;
}

/** 校验部门 ID 列表：非空、不重复、不超过上限。 */
export function parseDepartmentIds(value: unknown, label = "departments"): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_DEPARTMENTS)
    throw new Error(`${label} 必须是 1 到 ${MAX_SCOPE_DEPARTMENTS} 个部门 ID`);
  for (const id of value) if (typeof id !== "string" || !DEPARTMENT_ID.test(id)) throw new Error(`${label} 含无效的部门 ID`);
  if (new Set(value).size !== value.length) throw new Error(`${label} 含重复的部门 ID`);
  return [...value] as string[];
}

/**
 * 要保存的同步范围：在 parseDepartmentIds 之外拒绝根部门 1（ROOT_DEPARTMENT）。
 * 1 只是列子部门时的别名，平台的部门详情答回组织根部门自己的 ID，保存前的核对必然对不上。查询部门的接口照常接受 1。
 */
export function parseScopeDepartments(value: unknown): string[] {
  const departments = parseDepartmentIds(value);
  if (departments.includes(ROOT_DEPARTMENT)) throw new Error("部门 1 是根部门的查询别名，不能作为同步范围；要同步整个通讯录请明确选择整个通讯录（all）");
  return departments;
}

/** 控制接口的请求体：`{"all":true}` 或 `{"departments":[…]}`。旧的 `{"departments":null}`（整个通讯录）不再接受。 */
export function parseScopeRequest(value: unknown): DirectoryScope {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const keys = body ? Object.keys(body) : [];
  if (body && keys.length === 1 && body.all === true) return WHOLE_DIRECTORY;
  if (body && keys.length === 1 && "departments" in body) {
    if (body.departments === null) throw new Error("整个通讯录需要明确写成 {\"all\":true}");
    return { kind: "departments", departments: parseScopeDepartments(body.departments) };
  }
  throw new Error("请求体必须是 {\"all\":true} 或 {\"departments\":[部门 ID,…]}");
}

/** 两个范围是否相同（部门顺序不计）。 */
export function sameScope(a: DirectoryScope, b: DirectoryScope): boolean {
  if (a.kind === "all" || b.kind === "all") return a.kind === b.kind;
  return a.departments.length === b.departments.length && a.departments.every(id => b.departments.includes(id));
}

/** 范围的存储形式（状态库的生效记录）：`{"all":true}` 或排好序的 `{"departments":[…]}`，相同的范围写出相同的文本。 */
export function scopeRecord(scope: DirectoryScope): string {
  return JSON.stringify(scope.kind === "all" ? { all: true } : { departments: scope.departments.toSorted() });
}

/** 读回 scopeRecord 写下的文本；不认识的内容抛错。 */
export function parseScopeRecord(text: string): DirectoryScope {
  const value = JSON.parse(text) as Record<string, unknown> | null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && value.all === true) return WHOLE_DIRECTORY;
    if (keys.length === 1 && "departments" in value) return { kind: "departments", departments: parseDepartmentIds(value.departments) };
  }
  throw new Error("通讯录生效范围的记录无法识别");
}

/** 范围文件（或部署的计划文件）的内容：`format` 为 1，`all: true` 与 `departments` 恰有一个；不合法时抛错。 */
export function parseScopeFile(raw: unknown, label: string): DirectoryScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${label} 必须是对象`);
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (value.format !== 1 || keys.some(key => !["format", "all", "departments"].includes(key)) || keys.length !== 2) throw new Error(`${label} 格式无效`);
  if ("all" in value) {
    if (value.all !== true) throw new Error(`${label} 格式无效`);
    return WHOLE_DIRECTORY;
  }
  return { kind: "departments", departments: parseDepartmentIds(value.departments, `${label}.departments`) };
}

/** 范围文件的文本。 */
export function scopeFileText(scope: DirectoryScope): string {
  const record = scope.kind === "all" ? { format: 1, all: true } : { format: 1, departments: parseDepartmentIds(scope.departments) };
  return JSON.stringify(record, null, 2) + "\n";
}

/** 读取保存的范围；文件不存在时为未设置（undefined），内容不合法时抛错。 */
export function readDirectoryScope(path = DIRECTORY_CONFIG_PATH): DirectoryScope | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return parseScopeFile(raw, path);
}
