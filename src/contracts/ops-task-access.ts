import { posix } from "node:path";

/** Non-secret, bounded native facts persisted for ownership verification when recovering a maintenance writer. */
export interface DockerDataAccess {
  workspace?: string;
  tasks?: { endpoint: string; daemon: string; uid: number };
}
export const dockerPath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && path !== "/"
  && posix.normalize(path) === path && !path.endsWith("/") && !/[,\x00-\x1f\x7f]/.test(path);
export function validateDockerDataAccess(value: unknown): asserts value is DockerDataAccess {
  const v = value as DockerDataAccess;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["workspace", "tasks"].includes(k))
    || Object.hasOwn(v, "workspace") && !dockerPath(v.workspace)
    || Object.hasOwn(v, "tasks") && (!v.tasks || typeof v.tasks !== "object" || Array.isArray(v.tasks)
      || Object.keys(v.tasks).sort().join(",") !== "daemon,endpoint,uid" || typeof v.tasks.endpoint !== "string" || !v.tasks.endpoint.startsWith("unix://")
      || !dockerPath(v.tasks.endpoint.slice(7)) || typeof v.tasks.daemon !== "string" || !/^[a-zA-Z0-9:._-]{1,128}$/.test(v.tasks.daemon)
      || !Number.isSafeInteger(v.tasks.uid) || v.tasks.uid < 1 || v.tasks.uid > 0xffffffff)) throw new Error("维护容器附加访问记录无效");
}
