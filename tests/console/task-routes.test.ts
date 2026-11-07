import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdirSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AuditLog } from "../../console/server/audit.ts";
import { Auth } from "../../console/server/auth.ts";
import { guardConfig } from "../../console/server/guard.ts";
import { PlanStore } from "../../ops/core/plans.ts";
import { createHandler } from "../../console/server/server.ts";
import { taskRoutes } from "../../console/server/task-routes.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import { tempFixture } from "../helpers/temp.ts";

const actor = { pid: 1, startedAt: "fixture" };
async function setup() {
  const fixture = await tempFixture("console-task-http-");
  const time = { at: 1000, scope: "first", hosting: true, launches: 0, accept: true, current: true, replaceDuringHosting: false };
  const tasks = new TaskStore(join(fixture.root, ".console"), () => time.at);
  const plans = new PlanStore(join(fixture.root, ".console"), async () => ({ facts: { project: fixture.root, platform: process.platform,
    identity: "test", head: "head", protocol: 1, runState: "stopped", scope: time.scope }, summary: ["停止机器人"] }), () => time.at);
  const observers = { hosting: async () => ({ state: "running" as const, executor: actor }), needsRecovery: async () => false };
  const auth = new Auth({ exchangeMs: 60_000, idleMs: 30_000, absoluteMs: 999_999 }, () => time.at);
  const login = auth.exchange(auth.issueToken().token)!;
  const handler = createHandler({ port: 10001, guard: guardConfig(10001), auth, instanceId: "fixture", overview: async () => { throw new Error("unused"); },
    bundle: { index: { path: "/", type: "text/html", body: new Uint8Array() }, assets: new Map() },
    routes: taskRoutes({ tasks, plans, observers, audit: new AuditLog(join(fixture.root, ".console/audit")),
      current: () => time.current,
      hosting: async () => { if (time.replaceDuringHosting) time.current = false; return time.hosting ? { ok: true, mechanism: "systemd-system", facts: [] } : { ok: false, reason: "没有 systemd", facts: [] }; },
      launch: async id => { time.launches++; if (time.accept) tasks.accept(id, actor); else { time.at += 20_000; tasks.abandon(id); } },
    }),
  });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) => handler(new Request(`http://127.0.0.1:10001${path}`, {
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), signal,
    headers: { Host: "127.0.0.1:10001", Origin: "http://127.0.0.1:10001", "X-Console-Request": "1", "Content-Type": "application/json", cookie: `${auth.cookieName}=${login.sessionId}`, ...headers },
  }));
  const plan = async () => (await (await request("/api/plans", { operation: "stop", params: {} })).json()) as { id: string };
  return { fixture, time, tasks, request, plan, auth };
}

test("HTTP 双击和两个标签页同一计划只启动一次；重试在计划过期后仍返回原任务", async () => {
  const h = await setup();
  try {
    const plan = await h.plan();
    const responses = await Promise.all(["idempotent-1", "idempotent-1", "idempotent-2"].map(key => h.request("/api/tasks", { plan: plan.id, key })));
    const bodies = await Promise.all(responses.map(response => response.json() as Promise<{ id: string; state: string }>));
    expect(new Set(bodies.map(body => body.id)).size).toBe(1);
    expect(h.time.launches).toBe(1);
    const id = bodies[0]!.id;
    expect((await (await h.request(`/api/tasks/${id}`)).json() as { state: string }).state).toBe("running");
    expect(JSON.stringify(bodies)).not.toContain(h.fixture.root);
    h.time.scope = "changed";
    expect((await h.request("/api/tasks", { plan: plan.id, key: "idempotent-3" })).status).toBe(200);
    const changed = await h.plan();
    expect((await h.request("/api/tasks", { plan: changed.id, key: "idempotent-1" })).status).toBe(409);
  } finally { await h.fixture.cleanup(); }
});

test("托管条件不足、范围改变、计划过期在创建任务前拒绝；接单超时不能晚执行", async () => {
  const h = await setup();
  try {
    const plan = await h.plan();
    h.time.hosting = false;
    expect((await h.request("/api/tasks", { plan: plan.id, key: "hosting-off" })).status).toBe(409);
    h.time.hosting = true; h.time.scope = "changed";
    expect((await h.request("/api/tasks", { plan: plan.id, key: "scope-changed" })).status).toBe(409);
    const expired = await h.plan();
    // Extend browser authentication independently; this test concerns plan expiry, not session expiry.
    h.time.at += 600_000;
    const direct = new PlanStore(join(h.fixture.root, ".console"), async () => { throw new Error("must not observe expired plan"); }, () => h.time.at);
    await expect(direct.verify(expired.id)).rejects.toThrow("过期");
    h.time.at = 1001; h.time.accept = false;
    const fresh = await h.plan();
    const response = await h.request("/api/tasks", { plan: fresh.id, key: "too-late" });
    const body = await response.json() as { id: string; state: string };
    expect(body.state).toBe("not-accepted"); expect(h.tasks.accept(body.id, actor)).toBe(false);
  } finally { await h.fixture.cleanup(); }
});

test("过期一小时后的计划和中断写入的临时文件在新建计划时删除；未到期和无法读取的计划保留", async () => {
  const fixture = await tempFixture("console-plan-prune-");
  try {
    const time = { at: Date.now() };
    const plans = new PlanStore(join(fixture.root, ".console"), async () => ({ facts: { project: fixture.root, platform: process.platform,
      identity: "test", head: "head", protocol: 1, runState: "stopped", scope: "s" }, summary: [] }), () => time.at);
    const old = await plans.create("stop", {}), dir = join(fixture.root, ".console", "plans");
    const broken = join(dir, `plan-${"0".repeat(32)}.json`), temporary = join(dir, `${old.id}.json.${randomUUID()}.tmp`);
    writeFileSync(broken, "{broken"); writeFileSync(temporary, "{}");
    // The temporary file ages by its mtime: pin it to the test clock (2 s ahead, so a coarse or skewed file clock cannot age it early).
    const written = new Date(time.at + 2000); utimesSync(temporary, written, written);
    time.at += 600_000 + 3_600_000 - 1;
    const kept = await plans.create("stop", {});
    expect(readdirSync(dir).sort()).toEqual([`${old.id}.json`, `${kept.id}.json`, basename(temporary), basename(broken)].sort());
    time.at += 60_000;
    plans.prune();
    expect(readdirSync(dir).sort()).toEqual([`${kept.id}.json`, basename(broken)].sort());
  } finally { await fixture.cleanup(); }
});

test("版本检查后在异步托管核对期间代码改变，也不能创建或启动新任务", async () => {
  const h = await setup();
  try {
    const plan = await h.plan(); h.time.replaceDuringHosting = true;
    const response = await h.request("/api/tasks", { plan: plan.id, key: "changed-while-hosting" });
    expect(response.status).toBe(409); expect(h.time.launches).toBe(0);
    expect(h.tasks.lookupSubmission("changed-while-hosting")).toBeUndefined();
    expect((await h.request("/api/plans", { operation: "stop", params: {} })).status).toBe(409);
  } finally { await h.fixture.cleanup(); }
});

test("SSE 续读、跨端口来源拒绝；断开和登录失效不改变已接单任务", async () => {
  const h = await setup();
  try {
    const plan = await h.plan(), submitted = await h.request("/api/tasks", { plan: plan.id, key: "sse-fixture" });
    const { id } = await submitted.json() as { id: string };
    const log = h.tasks.eventWriter(id); log("phase", "one"); log("phase", "two");
    expect((await h.request(`/api/tasks/${id}/events`, undefined, { Origin: "http://127.0.0.1:12345" })).status).toBe(403);
    const controller = new AbortController();
    const stream = await h.request(`/api/tasks/${id}/events`, undefined, { "Last-Event-ID": "1" }, controller.signal);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("x-content-type-options")).toBe("nosniff");
    const reader = stream.body!.getReader(), first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("id: 2"); expect(first).not.toContain("one");
    controller.abort(); expect((await reader.read()).done).toBe(true);
    const again = await h.request(`/api/tasks/${id}/events`, undefined, { "Last-Event-ID": "2" });
    const more = again.body!.getReader(); await more.read();
    h.auth.revokeAll(); expect((await more.read()).done).toBe(true);
    expect(h.tasks.request(id).operation).toBe("stop");
    h.tasks.finish(id, { outcome: "success", exitCode: 0, finalState: "stopped", message: "completed after disconnect" });
    expect(h.time.launches).toBe(1);
  } finally { await h.fixture.cleanup(); }
}, 10_000);
