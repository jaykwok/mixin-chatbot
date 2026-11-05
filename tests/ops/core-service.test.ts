import { expect, test } from "bun:test";
import { MaintenanceRefused, type ServiceFacts } from "../../scripts/ops/core/maintenance.ts";
import { runServiceCommand, type ServiceAction, type ServiceControlHost } from "../../scripts/ops/core/service.ts";

function fixture() {
  const facts: ServiceFacts = { identity: "test", owned: true, state: "running", ready: true, pending: false };
  const events: string[] = [], abort = new AbortController(); let locked = false;
  const host: ServiceControlHost = {
    async locked(body) { locked = true; events.push("lock"); try { return await body(); } finally { locked = false; events.push("unlock"); } },
    async verify() { expect(locked).toBe(true); events.push("verify"); },
    async inspect() { expect(locked).toBe(true); return { ...facts }; },
    async assess(intent) { expect(locked).toBe(true); events.push("assess:" + intent); },
    async stop() { events.push("stop"); facts.state = "stopped"; facts.ready = false; },
    async start() { events.push("start"); facts.state = "running"; },
    async waitReady() { events.push("ready"); facts.ready = true; return true; },
    async finish(value) { expect(locked).toBe(true); events.push("finish:" + value.outcome); },
  };
  return { facts, events, host, abort, run: (action: ServiceAction) => runServiceCommand(action, host, abort.signal) };
}

test("服务控制在同一部署锁内重启，停机后重新判断维护状态，通过身份与就绪才报告运行中", async () => {
  const f = fixture(); expect(await f.run("restart")).toMatchObject({ outcome: "success", exitCode: 0, wasRunning: true, finalState: "running" });
  expect(f.events).toEqual(["lock", "verify", "assess:service", "stop", "assess:service", "start", "ready", "finish:success", "unlock"]);
});

test("停止不被未完成事务挡住；启动/重启拒绝事务、陌生实例或异常运行状态", async () => {
  const stop = fixture(); stop.facts.pending = true;
  expect(await stop.run("stop")).toMatchObject({ outcome: "success", finalState: "stopped" });
  expect(stop.events).not.toContain("assess:service");
  const foreground = fixture(); foreground.facts.state = "unsupported";
  expect(await foreground.run("stop")).toMatchObject({ outcome: "success", finalState: "stopped" });
  expect(foreground.events).toContain("stop");
  const locked = fixture(); locked.host.locked = async () => { throw new MaintenanceRefused("locked"); };
  expect((await locked.run("stop")).outcome).toBe("refused"); expect(locked.events).not.toContain("stop");
  for (const action of ["start", "restart", "repair"] as const) for (const reason of ["pending", "foreign", "unsupported", "absent", "maintenance", "lock"]) {
    const f = fixture();
    if (reason === "pending") f.facts.pending = true;
    if (reason === "foreign") f.facts.owned = false;
    if (reason === "unsupported") f.facts.state = "unsupported";
    if (reason === "absent") f.facts.state = "absent";
    if (reason === "maintenance") f.host.assess = async () => { throw new MaintenanceRefused("blocked"); };
    if (reason === "lock") f.host.locked = async () => { throw new MaintenanceRefused("locked"); };
    expect((await f.run(action)).outcome, action + reason).toBe("refused");
    expect(f.events).not.toContain("start"); expect(f.events).not.toContain("stop");
  }
});

test("服务启停幂等；原来停止的实例可显式启动，已运行也必须核对就绪", async () => {
  for (const state of ["stopped", "absent"] as const) {
    const f = fixture(); f.facts.state = state;
    expect((await f.run("stop")).outcome).toBe("success"); expect(f.events).not.toContain("stop");
  }
  const stopped = fixture(); stopped.facts.state = "stopped"; stopped.facts.ready = false;
  expect(await stopped.run("start")).toMatchObject({ outcome: "success", wasRunning: false, finalState: "running" });
  expect(stopped.events).toContain("start");
  const running = fixture(); running.host.waitReady = async () => false; running.facts.ready = false;
  expect(await running.run("start")).toMatchObject({ outcome: "failed", finalState: "start-requested" });
  expect(running.events).not.toContain("start");
});

test("Windows 修复：已就绪时不重启；未就绪或已停止时与重启相同，必须通过身份与就绪", async () => {
  const ready = fixture();
  expect(await ready.run("repair")).toMatchObject({ command: "repair", outcome: "success", exitCode: 0, wasRunning: true, finalState: "running" });
  expect(ready.events).toEqual(["lock", "verify", "assess:service", "finish:success", "unlock"]);
  const unready = fixture(); unready.facts.ready = false;
  expect(await unready.run("repair")).toMatchObject({ outcome: "success", wasRunning: true, finalState: "running" });
  expect(unready.events).toEqual(["lock", "verify", "assess:service", "stop", "assess:service", "start", "ready", "finish:success", "unlock"]);
  const stopped = fixture(); stopped.facts.state = "stopped"; stopped.facts.ready = false;
  expect(await stopped.run("repair")).toMatchObject({ outcome: "success", wasRunning: false, finalState: "running" });
  expect(stopped.events).toEqual(["lock", "verify", "assess:service", "assess:service", "start", "ready", "finish:success", "unlock"]);
});

test("重启或修复时停止失败、取消、身份变化、第二次维护判断失败或结果落盘失败不报告成功", async () => {
  for (const action of ["restart", "repair"] as const) for (const reason of ["stop", "cancel", "identity", "assessment", "publish", "ready"]) {
    const f = fixture(), stop = f.host.stop;
    // Repair acts only on an instance that is not ready.
    if (action === "repair") f.facts.ready = false;
    if (reason === "stop") f.host.stop = async () => { throw new Error("stop failed"); };
    if (reason === "cancel") f.host.stop = async () => { await stop(); f.abort.abort(); };
    if (reason === "identity") f.host.stop = async () => { await stop(); f.facts.identity = "another"; };
    if (reason === "assessment") { let n = 0; f.host.assess = async () => { if (++n === 2) throw new MaintenanceRefused("blocked"); }; }
    if (reason === "publish") f.host.finish = async () => { throw new Error("disk full"); };
    if (reason === "ready") f.host.waitReady = async () => false;
    const result = await f.run(action); expect(result.outcome, action + reason).toBe("failed"); expect(result.exitCode).not.toBe(0);
    if (["stop", "cancel", "identity", "assessment"].includes(reason)) expect(f.events).not.toContain("start");
    if (reason === "cancel") expect(result.exitCode).toBe(130);
    if (reason === "identity") expect(result.finalState).toBe("unknown");
    if (reason === "ready") expect(result.finalState).toBe("start-requested");
  }
});
