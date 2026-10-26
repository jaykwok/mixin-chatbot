import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { log } from "../core/log.ts";
import { APP_BUILD, APP_VERSION } from "../core/version.ts";
import type { DepartmentInfo } from "../integrations/open-platform/directory.ts";
import { parseDepartmentIds } from "../integrations/open-platform/directory-scope.ts";
import { constantTimeEqual } from "./http.ts";

export interface AppOptions {
  isStopping: () => boolean;
  adminToken: string;
  shutdown: () => void;
  instanceId?: string;
  startedAt?: number;
  /** Extra health fields (event stream, directory sync); must not throw or contain credentials. */
  health?: () => Record<string, unknown>;
  /** Confirms the paused bulk revocation of directory scan `scanId` (see IdentityDirectory.confirmRevocations). */
  confirmRevocations?: (scanId: number) => "started" | "stale" | "busy";
  /** Direct child departments of `parent` from the platform (for choosing the directory scope). */
  listDepartments?: (parent: string) => Promise<DepartmentInfo[]>;
  /** Checks the departments with the platform, saves the scope (`undefined`: the whole directory) and rescans; the current scope again is a no-op. */
  changeScope?: (departments: string[] | undefined) => Promise<DepartmentInfo[] | "unchanged">;
}

/**
 * The host-local control surface: `/health`, `/_admin/shutdown` and `/_admin/directory/*`. Messages arrive over the platform's event stream,
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
  app.post("/_admin/shutdown", (c) => {
    if (!authorized(c.req.header("Authorization"))) return c.notFound();
    setTimeout(options.shutdown, 0);
    return c.json({ status: "stopping" });
  });
  app.post("/_admin/directory/confirm", async (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.confirmRevocations) return c.notFound();
    const body = await c.req.json().catch(() => undefined) as { scanId?: unknown } | undefined;
    const scanId = body?.scanId;
    if (typeof scanId !== "number" || !Number.isSafeInteger(scanId) || scanId < 1) return c.json({ status: "error", message: "scanId 无效" }, 400);
    const result = options.confirmRevocations(scanId);
    if (result === "started") return c.json({ status: "started" }, 202);
    return c.json({ status: result, message: result === "busy" ? "通讯录同步正在进行，请稍后重试" : "这一轮已不是待确认的撤销，请刷新后重新查看" }, 409);
  });
  app.post("/_admin/directory/departments", async (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.listDepartments) return c.notFound();
    const body = await c.req.json().catch(() => undefined) as { parent?: unknown } | undefined;
    let parent: string;
    try { [parent] = parseDepartmentIds([body?.parent ?? "1"], "parent"); }
    catch (error) { return c.json({ status: "error", message: (error as Error).message }, 400); }
    try { return c.json({ status: "ok", departments: await options.listDepartments(parent) }); }
    catch (error) { return c.json({ status: "error", message: `读取部门失败：${(error as Error).message}` }, 502); }
  });
  app.post("/_admin/directory/scope", async (c) => {
    if (!authorized(c.req.header("Authorization")) || !options.changeScope) return c.notFound();
    const body = await c.req.json().catch(() => undefined) as { departments?: unknown } | undefined;
    let departments: string[] | undefined;
    try { departments = body?.departments === null ? undefined : parseDepartmentIds(body?.departments); }
    catch (error) { return c.json({ status: "error", message: (error as Error).message }, 400); }
    try {
      const checked = await options.changeScope(departments);
      return checked === "unchanged" ? c.json({ status: "unchanged" }) : c.json({ status: "started", departments: checked }, 202);
    }
    catch (error) { return c.json({ status: "error", message: (error as Error).message }, 409); }
  });
  app.onError((err, c) => {
    log.error(`本机控制接口异常: ${String(err)}`);
    return c.json({ status: "error", message: "内部服务器错误" }, 500);
  });
  app.notFound((c) => c.json({ status: "error", message: "Not Found" }, 404));
  return app;
}
