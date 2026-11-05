import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TaskStore } from "../../scripts/ops/console/tasks.ts";
import type { TaskObservers, TaskRequest } from "../../scripts/ops/console/tasks.ts";
import { tempFixture } from "../helpers/temp.ts";

const actor = { pid: 1234, startedAt: "2026-10-29T00:00:00.123Z" };
const observers: TaskObservers = { hosting: async () => ({ state: "running", executor: actor }), needsRecovery: async () => false };
const done = { outcome: "success" as const, exitCode: 0, finalState: "stopped" as const, message: "完成" };
const input = (project: string): Omit<TaskRequest, "version" | "id" | "createdAt" | "acceptBy"> => ({ project, operation: "stop",
  params: {}, planId: "plan-fixture", mechanism: process.platform === "win32" ? "windows-task" : "systemd-system" });

test("多进程争接单和放弃只有一个赢家；同键并发提交只发布一个请求", async () => {
  const fixture = await tempFixture("console-tasks-race-");
  try {
    const store = new TaskStore(fixture.root, () => 1000);
    const ids = Array.from({ length: 24 }, (_, i) => store.create(input(fixture.root), `race-${i}`, 100).id);
    const inputPath = join(fixture.root, "races.json");
    writeFileSync(inputPath, JSON.stringify({ ids, at: 1000, input: input(fixture.root) }));
    const results = await Promise.all(["accept", "abandon", "accept", "abandon"].map(async mode => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../helpers/console-task-racer.ts"), fixture.root, inputPath, mode],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(stdout) as { wins: boolean[]; submitted: { id: string; created: boolean }[] };
    }));
    for (let i = 0; i < ids.length; i++) {
      expect(results.filter(result => result.wins[i]).length).toBe(1);
      expect(JSON.parse(readFileSync(join(store.dir(ids[i]!), "claim"), "utf8")).kind).toMatch(/^(executor|abandoned)$/);
    }
    for (let i = 0; i < 12; i++) {
      expect(new Set(results.map(result => result.submitted[i]!.id)).size).toBe(1);
      expect(results.filter(result => result.submitted[i]!.created).length).toBe(1);
    }
    expect(readdirSync(store.root).filter(name => name.startsWith("task-")).length).toBe(36);
  } finally { await fixture.cleanup(); }
}, 120_000);

test("过期后放弃阻止晚到执行者；同键不同计划拒绝；失败不留下半个映射", async () => {
  const fixture = await tempFixture("console-tasks-deadline-");
  try {
    let at = 1000;
    const store = new TaskStore(fixture.root, () => at), request = input(fixture.root);
    const { id } = store.create(request, "retry");
    expect(store.create(request, "retry")).toEqual({ id, created: false });
    expect(() => store.create({ ...request, operation: "start" }, "retry")).toThrow("幂等键");
    expect((await store.view(id, observers)).state).toBe("queued");
    expect(store.abandon(id)).toBe(false);
    at += 20_000;
    expect((await store.view(id, observers)).state).toBe("not-accepted");
    expect(store.accept(id, actor)).toBe(false);
    expect(() => store.finish(id, done)).toThrow("尚未接单");
    expect(() => store.dir("../state")).toThrow("编号");
  } finally { await fixture.cleanup(); }
});

test("查看旧任务不写文件：已有接单记录时放弃直接返回，目录不变", async () => {
  const fixture = await tempFixture("console-tasks-view-quiet-");
  try {
    let at = 1000;
    const store = new TaskStore(fixture.root, () => at);
    const accepted = store.create(input(fixture.root), "accepted").id, expired = store.create(input(fixture.root), "expired").id;
    expect(store.accept(accepted, actor)).toBe(true);
    store.finish(accepted, done);
    at += 20_000;
    expect((await store.view(expired, observers)).state).toBe("not-accepted");
    for (const id of [accepted, expired]) {
      const dir = store.dir(id), before = { mtime: statSync(dir).mtimeMs, names: readdirSync(dir).sort() };
      await Bun.sleep(30);
      for (let i = 0; i < 5; i++) { await store.view(id, observers); expect(store.abandon(id)).toBe(false); }
      expect({ mtime: statSync(dir).mtimeMs, names: readdirSync(dir).sort() }).toEqual(before);
    }
  } finally { await fixture.cleanup(); }
});

test("PID 重用、托管结束、查询失败与心跳超时分别判断；恢复标记不被成功覆盖", async () => {
  const fixture = await tempFixture("console-tasks-state-");
  try {
    let at = 1000;
    const store = new TaskStore(fixture.root, () => at), { id } = store.create(input(fixture.root), "state");
    expect(store.accept(id, actor)).toBe(true);
    expect((await store.view(id, observers)).state).toBe("running");
    expect((await store.view(id, { ...observers, hosting: async () => ({ state: "running", executor: { ...actor, startedAt: "new-process" } }) })).state).toBe("interrupted");
    expect((await store.view(id, { ...observers, hosting: async () => ({ state: "ended" }) })).state).toBe("interrupted");
    const unknown: TaskObservers = { ...observers, hosting: async () => { throw new Error("unavailable"); } };
    store.heartbeat(id, actor);
    at += 59_000;
    expect((await store.view(id, unknown)).state).toBe("unknown");
    store.heartbeat(id, actor);
    at += 60_001;
    expect((await store.view(id, unknown)).state).toBe("interrupted");
    // A running unit is stronger evidence than an old heartbeat.
    expect((await store.view(id, observers)).state).toBe("running");
    expect(() => store.heartbeat(id, { ...actor, startedAt: "reused" })).toThrow("接单记录不符");
    // Unfinished tasks carry the deployment's recovery state; an unreadable state never clears the warning.
    expect(await store.view(id, { ...unknown, needsRecovery: async () => true })).toMatchObject({ state: "interrupted", needsRecovery: true });
    expect((await store.view(id, { ...unknown, needsRecovery: async () => { throw new Error("bad state"); } })).needsRecovery).toBe(true);
    expect((await store.view(id, { ...observers, needsRecovery: async () => true })).needsRecovery).toBe(false); // running
    store.finish(id, done);
    expect(await store.view(id, { ...observers, needsRecovery: async () => true })).toMatchObject({ state: "succeeded", needsRecovery: false });
  } finally { await fixture.cleanup(); }
});

test("恢复提示只标在可能留下状态的任务上：失败时执行器仍看到未完成状态、且现在仍未处理", async () => {
  const fixture = await tempFixture("console-tasks-recovery-");
  try {
    const store = new TaskStore(fixture.root), pending = { ...observers, needsRecovery: async () => true };
    const failed = (key: string, extra: { leftRecovery?: boolean; outcome?: "failed" | "refused" } = {}) => {
      const { id } = store.create(input(fixture.root), key);
      store.accept(id, actor);
      store.finish(id, { outcome: "failed", exitCode: 1, finalState: "unknown", message: "失败", ...extra });
      return id;
    };
    const left = failed("left", { leftRecovery: true }), clean = failed("clean", { leftRecovery: false }), refused = failed("refused", { outcome: "refused" });
    expect((await store.view(left, pending)).needsRecovery).toBe(true);
    expect((await store.view(left, observers)).needsRecovery).toBe(false); // handled since
    expect((await store.view(clean, pending)).needsRecovery).toBe(false); // e.g. rolled back on its own
    expect((await store.view(refused, pending)).needsRecovery).toBe(false);
    const { id } = store.create(input(fixture.root), "contradiction");
    store.accept(id, actor);
    expect(() => store.finish(id, { ...done, leftRecovery: true })).toThrow("相互矛盾");
  } finally { await fixture.cleanup(); }
});

test("执行器在托管查询期间写完结果并退出：直接显示结果，不闪“结果未知”或“执行中断”", async () => {
  const fixture = await tempFixture("console-tasks-late-");
  try {
    const store = new TaskStore(fixture.root);
    for (const hosted of ["ended", "unknown"] as const) {
      const { id } = store.create(input(fixture.root), hosted);
      store.accept(id, actor);
      const exiting: TaskObservers = { ...observers, hosting: async () => { store.finish(id, done); return { state: hosted }; } };
      expect(await store.view(id, exiting)).toMatchObject({ state: "succeeded", result: { message: "完成" } });
    }
  } finally { await fixture.cleanup(); }
});

test("半写和损坏记录、矛盾结果均不能算成功", async () => {
  const fixture = await tempFixture("console-tasks-corrupt-");
  try {
    const store = new TaskStore(fixture.root);
    for (const name of ["request.json", "claim", "result.json", "heartbeat"]) {
      const { id } = store.create(input(fixture.root), name);
      store.accept(id, actor);
      writeFileSync(join(store.dir(id), name), '{"version":1');
      expect((await store.view(id, { ...observers, hosting: async () => ({ state: "unknown" }) })).state).toBe("unknown");
    }
    const { id } = store.create(input(fixture.root), "result");
    store.accept(id, actor);
    expect(() => store.finish(id, { ...done, exitCode: 1 })).toThrow("相互矛盾");
    writeFileSync(join(store.dir(id), "result.json"), JSON.stringify({ ...done, version: 1, id, finishedAt: Date.now(), exitCode: 1 }));
    expect((await store.view(id, observers)).state).toBe("unknown");
    writeFileSync(join(store.dir(id), "result.json"), JSON.stringify({ outcome: "success", exitCode: 0 }));
    expect((await store.view(id, observers)).state).toBe("unknown");
    rmSync(join(store.dir(id), "result.json"));
    store.finish(id, { ...done, outcome: "failed", exitCode: 1 });
    expect((await store.view(id, observers)).state).toBe("failed");
    expect(() => store.finish(id, done)).toThrow("已经写入");
  } finally { await fixture.cleanup(); }
});

test("事件按序续读，脱敏后落盘，2 MB 内截断但保留阶段和错误", async () => {
  const fixture = await tempFixture("console-tasks-events-");
  try {
    const store = new TaskStore(fixture.root), { id } = store.create(input(fixture.root), "events");
    store.accept(id, actor);
    const log = store.eventWriter(id);
    log("output", "中文 token=very-secret 13800138000\nsecond");
    expect(store.events(id).map(event => event.text)).toEqual(["中文 token=*** 138****8000", "second"]);
    expect(store.events(id, 1).map(event => event.seq)).toEqual([2]);
    for (let i = 0; i < 300; i++) log("output", "x".repeat(8192));
    log("phase", "完成动作"); log("error", "恢复未就绪");
    const events = store.events(id);
    expect(events.filter(event => event.kind === "truncated").length).toBe(1);
    expect(events.slice(-2).map(event => event.text)).toEqual(["完成动作", "恢复未就绪"]);
    expect(statSync(join(store.dir(id), "events.jsonl")).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    const tail = events.at(-1)!.seq;
    expect(store.events(id, tail)).toEqual([]);
    expect(readFileSync(join(store.dir(id), "events.jsonl"), "utf8")).not.toContain("very-secret");
    writeFileSync(join(store.dir(id), "events.jsonl"), '{"seq":1');
    expect(store.events(id)).toEqual([]);
    writeFileSync(join(store.dir(id), "events.jsonl"), '{"seq":1}\n');
    expect(() => store.events(id)).toThrow("损坏");
  } finally { await fixture.cleanup(); }
});

test("清理仅删结束超过 30 天且不在最近 50 个中的任务，键保留防止重放", async () => {
  const fixture = await tempFixture("console-tasks-prune-");
  try {
    let at = 1000;
    const store = new TaskStore(fixture.root, () => at), ids: string[] = [];
    for (let i = 0; i < 54; i++) {
      const { id } = store.create(input(fixture.root), `old-${i}`);
      ids.push(id); store.accept(id, actor);
      if (i === 2) store.finish(id, { outcome: "failed", exitCode: 1, finalState: "unknown", message: "失败", leftRecovery: true });
      else if (i !== 1) store.finish(id, done);
      at++;
    }
    at += 31 * 86_400_000;
    const recovery: TaskObservers = { ...observers, needsRecovery: async request => request.id === ids[2] };
    const removed = await store.prune(recovery);
    expect(removed.sort()).toEqual([ids[0]!, ids[3]!].sort());
    expect(existsSync(store.dir(ids[1]!))).toBe(true); // running
    expect(existsSync(store.dir(ids[2]!))).toBe(true); // recovery
    expect(existsSync(store.dir(ids[4]!))).toBe(true); // recent 50
    expect(() => store.create(input(fixture.root), "old-0")).toThrow("缺失");
  } finally { await fixture.cleanup(); }
});

test("目录不可写时提交失败；日志和结果写失败后状态不是成功", async () => {
  const fixture = await tempFixture("console-tasks-disk-");
  try {
    const store = new TaskStore(fixture.root), { id } = store.create(input(fixture.root), "disk");
    store.accept(id, actor);
    // A directory in place of a file reliably rejects writes on both NTFS and POSIX (also for root).
    mkdirSync(join(store.dir(id), "events.jsonl"));
    expect(() => store.eventWriter(id)).toThrow();
    mkdirSync(join(store.dir(id), "result.json"));
    expect(() => store.finish(id, done)).toThrow();
    expect((await store.view(id, { ...observers, hosting: async () => ({ state: "ended" }) })).state).toBe("unknown");
    const keys = join(store.root, "keys");
    rmSync(keys, { recursive: true });
    writeFileSync(keys, "blocks directory access");
    expect(() => store.create(input(fixture.root), "cannot-write")).toThrow();
  } finally { await fixture.cleanup(); }
});

test.skipIf(process.platform === "win32" || process.geteuid?.() === 0)("POSIX 只读目录模拟写满：没有接单、没有成功结果", async () => {
  const fixture = await tempFixture("console-tasks-readonly-");
  const store = new TaskStore(fixture.root), { id } = store.create(input(fixture.root), "readonly");
  const dir = store.dir(id);
  try {
    chmodSync(dir, 0o500);
    expect(() => store.accept(id, actor)).toThrow();
    expect(existsSync(join(dir, "claim"))).toBe(false);
    expect((await store.view(id, observers)).state).not.toBe("succeeded");
  } finally { chmodSync(dir, 0o700); await fixture.cleanup(); }
});
