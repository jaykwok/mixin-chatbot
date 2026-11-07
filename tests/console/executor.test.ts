import { expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeTask } from "../../console/server/executor.ts";
import { operationArgs, operationCommand, operationObserver } from "../../ops/core/operations.ts";
import { PlanStore } from "../../ops/core/plans.ts";
import type { PlanFacts } from "../../ops/core/plans.ts";
import { buildExecutor, executorIdentity, hostedTask, launchTask, reconcileTasks, verifyExecutor } from "../../console/server/task-host.ts";
import { TaskStore } from "../../ops/core/tasks.ts";
import type { TaskRequest } from "../../ops/core/tasks.ts";
import { tempFixture } from "../helpers/temp.ts";

const actor = { pid: 1234, startedAt: "fixture" };
const observers = { hosting: async () => ({ state: "ended" as const }), needsRecovery: async () => false };
const project = resolve(import.meta.dir, "../..");
const input = (root: string): Omit<TaskRequest, "version" | "id" | "createdAt" | "acceptBy"> => ({ project: root,
  mechanism: process.platform === "win32" ? "windows-task" : "systemd-system", planId: "fixture", operation: "stop", params: {} });

test("完整执行器并发排空中文 stdout/stderr，仅完整结果与退出码一致才成功", async () => {
  const fixture = await tempFixture("console-executor-");
  try {
    const store = new TaskStore(join(fixture.root, ".console"));
    for (const mode of ["ok", "missing", "contradictory"]) {
      const { id } = store.create(input(fixture.root), mode);
      let checked = false, cleaned = false;
      const code = await executeTask(store, id, { identity: actor, verify: async () => { checked = true; },
        command: () => {
          expect(checked).toBe(true);
          return { command: process.execPath, args: [join(project, "tests/helpers/console-ops-fixture.ts"), mode] };
        }, cleanup: async () => { cleaned = true; }, needsRecovery: async () => true });
      const view = await store.view(id, observers);
      expect(view.state).toBe(mode === "ok" ? "succeeded" : "failed");
      // Only a failure records what the executor saw; the view still asks whether that state is unfinished now.
      expect(view.result?.leftRecovery).toBe(mode === "ok" ? undefined : true);
      expect((await store.view(id, { ...observers, needsRecovery: async () => true })).needsRecovery).toBe(mode !== "ok");
      expect(code === 0).toBe(mode === "ok");
      expect(cleaned).toBe(true);
      expect(existsSync(join(store.dir(id), "heartbeat"))).toBe(true);
      const logs = readFileSync(join(store.dir(id), "events.jsonl"), "utf8");
      expect(logs).toContain("中文诊断 159");
      const kinds = Object.fromEntries(logs.trim().split("\n").map(line => JSON.parse(line)).map(event => [event.text.split(" ")[0], event.kind]));
      expect([kinds["中文诊断"], kinds["部署阶段：forward/stop"]]).toEqual(["error", "output"]);
      expect(logs).not.toContain("do-not-persist");
      expect(logs).not.toContain("13800138000");
    }
  } finally { await fixture.cleanup(); }
}, 60_000);

test("计划失效和接单超时不启动命令；日志不能写入时不算成功", async () => {
  const fixture = await tempFixture("console-executor-refused-");
  try {
    let at = 1000, called = false;
    const store = new TaskStore(fixture.root, () => at), { id } = store.create(input(fixture.root), "expired");
    const deps = { identity: actor, verify: async () => {}, command: () => { called = true; throw new Error("must not run"); } };
    at += 20_000;
    expect(await executeTask(store, id, deps)).toBe(1);
    expect(called).toBe(false);
    expect((await store.view(id, observers)).state).toBe("not-accepted");
    const bad = store.create(input(fixture.root), "changed");
    expect(await executeTask(store, bad.id, { ...deps, verify: async () => { throw new Error("范围已变化"); } })).toBe(1);
    expect(called).toBe(false);
    expect((await store.view(bad.id, observers)).state).toBe("failed");
    const log = store.create(input(fixture.root), "unwritable");
    writeFileSync(join(store.dir(log.id), "events.jsonl"), "broken\n");
    expect(await executeTask(store, log.id, deps)).toBe(1);
    expect(called).toBe(false);
    expect((await store.view(log.id, observers)).state).toBe("failed");
  } finally { await fixture.cleanup(); }
});

test("计划绑定身份、代码、范围和状态，有效期内复核两次；未知参数拒绝", async () => {
  const fixture = await tempFixture("console-plans-");
  try {
    let at = 1000;
    let facts: PlanFacts = { project: fixture.root, platform: process.platform, identity: "fixture", head: "a".repeat(40), protocol: 1, scope: "first", runState: "stopped" };
    const store = new PlanStore(fixture.root, async () => ({ facts, summary: ["停止机器人"] }), () => at);
    const plan = await store.create("stop", {});
    expect((await store.verify(plan.id)).id).toBe(plan.id);
    for (const key of ["identity", "head", "scope", "runState"] as const) {
      const previous = facts; facts = { ...facts, [key]: "changed" };
      expect(store.verify(plan.id)).rejects.toThrow("已变化"); facts = previous;
    }
    at += 600_000;
    expect(store.verify(plan.id)).rejects.toThrow("过期");
    expect(() => operationArgs("sh", {})).toThrow("不支持");
    expect(() => operationArgs("stop", { args: ["; echo bad"] })).toThrow("未允许");
    const command = operationCommand(fixture.root, "stop", {});
    expect(command.env.MIXIN_OPS_PROJECT).toBe(fixture.root);
    expect(command.env.MIXIN_OPS_EXPECT_CODE).toMatch(/^[a-f0-9]{64}$/);
    expect(command.args.join(" ")).toContain(project);
  } finally { await fixture.cleanup(); }
});

test("固定版本运行包可单独执行，不随源码改变；摘要错误时不启动托管", async () => {
  const fixture = await tempFixture("console-runtime-");
  try {
    const dir = join(fixture.root, ".console"), bundle = await buildExecutor(dir, project);
    expect(() => verifyExecutor(bundle)).not.toThrow();
    const child = Bun.spawn([process.execPath, bundle.path], { cwd: fixture.root, stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect(code).toBe(1); expect(stderr).toContain("需要 --project");
    const store = new TaskStore(dir), { id } = store.create(input(fixture.root), "bad-runtime");
    appendFileSync(bundle.path, "\n// changed");
    let launched = false;
    await expect(launchTask(store, id, bundle, async () => { launched = true; return { code: 0, stdout: "", stderr: "" }; })).rejects.toThrow("摘要");
    expect(launched).toBe(false);
  } finally { await fixture.cleanup(); }
}, 60_000);

test.skipIf(process.platform === "win32")("后台任务沿用控制台的 Docker 端点、上下文和配置目录", async () => {
  const fixture = await tempFixture("console-docker-env-");
  const saved = { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, DOCKER_CONFIG: process.env.DOCKER_CONFIG };
  try {
    process.env.DOCKER_CONTEXT = "fixture-context"; process.env.DOCKER_CONFIG = "/srv/fixture-docker";
    const dir = join(fixture.root, ".console"), bundle = await buildExecutor(dir, project), store = new TaskStore(dir), { id } = store.create(input(fixture.root), "docker-env");
    let argv: string[] = [];
    await launchTask(store, id, bundle, async args => { argv = args; writeFileSync(join(store.dir(id), "claim"), "fixture"); return { code: 0, stdout: "", stderr: "" }; });
    expect(argv).toContain("--setenv=DOCKER_CONTEXT=fixture-context"); expect(argv).toContain("--setenv=DOCKER_CONFIG=/srv/fixture-docker");
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await fixture.cleanup();
  }
}, 60_000);

test.skipIf(process.platform !== "linux")("启停计划绑定容器 ID：重建的容器或另一个 daemon 上的同名容器都算变化", async () => {
  let listing = "";
  const run = async (args: string[]) => args[0] === "git" ? { code: 0, stdout: "c".repeat(40) + "\n", stderr: "" }
    : args[0] === "docker" && args[1] === "ps" ? { code: 0, stdout: listing, stderr: "" } : { code: 1, stdout: "", stderr: "unexpected" };
  const observe = operationObserver(project, run);
  listing = `${"a".repeat(64)} running\n`;
  const first = await observe("stop", {});
  expect(first.facts).toMatchObject({ container: "a".repeat(64), runState: "running" });
  listing = `${"b".repeat(64)} running\n`;
  expect((await observe("stop", {})).facts.container).toBe("b".repeat(64));
  listing = "";
  const absent = await observe("start", {});
  expect(absent.facts.runState).toBe("absent"); expect("container" in absent.facts).toBe(false);
  listing = `${"a".repeat(64)} running\n${"b".repeat(64)} exited\n`;
  await expect(observe("stop", {})).rejects.toThrow("不唯一");
});

test("宿主查询使用创建时间，残留清理不删除陌生或其他项目的托管项", async () => {
  const fixture = await tempFixture("console-host-query-");
  try {
    expect((await executorIdentity()).pid).toBe(process.pid);
    const store = new TaskStore(join(fixture.root, ".console")), { id } = store.create(input(fixture.root), "host");
    store.accept(id, actor); store.finish(id, { outcome: "success", exitCode: 0, finalState: "stopped", message: "done" });
    const request = store.request(id), calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const source = args.join(" ");
      if (source.includes("list-units") || source.includes("ForEach-Object")) return { code: 0,
        stdout: `mixin-console-${id}${process.platform === "win32" ? "" : ".service loaded inactive dead"}\nmixin-console-probe-foreign\nmixin-console-task-${"f".repeat(32)}`, stderr: "" };
      return { code: 0, stdout: process.platform === "win32" ? "Ready" : "ActiveState=inactive\nMainPID=0", stderr: "" };
    };
    expect((await hostedTask(request, actor, run)).state).toBe("ended");
    expect(await reconcileTasks(store, request.mechanism, run)).toEqual([id]);
    expect(calls.some(args => args.join(" ").includes("foreign") && !args.join(" ").includes("ForEach"))).toBe(false);
  } finally { await fixture.cleanup(); }
});
