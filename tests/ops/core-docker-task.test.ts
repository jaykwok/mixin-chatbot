import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { DockerPlatform } from "../../ops/core/docker-host.ts";
import { DockerWriterUnsettled, newDockerTask, recoverDockerTask, runDockerTask, taskCommandDigest, taskInput, taskName } from "../../ops/core/docker-task.ts";
import type { DockerTaskRecord } from "../../src/contracts/ops-writer.ts";
import type { NativeCommand, NativeRunner } from "../../ops/core/native-process.ts";
import { runtimeEnvironmentDigest } from "../../ops/core/runtime-environment.ts";
import { prepareReports, reportsPath } from "../../ops/core/reports.ts";
import { mkdir, rename } from "node:fs/promises";
import { tempFixture } from "../helpers/temp.ts";

/** Only the Docker process boundary is replaced; creation, attach, validation and reaping use the real platform. */
function fixture(uid = 0, project = resolve("docker-task-fixture")) {
  const endpoint = `unix:///run/${uid}/docker.sock`, daemon = "task-daemon";
  const args = ["run", "ops/tools/data-current.ts", "apply", "--project", "/app", "--json"];
  const record = newDockerTask({ daemon, endpoint, image: "sha256:" + "b".repeat(64), user: uid ? "0:0" : "1001:1001",
    data: resolve(project, "data"), backup: resolve(project, "backup"), network: "none" }, args);
  const service: any = { Id: "d".repeat(64), Name: "/mixin-bot", Image: record.image, Config: { User: record.user },
    Mounts: [{ Type: "bind", Source: record.data, Destination: "/app/data", RW: true }], State: { Status: "running", Running: true } };
  const calls: NativeCommand[] = [], saves: DockerTaskRecord[] = [];
  const tasks = { uid: uid || 1001, daemon: "recorded-task-daemon", rootless: true, socket: true, link: false };
  let container: any, failure = "", exitCode = 0, failSave = "", daemonId = daemon;
  const run: NativeRunner = async command => {
    calls.push(command);
    if (record.access?.tasks && command.args[1] === record.access.tasks.endpoint) {
      expect(command.args.slice(2)).toEqual(["info", "--format", "{{json .}}"]);
      return { code: 0, stdout: JSON.stringify({ ID: tasks.daemon, SecurityOptions: tasks.rootless ? ["name=rootless"] : [] }) };
    }
    expect(command.args.slice(0, 2)).toEqual(["--host", endpoint]);
    const argv = command.args.slice(2), verb = argv[0] === "info" ? "info" : argv[1];
    if (verb === failure) return { code: 1, stdout: "" };
    if (verb === "info") return { code: 0, stdout: JSON.stringify({ ID: daemonId, SecurityOptions: uid ? ["name=rootless"] : [] }) };
    if (verb === "ls") return { code: 0, stdout: argv.includes("name=^/mixin-bot$") ? service.Id : container?.Id ?? "" };
    if (verb === "inspect") return { code: 0, stdout: JSON.stringify([argv[2] === service.Id ? service : container]) };
    if (verb === "create") {
      expect(saves.at(-1)?.phase).toBe("prepared");
      expect(argv).toContain(record.image); expect(argv).not.toContain("--rm");
      expect(argv.slice(-args.length)).toEqual(args);
      container = { Id: "c".repeat(64), Name: "/" + taskName(record), Image: record.image,
        Config: { User: record.user, Entrypoint: ["bun"], Cmd: args, Tty: false, OpenStdin: argv.includes("--interactive"), StdinOnce: argv.includes("stdin"),
          Env: [...(record.access?.workspace ? ["WORKSPACE_ROOT=/app/workspace"] : []),
            ...(record.access?.tasks ? ["DOCKER_HOST=unix:///run/mixin-task/docker.sock", "MIXIN_TASK_DEPLOYMENT=/app/data/config/task-deployment.json"] : []),
            ...argv.flatMap((value, i) => value === "--env" && argv[i + 1]?.startsWith("BOT_BASH_TIMEOUT=") ? [argv[i + 1]!] : [])],
          Labels: { "org.mixin.maintenance.id": record.id, "org.mixin.maintenance.command": record.commandDigest } },
        HostConfig: { Privileged: false, ReadonlyRootfs: true, AutoRemove: false, NetworkMode: record.network, RestartPolicy: { Name: "no" } },
        Mounts: [{ Type: "bind", Source: record.data, Destination: "/app/data", RW: true },
          { Type: "bind", Source: record.backup, Destination: "/app/backup", RW: true },
          ...(record.access?.workspace ? [{ Type: "bind", Source: record.access.workspace, Destination: "/app/workspace", RW: false }] : []),
          ...(record.access?.tasks ? [{ Type: "bind", Source: record.access.tasks.endpoint.slice(7), Destination: "/run/mixin-task/docker.sock", RW: true }] : []),
          ...(record.reports ? [{ Type: "bind", Source: reportsPath(project), Destination: "/app/tmp/backup-cleanup", RW: true }] : [])],
        State: { Running: false, Status: "created", ExitCode: 0 } };
      if (failure === "create-response") throw new Error("create response lost");
      return { code: 0, stdout: container.Id + "\n" };
    }
    if (["start", "stop", "rm"].includes(verb!)) expect(argv.at(-1)).toBe(container.Id);
    if (verb === "start") {
      expect(saves.at(-1)?.phase).toBe("starting");
      container.State = { Running: true, Status: "running", ExitCode: 0 };
      if (failure === "attach-cancel") throw new Error("client cancelled; writer still alive");
      if (failure === "daemon-gone") { daemonId = "different-daemon"; throw new Error("daemon disconnected"); }
      if (failure !== "false-success") container.State = { Running: false, Status: "exited", ExitCode: exitCode };
      if (failure === "rm-after-exit") failure = "rm";
      return { code: exitCode, stdout: '{"outcome":"success"}\n' };
    }
    if (verb === "stop") { container.State = { Running: false, Status: "exited", ExitCode: 143 }; return { code: 0, stdout: container.Id }; }
    if (verb === "rm") { container = undefined; return { code: 0, stdout: "removed\n" }; }
    throw new Error("unexpected Docker command " + verb);
  };
  const save = async (value: DockerTaskRecord) => { if (value.phase === failSave) throw new Error("disk full"); saves.push(structuredClone(value)); };
  const host = () => DockerPlatform.connect(project, run, { uid, env: { DOCKER_HOST: endpoint },
    socket: path => path === record.access?.tasks?.endpoint.slice(7) ? tasks : ({ uid, socket: true, link: false }), data: () => record.data });
  return { args, record, calls, saves, save, host, tasks, service, get container() { return container; },
    failure: (value: string) => { failure = value; }, failSave: (value: string) => { failSave = value; }, code: (value: number) => { exitCode = value; } };
}

test.each([0, 1002])("Docker 数据写入 UID %s：意图先落盘；固定镜像/身份，实际退出并移除后才完成", async uid => {
  for (const code of [0, 3]) {
    const f = fixture(uid), driver = (await f.host()).taskDriver(); f.code(code);
    const result = await runDockerTask(driver, f.record, f.args, f.save);
    expect(result.code).toBe(code); expect(f.container).toBeUndefined();
    expect(f.saves.map(row => row.phase)).toEqual(["prepared", "created", "starting", "reaped"]);
    expect(f.saves.at(-1)?.container).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(f.saves)).not.toContain("data-current.ts");
    const create = f.calls.find(call => call.args[3] === "create")!;
    expect(create.args).toContain("--read-only"); expect(create.args).toContain("no-new-privileges");
  }
});

test("Docker 备份报告只挂载固定目录，启动前拒绝替换，回收不依赖目录仍存在", async () => {
  const dir = await tempFixture("core-docker-reports-");
  try {
    const f = fixture(0, dir.root), host = await f.host(), driver = host.taskDriver();
    f.record.reports = prepareReports(dir.root, { uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0 });
    await f.save(f.record); const container = await driver.create(f.record, f.args);
    const created = { ...f.record, container, phase: "created" as const };
    const create = f.calls.find(call => call.args[3] === "create")!;
    expect(create.args).toContain(`type=bind,src=${reportsPath(dir.root)},dst=/app/tmp/backup-cleanup`);
    f.container.Mounts.at(-1).RW = false;
    await expect(driver.reap(created)).rejects.toThrow("挂载"); expect(f.container.Id).toBe(container);
    f.container.Mounts.at(-1).RW = true;
    await rename(reportsPath(dir.root), resolve(dir.root, "tmp/retained")); await mkdir(reportsPath(dir.root));
    await expect(driver.attach(created)).rejects.toThrow("替换");
    expect(f.calls.some(call => call.args[3] === "start")).toBe(false);
    await recoverDockerTask(host.taskDriver(), created, f.save); expect(f.container).toBeUndefined();
    await expect(driver.create(f.record, f.args)).rejects.toThrow("替换");
  } finally { await dir.cleanup(); }
});

test.each([0, 1002])("外链任务 UID %s 核对共享网络的运行实例；服务停止或被替换时拒绝启动，回收仍可执行", async uid => {
  for (const mode of ["running", "stopped", "replaced", "foreign", "host"]) {
    const f = fixture(uid); f.record.network = mode === "host" ? "host" : `container:${f.service.Id}`;
    const driver = (await f.host()).taskDriver();
    if (mode === "running" || mode === "host") {
      await runDockerTask(driver, f.record, f.args, f.save);
      const args = f.calls.find(call => call.args[3] === "create")!.args;
      expect(args[args.indexOf("--network") + 1]).toBe(f.record.network); expect(f.container).toBeUndefined(); continue;
    }
    await f.save(f.record); const container = await driver.create(f.record, f.args), created = { ...f.record, container, phase: "created" as const };
    if (mode === "stopped") { f.service.State.Status = "exited"; f.service.State.Running = false; }
    if (mode === "replaced") f.service.Id = "e".repeat(64);
    if (mode === "foreign") f.service.Mounts[0].Source = resolve("unrelated-data");
    await expect(driver.attach(created)).rejects.toThrow("网络所属实例");
    expect(f.calls.some(call => call.args[3] === "start")).toBe(false);
    await recoverDockerTask(driver, created, f.save); expect(f.container).toBeUndefined();
  }
});

test("维护输入只送往 attach 的独立管道；摘要或 stdin 模式不符拒绝，恢复不需要秘密", async () => {
  const input = Buffer.from("合成凭据\n".repeat(2000));
  for (const issue of ["success", "wrong-payload", "missing-payload", "extra-payload", "wrong-stdin", "wrong-tty"]) {
    const f = fixture();
    if (issue !== "extra-payload") f.record.input = taskInput(input);
    const host = await f.host();
    const driver = host.taskDriver(undefined, true, undefined, issue === "missing-payload" ? undefined : issue === "wrong-payload" ? Buffer.from("wrong") : input);
    if (["wrong-payload", "missing-payload", "extra-payload"].includes(issue)) {
      await expect(runDockerTask(driver, f.record, f.args, f.save)).rejects.toThrow("输入与记录不符");
      expect(f.calls.some(call => call.args[3] === "create")).toBe(false); continue;
    }
    if (issue === "success") {
      await runDockerTask(driver, f.record, f.args, f.save);
      const attach = f.calls.find(call => call.args[3] === "start")!;
      expect(attach.args).toContain("--interactive"); expect(attach.input).toEqual(input);
      expect(f.calls.filter(call => call.args[3] !== "start").every(call => call.input === undefined)).toBe(true);
      expect(JSON.stringify(f.saves)).not.toContain("合成凭据");
      expect(JSON.stringify(f.calls.map(({ args, env }) => ({ args, env })))).not.toContain("合成凭据");
    } else {
      await f.save(f.record); const container = await driver.create(f.record, f.args);
      const record = { ...f.record, container, phase: "created" as const };
      if (issue === "wrong-stdin") f.container.Config.StdinOnce = false;
      else f.container.Config.Tty = true;
      await expect(recoverDockerTask(host.taskDriver(), record, f.save)).rejects.toThrow();
      expect(f.container.Id).toBe(container);
      f.container.Config.StdinOnce = true; f.container.Config.Tty = false;
      await recoverDockerTask(host.taskDriver(), record, f.save);
      expect(f.container).toBeUndefined();
      expect(f.calls.some(call => call.args[3] === "start")).toBe(false);
    }
  }
});

test("Docker 运行参数环境按摘要固定，执行丢失或改变则拒绝；恢复仅凭摘要收尾", async () => {
  const values = ["BOT_BASH_TIMEOUT=120"];
  const f = fixture(), host = await f.host(); f.record.runtimeEnvironment = runtimeEnvironmentDigest(values);
  await expect(runDockerTask(host.taskDriver(), f.record, f.args, f.save)).rejects.toThrow("环境与记录不符");
  expect(f.container).toBeUndefined();
  const driver = host.taskDriver(undefined, true, undefined, undefined, values);
  await f.save(f.record); const container = await driver.create(f.record, f.args);
  const record = { ...f.record, container, phase: "created" as const };
  expect(f.calls.find(call => call.args[3] === "create")!.args).toContain("BOT_BASH_TIMEOUT=120");
  f.container.Config.Env.push("BOT_BASH_TIMEOUT=99");
  await expect(recoverDockerTask(host.taskDriver(), record, f.save)).rejects.toThrow(); expect(f.container).toBeDefined();
  f.container.Config.Env.pop();
  await recoverDockerTask(host.taskDriver(), record, f.save); expect(f.container).toBeUndefined();
  expect(JSON.stringify(f.saves)).not.toContain("BOT_BASH_TIMEOUT");
});

test("维护容器绑定原任务 daemon 和只读资料；daemon 失联仍可回收维护写入者，不能误认额外挂载", async () => {
  for (const issue of ["success", "owner", "rootful", "daemon", "lost-after-start", "writable-workspace", "wrong-env"]) {
    const f = fixture();
    f.record.access = { workspace: "/shared", tasks: { endpoint: "unix:///run/user/1001/docker.sock", daemon: f.tasks.daemon, uid: 1001 } };
    const driver = (await f.host()).taskDriver();
    if (issue === "owner") f.tasks.uid = 1002;
    if (issue === "rootful") f.tasks.rootless = false;
    if (issue === "daemon") f.tasks.daemon = "different";
    if (["owner", "rootful", "daemon"].includes(issue)) {
      await expect(runDockerTask(driver, f.record, f.args, f.save)).rejects.toThrow(); expect(f.container).toBeUndefined(); continue;
    }
    await f.save(f.record); const id = await driver.create(f.record, f.args);
    const record = { ...f.record, container: id, phase: "created" as const }; await f.save(record);
    const create = f.calls.find(c => c.args[3] === "create")!;
    expect(create.args).toContain("type=bind,src=/shared,dst=/app/workspace,readonly");
    if (issue === "writable-workspace") f.container.Mounts[2].RW = true;
    if (issue === "wrong-env") f.container.Config.Env[0] = "WORKSPACE_ROOT=/wrong";
    if (["writable-workspace", "wrong-env"].includes(issue)) {
      await expect(recoverDockerTask(driver, record, f.save)).rejects.toThrow(); expect(f.container.Id).toBe(id); continue;
    }
    if (issue === "lost-after-start") { f.container.State = { Running: true, Status: "running", ExitCode: 0 }; f.tasks.daemon = "unavailable"; f.tasks.socket = false; }
    await recoverDockerTask(driver, record, f.save); expect(f.container).toBeUndefined();
    expect(f.saves.at(-1)?.phase).toBe("reaped");
  }
});

test("attach 客户端失败、创建答复丢失和伪成功均先回收 daemon 写入者，不把进程退出当成容器退出", async () => {
  for (const issue of ["attach-cancel", "create-response", "false-success"]) {
    const f = fixture(), driver = (await f.host()).taskDriver(); f.failure(issue);
    await expect(runDockerTask(driver, f.record, f.args, f.save)).rejects.toThrow();
    expect(f.container).toBeUndefined(); expect(f.saves.at(-1)?.phase).toBe("reaped");
    expect(f.calls.some(call => call.args[3] === "rm")).toBe(true);
    expect(f.calls.some(call => call.args[3] === "stop")).toBe(issue !== "create-response");
  }
});

test("保存或回收失败保留阻止状态；取消前不创建；恢复绝不重复执行写命令", async () => {
  for (const phase of ["prepared", "created", "starting", "reaped"]) {
    const f = fixture(), driver = (await f.host()).taskDriver(); f.failSave(phase);
    await expect(runDockerTask(driver, f.record, f.args, f.save)).rejects.toThrow();
    expect(f.calls.some(call => call.args[3] === "create")).toBe(phase !== "prepared");
    expect(f.container).toBeUndefined();
    if (phase === "reaped") {
      expect(f.saves.at(-1)?.phase).toBe("starting"); f.failSave("");
      const count = f.calls.filter(call => call.args[3] === "start").length;
      await recoverDockerTask(driver, f.saves.at(-1)!, f.save);
      expect(f.saves.at(-1)?.phase).toBe("reaped"); expect(f.calls.filter(call => call.args[3] === "start")).toHaveLength(count);
    }
  }
  for (const issue of ["daemon-gone", "rm-after-exit"]) {
    const f = fixture(), driver = (await f.host()).taskDriver(); f.failure(issue);
    await expect(runDockerTask(driver, f.record, f.args, f.save)).rejects.toBeInstanceOf(DockerWriterUnsettled);
    expect(f.container).toBeDefined(); expect(f.saves.at(-1)?.phase).toBe("starting");
  }
  const f = fixture(), driver = (await f.host()).taskDriver(), abort = AbortSignal.abort(new Error("cancelled"));
  await expect(runDockerTask(driver, f.record, f.args, f.save, abort)).rejects.toThrow("cancelled");
  expect(f.saves).toHaveLength(0); expect(f.calls.some(call => call.args[3] === "create")).toBe(false);
});

test("强杀后的记录按名称找回尚未记 ID 的容器；归属、命令、镜像、挂载或 ID 不符时不误删", async () => {
  for (const issue of ["none", "id", "image", "command", "user", "mount", "label", "privileged", "restart", "list-failed"]) {
    const f = fixture(), driver = (await f.host()).taskDriver(); await f.save(f.record);
    const id = await driver.create(f.record, f.args);
    const record = { ...f.record, ...(issue === "id" ? { container: "d".repeat(64) } : {}) };
    if (issue === "image") f.container.Image = "sha256:" + "e".repeat(64);
    if (issue === "command") f.container.Config.Cmd = ["unexpected"];
    if (issue === "user") f.container.Config.User = "0:0";
    if (issue === "mount") f.container.Mounts[0].Source += "-foreign";
    if (issue === "label") f.container.Config.Labels["org.mixin.maintenance.id"] = "foreign";
    if (issue === "privileged") f.container.HostConfig.Privileged = true;
    if (issue === "restart") f.container.HostConfig.RestartPolicy.Name = "always";
    if (issue === "list-failed") f.failure("ls");
    if (issue === "none") { await recoverDockerTask(driver, record, f.save); expect(f.container).toBeUndefined(); }
    else {
      await expect(recoverDockerTask(driver, record, f.save)).rejects.toBeInstanceOf(DockerWriterUnsettled);
      expect(f.container.Id).toBe(id); expect(f.calls.some(call => ["stop", "rm"].includes(call.args[3]!))).toBe(false);
    }
  }
  expect(taskCommandDigest(["a", "bc"])).not.toBe(taskCommandDigest(["ab", "c"]));
});
