import { expect, test } from "bun:test";
import { readDockerDataAccess, type AccessFiles } from "../../ops/core/docker-access.ts";
import { validateDockerDataAccess } from "../../src/contracts/ops-task-access.ts";

function fixture(rootless = false) {
  const uid = rootless ? 1002 : 1001, project = "/srv/fixture", image = "sha256:" + "a".repeat(64), workspace = "/srv/shared";
  const endpoint = `unix:///run/user/${uid}/docker.sock`, daemon = "task-daemon";
  const launch = { version: 1, image, controlRoot: "/app/data/runtime/task-control", mounts: [
    { manager: "/app/data", daemon: project + "/data" }, { manager: "/app/workspace", daemon: workspace }], imagePaths: ["/app/src"] };
  const service = { user: rootless ? "0:0" : `${uid}:${uid}`, image,
    mounts: [{ Destination: "/app/workspace", Source: workspace, Type: "bind", RW: false },
      { Destination: "/run/mixin-task/docker.sock", Source: endpoint.slice(7), Type: "bind", RW: true }],
    env: ["DOCKER_HOST=unix:///run/mixin-task/docker.sock", "MIXIN_TASK_DEPLOYMENT=/app/data/config/task-deployment.json", "IGNORED_SECRET=never-copy"] };
  const manifest = { value: JSON.stringify(launch), uid, mode: 0o600 }, runtime = { value: `endpoint=${endpoint}\ndaemon=${daemon}\n`, uid: 0, mode: 0o600 };
  let absent = false, directory = true;
  const files: AccessFiles = { file: path => absent ? undefined : path.endsWith("task-runtime") ? runtime : manifest, directory: () => directory };
  return { service, launch, manifest, runtime, uid, endpoint, daemon, workspace,
    run: () => readDockerDataAccess(project, service, rootless ? uid : 0, rootless, files),
    absent: () => { absent = true; }, noDirectory: () => { directory = false; } };
}

test.each([false, true])("临时文件维护复用已部署的 rootless 任务 daemon 和只读资料映射，rootless 服务=%s", rootless => {
  const f = fixture(rootless);
  expect(f.run()).toEqual({ workspace: f.workspace, tasks: { endpoint: f.endpoint, daemon: f.daemon, uid: f.uid } });
  expect(JSON.stringify(f.run())).not.toContain("IGNORED_SECRET");
  f.service.mounts = []; f.service.env = []; f.absent(); expect(f.run()).toEqual({});
});

test("附加访问在运行维护前拒绝不完整记录、身份/映射不符、错误权限和可写共享资料", () => {
  for (const issue of ["absent", "owner", "permissions", "duplicate", "unknown", "remote", "socket", "environment", "image", "mapping", "workspace", "directory"]) {
    const f = fixture();
    if (issue === "absent") f.absent();
    if (issue === "owner") f.manifest.uid++;
    if (issue === "permissions") f.manifest.mode = 0o644;
    if (issue === "duplicate") f.runtime.value = `endpoint=${f.endpoint}\nendpoint=${f.endpoint}\n`;
    if (issue === "unknown") f.runtime.value += "other=value\n";
    if (issue === "remote") f.runtime.value = "endpoint=tcp://example.invalid:2375\ndaemon=task-daemon\n";
    if (issue === "socket") f.service.mounts[1]!.Source = "/run/another.sock";
    if (issue === "environment") f.service.env[0] = "DOCKER_HOST=unix:///run/unrelated.sock";
    if (issue === "image") { f.launch.image = "sha256:" + "b".repeat(64); f.manifest.value = JSON.stringify(f.launch); }
    if (issue === "mapping") { f.launch.mounts[0]!.daemon += "/wrong"; f.manifest.value = JSON.stringify(f.launch); }
    if (issue === "workspace") f.service.mounts[0]!.RW = true;
    if (issue === "directory") f.noDirectory();
    expect(f.run, issue).toThrow();
  }
});

test("维护恢复记录的访问字段严格校验；不能携带任意挂载、环境、远程 daemon 或无效身份", () => {
  const valid = fixture().run(); expect(() => validateDockerDataAccess(valid)).not.toThrow();
  for (const value of [null, [], { ...valid, extra: "mount" }, { workspace: "/" }, { workspace: "/a/../b" }, { workspace: "/a,readonly" },
    { ...valid, tasks: null }, { ...valid, tasks: { ...valid.tasks, uid: 0 } }, { ...valid, tasks: { ...valid.tasks, endpoint: "tcp://host" } },
    { ...valid, tasks: { ...valid.tasks, endpoint: 3 } }, { ...valid, tasks: { ...valid.tasks, daemon: "" } }])
    expect(() => validateDockerDataAccess(value)).toThrow();
});
