import { expect, test } from "bun:test";
import { join } from "node:path";
import { AuditLog } from "../../console/server/audit.ts";
import { FormRoutes } from "../../console/server/form-routes.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import type { ServiceStatus } from "../../ops/tools/directory-admin.ts";
import type { DirectoryScope } from "../../src/integrations/open-platform/directory-scope.ts";
import { ADVANCED_RUNTIME_KEYS } from "../../src/core/runtime-schema.ts";
import { tempFixture } from "../helpers/temp.ts";

test("通讯录表单只接受已展示的部门键，登录隔离，保存即应用且不受页面中断取消", async () => {
  const f = await tempFixture("console-directory-form-");
  try {
    const applied: DirectoryScope[] = [], parents: string[] = [];
    const controller = new AbortController();
    const forms = new FormRoutes(f.root, new AuditLog(join(f.root, "audit")), {
      status: async () => ({ verificationOnly: false, directory: { mappings: 0, state: "effective", scope: { kind: "departments", departments: ["10"] } } } as ServiceStatus),
      describe: async () => ({ departments: [{ id: "10", name: "技术部", ancestors: [] }], unavailable: [] }),
      list: async parent => { parents.push(parent!); return parent === "1" ? [{ id: "10", name: "技术部" }] : [{ id: "11", name: "研发部" }]; },
      apply: async scope => { await Bun.sleep(5); applied.push(scope); return { status: "started", departments: [] }; },
    });
    const routes = forms.routes();
    const context = (body?: unknown, session = "s") => ({ body, signal: controller.signal, session: { label: session } } as RouteContext);
    const opened = await routes["GET /api/directory/selection"]!.run(context()) as { view: string; children: { key: string; name: string }[]; selected: { key: string }[] };
    expect(opened.children[0]!.key).not.toBe("10"); expect(opened.selected[0]!.key).toBe(opened.children[0]!.key);
    await expect(routes["POST /api/directory/apply"]!.run(context({ view: opened.view, mode: "departments", selected: ["10"] }))).rejects.toThrow("不接受手填");
    await expect(routes["POST /api/directory/apply"]!.run(context({ view: opened.view, mode: "all", selected: [] }, "other"))).rejects.toThrow("失效");
    const children = await routes["POST /api/directory/children"]!.run(context({ view: opened.view, parent: opened.children[0]!.key })) as { children: { key: string }[] };
    expect(parents).toEqual(["1", "10"]);
    // Read again, the picker of the same login keeps its keys, so ticks made in the first one can be saved from it.
    const again = await routes["GET /api/directory/selection"]!.run(context()) as typeof opened;
    expect(again.view).not.toBe(opened.view); expect(again.children[0]!.key).toBe(opened.children[0]!.key);
    // Another login gets keys of its own.
    const other = await routes["GET /api/directory/selection"]!.run(context(undefined, "other")) as typeof opened;
    expect(other.children[0]!.key).not.toBe(opened.children[0]!.key);
    await expect(routes["POST /api/directory/apply"]!.run(context({ view: other.view, mode: "departments", selected: [children.children[0]!.key] }, "other"))).rejects.toThrow("不接受手填");
    const saving = routes["POST /api/directory/apply"]!.run(context({ view: again.view, mode: "departments", selected: [children.children[0]!.key] }));
    controller.abort(); expect(await saving).toEqual({ status: "started" });
    expect(applied).toEqual([{ kind: "departments", departments: ["11"] }]);
    // The first picker is still open: pickers last as long as the login, not on a clock.
    expect(await routes["POST /api/directory/children"]!.run(context({ view: opened.view, parent: opened.children[0]!.key }))).toEqual(children);
    forms.end("s");
    await expect(routes["POST /api/directory/apply"]!.run(context({ view: again.view, mode: "all", selected: [] }))).rejects.toThrow("失效");
    // Logged in again, the old keys are gone with the login.
    const fresh = await routes["GET /api/directory/selection"]!.run(context()) as typeof opened;
    expect(fresh.children[0]!.key).not.toBe(opened.children[0]!.key);
  } finally { await f.cleanup(); }
});

test("通讯录未运行时拒绝；运行参数表单读取默认值和已有中文说明", async () => {
  const f = await tempFixture("console-form-offline-");
  try {
    const forms = new FormRoutes(f.root, new AuditLog(join(f.root, "audit")), { status: async () => { throw new Error("机器人未运行"); },
      list: async () => { throw new Error("unexpected list"); }, describe: async () => { throw new Error("unexpected describe"); }, apply: async () => { throw new Error("unexpected apply"); } });
    const context = { session: { label: "s" }, signal: new AbortController().signal } as RouteContext;
    await expect(forms.routes()["GET /api/directory/selection"]!.run(context)).rejects.toThrow("未运行");
    const runtime = await forms.routes()["GET /api/forms/runtime"]!.run(context) as { hash: unknown; values: unknown;
      groups: { options: { key: string; default?: string }[] }[] };
    expect(runtime.hash).toBeNull(); expect(runtime.values).toEqual({}); expect(runtime.groups.length).toBeGreaterThan(0);
    expect(JSON.stringify(runtime.groups)).toContain("请求并发上限");
    // Every advanced runtime setting is on the form, once, with the runtime's default; the task image and control root
    // are written by the deployment, not edited here.
    const options = runtime.groups.flatMap(group => group.options);
    expect(options.map(option => option.key).sort())
      .toEqual(ADVANCED_RUNTIME_KEYS.filter(key => key !== "BOT_TASK_IMAGE" && key !== "BOT_TASK_CONTROL_ROOT").sort());
    expect(options.find(option => option.key === "BOT_ACKNOWLEDGE_IDLE_MINUTES")).toMatchObject({ default: "30" });
  } finally { await f.cleanup(); }
});
