import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DockerPlatform } from "../../scripts/ops/core/docker-host.ts";
import type { NativeCommand, NativeRunner } from "../../scripts/ops/core/native-process.ts";

function fixture(uid = 0) {
  const project = resolve("fixture-project"), data = resolve(project, "data"), calls: NativeCommand[] = [];
  const env: NodeJS.ProcessEnv = { DOCKER_HOST: `unix:///run/${uid}/docker.sock`, DOCKER_TLS_VERIFY: "1" };
  const c = { Id: "a".repeat(64), Name: "/mixin-chatbot", Image: "sha256:" + "b".repeat(64),
    Config: { User: uid ? "0:0" : "1001:1001" }, Mounts: [{ Destination: "/app/data", Source: data, Type: "bind", RW: true }],
    State: { Status: "running", Running: true, Paused: false, Restarting: false } };
  const facts = { daemon: "daemon-fixture", rootless: uid !== 0, present: true, socketUid: uid, socket: true, link: false, failed: "" };
  const run: NativeRunner = async command => {
    calls.push(command);
    if (command.args[0] === "context") return { code: 0, stdout: JSON.stringify([{ Endpoints: { docker: { Host: `unix:///run/${uid}/from-context.sock` } } }]) };
    expect(command.args[0]).toBe("--host"); expect(command.env?.DOCKER_CONTEXT).toBeUndefined(); expect(command.env?.DOCKER_HOST).toBeUndefined();
    const args = command.args.slice(2), action = args[0] === "info" ? "info" : args[1];
    if (action === facts.failed) return { code: 1, stdout: "" };
    if (action === "info") return { code: 0, stdout: JSON.stringify({ ID: facts.daemon, SecurityOptions: facts.rootless ? ["name=rootless"] : ["name=seccomp"] }) };
    if (action === "ls") return { code: 0, stdout: facts.present ? c.Id + "\n" : "" };
    if (action === "inspect") return { code: 0, stdout: JSON.stringify([c]) };
    if (action === "stop" || action === "start") {
      expect(args.at(-1)).toBe(c.Id); c.State.Status = action === "stop" ? "exited" : "running"; c.State.Running = action === "start";
      return { code: 0, stdout: c.Id + "\n" };
    }
    throw new Error("Unexpected Docker command");
  };
  const connect = () => DockerPlatform.connect(project, run, { uid, env,
    socket: () => ({ uid: facts.socketUid, socket: facts.socket, link: facts.link }), data: () => data });
  return { c, facts, calls, env, connect };
}

test.each([0, 1002])("Docker 平台 UID %s：固定本机 daemon、核对数据挂载，只用容器 ID 启停", async uid => {
  const f = fixture(uid), host = await f.connect(), original = await host.inspect();
  expect(original).toMatchObject({ state: "running", owned: true, container: f.c.Id });
  await host.stop(original.identity); expect((await host.inspect()).state).toBe("stopped");
  await host.start(original.identity); expect((await host.inspect()).identity).toBe(original.identity);
  f.env.DOCKER_HOST = "unix:///other.sock";
  await host.inspect(); expect(f.calls.at(-1)!.args[1]).toBe(`unix:///run/${uid}/docker.sock`);
  f.facts.daemon = "changed";
  await expect(host.stop(original.identity)).rejects.toThrow("daemon 身份已变化");
});

test("Docker context 优先于环境的 HOST，远程 endpoint、错误身份和失败查询不算不存在", async () => {
  const context = fixture(1002); context.env.DOCKER_CONTEXT = "chosen";
  const host = await context.connect(); expect(host.endpoint).toBe("unix:///run/1002/from-context.sock");
  expect(context.calls[0]!.args).toEqual(["context", "inspect", "chosen"]);
  const remote = fixture(); remote.env.DOCKER_HOST = "tcp://remote:2375";
  await expect(remote.connect()).rejects.toThrow("本机"); expect(remote.calls).toHaveLength(0);
  for (const issue of ["owner", "link", "mode", "info", "ls", "inspect"]) {
    const f = fixture(), adapter = await f.connect();
    if (issue === "owner") f.facts.socketUid = 1000;
    else if (issue === "link") f.facts.link = true;
    else if (issue === "mode") f.facts.rootless = true;
    else f.facts.failed = issue;
    await expect(adapter.inspect()).rejects.toThrow();
  }
  const absent = fixture(), adapter = await absent.connect(); absent.facts.present = false;
  expect((await adapter.inspect()).state).toBe("absent");
});

test("Docker 异常状态、陌生挂载、被替换实例拒绝写入；单纯返回成功不代替最终就绪检查", async () => {
  for (const issue of ["paused", "restarting", "mount", "replacement"]) {
    const f = fixture(), host = await f.connect(), original = await host.inspect();
    if (issue === "paused") { f.c.State.Paused = true; }
    if (issue === "restarting") { f.c.State.Restarting = true; }
    if (issue === "mount") f.c.Mounts[0]!.Source += "-other";
    if (issue === "replacement") f.c.Id = "c".repeat(64);
    await expect(["paused", "restarting"].includes(issue) ? host.start(original.identity) : host.stop(original.identity)).rejects.toThrow();
    expect(f.calls.some(call => call.args[3] === "stop")).toBe(false);
  }
});
