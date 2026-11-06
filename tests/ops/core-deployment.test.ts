import { expect, test } from "bun:test";
import { runDeployment, type DeploymentCheckpoint, type DeploymentDirection, type DeploymentHost, type DeploymentRequest,
  type DeploymentService } from "../../ops/core/deployment.ts";
import type { DeploymentState } from "../../ops/core/deployment-state.ts";
import type { TransactionRecord } from "../../ops/core/transaction-record.ts";
import type { OpsResult } from "../../ops/core/result.ts";
import { MaintenanceRefused } from "../../ops/core/maintenance.ts";

function fixture(operation: "deploy" | "upgrade" = "upgrade", wasRunning = true) {
  const record: TransactionRecord = { format: "2", operation, snapshot: "deploy-synthetic", target_sha: "a".repeat(40), original_sha: "b".repeat(40),
    original_branch: "main", original_workspace_root: "", target_workspace_root: "", was_running: wasRunning ? "1" : "0", bot_port: "2022", reconfigure_ai: "0" };
  const request: DeploymentRequest = { command: operation === "upgrade" ? "update" : "deploy", action: "continue", snapshot: record.snapshot, runtime: "c".repeat(64) };
  const facts: DeploymentService = { state: wasRunning ? "running" : "stopped", ready: wasRunning, role: "original", owned: true };
  let phase: DeploymentState["dataPhase"] = "unprepared", saved: DeploymentCheckpoint | null = null, locked = false;
  const events: string[] = [], checkpoints: DeploymentCheckpoint[] = [], controller = new AbortController();
  let published: OpsResult | undefined, completed: DeploymentDirection | undefined;
  const host: DeploymentHost = {
    async locked(body) { expect(locked).toBe(false); locked = true; try { return await body(); } finally { locked = false; } },
    async verify() { expect(locked).toBe(true); events.push("verify"); },
    async state() { expect(locked).toBe(true); return { confirmation: { operation, id: record.snapshot, digest: "d".repeat(64), text: () => null },
      snapshot: record.snapshot, operation, record: { ...record }, targetSha: record.target_sha, dataPhase: phase,
      committed: phase === "committed" }; },
    async checkpoint() { expect(locked).toBe(true); return saved; },
    async save(value) { expect(locked).toBe(true); saved = structuredClone(value); checkpoints.push(saved); },
    async reap() { expect(locked).toBe(true); events.push("reap"); },
    async inspect() { expect(locked).toBe(true); return { ...facts }; },
    async preflight(direction, signal) { expect(locked).toBe(true); expect(signal?.aborted).not.toBe(true); events.push("preflight:" + direction); },
    async perform(name, signal) {
      expect(locked).toBe(true); expect(signal?.aborted).not.toBe(true); expect(saved?.step).toBe(name); events.push(name);
      if (["prepare-data", "commit-data", "restore-data", "restore-configuration"].includes(name))
        expect(facts.state, name).not.toBe("running");
      if (name === "stop") { facts.state = facts.role === "absent" ? "absent" : "stopped"; facts.ready = false; }
      if (name === "prepare-data") phase = "prepared";
      if (name === "commit-data") phase = "committed";
      if (name === "install-candidate") { facts.role = "candidate"; facts.state = "stopped"; facts.ready = false; }
      if (["start-verification", "start-candidate", "start-original"].includes(name)) { facts.state = "running"; facts.ready = false; }
      if (name === "restore-data") phase = "unprepared";
      if (name === "restore-service") { facts.role = "original"; facts.state = "stopped"; facts.ready = false; }
    },
    async assess(intent) { expect(locked).toBe(true); events.push("assess:" + intent); },
    async waitReady(role) { expect(locked).toBe(true); events.push("ready:" + role); facts.ready = true; return true; },
    notice(message) { expect(locked).toBe(true); events.push("notice:" + message); },
    async finish(result, direction) { expect(locked).toBe(true); published = structuredClone(result); completed = direction; },
  };
  return { host, request, record, facts, events, checkpoints, controller,
    phase(value: DeploymentState["dataPhase"]) { phase = value; }, saved(value: DeploymentCheckpoint | null) { saved = value; },
    completed: () => completed, published: () => published,
    run: () => runDeployment(request, host, controller.signal) };
}

test("部署核心先验证后提交，再启动正式实例；升级保持原停止状态，重新部署总是启动", async () => {
  for (const operation of ["deploy", "upgrade"] as const) for (const running of [true, false]) {
    const f = fixture(operation, running), result = await f.run();
    expect(result).toMatchObject({ outcome: "success", exitCode: 0, finalState: operation === "deploy" || running ? "running" : "stopped" });
    expect(f.published()).toEqual(result); expect(f.completed()).toBe("forward");
    for (const [before, after] of [["prepare-data", "start-verification"],
      ["ready:verification", "commit-data"], ["commit-data", "retire-previous-writers"], ["retire-previous-writers", "publish-target"]]) {
      expect(f.events.indexOf(before!)).toBeLessThan(f.events.indexOf(after!));
    }
    expect(f.events.filter(value => value === "start-candidate").length).toBe(operation === "deploy" || running ? 1 : 0);
    expect(f.events.some(value => value.startsWith("restore-"))).toBe(false);
    expect(f.checkpoints.every(value => value.runtime === f.request.runtime && value.snapshot === f.request.snapshot)).toBe(true);
  }
});

test("强杀后先回收写入者再判定提交；已提交续做不重复安装、配置或数据准备", async () => {
  const f = fixture(); f.request.command = "resume"; f.facts.role = "candidate"; f.facts.state = "stopped"; f.facts.ready = false;
  f.phase("prepared"); f.saved({ version: 1, snapshot: f.request.snapshot, runtime: f.request.runtime, direction: "forward", step: "commit-data" });
  f.host.reap = async () => { f.events.push("reap"); f.phase("committed"); };
  expect(await f.run()).toMatchObject({ outcome: "success", finalState: "running" });
  expect(f.events.indexOf("reap")).toBeLessThan(f.events.indexOf("preflight:forward"));
  for (const name of ["switch-code", "prepare-dependencies", "prepare-data", "install-candidate", "commit-data", "restore-data"])
    expect(f.events).not.toContain(name);
});

test("提交回执未知、损坏或提交后丢失答复均不回退数据；报告失败并保留事务", async () => {
  for (const mode of ["committed-reply-lost", "unreadable-receipt", "no-receipt"] as const) {
    const f = fixture(), perform = f.host.perform;
    f.host.perform = async (name, signal) => {
      if (name !== "commit-data") return perform(name, signal);
      if (mode !== "no-receipt") await perform(name, signal);
      if (mode === "unreadable-receipt") f.host.state = async () => { throw new Error("发布状态无法读取"); };
      if (mode !== "no-receipt") throw new Error("提交答复中断");
    };
    expect((await f.run()).outcome, mode).toBe("failed");
    if (mode === "no-receipt") {
      expect(f.completed()).toBe("rollback"); expect(f.events).toContain("restore-data");
    } else {
      expect(f.completed()).toBeUndefined(); expect(f.events).not.toContain("restore-data"); expect(f.events).not.toContain("restore-code");
    }
  }
});

test("验证未通过、提交前步骤失败和普通取消均恢复原状态；成功回滚仍报告原任务失败", async () => {
  for (const mode of ["configure-directory", "prepare-data", "verification", "commit-assessment", "cancel"]) {
    const f = fixture(), perform = f.host.perform;
    f.host.perform = async (name, signal) => {
      await perform(name, signal);
      if (name === mode) throw new MaintenanceRefused("步骤失败", 3);
      if (mode === "cancel" && name === "prepare-data") f.controller.abort();
    };
    if (mode === "verification") {
      const wait = f.host.waitReady; f.host.waitReady = async (role, signal) => role === "verification" ? false : wait(role, signal);
    }
    if (mode === "commit-assessment") f.host.assess = async intent => { if (intent === "commit") throw new Error("维护状态阻止提交"); };
    const result = await f.run();
    expect(result.outcome, mode).toBe("failed"); expect(result.exitCode).not.toBe(0); expect(result.finalState).toBe("running");
    expect(f.completed()).toBe("rollback");
    expect(f.events.indexOf("restore-data")).toBeLessThan(f.events.indexOf("restore-code"));
    expect(f.events.indexOf("restore-code")).toBeLessThan(f.events.indexOf("start-original"));
    expect(f.events).not.toContain("publish-target");
    if (mode === "cancel") expect(result.exitCode).toBe(130);
    // The cause is announced once, before the first restoration step.
    const notices = f.events.filter(value => value.startsWith("notice:")), restore = f.events.indexOf("restore-data");
    expect(notices, mode).toEqual(["notice:" + result.message.replace(/；已自动恢复到操作前的状态$/, "") + "；正在自动恢复到操作前的状态"]);
    expect(f.events.indexOf(notices[0]!)).toBeLessThan(f.events.lastIndexOf("stop", restore));
  }
});

test("提交后撤销旧写者、启动、就绪或发布失败，只保留新版本供续做", async () => {
  for (const mode of ["retire-previous-writers", "start-candidate", "ready", "publish-target"]) {
    const f = fixture(), perform = f.host.perform;
    f.host.perform = async (name, signal) => { await perform(name, signal); if (name === mode) throw new Error("提交后故障"); };
    if (mode === "ready") { const wait = f.host.waitReady; f.host.waitReady = async (role, signal) => role === "candidate" ? false : wait(role, signal); }
    expect((await f.run()).outcome, mode).toBe("failed"); expect(f.completed()).toBeUndefined();
    expect(f.events).not.toContain("restore-data"); expect(f.events).not.toContain("restore-code"); expect(f.events).not.toContain("start-original");
  }
});

test("显式回滚在改动前拒绝已提交、冲突或未知记录；开始回滚的事务不能再次继续发布", async () => {
  for (const mode of ["committed", "conflict", "unknown", "runtime", "already-rolling-back"]) {
    const f = fixture(); f.request.action = "rollback"; f.request.command = "rollback";
    if (mode === "committed") f.phase("committed");
    if (mode === "conflict") f.host.preflight = async () => { throw new MaintenanceRefused("恢复代码会覆盖外来改动"); };
    if (mode === "unknown") f.host.state = async () => { throw new Error("状态格式不支持"); };
    if (mode === "runtime") f.saved({ version: 1, snapshot: f.request.snapshot, runtime: "e".repeat(64), direction: "forward", step: "commit-data" });
    if (mode === "already-rolling-back") {
      f.request.action = "continue"; f.request.command = "resume";
      f.saved({ version: 1, snapshot: f.request.snapshot, runtime: f.request.runtime, direction: "rollback", step: "restore-data" });
    }
    expect((await f.run()).exitCode, mode).not.toBe(0); expect(f.checkpoints).toEqual([]); expect(f.completed()).toBeUndefined();
    expect(f.events).not.toContain("stop"); expect(f.events).not.toContain("prepare-data"); expect(f.events).not.toContain("restore-data");
  }
});

test("续做在本次第一个步骤之前被预检拒绝（例如已跟踪文件被改动）时不自动回滚，事务停在上次的阶段，修正后可再续做", async () => {
  const f = fixture(); f.request.command = "resume"; f.facts.state = "stopped"; f.facts.ready = false;
  f.saved({ version: 1, snapshot: f.request.snapshot, runtime: f.request.runtime, direction: "forward", step: "switch-code" });
  let refusing = true;
  const preflight = f.host.preflight;
  f.host.preflight = async (direction, signal) => {
    if (refusing && direction === "forward") throw new MaintenanceRefused("切换代码会覆盖未提交的改动");
    return preflight(direction, signal);
  };
  const refused = await f.run();
  expect(refused).toMatchObject({ outcome: "failed", exitCode: 1, finalState: "stopped", message: "切换代码会覆盖未提交的改动" });
  expect(f.checkpoints).toEqual([]); expect(f.completed()).toBeUndefined();
  expect(f.events).toEqual(["verify", "reap"]);
  refusing = false;
  expect(await f.run()).toMatchObject({ outcome: "success", exitCode: 0, finalState: "running" });
  expect(f.events.some(value => value.startsWith("restore-"))).toBe(false); expect(f.completed()).toBe("forward");
});

test("自动恢复遇到并发代码改动先恢复本次数据，代码预检仍在恢复代码和启动原实例之前", async () => {
  const f = fixture(), perform = f.host.perform, preflight = f.host.preflight;
  f.host.perform = async (step, signal) => { await perform(step, signal); if (step === "prepare-data") throw new Error("准备数据失败"); };
  f.host.preflight = async (direction, signal) => {
    await preflight(direction, signal); if (direction === "rollback") throw new MaintenanceRefused("操作员修改了代码，不能覆盖");
  };
  const result = await f.run(); expect(result.exitCode).toBe(1); expect(result.message).toContain("不能覆盖");
  expect(f.events.indexOf("preflight:rollback")).toBeGreaterThan(f.events.indexOf("restore-data"));
  for (const event of ["restore-code", "restore-configuration", "restore-service", "start-original"]) expect(f.events).not.toContain(event);
  expect(f.facts.state).toBe("stopped"); expect(f.completed()).toBeUndefined();
});

test("无法回收写入者、停止失败或恢复失败时不启动旧服务，也不清掉事务", async () => {
  for (const mode of ["writer", "stop", "restore-data", "restore-code", "restore-service"]) {
    const f = fixture(); f.request.action = "rollback"; f.request.command = "rollback"; f.phase("prepared");
    f.saved({ version: 1, snapshot: f.request.snapshot, runtime: f.request.runtime, direction: "forward", step: "prepare-data" });
    const perform = f.host.perform;
    if (mode === "writer") f.host.reap = async () => { f.events.push("reap-failed"); throw new Error("写入者仍在运行"); };
    f.host.perform = async (name, signal) => { if (name === mode) throw new Error("恢复步骤失败"); await perform(name, signal); };
    expect((await f.run()).outcome, mode).toBe("failed"); expect(f.completed()).toBeUndefined(); expect(f.events).not.toContain("start-original");
    if (mode === "writer") { expect(f.checkpoints).toEqual([]); expect(f.events.filter(value => value === "reap-failed")).toHaveLength(1); }
    if (mode === "stop") expect(f.events).not.toContain("restore-data");
  }
});

test("首次阶段落盘失败不执行效果；最终状态或结果落盘失败不能宣布成功", async () => {
  for (const mode of ["checkpoint", "foreign", "finish"]) {
    const f = fixture();
    if (mode === "checkpoint") f.host.save = async () => { throw new Error("写盘失败"); };
    if (mode === "foreign") { const perform = f.host.perform; f.host.perform = async (name, signal) => { await perform(name, signal); if (name === "publish-target") f.facts.owned = false; }; }
    if (mode === "finish") f.host.finish = async () => { throw new Error("结果无法落盘"); };
    expect((await f.run()).outcome, mode).toBe("failed");
    if (mode === "checkpoint") expect(f.events).not.toContain("stop");
    if (mode === "foreign") expect(f.completed()).toBeUndefined();
  }
});

test("恢复后启动请求已发出时被强杀，重试只核对或启动原实例，不再用旧快照覆盖新业务数据", async () => {
  for (const [running, ready] of [[true, true], [true, false], [false, false]] as const) {
    const f = fixture(); f.request.action = "rollback"; f.request.command = "rollback";
    f.facts.state = running ? "running" : "stopped"; f.facts.ready = ready;
    f.saved({ version: 1, snapshot: f.request.snapshot, runtime: f.request.runtime, direction: "rollback", step: "start-original" });
    expect(await f.run()).toMatchObject({ outcome: "success", finalState: "running" });
    expect(f.completed()).toBe("rollback"); expect(f.events).toContain("ready:original");
    for (const name of ["stop", "restore-data", "restore-code", "restore-configuration", "restore-service"])
      expect(f.events).not.toContain(name);
    // Only a ready instance is left alone: a running but unready one is a supervisor retrying, started again under the step.
    expect(f.events.includes("start-original")).toBe(!ready);
  }
});

test("提交后启动失败、排除原因后续做：监督器仍在重试的未就绪实例在启动检查点下重新启动", async () => {
  // As on Windows after a failed formal start: the task stays Running (the supervisor retries), the bot is not ready,
  // and the resume's own retire/disable steps move the checkpoint back before ready() looks at the instance.
  const f = fixture(); f.request.command = "resume"; f.facts.role = "candidate"; f.facts.state = "running"; f.facts.ready = false;
  f.phase("committed"); f.saved({ version: 1, snapshot: f.request.snapshot, runtime: f.request.runtime, direction: "forward", step: "start-candidate" });
  expect(await f.run()).toMatchObject({ outcome: "success", finalState: "running" });
  const order = ["retire-previous-writers", "disable-verification", "start-candidate", "ready:candidate", "publish-target"];
  expect(f.events.filter(value => order.includes(value))).toEqual(order);
  expect(f.checkpoints.map(value => value.step)).toEqual(["retire-previous-writers", "disable-verification", "start-candidate", "publish-target"]);
  expect(f.events.some(value => value === "stop" || value.startsWith("restore-"))).toBe(false);
});

test("数据步骤没有 prepared 回执或验证实例被替换时，不能提交或报告成功", async () => {
  for (const mode of ["no-prepared", "candidate-changed", "stopped-not-observed"]) {
    const f = fixture(), perform = f.host.perform;
    f.host.perform = async (name, signal) => {
      if (mode === "stopped-not-observed" && name === "stop") return;
      await perform(name, signal);
      if (mode === "no-prepared" && name === "prepare-data") f.phase("unprepared");
      if (mode === "candidate-changed" && name === "install-candidate") f.facts.owned = false;
    };
    expect((await f.run()).outcome, mode).toBe("failed"); expect(f.events).not.toContain("commit-data");
    if (mode !== "no-prepared") expect(f.completed()).toBeUndefined();
  }
});

test("改动之前的拒绝保留原因：最终状态读不到也不改成失败；在读取事务之前拒绝时按实例的当前状态报告原运行状态", async () => {
  const unreadable = fixture();
  unreadable.host.verify = async () => { throw new MaintenanceRefused("fixture: confirmation changed."); };
  unreadable.host.inspect = async () => { throw new Error("fixture: inspect failed"); };
  expect(await unreadable.run()).toMatchObject({ outcome: "refused", exitCode: 1, finalState: "unknown", message: "fixture: confirmation changed." });
  for (const running of [true, false]) {
    const early = fixture("upgrade", running);
    early.host.verify = async () => { throw new MaintenanceRefused("fixture: confirmation changed"); };
    expect(await early.run()).toMatchObject({ outcome: "refused", wasRunning: running, finalState: running ? "running" : "stopped" });
  }
  // After a change the final state still decides, and a reason ending in a full stop is not followed by another separator.
  const changed = fixture(); let reads = 0;
  changed.host.perform = async name => { if (name === "stop") throw new Error("fixture: stop failed。"); };
  const inspect = changed.host.inspect;
  changed.host.inspect = async () => { if (++reads > 2) throw new Error("fixture: inspect failed"); return inspect(); };
  const result = await changed.run();
  expect(result).toMatchObject({ outcome: "failed", finalState: "unknown",
    message: "fixture: stop failed；恢复未完成：fixture: stop failed；最终状态：fixture: inspect failed" });
});
