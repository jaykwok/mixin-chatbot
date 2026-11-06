// Non-secret inputs for a maintenance container. They are copied from the owned service and independently checked;
// no caller can supply arbitrary Docker mounts or environment variables through the administrative CLI.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { TaskPaths, type TaskLaunch } from "../../src/core/task-deployment.ts";
import { dockerPath, validateDockerDataAccess, type DockerDataAccess } from "../../src/contracts/ops-task-access.ts";
export interface AccessFiles {
  file(path: string): { value: string; uid: number; mode: number } | undefined;
  directory(path: string): boolean;
}
const actualFiles: AccessFiles = {
  file(path) {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("维护部署输入不是有限的普通文件");
    return { value: readFileSync(path, "utf8"), uid: stat.uid, mode: stat.mode & 0o777 };
  },
  directory(path) { return lstatSync(path).isDirectory() && realpathSync(path) === path; },
};

/** The service's task socket is the same-owner rootless daemon, never the rootful service daemon. */
export function readDockerDataAccess(project: string, service: { user: string; image: string; mounts: unknown[]; env: unknown[] },
  hostUid: number, rootless: boolean, files = actualFiles, data = project + "/data"): DockerDataAccess {
  const access: DockerDataAccess = {}, mounts = service.mounts as { Destination?: string; Source?: string; Type?: string; RW?: boolean }[];
  const workspace = mounts.filter(m => m.Destination === "/app/workspace");
  if (workspace.length > 1 || workspace.length === 1 && (workspace[0]!.Type !== "bind" || workspace[0]!.RW !== false
    || !dockerPath(workspace[0]!.Source) || !files.directory(workspace[0]!.Source!))) throw new Error("服务共享资料挂载不是可核对的只读目录");
  if (workspace.length) access.workspace = workspace[0]!.Source;
  const manifest = files.file(join(project, "data/config/task-deployment.json")), runtime = files.file(join(project, "data/state/task-runtime"));
  const taskMount = mounts.filter(m => m.Destination === "/run/mixin-task/docker.sock");
  const taskEnv = service.env.filter(e => typeof e === "string" && /^(DOCKER_HOST|MIXIN_TASK_DEPLOYMENT)=/.test(e));
  if (!manifest && !runtime && !taskMount.length && !taskEnv.length) return access;
  const uid = rootless ? hostUid : Number(service.user.split(":")[0]);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !manifest || !runtime || manifest.uid !== uid || (manifest.mode & 0o077) !== 0)
    throw new Error("任务部署输入缺失、权限或服务身份不符");
  const entries = runtime.value.trimEnd().split("\n").map(line => line.split("="));
  if (entries.length !== 2 || entries.some(parts => parts.length !== 2) || new Set(entries.map(parts => parts[0])).size !== 2
    || entries.some(parts => !["endpoint", "daemon"].includes(parts[0]!))) throw new Error("任务 daemon 记录格式不支持");
  const recorded = Object.fromEntries(entries);
  access.tasks = { endpoint: recorded.endpoint!, daemon: recorded.daemon!, uid }; validateDockerDataAccess(access);
  if (taskMount.length !== 1 || taskMount[0]!.Type !== "bind" || taskMount[0]!.RW !== true || taskMount[0]!.Source !== access.tasks.endpoint.slice(7)
    || taskEnv.length !== 2 || !taskEnv.includes("DOCKER_HOST=unix:///run/mixin-task/docker.sock")
    || !taskEnv.includes("MIXIN_TASK_DEPLOYMENT=/app/data/config/task-deployment.json")) throw new Error("任务 daemon 与当前服务挂载不符");
  const launch = JSON.parse(manifest.value) as TaskLaunch, paths = new TaskPaths(launch, service.image);
  const expected = [{ manager: "/app/data", daemon: data }, ...(access.workspace ? [{ manager: "/app/workspace", daemon: access.workspace }] : [])];
  if (!dockerPath(launch.controlRoot) || !launch.controlRoot.startsWith("/app/data/") || paths.source("/app/data") !== expected[0]!.daemon
    || launch.mounts.length !== expected.length || expected.some(m => paths.source(m.manager) !== m.daemon)) throw new Error("任务清单的文件映射与当前部署不符");
  return access;
}
