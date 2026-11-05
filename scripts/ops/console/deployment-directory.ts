import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { directoryAppHash, type DirectoryChoice } from "../../lib/directory-choice.ts";
import { parseScopeDepartments, readDirectoryScope, MAX_SCOPE_DEPARTMENTS, ROOT_DEPARTMENT } from "../../../src/integrations/open-platform/directory-scope.ts";
import { readConfigurationState } from "../../../src/core/configuration-state.ts";
import { loadPendingTransaction } from "../shared/transaction.ts";
import { runtimeQuery } from "./runtime-query.ts";
import { ApiProblem, type Route } from "./routes.ts";

type Department = { id: string; name: string };
export type DepartmentQuery = (action: "children" | "verify", ids: string[], signal?: AbortSignal) => Promise<{ appHash: string; departments: Department[] }>;
interface Selection { session: string; expires: number; appHash: string; codes: Map<string, string>; ids: Map<string, string> }
const object = (value: unknown, fields: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new Error("部门选择参数无效");
  return value as Record<string, unknown>;
};

export function departmentQuery(project: string): DepartmentQuery {
  return async (action, ids, signal) => {
    const result = await runtimeQuery(project, "directory-query", action, { ids }, signal);
    if (result.code !== 0 || result.timedOut) throw new Error("部门查询未完成，请检查已部署镜像、应用权限与网络");
    try {
      const value = JSON.parse(result.stdout);
      if (value?.protocol !== "mixin-directory-query" || value.version !== 1 || typeof value.appHash !== "string" || !/^[a-f0-9]{64}$/.test(value.appHash)) throw new Error();
      return { appHash: value.appHash, departments: checkedDepartments(value.departments) };
    } catch { throw new Error("部门查询结果无效"); }
  };
}
function checkedDepartments(value: unknown): Department[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("部门列表过大或无效");
  const ids = new Set<string>();
  return value.map(item => {
    const raw = object(item, ["id", "name"]);
    if (typeof raw.id !== "string" || !/^[0-9A-Za-z_-]{1,64}$/.test(raw.id) || raw.id === ROOT_DEPARTMENT || ids.has(raw.id)
      || typeof raw.name !== "string" || raw.name.length > 1024 || /[\x00-\x1f\x7f]/.test(raw.name)) throw new Error("部门详情无效");
    ids.add(raw.id); return { id: raw.id, name: raw.name };
  });
}

/** Private in-memory trees. Only prepare() turns browser keys into a persisted, verified deployment choice. */
export class DeploymentDirectory {
  private readonly views = new Map<string, Selection>();
  constructor(readonly project: string, readonly query: DepartmentQuery = departmentQuery(project), readonly now = Date.now) {}
  end(session: string) { for (const [key, view] of this.views) if (view.session === session) this.views.delete(key); }
  private base(): string {
    if (loadPendingTransaction(this.project) || readConfigurationState(this.project)) throw new Error("请先处理未完成的维护事务");
    if (readDirectoryScope(join(this.project, "data/config/directory.json"))) throw new Error("已有同步范围，请沿用保存值；修改范围请使用通讯录设置");
    return directoryAppHash(this.project);
  }
  private view(session: string, key: unknown): Selection {
    const at = this.now(); for (const [id, value] of this.views) if (value.expires <= at) this.views.delete(id);
    const value = typeof key === "string" ? this.views.get(key) : undefined;
    if (!value || value.session !== session) throw new Error("部门列表已过期，请重新打开");
    if (this.base() !== value.appHash) throw new Error("应用配置已变化，请重新读取部门树");
    return value;
  }
  private display(view: Selection, items: Department[]) {
    return items.map(item => {
      let key = view.ids.get(item.id);
      if (!key) {
        if (view.ids.size >= 10000) throw new Error("部门树过大，请重新打开并缩小范围");
        key = randomUUID(); view.ids.set(item.id, key); view.codes.set(key, item.id);
      }
      return { key, name: item.name };
    });
  }
  private async read(session: string, key: string, action: "children" | "verify", ids: string[], signal?: AbortSignal) {
    const view = this.view(session, key), result = await this.query(action, ids, signal);
    signal?.throwIfAborted();
    if (this.view(session, key) !== view || result.appHash !== view.appHash) throw new Error("应用配置或登录已变化，请重新打开部门树");
    return checkedDepartments(result.departments);
  }
  async prepare(input: unknown, session: string): Promise<DirectoryChoice> {
    const params = object(input, ["view", "selected"]), view = this.view(session, params.view);
    if (!Array.isArray(params.selected) || !params.selected.length || params.selected.length > MAX_SCOPE_DEPARTMENTS) throw new Error(`请选择 1 至 ${MAX_SCOPE_DEPARTMENTS} 个部门`);
    const ids = parseScopeDepartments(params.selected.map(key => {
      const id = typeof key === "string" ? view.codes.get(key) : undefined;
      if (!id) throw new Error("请从部门树中选择，不接受手填 ID"); return id;
    }));
    const checked = await this.read(session, String(params.view), "verify", ids);
    const names = new Map(checked.map(item => [item.id, item.name]));
    if (checked.length !== ids.length || ids.some(id => !names.has(id))) throw new Error("部门核对不完整，请重新选择");
    return { departments: ids, names: ids.map(id => names.get(id)!), appHash: view.appHash };
  }
  routes(): Record<string, Route> {
    const wrap = (run: Route["run"]): Route => ({ slow: true, run: async context => {
      try { return await run(context); } catch (error) { throw new ApiProblem(409, "input", error instanceof Error ? error.message : "部门查询失败"); }
    } });
    return {
      "POST /api/lifecycle/directory/open": wrap(async ({ body, session, signal }) => {
        object(body, []); const appHash = this.base(), at = this.now();
        for (const [id, value] of this.views) if (value.expires <= at) this.views.delete(id);
        const prior = [...this.views].filter(([, value]) => value.session === session.label);
        while (prior.length >= 8) this.views.delete(prior.shift()![0]);
        const key = randomUUID(), view: Selection = { session: session.label, expires: at + 600_000, appHash, codes: new Map(), ids: new Map() };
        this.views.set(key, view);
        try { return { view: key, children: this.display(view, await this.read(session.label, key, "children", [ROOT_DEPARTMENT], signal)) }; }
        catch (error) { this.views.delete(key); throw error; }
      }),
      "POST /api/lifecycle/directory/children": wrap(async ({ body, session, signal }) => {
        const params = object(body, ["view", "parent"]), view = this.view(session.label, params.view);
        const id = typeof params.parent === "string" ? view.codes.get(params.parent) : undefined;
        if (!id) throw new Error("请从部门树中选择，不接受手填 ID");
        return { children: this.display(view, await this.read(session.label, String(params.view), "children", [id], signal)) };
      }),
    };
  }
}
