// 通讯录同步范围（可选）：data/config/directory.json `{"format":1,"departments":["<部门 ID>", ...]}`，只同步这些部门
// 及其全部子部门；文件不存在时同步整个通讯录。运维命令经服务的本机控制接口修改（服务先向平台核对部门），服务启动时读取。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replaceFile } from "../../core/maintenance.ts";
import { DIRECTORY_CONFIG_PATH } from "../../core/storage.ts";

const DEPARTMENT_ID = /^[0-9A-Za-z_-]{1,64}$/;
export const MAX_SCOPE_DEPARTMENTS = 200;

/** 校验部门 ID 列表：非空、不重复、不超过上限。 */
export function parseDepartmentIds(value: unknown, label = "departments"): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_DEPARTMENTS)
    throw new Error(`${label} 必须是 1 到 ${MAX_SCOPE_DEPARTMENTS} 个部门 ID`);
  for (const id of value) if (typeof id !== "string" || !DEPARTMENT_ID.test(id)) throw new Error(`${label} 含无效的部门 ID`);
  if (new Set(value).size !== value.length) throw new Error(`${label} 含重复的部门 ID`);
  return [...value] as string[];
}

/** 两个范围是否相同（`undefined` 为整个通讯录，部门顺序不计）。 */
export function sameScope(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every(id => b.includes(id));
}

/** 读取范围；文件不存在时返回 undefined（整个通讯录），内容不合法时抛错。 */
export function readDirectoryScope(path = DIRECTORY_CONFIG_PATH): string[] | undefined {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} 必须是对象`);
  const value = raw as Record<string, unknown>;
  if (value.format !== 1 || Object.keys(value).some(key => !["format", "departments"].includes(key))) throw new Error(`${path} 格式无效`);
  return parseDepartmentIds(value.departments, `${path}.departments`);
}

/** 保存范围；`undefined` 恢复为整个通讯录（删除范围文件）。 */
export async function writeDirectoryScope(departments: readonly string[] | undefined, path = DIRECTORY_CONFIG_PATH): Promise<void> {
  if (departments === undefined) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.directory-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ format: 1, departments: parseDepartmentIds(departments) }, null, 2) + "\n", { mode: 0o644 });
    await replaceFile(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
