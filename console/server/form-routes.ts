import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readRuntimeSettings } from "../../ops/config/runtime-draft.ts";
import { RUNTIME_DEFAULTS, RUNTIME_RANGES } from "../../src/core/runtime-schema.ts";
import { RUNTIME_GROUPS } from "../../ops/core/runtime-options.ts";
import { changeScope, describeDepartments, listDepartments, readServiceStatus } from "../../ops/tools/directory-admin.ts";
import type { AuditLog } from "./audit.ts";
import { ApiProblem, type Route } from "./routes.ts";
import { fields, textParam } from "../../ops/core/operations.ts";
import { scanTmp } from "../../src/lib/tmp-scan.ts";
import { maskUser, spaceLabel } from "../../ops/lib/format.ts";

const DIRECTORY = { status: readServiceStatus, describe: describeDepartments, list: listDepartments, apply: changeScope };
/**
 * One department picker opened by a session. It lives as long as the session (a few per session, like the conversation
 * views), not on a clock: choosing departments level by level takes as long as it takes.
 */
interface Selection { session: string; book: CodeBook }
/**
 * A session's department keys, shown instead of department IDs. Every picker of the session shares them, so a picker read
 * again keeps the keys of departments the page has already ticked.
 */
interface CodeBook { codes: Map<string, string>; ids: Map<string, string> }
/** Pickers per session; opening another drops the oldest. */
const MAX_SELECTIONS = 8;

export class FormRoutes {
  readonly selections = new Map<string, Selection>();
  private books = new Map<string, CodeBook>();
  private storage = new Map<string, { session: string; expires: number; space: string; user: string }>();
  constructor(readonly project: string, readonly audit: AuditLog, readonly directory = DIRECTORY) {}
  end(session: string): void {
    for (const [key, value] of this.selections) if (value.session === session) this.selections.delete(key);
    this.books.delete(session);
    for (const [key, value] of this.storage) if (value.session === session) this.storage.delete(key);
  }
  storageScope(session: string, key: string): { space: string; user: string } {
    const value = this.storage.get(key);
    if (!value || value.session !== session || value.expires <= Date.now()) throw new Error("文件范围列表已过期，请重新读取");
    return { space: value.space, user: value.user };
  }
  private code(view: Selection, id: string): string {
    const book = view.book;
    let code = book.ids.get(id);
    if (!code) {
      if (book.ids.size >= 10000) throw new Error("部门列表过大，请缩小选择范围");
      code = randomUUID(); book.ids.set(id, code); book.codes.set(code, id);
    }
    return code;
  }
  routes(): Record<string, Route> {
    const file = join(this.project, "data/state/instance.json");
    const selection = (session: string, value: unknown) => {
      const view = this.selections.get(textParam(value));
      if (!view || view.session !== session) throw new ApiProblem(410, "view-gone", "部门列表已失效，请重新读取部门树");
      return view;
    };
    const wrap = (run: Route["run"]): Route => ({ slow: true, run: async context => {
      try { return await run(context); } catch (error) {
        if (error instanceof ApiProblem) throw error;
        throw new ApiProblem(409, "input", error instanceof Error ? error.message : "请求未完成");
      }
    } });
    return {
      "GET /api/storage/scopes": wrap(async ({ session, signal }) => {
        const rows = await scanTmp(join(this.project, "data")); signal.throwIfAborted();
        for (const [key, value] of this.storage) if (value.session === session.label || value.expires <= Date.now()) this.storage.delete(key);
        return { truncated: rows.length > 10000, scopes: rows.slice(0, 10000).map(row => {
          const key = randomUUID(); this.storage.set(key, { session: session.label, expires: Date.now() + 600_000, space: row.space, user: row.user });
          return { key, label: `${spaceLabel(row.space)} · ${maskUser(row.user)}` };
        }) };
      }),
      "GET /api/forms/runtime": wrap(async () => ({ ...await readRuntimeSettings(join(this.project, "data/config/runtime.json")),
        groups: RUNTIME_GROUPS.map(group => ({ ...group, options: group.options.map(option => ({ ...option, default: RUNTIME_DEFAULTS[option.key],
          range: RUNTIME_RANGES[option.key as keyof typeof RUNTIME_RANGES] })) })) })),
      "GET /api/directory/selection": wrap(async ({ session, signal }) => {
        const status = await this.directory.status(undefined, file, signal);
        if (!status.directory || status.verificationOnly) throw new Error("机器人未运行或通讯录不可用");
        let book = this.books.get(session.label);
        if (!book) this.books.set(session.label, book = { codes: new Map(), ids: new Map() });
        const key = randomUUID(), view: Selection = { session: session.label, book };
        const scope = status.directory.scope;
        const selected = scope?.kind === "departments" ? await this.directory.describe(scope.departments, undefined, file, undefined, signal) : { departments: [], unavailable: [] };
        const children = await this.directory.list("1", undefined, file, signal);
        const prior = [...this.selections].filter(([, item]) => item.session === session.label);
        while (prior.length >= MAX_SELECTIONS) this.selections.delete(prior.shift()![0]);
        this.selections.set(key, view);
        const display = (item: { id: string; name: string }) => ({ key: this.code(view, item.id), name: item.name });
        return { view: key, mode: scope?.kind ?? "unset", state: status.directory.state, selected: selected.departments.map(display),
          unavailable: selected.unavailable.length, children: children.map(display) };
      }),
      "POST /api/directory/children": wrap(async ({ session, body, signal }) => {
        const params = body as Record<string, unknown>; fields(params, ["view", "parent"]);
        const view = selection(session.label, params.view), parent = view.book.codes.get(textParam(params.parent));
        if (!parent) throw new Error("请从部门树中选择，不接受手填 ID");
        const children = await this.directory.list(parent, undefined, file, signal);
        return { children: children.map(item => ({ key: this.code(view, item.id), name: item.name })) };
      }),
      "POST /api/directory/apply": wrap(async ({ session, body }) => {
        const params = body as Record<string, unknown>; fields(params, ["view", "mode", "selected"]);
        const view = selection(session.label, params.view);
        if (!["all", "departments"].includes(String(params.mode)) || !Array.isArray(params.selected) || params.selected.length > 10000) throw new Error("同步范围无效");
        const ids = [...new Set(params.selected.map(key => { const id = view.book.codes.get(textParam(key)); if (!id) throw new Error("请从部门树中选择，不接受手填 ID"); return id; }))];
        if (params.mode === "all" && ids.length || params.mode === "departments" && !ids.length) throw new Error("请选择整个通讯录或至少一个部门");
        this.audit.write({ action: "directory-apply", session: session.label, scope: params.mode === "all" ? "all" : `departments:${ids.length}`, mode: "default" });
        // Deliberately no browser signal: the service owns this saved operation after acceptance.
        const result = await this.directory.apply(params.mode === "all" ? { kind: "all" } : { kind: "departments", departments: ids }, undefined, file);
        return { status: result.status };
      }),
    };
  }
}
