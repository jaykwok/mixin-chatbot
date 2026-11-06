import { ApiProblem } from "./routes.ts";
import type { Route, RouteContext } from "./routes.ts";
import type { HostingCheck } from "../../ops/core/hosting.ts";
import type { PlanStore } from "../../ops/core/plans.ts";
import type { TaskStore, TaskView, TaskObservers, TaskRequest } from "../../ops/core/tasks.ts";
import type { AuditLog } from "./audit.ts";
import { redactSecrets } from "../../src/lib/redact.ts";

interface TaskApi {
  tasks: TaskStore; plans: PlanStore; observers: TaskObservers; audit: AuditLog;
  hosting(): Promise<HostingCheck>;
  current?(): boolean;
  launch(id: string): Promise<void>;
  prepare?(operation: string, params: Record<string, unknown>, session: string): Promise<Record<string, unknown>>;
  created?(request: TaskRequest): void;
}
const problem = (error: unknown): never => { throw new ApiProblem(409, "input", redactSecrets(error instanceof Error ? error.message : "管理请求被拒绝")
  .replace(/\b1[3-9]\d{9}\b/g, value => `${value.slice(0, 3)}****${value.slice(-4)}`)); };
const record = (body: unknown, allowed: string[]): Record<string, unknown> => {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw new ApiProblem(400, "input", "请求参数无效");
  return body as Record<string, unknown>;
};
/** Raw argv, paths and parameters may carry member identities. Only deliberate display fields leave the host. */
const display = (view: TaskView) => ({ id: view.id, state: view.state, needsRecovery: view.needsRecovery,
  operation: view.request?.operation, createdAt: view.request?.createdAt, result: view.result, reason: view.reason });

function events(tasks: TaskStore, id: string, context: RouteContext): Response {
  const header = context.request?.headers.get("last-event-id") ?? "0";
  if (!/^\d{1,10}$/.test(header)) throw new ApiProblem(400, "input", "事件序号无效");
  let cursor = Number(header), timer: ReturnType<typeof setInterval> | undefined, stopped = false;
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = () => {
        if (stopped) return;
        stopped = true; clearInterval(timer); context.signal.removeEventListener("abort", stop);
        try { controller.close(); } catch {}
      };
      const pump = () => {
        if (stopped) return;
        if (context.signal.aborted || !context.sessionAlive?.()) { stop(); return; }
        if ((controller.desiredSize ?? 0) <= 0) return;
        try {
          const batch = tasks.events(id, cursor).slice(0, 50);
          if (!batch.length) controller.enqueue(encoder.encode(": keepalive\n\n"));
          for (const event of batch) {
            controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: task\ndata: ${JSON.stringify(event)}\n\n`));
            cursor = event.seq;
          }
        } catch { controller.enqueue(encoder.encode('event: error\ndata: {"message":"事件记录无法读取"}\n\n')); stop(); }
      };
      context.signal.addEventListener("abort", stop, { once: true });
      timer = setInterval(pump, 1000); pump();
    }, cancel() { stop(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

export function taskRoutes(api: TaskApi): Record<string, Route> {
  const { tasks, plans, observers, audit } = api;
  const writable = () => { if (api.current && !api.current()) throw new Error("代码已变化，请退出并重新运行 bun run console"); };
  const get = async (id: string | undefined) => {
    if (!id || !/^task-[a-f0-9]{32}$/.test(id)) throw new ApiProblem(400, "input", "任务编号无效");
    const view = await tasks.view(id, observers);
    if (!view.request) throw new ApiProblem(404, "not-found", "任务不存在或记录不可读");
    return view;
  };
  return {
    "POST /api/plans": { slow: true, run: async ({ body, session }) => {
      const value = record(body, ["operation", "params"]);
      if (typeof value.operation !== "string" || !value.params || typeof value.params !== "object" || Array.isArray(value.params)) throw new ApiProblem(400, "input", "操作参数无效");
      try {
        writable();
        const params = api.prepare ? await api.prepare(value.operation, value.params as Record<string, unknown>, session.label) : value.params as Record<string, unknown>;
        writable();
        const plan = await plans.create(value.operation, params);
        audit.write({ action: "plan", scope: plan.operation, session: session.label, mode: "default" });
        return { id: plan.id, operation: plan.operation, summary: plan.summary, expiresAt: plan.expiresAt };
      } catch (error) { return problem(error); }
    } },
    "POST /api/tasks": { slow: true, run: async ({ body, session }) => {
      const value = record(body, ["plan", "key"]);
      if (typeof value.plan !== "string" || typeof value.key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value.key)) throw new ApiProblem(400, "input", "计划或幂等键无效");
      try {
        writable();
        const existing = tasks.lookupSubmission(value.key);
        if (existing) {
          const request = tasks.request(existing);
          if (request.planId !== value.plan) throw new Error("幂等键已用于其他计划");
          return display(await tasks.view(existing, observers));
        }
        const priorPlan = tasks.lookupPlan(value.plan);
        if (priorPlan) {
          tasks.bindKey(value.key, priorPlan);
          return display(await tasks.view(priorPlan, observers));
        }
        const check = await api.hosting();
        if (!check.ok) throw new Error(check.reason);
        const plan = await plans.verify(value.plan);
        writable();
        audit.write({ action: "task-submit", scope: plan.operation, session: session.label, mode: "default" });
        const task = tasks.create({ planId: plan.id, operation: plan.operation, params: plan.params,
          project: plan.facts.project, mechanism: check.mechanism }, `plan:${plan.id}`);
        tasks.bindKey(value.key, task.id);
        // Only the creator launches. Browser cancellation never propagates into this handoff.
        if (task.created) {
          api.created?.(tasks.request(task.id));
          try { await api.launch(task.id); } catch { /* return the durable task; expiration arbitrates a late launcher */ }
        }
        const view = display(await tasks.view(task.id, observers));
        return new Response(JSON.stringify(view), { status: 202, headers: { "Content-Type": "application/json" } });
      } catch (error) { return problem(error); }
    } },
    "GET /api/tasks": { run: async () => ({ tasks: (await tasks.list(observers)).map(display) }) },
    "GET /api/tasks/:id": { run: async context => display(await get(context.params?.id)) },
    "GET /api/tasks/:id/events": { slow: true, run: async context => {
      const view = await get(context.params?.id);
      return events(tasks, view.id, context);
    } },
    "POST /api/tasks/:id/log": { run: async context => {
      const view = await get(context.params?.id);
      audit.write({ action: "log-export", session: context.session.label, scope: view.id, mode: "default" });
      return { filename: `${view.id}.log`, content: tasks.events(view.id, 0).map(event => `${new Date(event.at).toISOString()} [${event.kind}] ${event.text}`).join("\n") + "\n" };
    } },
  };
}
