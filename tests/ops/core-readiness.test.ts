import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serviceReady } from "../../ops/core/readiness.ts";
import { createServiceHost, type ServiceHostOptions } from "../../ops/core/service-host.ts";
import { runServiceCommand } from "../../ops/core/service.ts";
import { recoverMaintenance } from "../../ops/core/maintenance-recovery.ts";
import { acquireDeploymentLock } from "../../ops/core/deployment-lock.ts";
import { tempFixture } from "../helpers/temp.ts";

test("真实本机就绪探针核对实例身份，不接受验证实例、重定向、无限正文或读取中更换实例", async () => {
  const f = await tempFixture("core-readiness-");
  let reply: () => Response | Promise<Response> = () => Response.json(body);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => reply() });
  const body = { service: "mixin-bot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const record = { ...body, port: server.port };
  const path = join(f.root, "data/state/instance.json");
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true }); await writeFile(path, JSON.stringify(record));
    expect(await serviceReady(f.root)).toBe(true);
    for (const wrong of [{ ...body, pid: body.pid + 1 }, { ...body, status: "stopping" }, { ...body, verificationOnly: true }]) {
      reply = () => Response.json(wrong); expect(await serviceReady(f.root)).toBe(false);
    }
    reply = () => Response.json({ ...body, verificationOnly: true, build: "a".repeat(40) });
    expect(await serviceReady(f.root, 2500, { verification: true, build: "a".repeat(40) })).toBe(true);
    expect(await serviceReady(f.root, 2500, { verification: true, build: "b".repeat(40) })).toBe(false);
    reply = () => Response.json({ ...body, verificationOnly: false, build: "a".repeat(40) });
    expect(await serviceReady(f.root, 2500, { verification: true })).toBe(false);
    expect(await serviceReady(f.root, 2500, { build: "a".repeat(40) })).toBe(true);
    reply = () => new Response(null, { status: 302, headers: { location: "http://example.invalid" } });
    expect(await serviceReady(f.root)).toBe(false);
    reply = () => new Response("x".repeat(70 * 1024)); expect(await serviceReady(f.root)).toBe(false);
    reply = async () => { await writeFile(path, JSON.stringify({ ...record, instanceId: randomUUID() })); return Response.json(body); };
    expect(await serviceReady(f.root)).toBe(false);
    await writeFile(path, JSON.stringify(record));
    reply = () => new Response(new ReadableStream({ start() {} }));
    expect(await serviceReady(f.root, 30)).toBe(false);
  } finally { server.stop(true); await f.cleanup(); }
}, 15_000);

test("维护记录损坏或版本未知仍可明确停止归属实例；启动、重启和恢复仍拒绝且保留记录", async () => {
  const f = await tempFixture("core-stop-unreadable-");
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true });
    for (const content of ["{damaged", '{"version":999}']) {
      const path = join(f.root, "data/state/ops-maintenance.json"); await writeFile(path, content);
      const facts = { identity: "a".repeat(64), owned: true, state: "running" as "running" | "stopped" };
      const effects: string[] = [];
      const options: ServiceHostOptions = { project: f.root, source: f.root, verify: async () => {}, finish: async () => {},
        platform: async () => ({ inspect: async () => facts,
          start: async () => { effects.push("start"); facts.state = "running"; },
          stop: async () => { effects.push("stop"); facts.state = "stopped"; } }) };
      for (const action of ["start", "restart"] as const) expect((await runServiceCommand(action, createServiceHost(options))).exitCode).not.toBe(0);
      expect((await recoverMaintenance(options)).exitCode).not.toBe(0);
      expect(effects).toEqual([]);
      expect(await runServiceCommand("stop", createServiceHost({ ...options, allowPendingMaintenance: true })))
        .toMatchObject({ outcome: "success", exitCode: 0, finalState: "stopped" });
      expect(effects).toEqual(["stop"]); expect(await Bun.file(path).text()).toBe(content);
    }
  } finally { await f.cleanup(); }
});

test("真实部署锁、磁盘维护状态和 HTTP 就绪通过后，服务控制才发布成功", async () => {
  const f = await tempFixture("core-service-host-");
  const body = { service: "mixin-bot", version: 1, status: "ready", instanceId: randomUUID(), pid: process.pid, startedAt: Date.now() };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body) });
  const facts = { identity: "fixture", owned: true, state: "stopped" as "stopped" | "running" };
  const published: string[] = [], effects: string[] = [];
  try {
    await mkdir(join(f.root, "data/state"), { recursive: true });
    await writeFile(join(f.root, "data/state/instance.json"), JSON.stringify({ ...body, port: server.port }));
    await writeFile(join(f.root, "data/state/data-version.json"), JSON.stringify({ dataVersion: 2, appVersion: "2.0.0", build: "fixture", transaction: "deploy-fixture", application: "a".repeat(64) }));
    const options: ServiceHostOptions = { project: f.root, source: f.root, readyTimeoutMs: 50,
      verify: async () => { expect(() => acquireDeploymentLock(f.root)).toThrow(); },
      finish: async result => { expect(() => acquireDeploymentLock(f.root)).toThrow(); published.push(result.outcome); },
      platform: async () => ({ inspect: async () => ({ ...facts, rawState: facts.state }), start: async () => { effects.push("start"); facts.state = "running"; },
        stop: async () => { effects.push("stop"); facts.state = "stopped"; } }),
    };
    const host = createServiceHost(options);
    expect(await runServiceCommand("start", host)).toMatchObject({ outcome: "success", finalState: "running" });
    expect(effects).toEqual(["start"]); expect(published).toEqual(["success"]);
    for (const action of ["start", "stop"] as const) {
      const changed = createServiceHost({ ...options, expectedState: "changed" });
      expect((await runServiceCommand(action, changed)).outcome).toBe("refused");
    }
    expect(effects).toEqual(["start"]);
    await writeFile(join(f.root, "data/state/verify-only"), "pending\n");
    expect(await runServiceCommand("restart", host)).toMatchObject({ outcome: "refused", finalState: "running" });
    expect(effects).toEqual(["start"]);
    expect(await runServiceCommand("stop", host)).toMatchObject({ outcome: "success", finalState: "stopped" });
    const lock = acquireDeploymentLock(f.root); lock.close();
  } finally { server.stop(true); await f.cleanup(); }
}, 15_000);
