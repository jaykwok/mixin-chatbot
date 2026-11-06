// 推送设置（推送人、管理员、频次上限与授权）：经运行中服务的本机控制接口（src/server/http-app.ts 的 /_admin/push/settings）
// 读写，服务核对名单里的人都在同步的通讯录里。页面只看到姓名和打码号码，部门只看到路径：已有的人和同步范围内的部门用本次
// 读取发的随机键指代，新加的人由管理员输入完整手机号。页面没有给出的授权项沿用这个人原有的。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { adminPost } from "../../ops/tools/directory-admin.ts";
import { maskUser } from "../../ops/lib/format.ts";
import type { AuditLog } from "./audit.ts";
import { fields } from "../../ops/core/operations.ts";
import { ApiProblem, problemOf, type Route } from "./routes.ts";

/** The grants as the service keeps them (src/push/store.ts). */
type Grants = { department?: { any: true } | { departments: string[] }; all?: true; group?: true };
type Role = { phone: string; name: string | null; admin: boolean; pusher: boolean; grants: Grants; dailyLimit: number | null; updatedAt: number };
type Department = { id: string; path: string };
interface View {
  session: string;
  expires: number;
  people: Map<string, { phone: string; grants: Grants }>;
  departments: Map<string, string>;
}

const VIEW_MS = 30 * 60_000;
const SETTINGS_TIMEOUT_MS = 10_000;

export interface PushSettingsSource {
  read(signal?: AbortSignal): Promise<{ roles: Role[]; departments: Department[] }>;
  save(roles: unknown[]): Promise<{ roles: Role[]; departments: Department[] }>;
}

/** 默认经本机控制接口；测试换成假的。 */
export function servicePushSettings(file: string): PushSettingsSource {
  const settings = async (path: string, body: unknown, signal?: AbortSignal) => {
    const { status, body: reply } = await adminPost(path, body, undefined, file, SETTINGS_TIMEOUT_MS, signal);
    if (status !== 200) {
      const phones = Array.isArray(reply.phones) ? `：${reply.phones.map(phone => maskUser(String(phone))).join("、")}` : "";
      throw new Error(typeof reply.message === "string" ? reply.message + phones : `服务拒绝了请求（HTTP ${status}）`);
    }
    return { roles: reply.roles as Role[], departments: Array.isArray(reply.departments) ? reply.departments as Department[] : [] };
  };
  return {
    read: signal => settings("/_admin/push/settings", {}, signal),
    save: roles => settings("/_admin/push/settings/save", { roles }),
  };
}

export class PushRoutes {
  readonly #views = new Map<string, View>();

  constructor(readonly project: string, readonly audit: AuditLog, readonly source = servicePushSettings(join(project, "data/state/instance.json"))) {}

  end(session: string): void {
    for (const [key, view] of this.#views) if (view.session === session) this.#views.delete(key);
  }

  /** 页面看到的名单和部门，每人、每个部门一个随机键；授权里已不在同步范围的部门也给键，保存时照样保留。 */
  #display(session: string, settings: { roles: Role[]; departments: Department[] }) {
    for (const [key, view] of this.#views) if (view.expires <= Date.now()) this.#views.delete(key);
    const prior = [...this.#views].filter(([, view]) => view.session === session);
    while (prior.length >= 4) this.#views.delete(prior.shift()![0]);
    const key = randomUUID(), view: View = { session, expires: Date.now() + VIEW_MS, people: new Map(), departments: new Map() };
    this.#views.set(key, view);
    const keys = new Map<string, string>(), departments: { key: string; path: string; gone?: true }[] = [];
    const keyOf = (id: string, path?: string) => {
      let found = keys.get(id);
      if (found === undefined) {
        found = randomUUID();
        keys.set(id, found);
        view.departments.set(found, id);
        departments.push({ key: found, ...(path === undefined ? { path: "已不在同步范围的部门", gone: true as const } : { path }) });
      }
      return found;
    };
    for (const department of settings.departments) keyOf(department.id, department.path);
    const roles = settings.roles.map(role => {
      const person = randomUUID(), grant = role.grants.department;
      view.people.set(person, { phone: role.phone, grants: role.grants });
      return { key: person, name: role.name, phone: maskUser(role.phone), admin: role.admin, pusher: role.pusher, dailyLimit: role.dailyLimit,
        grants: { all: role.grants.all === true, group: role.grants.group === true,
          department: !grant ? "none" : "any" in grant ? "any" : grant.departments.map(id => keyOf(id)) },
        updatedAt: role.updatedAt };
    });
    return { view: key, departments, roles };
  }

  /** 页面给的授权换回服务的写法：部门用本次读取的键；页面没给群授权时沿用这个人原有的。 */
  #grants(view: View, value: unknown, known: Grants | undefined, at: string): Grants {
    if (value === undefined) return known ?? {};
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    if (!raw) throw new Error(`${at}：授权无效`);
    fields(raw, ["all", "group", "department"]);
    if (raw.group !== undefined && typeof raw.group !== "boolean") throw new Error(`${at}：群授权无效`);
    if (raw.all !== undefined && typeof raw.all !== "boolean") throw new Error(`${at}：全员授权无效`);
    const grants: Grants = { ...(raw.all === true ? { all: true as const } : {}), ...((raw.group ?? known?.group) === true ? { group: true as const } : {}) };
    const department = raw.department ?? "none";
    if (department === "any") grants.department = { any: true };
    else if (Array.isArray(department)) {
      const ids = department.map(key => typeof key === "string" ? view.departments.get(key) : undefined);
      if (ids.some(id => id === undefined)) throw new Error(`${at}：部门已过期，请重新读取`);
      if (!ids.length) throw new Error(`${at}：指定部门时至少选一个部门`);
      grants.department = { departments: [...new Set(ids as string[])] };
    } else if (department !== "none") throw new Error(`${at}：部门授权无效`);
    return grants;
  }

  routes(): Record<string, Route> {
    const wrap = (run: Route["run"]): Route => ({ slow: true, run: async context => {
      try { return await run(context); } catch (error) {
        const problem = problemOf(error);
        if (problem instanceof ApiProblem) throw problem;
        throw new ApiProblem(409, "input", error instanceof Error ? error.message : "请求未完成");
      }
    } });
    return {
      "GET /api/push/settings": wrap(async ({ session, signal }) => this.#display(session.label, await this.source.read(signal))),
      "POST /api/push/settings": wrap(async ({ session, body }) => {
        const params = body as Record<string, unknown>; fields(params, ["view", "roles"]);
        const view = this.#views.get(String(params.view));
        if (!view || view.session !== session.label || view.expires <= Date.now()) throw new ApiProblem(410, "view-gone", "名单已过期，请重新读取");
        if (!Array.isArray(params.roles) || params.roles.length > 1000) throw new Error("名单无效");
        const roles = params.roles.map((raw, index) => {
          const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
          fields(item, ["key", "phone", "admin", "pusher", "dailyLimit", "grants"]);
          // An existing person by the key of this view; a new one by the number typed in.
          const known = typeof item.key === "string" ? view.people.get(item.key) : undefined;
          const typed = item.key === undefined && typeof item.phone === "string" ? item.phone.replace(/[\s-]/g, "") : undefined;
          const phone = known?.phone ?? typed;
          if (!phone) throw new Error(`第 ${index + 1} 项：请从名单中选择或输入手机号`);
          return { phone, admin: item.admin, pusher: item.pusher, grants: this.#grants(view, item.grants, known?.grants, `第 ${index + 1} 项`),
            dailyLimit: item.dailyLimit ?? null };
        });
        const pushers = roles.filter(role => role.pusher === true).length, admins = roles.filter(role => role.admin === true).length;
        const granted = roles.filter(role => role.pusher === true && (role.grants.department || role.grants.all || role.grants.group)).length;
        this.audit.write({ action: "push-settings", session: session.label, scope: `pushers:${pushers},admins:${admins},granted:${granted}`, mode: "default" });
        const saved = await this.source.save(roles);
        this.#views.delete(String(params.view));
        return this.#display(session.label, saved);
      }),
    };
  }
}
