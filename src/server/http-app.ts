import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { log } from "../core/log.ts";
import { APP_BUILD, APP_VERSION } from "../core/version.ts";
import type { DepartmentDescription, DepartmentInfo } from "../integrations/open-platform/directory.ts";
import { type DirectoryScope, parseDepartmentIds, parseScopeRequest } from "../integrations/open-platform/directory-scope.ts";
import { readStatus } from "../durable/read/client.ts";
import { parseReadOp, ReadRequestError, type ReadOp } from "../durable/read/protocol.ts";
import { PUSH_ID } from "../push/cards.ts";
import { PUSH_GROUPS, type PushAdmin, type PushGroup } from "../push/service.ts";
import { constantTimeEqual } from "./http.ts";

export interface AppOptions {
  isStopping: () => boolean;
  adminToken: string;
  shutdown: () => void;
  instanceId?: string;
  startedAt?: number;
  /** Extra health fields (event stream, directory sync); must not throw or contain credentials. */
  health?: () => Record<string, unknown>;
  /** Direct child departments of `parent` from the platform (for choosing the directory scope). */
  listDepartments?: (parent: string, signal: AbortSignal) => Promise<DepartmentInfo[]>;
  /** Names, full paths and ancestor chains of the departments (for showing the scope); read-only. */
  describeDepartments?: (ids: string[], signal: AbortSignal) => Promise<DepartmentDescription>;
  /**
   * The paths of the saved and the effective scope's departments that the service knows, without asking the platform (the console
   * names the scope with them). Not in /health: the department tree is as sensitive as the member list.
   */
  scopePaths?: () => Record<string, string>;
  /**
   * Checks the departments with the platform, saves the scope and starts applying it (the members of the scope in effect keep
   * their access until the new list is complete); see IdentityDirectory.changeScope. The saved scope again, already in effect,
   * is a no-op; any scope chosen while none is saved starts a sync. `signal` covers the checks only: once they pass, the save and
   * the sync go ahead. The body is `{"all":true}` or `{"departments":[…]}`.
   */
  changeScope?: (scope: DirectoryScope, signal: AbortSignal) =>
    Promise<{ status: "unchanged" } | { status: "started" | "cancelled"; departments: DepartmentInfo[] }>;
  /** Read-only views of the conversation databases for the host console (src/durable/read/). */
  read?: { run(op: ReadOp, signal: AbortSignal): Promise<unknown>; readonly deadlineMs: number };
  /**
   * Pushes for the console (src/push/service.ts): the settings (a refused list throws with the reason), the groups, the
   * list, one push, 补推送, the CCs, deleting, and the package download.
   */
  push?: PushAdmin;
  /** How long a route may wait on the platform (default PLATFORM_WAIT_MS); tests shorten it. */
  platformWaitMs?: number;
}

/** A console package may take this long to build (attachments are copied into one archive). */
const PACKAGE_MS = 10 * 60_000;

/** A push request's parameters; a malformed one throws PushInput (HTTP 400). */
class PushInput extends Error { override name = "PushInput"; }
const pushId = (value: unknown) => typeof value === "string" && PUSH_ID.test(value) ? value : fail("推送编号无效");
const phone = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_+\-]{1,32}$/.test(value) ? value : fail("手机号无效");
const groupId = (value: unknown) => typeof value === "string" && /^[0-9]{1,64}$/.test(value) ? value : fail("群号无效");
/** A recipient: a person's phone, or a group's `group:<ID>`. */
const member = (value: unknown) => typeof value === "string" && value.startsWith("group:") ? `group:${groupId(value.slice("group:".length))}` : phone(value);
function fail(message: string): never { throw new PushInput(message); }
function members(value: unknown, max: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) && value.length >= 1 && value.length <= max ? value.map(member) : fail(`members 必须是 1–${max} 个接收人`);
}

/** The longest a directory route waits on the platform before answering that it took too long (the console waits 75 s). */
const PLATFORM_WAIT_MS = 60_000;

/**
 * The signal of a route that waits on the platform: aborted when the caller goes away (the console closed it or gave up) or after `limitMs`.
 * Bun.serve closes a connection that sent nothing for its idleTimeout (15 s), even while the handler still works, so such a request gets
 * its own limit a little past the deadline (`c.env` is the Bun server; absent under `app.request`).
 */
function platformWait(c: Context, limitMs: number): AbortSignal {
  keepOpen(c, limitMs);
  return AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(limitMs)]);
}
/** Lets the connection of this request stay quiet a little past `limitMs` (Bun's idleTimeout would close it at 15 s). */
function keepOpen(c: Context, limitMs: number): void {
  (c.env as { timeout?: (request: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, Math.ceil(limitMs / 1000) + 10);
}

/** The failure came from the route's own signal (deadline or caller gone), not from the platform. */
const expired = (signal: AbortSignal, error: unknown) => signal.aborted && error === signal.reason;

/**
 * The host-local control surface: `/health`, `/_admin/shutdown`, `/_admin/directory/*`, `/_admin/read` and `/_admin/push/*` (settings and the
 * console's push page). Messages arrive over the platform's event stream,
 * so nothing here is reachable from the platform; the server listens on loopback only (src/core/config.ts).
 */
export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  // version is the health protocol; appVersion and build name the running program.
  const identity = { service: "mixin-chatbot" as const, version: 1 as const, appVersion: APP_VERSION, build: APP_BUILD, instanceId: options.instanceId ?? randomUUID(),
    startedAt: options.startedAt ?? Date.now(), pid: process.pid };

  app.get("/health", (c) => {
    const stopping = options.isStopping();
    let extra: Record<string, unknown> = {};
    try { extra = options.health?.() ?? {}; } catch (error) { log.error("健康状态读取失败: " + String(error)); }
    return c.json({ ...identity, status: stopping ? "stopping" : "ready", ...extra }, stopping ? 503 : 200);
  });
  const authorized = (header: string | undefined) => constantTimeEqual(header ?? "", "Bearer " + options.adminToken);
  const waitMs = options.platformWaitMs ?? PLATFORM_WAIT_MS, waitSeconds = Math.ceil(waitMs / 1000);
  app.post("/_admin/shutdown", (c) => {
    if (!authorized(c.req.header("Authorization"))) return c.notFound();
    setTimeout(options.shutdown, 0);
    return c.json({ status: "stopping" });
  });
  app.post("/_admin/directory/departments", async (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.listDepartments) return c.notFound();
    const body = await c.req.json().catch(() => undefined) as { parent?: unknown } | undefined;
    let parent: string;
    try { [parent] = parseDepartmentIds([body?.parent ?? "1"], "parent"); }
    catch (error) { return c.json({ status: "error", message: (error as Error).message }, 400); }
    const signal = platformWait(c, waitMs);
    try { return c.json({ status: "ok", departments: await options.listDepartments(parent, signal) }); }
    catch (error) {
      if (expired(signal, error)) return c.json({ status: "error", message: `读取部门超过 ${waitSeconds} 秒没有完成，请稍后重试` }, 504);
      return c.json({ status: "error", message: `读取部门失败：${(error as Error).message}` }, 502);
    }
  });
  app.post("/_admin/directory/department-details", async (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.describeDepartments) return c.notFound();
    const body = await c.req.json().catch(() => undefined) as { ids?: unknown } | undefined;
    let ids: string[];
    try { ids = parseDepartmentIds(body?.ids, "ids"); }
    catch (error) { return c.json({ status: "error", message: (error as Error).message }, 400); }
    const signal = platformWait(c, waitMs);
    try { return c.json({ status: "ok", ...await options.describeDepartments(ids, signal) }); }
    catch (error) {
      if (expired(signal, error)) return c.json({ status: "error", message: `读取部门详情超过 ${waitSeconds} 秒没有完成，请稍后重试` }, 504);
      return c.json({ status: "error", message: `读取部门详情失败：${(error as Error).message}` }, 502);
    }
  });
  app.post("/_admin/directory/scope-paths", (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.scopePaths) return c.notFound();
    return c.json({ status: "ok", paths: options.scopePaths() });
  });
  app.post("/_admin/directory/scope", async (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.changeScope) return c.notFound();
    const body: unknown = await c.req.json().catch(() => undefined);
    let scope: DirectoryScope;
    try { scope = parseScopeRequest(body); }
    catch (error) { return c.json({ status: "error", message: (error as Error).message }, 400); }
    const signal = platformWait(c, waitMs);
    try {
      // started: applying now (202); cancelled: the scope in effect was saved again and an unfinished apply dropped.
      const result = await options.changeScope(scope, signal);
      return c.json(result, result.status === "started" ? 202 : 200);
    }
    catch (error) {
      if (expired(signal, error)) return c.json({ status: "error", message: `核对部门超过 ${waitSeconds} 秒没有完成；范围未改，请稍后重试` }, 504);
      return c.json({ status: "error", message: (error as Error).message }, 409);
    }
  });
  app.post("/_admin/read", async (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.read) return c.notFound();
    let op: ReadOp;
    try { op = parseReadOp(await c.req.json()); }
    catch (error) { return c.json({ status: "error", code: "ReadRequestError", message: error instanceof ReadRequestError ? error.message : "请求体不是 JSON" }, 400); }
    keepOpen(c, options.read.deadlineMs);
    try { return c.json({ status: "ok", result: await options.read.run(op, c.req.raw.signal) }); }
    catch (error) {
      const status = readStatus(error);
      if (status === 500) log.error(`控制台读取失败: ${String(error)}`);
      return c.json({ status: "error", code: (error as Error).name, message: (error as Error).message }, status);
    }
  });
  app.post("/_admin/push/settings", (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.push) return c.notFound();
    return c.json({ status: "ok", ...options.push.settings() as object });
  });
  app.post("/_admin/push/settings/save", async (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.push) return c.notFound();
    const body = await c.req.json().catch(() => undefined) as { roles?: unknown } | undefined;
    try { options.push.saveSettings(body?.roles); }
    catch (error) {
      // The numbers the service refused go back as a list: the console shows them masked.
      const phones = (error as { phones?: unknown }).phones;
      return c.json({ status: "error", message: (error as Error).message, ...(Array.isArray(phones) ? { phones } : {}) }, 400);
    }
    return c.json({ status: "ok", ...options.push.settings() as object });
  });
  // The console's push page. Refusals (PushRefused) answer 409 with the reason; malformed parameters 400.
  const pushRoute = (name: string, handle: (push: PushAdmin, body: Record<string, unknown>, c: Context) => Promise<Response> | Response) =>
    app.post(`/_admin/push/${name}`, async (c) => {
      if (!authorized(c.req.header("Authorization")) || !options.push) return c.notFound();
      const body: unknown = await c.req.json().catch(() => undefined);
      if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ status: "error", message: "请求体必须是对象" }, 400);
      try { return await handle(options.push, body as Record<string, unknown>, c); }
      catch (error) {
        const name = (error as Error).name;
        if (name === "PushInput") return c.json({ status: "error", message: (error as Error).message }, 400);
        if (name === "PushRefused") return c.json({ status: "error", message: (error as Error).message }, 409);
        // The caller has gone: nobody reads this answer.
        if (c.req.raw.signal.aborted) return c.json({ status: "error", message: "请求已取消" }, 503);
        throw error;
      }
    });
  pushRoute("list", (push, body, c) => {
    const group = body.group ?? null, before = body.before ?? null, limit = body.limit ?? 50;
    if (group !== null && !(typeof group === "string" && group in PUSH_GROUPS)) fail("group 无效");
    if (before !== null && !(typeof before === "number" && Number.isSafeInteger(before) && before > 0)) fail("before 无效");
    if (!(typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100)) fail("limit 超出范围 1–100");
    return c.json({ status: "ok", ...push.list({ group: group as PushGroup | null, before: before as number | null, limit: limit as number }) });
  });
  pushRoute("detail", (push, body, c) => c.json({ status: "ok", ...push.detail(pushId(body.id)) }));
  pushRoute("remind", async (push, body, c) => c.json({ status: "ok", ...await push.remind(pushId(body.id), members(body.members, 5000)) }));
  pushRoute("cc", (push, body, c) => {
    const people = Array.isArray(body.cc) && body.cc.length <= 10 ? body.cc.map(raw => {
      const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : fail("抄送人无效");
      return { phone: phone(item.phone), name: typeof item.name === "string" ? item.name : "" };
    }) : fail("cc 必须是不超过 10 人的数组");
    push.setCc(pushId(body.id), people);
    return c.json({ status: "ok" });
  });
  pushRoute("delete", async (push, body, c) => { await push.remove(pushId(body.id)); return c.json({ status: "ok" }); });
  pushRoute("groups", (push, _body, c) => c.json({ status: "ok", ...push.groups() }));
  pushRoute("group", (push, body, c) => {
    if (Object.keys(body).some(key => !["id", "name", "state"].includes(key))) fail("群设置含未知项");
    if (body.state !== "registered" && body.state !== "disabled") fail("state 必须是 registered 或 disabled");
    if (body.name !== undefined && typeof body.name !== "string") fail("群名无效");
    return c.json({ status: "ok", group: push.saveGroup(groupId(body.id), { state: body.state, ...(typeof body.name === "string" ? { name: body.name } : {}) }) });
  });
  // The archive streams from its file, which goes once the stream ends either way.
  pushRoute("package", async (push, body, c) => {
    keepOpen(c, PACKAGE_MS);
    const pack = await push.package(pushId(body.id), body.member === undefined || body.member === null ? undefined : member(body.member), c.req.raw.signal);
    const reader = Bun.file(pack.path).stream().getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { controller.close(); await pack.done(); } else controller.enqueue(next.value);
        } catch (error) { controller.error(error); await pack.done(); }
      },
      async cancel() { await reader.cancel().catch(() => {}); await pack.done(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/zip", "Content-Length": String(pack.size),
      "X-Push-Filename": encodeURIComponent(pack.name) } });
  });
  app.onError((err, c) => {
    log.error(`本机控制接口异常: ${String(err)}`);
    return c.json({ status: "error", message: "内部服务器错误" }, 500);
  });
  app.notFound((c) => c.json({ status: "error", message: "Not Found" }, 404));
  return app;
}
