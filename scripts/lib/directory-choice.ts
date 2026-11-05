// A verified deployment choice, distinct from browser tree keys and from the final directory.json file.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseScopeDepartments, parseScopeFile, scopeFileText, type DirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";

export interface DirectoryChoice { departments: string[]; names: string[]; appHash: string }
export function directoryAppHash(project: string): string {
  const path = join(project, "data/config/app-bot.json"), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("应用配置不可用");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function directoryChoice(value: unknown): DirectoryChoice {
  const raw = value as Partial<DirectoryChoice>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 3 || Object.keys(raw).some(key => !["departments", "names", "appHash"].includes(key))
    || typeof raw.appHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.appHash)) throw new Error("通讯录部署选择无效");
  const departments = parseScopeDepartments(raw.departments);
  if (!Array.isArray(raw.names) || raw.names.length !== departments.length || raw.names.some(name => typeof name !== "string" || name.length > 1024 || /[\x00-\x1f\x7f]/.test(name))) throw new Error("部门名称无效");
  if (Buffer.byteLength(JSON.stringify(raw)) > 64 * 1024) throw new Error("部门选择过大，请缩小范围");
  return { departments, names: [...raw.names], appHash: raw.appHash };
}
export function checkedDirectoryChoice(project: string, value: unknown): DirectoryChoice {
  const choice = directoryChoice(value);
  if (directoryAppHash(project) !== choice.appHash) throw new Error("应用配置已变化，请重新读取部门树");
  return choice;
}
export function directoryChoiceText(value: DirectoryChoice): string {
  return scopeFileText({ kind: "departments", departments: value.departments });
}

/** Internal console transport. Only a verified task may materialize this as the deployment transaction's plan. */
export function consoleDirectoryScope(project: string, env = process.env): DirectoryScope {
  if (env.MIXIN_OPS_CONSOLE !== "1" || !env.MIXIN_OPS_TASK_ID || env.MIXIN_OPS_DIRECTORY !== "selected" || env.BOT_DIRECTORY_SCOPE
    || !env.MIXIN_OPS_DIRECTORY_INPUT || env.MIXIN_OPS_DIRECTORY_INPUT.length > 32 * 1024 || directoryAppHash(project) !== env.MIXIN_OPS_DIRECTORY_APP) throw new Error("控制台通讯录选择或应用配置已变化，未写入范围");
  const scope = parseScopeFile(JSON.parse(env.MIXIN_OPS_DIRECTORY_INPUT), "控制台通讯录范围");
  if (scope.kind !== "departments") throw new Error("部门选择必须包含明确的部门");
  return { kind: "departments", departments: parseScopeDepartments(scope.departments) };
}
