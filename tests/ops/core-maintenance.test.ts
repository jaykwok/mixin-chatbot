import { expect, test } from "bun:test";
import { runMaintenance, MaintenanceRefused, type MaintenanceHost, type MaintenanceWork, type ServiceFacts,
  type MaintenanceCheckpoint } from "../../ops/core/maintenance.ts";
import { readOpsResult, type OpsResult } from "../../ops/core/result.ts";

const request = { id: "fixture", runtime: "a".repeat(64), command: "configuration-apply", intent: "configuration" as const, label: "应用配置" };
function fixture() {
  const facts: ServiceFacts = { identity: "fixture-container", state: "running", ready: true, owned: true, pending: false };
  const events: string[] = [], checkpoints: MaintenanceCheckpoint[] = [];
  const controller = new AbortController(); let locked = false, published: OpsResult | undefined;
  const host: MaintenanceHost = {
    async locked(body) { events.push("lock"); locked = true; try { return await body(); } finally { locked = false; events.push("unlock"); } },
    async verify() { expect(locked).toBe(true); events.push("verify"); },
    async inspect() { expect(locked).toBe(true); return { ...facts }; },
    async assess(intent) { expect(locked).toBe(true); events.push("assess:" + intent); },
    async save(value) { expect(locked).toBe(true); checkpoints.push(value); },
    async stop() { expect(checkpoints.at(-1)?.phase).toBe("stopping"); events.push("stop"); facts.state = "stopped"; facts.ready = false; },
    async start() { expect(checkpoints.at(-1)?.phase).toBe("starting"); events.push("start"); facts.state = "running"; },
    async waitReady() { events.push("ready"); facts.ready = true; return true; },
    async finish(result) { expect(locked).toBe(true); events.push("finish"); published = result; },
  };
  const work: MaintenanceWork = {
    async prepare() { events.push("prepare"); },
    async run() { expect(facts.state).not.toBe("running"); expect(checkpoints.at(-1)?.phase).toBe("acting"); events.push("action"); return 0; },
    async recover() { expect(facts.state).not.toBe("running"); expect(checkpoints.at(-1)?.phase).toBe("recovering"); events.push("recover"); },
    async complete() { expect(checkpoints.at(-1)?.phase).toBe("completing"); events.push("complete"); },
  };
  return { facts, events, checkpoints, host, work, controller, published: () => published,
    run: () => runMaintenance(request, host, work, controller.signal) };
}

test("共用维护核心：同一锁内预检、停机、执行、重新判断磁盘状态、就绪、收尾和发布", async () => {
  const f = fixture(), result = await f.run();
  expect(result).toMatchObject({ outcome: "success", wasRunning: true, finalState: "running", exitCode: 0 });
  expect(f.events).toEqual(["lock", "verify", "prepare", "assess:configuration", "stop", "action", "assess:service", "start", "ready", "complete", "finish", "unlock"]);
  expect(f.published()).toEqual(result);
  expect(f.checkpoints.map(value => value.phase)).toEqual(["prepared", "stopping", "acting", "starting", "completing"]);
  expect(f.checkpoints.every(value => value.request.runtime === request.runtime && value.original.state === "running")).toBe(true);
});

test.each(["stopped", "absent"] as const)("共用维护核心：原来 %s 时不擅自启动", async state => {
  const f = fixture(); f.facts.state = state; f.facts.ready = false;
  expect(await f.run()).toMatchObject({ outcome: "success", wasRunning: false, finalState: "stopped" });
  expect(f.events).toEqual(["lock", "verify", "prepare", "action", "complete", "finish", "unlock"]);
});

test("共用维护核心：锁、未完成事务、陌生身份、前台/异常状态和预检改变均在数据写入前拒绝", async () => {
  for (const mode of ["locked", "pending", "foreign", "unsupported", "verify", "prepare", "changed", "intent"]) {
    const f = fixture();
    if (mode === "locked") f.host.locked = async () => { throw new MaintenanceRefused("锁已占用"); };
    if (mode === "pending") f.facts.pending = true;
    if (mode === "foreign") f.facts.owned = false;
    if (mode === "unsupported") f.facts.state = "unsupported";
    if (mode === "verify") f.host.verify = async () => { throw new MaintenanceRefused("计划已变化"); };
    if (mode === "prepare") f.work.prepare = async () => { throw new MaintenanceRefused("草稿无效"); };
    if (mode === "changed") f.work.prepare = async () => { f.facts.state = "stopped"; };
    if (mode === "intent") f.host.assess = async () => { throw new MaintenanceRefused("维护状态不允许"); };
    expect((await f.run()).outcome, mode).toBe("refused");
    expect(f.events.some(event => ["stop", "start", "action", "recover", "complete"].includes(event)), mode).toBe(false);
  }
});

test("共用维护核心：改动之前的拒绝保留自己的原因，最终状态读不到也不改成失败", async () => {
  const foreign = fixture(); foreign.facts.owned = false;
  expect(await foreign.run()).toMatchObject({ outcome: "refused", exitCode: 1, finalState: "unknown", message: "实例不属于当前部署或运行方式不支持自动恢复" });
  const unreadable = fixture();
  unreadable.host.verify = async () => { throw new MaintenanceRefused("计划已变化"); };
  unreadable.host.inspect = async () => { throw new Error("fixture: inspect failed"); };
  expect(await unreadable.run()).toMatchObject({ outcome: "refused", exitCode: 1, finalState: "unknown", message: "计划已变化" });
});

test("共用维护核心：动作失败后先恢复旧配置再恢复运行，保留原失败退出码", async () => {
  const f = fixture(); f.work.run = async () => { f.events.push("action"); return 3; };
  expect(await f.run()).toMatchObject({ outcome: "failed", exitCode: 3, finalState: "running" });
  expect(f.events).toEqual(["lock", "verify", "prepare", "assess:configuration", "stop", "action", "recover", "assess:service", "start", "ready", "complete", "finish", "unlock"]);
});

test("共用维护核心：新配置未就绪时先停新实例再回退，即使恢复运行仍报告本次失败", async () => {
  const f = fixture(); let waits = 0;
  f.host.waitReady = async () => { f.events.push("ready"); f.facts.ready = ++waits > 1; return f.facts.ready; };
  expect(await f.run()).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "running" });
  expect(f.events).toEqual(["lock", "verify", "prepare", "assess:configuration", "stop", "action", "assess:service", "start", "ready", "stop", "recover", "assess:service", "start", "ready", "complete", "finish", "unlock"]);
});

test("共用维护核心：新实例就绪但变更未生效（凭据连不上）同样回退；回退后的启动不再要求生效证明", async () => {
  const f = fixture();
  f.work.started = async () => { f.events.push("started"); throw new Error("新应用凭据启动后没有连上事件 Stream；恢复原配置"); };
  expect(await f.run()).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "running", message: "新应用凭据启动后没有连上事件 Stream；恢复原配置" });
  expect(f.events).toEqual(["lock", "verify", "prepare", "assess:configuration", "stop", "action", "assess:service", "start", "ready", "started", "stop", "recover", "assess:service", "start", "ready", "complete", "finish", "unlock"]);
  const failed = fixture(); failed.work.started = async () => { failed.events.push("started"); };
  failed.work.run = async () => { failed.events.push("action"); return 1; };
  await failed.run();
  expect(failed.events).not.toContain("started");
});

test("共用维护核心：磁盘阻止启动、恢复失败或实例被替换时不会用动作成功来放行", async () => {
  for (const mode of ["blocked", "recovery", "replaced", "unreadable"] as const) {
    const f = fixture();
    f.work.run = async () => {
      f.events.push("action");
      if (mode === "replaced") f.facts.identity = "another-container";
      if (mode === "unreadable") f.host.inspect = async () => { throw new Error("状态无法读取"); };
      return mode === "recovery" ? 2 : 0;
    };
    if (mode === "blocked") { delete f.work.recover; f.host.assess = async intent => { if (intent === "service") throw new MaintenanceRefused("收缩未收尾"); }; }
    if (mode === "recovery") f.work.recover = async () => { f.events.push("recover"); throw new Error("备份校验失败"); };
    const result = await f.run();
    expect(result.outcome, mode).toBe("failed"); expect(result.exitCode).not.toBe(0);
    expect(f.events).not.toContain("start"); expect(f.events).not.toContain("complete");
    expect(result.finalState).toBe(mode === "replaced" || mode === "unreadable" ? "unknown" : "stopped");
  }
});

test("共用维护核心：停止失败/未停止不运行数据步骤；仍按当前磁盘状态尝试恢复原运行状态", async () => {
  const f = fixture(); f.host.stop = async () => { f.events.push("stop"); }; // successful request, still running
  const result = await f.run();
  expect(result).toMatchObject({ outcome: "failed", finalState: "running" });
  expect(f.events).not.toContain("action"); expect(f.events).not.toContain("recover");
  expect(f.events).toContain("assess:service");
});

test("共用维护核心：取消在动作前阻止写入，在动作后仍完成受保护的回退和恢复", async () => {
  for (const mode of ["before", "after-stop", "after-action"] as const) {
    const f = fixture();
    if (mode === "before") f.controller.abort();
    if (mode === "after-stop") { const original = f.host.stop; f.host.stop = async () => { await original(); f.controller.abort(); }; }
    if (mode === "after-action") { const original = f.work.run; f.work.run = async () => { await original(); f.controller.abort(); return 0; }; }
    expect(await f.run()).toMatchObject({ exitCode: 130, outcome: "failed", finalState: "running" });
    expect(f.events.includes("action")).toBe(mode === "after-action");
    expect(f.events.includes("recover")).toBe(mode === "after-action");
    expect(f.events.includes("start")).toBe(mode !== "before");
  }
});

test("共用维护核心：阶段不能落盘就不执行对应写入，收尾或结果写入失败不报成功", async () => {
  for (const mode of ["stopping", "acting", "complete", "finish"] as const) {
    const f = fixture();
    if (mode === "stopping" || mode === "acting") {
      const original = f.host.save;
      f.host.save = async value => { if (value.phase === mode) throw new Error("磁盘满"); await original(value); };
    }
    if (mode === "complete") f.work.complete = async () => { throw new Error("清理恢复材料失败"); };
    if (mode === "finish") f.host.finish = async () => { throw new Error("结果不能落盘"); };
    const result = await f.run();
    expect(result.outcome, mode).toBe("failed"); expect(result.exitCode).not.toBe(0);
    if (mode === "stopping") expect(f.events).not.toContain("stop");
    if (mode === "stopping" || mode === "acting") expect(f.events).not.toContain("action");
    if (mode === "finish") expect(f.published()).toBeUndefined();
  }
});

test("共用结果协议：未知版本、不同动作、不完整值和矛盾退出码均拒绝，不猜测成功", () => {
  const good: OpsResult = { protocol: "mixin-ops", version: 1, command: "stop", outcome: "success", wasRunning: true, finalState: "stopped", exitCode: 0, message: "已停止" };
  expect(readOpsResult(good, "stop", 0)).toEqual(good);
  for (const bad of [null, [], {}, { ...good, version: 2 }, { ...good, command: "start" }, { ...good, wasRunning: 1 },
    { ...good, finalState: "ready" }, { ...good, message: null }, { ...good, outcome: "ok" }, { ...good, exitCode: 1 }]) expect(readOpsResult(bad, "stop", 0)).toBeNull();
  expect(readOpsResult({ ...good, exitCode: 1 }, "stop", 1)).toBeNull();
  expect(readOpsResult({ ...good, outcome: "failed", exitCode: 3 }, "stop", 3)?.outcome).toBe("failed");
  expect(readOpsResult({ ...good, outcome: "failed", exitCode: 3 }, "stop", 0)).toBeNull();
});
