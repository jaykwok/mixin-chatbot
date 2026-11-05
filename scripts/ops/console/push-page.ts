// 推送页：推送列表、单条推送的接收情况、补推送、修改抄送、删除和下载汇总包，以及群的登记名单。都经运行中服务的本机
// 控制接口（src/server/http-app.ts 的 /_admin/push/*）；服务没有运行时页面只提示。
//
// 页面只看到姓名和打码号码：打开一条推送时，接收人和抄送人各得一个随机键（只在这次打开、这次登录内有效），补推送、
// 改抄送和按人下载都用键；新加的抄送人由管理员输入完整手机号。群在接收人里按群名列出（号码一栏写“群”），群名单里的
// 群也按本次读取的随机键指代。打开推送（看得到回复内容）、补推送、改抄送、删除、下载和改群名单都记审计，只记推送编号、
// 人数和群号。下载与导出一样先领一次性票据，再由浏览器按普通下载取文件，文件不在本机落地。
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  PushChatGroupsResponse, PushChatGroupView, PushDetailResponse, PushGroupKey, PushListItemView, PushListResponse, PushPersonView, PushRecipientView, PushTicket,
} from "../../../ui/console/src/contract.ts";
import type { PushDetail, PushGroupRow, PushListItem } from "../../../src/push/service.ts";
import { memberGroup, type PushTotals } from "../../../src/push/store.ts";
import { adminPost, adminStream } from "../directory-admin.ts";
import { maskUser } from "../shared/format.ts";
import type { AuditLog } from "./audit.ts";
import { attachment, safeFileName } from "./export-format.ts";
import { SECURITY_HEADERS } from "./guard.ts";
import { fields } from "./operations.ts";
import { ApiProblem, input, problemOf, type Route } from "./routes.ts";

const VIEW_MS = 30 * 60_000;
const TICKET_MS = 60_000;
const REQUEST_MS = 15_000;
/** The bot builds the archive first (attachments copied in), then it streams. */
const DOWNLOAD_MS = 30 * 60_000;
const PUSH_ID = /^[a-z0-9]{8}$/;
const GROUPS: readonly PushGroupKey[] = ["preview", "live", "closed", "void"];

/** `people`: by key, the member (a phone, or `group:<ID>` for a group) and the name. */
interface DetailView { session: string; expires: number; push: string; subject: string; people: Map<string, { phone: string; name: string }> }
interface GroupsView { session: string; expires: number; groups: Map<string, string> }
interface Ticket { session: string; expires: number; push: string; member?: string; filename: string; scope: string }

const plain = (status: number, text: string) => new Response(text, { status, headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
const who = (name: string, phone: string) => `${name} · ${maskUser(phone)}`;

/** Talks to the bot; tests replace it. */
export interface PushSource {
  call(name: "list" | "detail" | "remind" | "cc" | "delete" | "groups" | "group", body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;
  package(body: { id: string; member?: string }, signal: AbortSignal): Promise<Response>;
}

export function servicePushSource(file: string): PushSource {
  return {
    async call(name, body, signal) {
      const { status, body: reply } = await adminPost(`/_admin/push/${name}`, body, undefined, file, REQUEST_MS, signal);
      if (status !== 200) throw new Error(typeof reply.message === "string" ? reply.message : `服务拒绝了请求（HTTP ${status}）`);
      return reply;
    },
    package: (body, signal) => adminStream("/_admin/push/package", body, file, DOWNLOAD_MS, signal),
  };
}

export class PushPage {
  readonly #views = new Map<string, DetailView>();
  readonly #groupViews = new Map<string, GroupsView>();
  readonly #tickets = new Map<string, Ticket>();

  constructor(readonly project: string, readonly audit: AuditLog, readonly source = servicePushSource(join(project, "data/state/instance.json")),
    readonly now: () => number = Date.now) {}

  end(session: string): void {
    for (const [key, view] of this.#views) if (view.session === session) this.#views.delete(key);
    for (const [key, view] of this.#groupViews) if (view.session === session) this.#groupViews.delete(key);
    for (const [key, ticket] of this.#tickets) if (ticket.session === session) this.#tickets.delete(key);
  }

  #prune(): void {
    const now = this.now();
    for (const [key, view] of this.#views) if (view.expires <= now) this.#views.delete(key);
    for (const [key, view] of this.#groupViews) if (view.expires <= now) this.#groupViews.delete(key);
    for (const [key, ticket] of this.#tickets) if (ticket.expires <= now) this.#tickets.delete(key);
  }

  /** The group list for the page: each group by a fresh key of a new view. */
  #groupsDisplay(session: string, reply: Record<string, unknown>): PushChatGroupsResponse {
    this.#prune();
    const prior = [...this.#groupViews].filter(([, view]) => view.session === session);
    while (prior.length >= 4) this.#groupViews.delete(prior.shift()![0]);
    const key = randomUUID(), view: GroupsView = { session, expires: this.now() + VIEW_MS, groups: new Map() };
    this.#groupViews.set(key, view);
    const groups = (reply.groups as PushGroupRow[]).map((group): PushChatGroupView => {
      const id = randomUUID();
      view.groups.set(id, group.id);
      return { key: id, name: group.name, state: group.state, firstSeenAt: group.firstSeenAt, lastSeenAt: group.lastSeenAt, registeredAt: group.registeredAt,
        registeredBy: group.registeredBy ? who(group.registeredByName ?? "不在通讯录里", group.registeredBy) : group.registeredAt !== null ? "控制台" : null };
    });
    return { view: key, groups, steps: String(reply.steps ?? "") };
  }

  #listItem(push: PushListItem): PushListItemView {
    return { id: push.id, subject: push.subject, mode: push.mode, state: push.state, pusher: who(push.pusherName, push.pusher), createdAt: push.createdAt,
      confirmedAt: push.confirmedAt, deadline: push.deadline, closedAt: push.closedAt, closeReason: push.closeReason, summaryState: push.summaryState,
      of: push.of, followUp: push.followUp, counts: push.counts };
  }

  /** The detail for the page: people by fresh keys of a new view. */
  #display(session: string, detail: PushDetail): PushDetailResponse {
    this.#prune();
    const prior = [...this.#views].filter(([, view]) => view.session === session);
    while (prior.length >= 8) this.#views.delete(prior.shift()![0]);
    const key = randomUUID(), view: DetailView = { session, expires: this.now() + VIEW_MS, push: detail.push.id, subject: detail.push.subject, people: new Map() };
    this.#views.set(key, view);
    // A group shows "群" where a person shows the masked number; its key still names the member for 补推送 and 下载.
    const person = (member: string, name: string): PushPersonView => {
      const id = randomUUID();
      view.people.set(id, { phone: member, name });
      return { key: id, name, phone: memberGroup(member) === undefined ? maskUser(member) : "群" };
    };
    const { push } = detail, target = push.target, groups = target.groups ?? [];
    const lines = target.of ? [`补推送：推送编号 ${target.of} 中没有答复的${groups.length ? "" : "人"}`] : [
      ...(target.everyone ? ["全员（同步范围内的所有人）"] : []),
      ...target.departments.map(department => `部门 ${department.path}${department.children ? "（含下级）" : "（不含下级）"}`),
      ...(target.people.length ? [`个人 ${target.people.slice(0, 50).map(each => who(each.name, each.phone)).join("、")}${target.people.length > 50 ? ` 等 ${target.people.length} 人` : ""}`] : []),
      ...(groups.length ? [`群 ${groups.map(group => group.name).join("、")}`] : []),
    ];
    const recipients: PushRecipientView[] = detail.recipients.map(recipient => ({ ...person(recipient.member, recipient.name),
      group: memberGroup(recipient.member) !== undefined, sendState: recipient.sendState, sendError: recipient.sendError, sentAt: recipient.sentAt,
      ackedAt: recipient.ackedAt, clicks: recipient.clicks, choice: recipient.choice, choiceAt: recipient.choiceAt, replyState: recipient.replyState,
      submittedAt: recipient.submittedAt, answered: recipient.answered, reply: recipient.reply, drafting: recipient.drafting }));
    return { view: key, recipients, push: { ...this.#listItem(push), body: push.body, options: push.options, defaultDeadline: push.defaultDeadline, target: lines,
      cc: push.cc.map(each => person(each.phone, each.name)), summaryError: push.summaryError, summaryAt: push.summaryAt } };
  }

  #view(session: string, key: unknown, id: string): DetailView {
    const view = typeof key === "string" ? this.#views.get(key) : undefined;
    if (!view || view.session !== session || view.expires <= this.now() || view.push !== id) throw new ApiProblem(410, "view-gone", "这条推送的页面已过期，请重新打开");
    return view;
  }

  routes(): Record<string, Route> {
    const wrap = (run: Route["run"]): Route => ({ slow: true, run: async context => {
      try { return await run(context); } catch (error) {
        const problem = problemOf(error);
        if (problem instanceof ApiProblem) throw problem;
        throw new ApiProblem(409, "input", error instanceof Error ? error.message : "请求未完成");
      }
    } });
    const params = (body: unknown, allowed: string[]) => { const value = (body ?? {}) as Record<string, unknown>; fields(value, allowed); return value; };
    const pushId = (value: unknown) => typeof value === "string" && PUSH_ID.test(value) ? value : input("推送编号无效");
    return {
      "POST /api/push/list": wrap(async ({ body, signal }) => {
        const { group, before } = params(body, ["group", "before"]);
        if (group !== undefined && group !== null && !GROUPS.includes(group as PushGroupKey)) input("筛选无效");
        if (before !== undefined && before !== null && !(typeof before === "number" && Number.isSafeInteger(before) && before > 0)) input("翻页位置无效");
        const reply = await this.source.call("list", { group: group ?? null, before: before ?? null, limit: 50 }, signal);
        const totals = reply.totals as PushTotals;
        return { pushes: (reply.pushes as PushListItem[]).map(push => this.#listItem(push)), more: reply.more === true,
          totals: { sent: totals.sent, followUps: totals.followUps, live: totals.live, delivered: totals.delivered, acked: totals.acked,
            replyDelivered: totals.replyDelivered, replied: totals.replied } } satisfies PushListResponse;
      }),
      "POST /api/push/detail": wrap(async ({ session, body, signal }) => {
        const id = pushId(params(body, ["id"]).id);
        const detail = await this.source.call("detail", { id }, signal) as unknown as PushDetail;
        this.audit.write({ action: "push-view", session: session.label, scope: `push:${id}`, mode: "default", rows: detail.recipients.length });
        return this.#display(session.label, detail);
      }),
      "POST /api/push/remind": wrap(async ({ session, body, signal }) => {
        const value = params(body, ["view", "id", "people"]), id = pushId(value.id), view = this.#view(session.label, value.view, id);
        let members: string[] | undefined;
        if (value.people !== undefined) {
          if (!Array.isArray(value.people) || !value.people.length || value.people.length > 5000) input("请选择要补推送的人");
          members = (value.people as unknown[]).map(key => (typeof key === "string" ? view.people.get(key)?.phone : undefined) ?? input("名单已过期，请重新打开这条推送"));
        }
        this.audit.write({ action: "push-remind", session: session.label, scope: `push:${id},people:${members?.length ?? "all"}`, mode: "default" });
        return await this.source.call("remind", { id, ...(members ? { members } : {}) }, signal);
      }),
      "POST /api/push/cc": wrap(async ({ session, body, signal }) => {
        const value = params(body, ["view", "id", "cc"]), id = pushId(value.id), view = this.#view(session.label, value.view, id);
        if (!Array.isArray(value.cc) || value.cc.length > 10) input("抄送人最多 10 个");
        const cc = (value.cc as unknown[]).map((raw, index) => {
          const item = params(raw, ["key", "phone", "name"]);
          // An existing person by the key of this view; a new one by the number typed in (the bot checks the name against it).
          const known = typeof item.key === "string" ? view.people.get(item.key) : undefined;
          if (known) return { phone: known.phone, name: known.name };
          const phone = item.key === undefined && typeof item.phone === "string" ? item.phone.replace(/[\s-]/g, "") : "";
          if (!phone) input(`第 ${index + 1} 个抄送人：请从名单中选择或输入手机号`);
          return { phone, name: typeof item.name === "string" ? item.name.trim() : "" };
        });
        this.audit.write({ action: "push-cc", session: session.label, scope: `push:${id},cc:${cc.length}`, mode: "default" });
        await this.source.call("cc", { id, cc }, signal);
        return this.#display(session.label, await this.source.call("detail", { id }, signal) as unknown as PushDetail);
      }),
      "POST /api/push/delete": wrap(async ({ session, body, signal }) => {
        const id = pushId(params(body, ["id"]).id);
        this.audit.write({ action: "push-delete", session: session.label, scope: `push:${id}`, mode: "default" });
        await this.source.call("delete", { id }, signal);
        for (const [key, view] of this.#views) if (view.push === id) this.#views.delete(key);
        return { ok: true };
      }),
      "POST /api/push/package": wrap(async ({ session, body }) => {
        const value = params(body, ["view", "id", "person"]), id = pushId(value.id), view = this.#view(session.label, value.view, id);
        const person = value.person === undefined ? undefined : typeof value.person === "string" ? view.people.get(value.person) : undefined;
        if (value.person !== undefined && !person) input("名单已过期，请重新打开这条推送");
        this.#prune();
        const ticket = `push-${randomBytes(16).toString("hex")}`, expires = this.now() + TICKET_MS;
        const group = person && memberGroup(person.phone);
        const filename = safeFileName(`推送汇总-${view.subject}-${id}${!person ? "" : group !== undefined ? `-群-${person.name}` : `-${person.name}-${person.phone.slice(-4)}`}.zip`);
        const scope = `push:${id}${!person ? "" : group !== undefined ? `,group:${group}` : `,member:${maskUser(person.phone)}`}`;
        this.audit.write({ action: "export-request", session: session.label, scope, mode: "default", export: ticket, format: "zip" });
        this.#tickets.set(ticket, { session: session.label, expires, push: id, ...(person ? { member: person.phone } : {}), filename, scope });
        return { url: `/download/${ticket}`, filename, expiresAt: expires } satisfies PushTicket;
      }),
      "POST /api/push/groups": wrap(async ({ session, body, signal }) => {
        params(body, []);
        return this.#groupsDisplay(session.label, await this.source.call("groups", {}, signal));
      }),
      // Register (with a name), rename, disable or enable one group of the list just read; the list comes back fresh.
      "POST /api/push/group": wrap(async ({ session, body, signal }) => {
        const value = params(body, ["view", "key", "name", "state"]);
        const view = typeof value.view === "string" ? this.#groupViews.get(value.view) : undefined;
        if (!view || view.session !== session.label || view.expires <= this.now()) throw new ApiProblem(410, "view-gone", "群名单已过期，请重新读取");
        const group = typeof value.key === "string" ? view.groups.get(value.key) : undefined;
        if (group === undefined) input("群名单已过期，请重新读取");
        if (value.state !== "registered" && value.state !== "disabled") input("群的状态无效");
        if (value.name !== undefined && typeof value.name !== "string") input("群名无效");
        this.audit.write({ action: "push-group", session: session.label, scope: `group:${group},state:${value.state}`, mode: "default" });
        await this.source.call("group", { id: group, state: value.state, ...(value.name === undefined ? {} : { name: value.name }) }, signal);
        this.#groupViews.delete(value.view as string);
        return this.#groupsDisplay(session.label, await this.source.call("groups", {}, signal));
      }),
    };
  }

  /** `/download/push-…`: the bot's archive, passed through to the browser; the outcome is audited. */
  async download(ticket: string, context: { session: { label: string }; signal: AbortSignal }): Promise<Response> {
    this.#prune();
    const found = this.#tickets.get(ticket);
    if (!found || found.session !== context.session.label) return plain(404, "下载链接无效或已过期，请在控制台重新下载。");
    this.#tickets.delete(ticket);
    const record = (action: "export-sent" | "export-interrupted" | "export-failed", bytes: number, note?: string) => {
      try {
        this.audit.write({ action, session: found.session, scope: found.scope, mode: "default", export: ticket, format: "zip", bytes, ...(note ? { note } : {}) });
      } catch { console.error("推送汇总包下载的结果没能写进审计记录。"); }
    };
    let response: Response;
    try { response = await this.source.package({ id: found.push, ...(found.member ? { member: found.member } : {}) }, context.signal); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record("export-failed", 0, message.slice(0, 200));
      return plain(409, `汇总包没有生成：${message}`);
    }
    const reader = response.body!.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { record("export-sent", bytes); controller.close(); return; }
          bytes += next.value.byteLength;
          controller.enqueue(next.value);
        } catch (error) {
          record(context.signal.aborted ? "export-interrupted" : "export-failed", bytes, (error instanceof Error ? error.message : String(error)).slice(0, 200));
          controller.error(error);
        }
      },
      async cancel() { record("export-interrupted", bytes, "浏览器断开了下载"); await reader.cancel().catch(() => {}); },
    }, { highWaterMark: 0 });
    const length = response.headers.get("content-length");
    return new Response(body, { status: 200, headers: { ...SECURITY_HEADERS, "Content-Type": "application/zip",
      ...(length ? { "Content-Length": length } : {}), "Content-Disposition": attachment(found.filename, `push-${found.push}.zip`) } });
  }
}
