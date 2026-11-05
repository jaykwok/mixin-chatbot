import { join } from "node:path";
import { capture } from "../shared/query.ts";
import { SOURCE_DIR } from "../shared/platform.ts";
import { ownsDataMount } from "../core/deployment-data.ts";

/** Only these read-only runtime helpers may run with deployed dependencies. Never takes a browser-supplied entry. */
export async function runtimeQuery(project: string, entry: "configuration-check" | "directory-query", action: string,
  input: unknown, signal?: AbortSignal, query = capture) {
  let command = process.execPath, argv = [join(SOURCE_DIR, `scripts/config/${entry}.ts`), action, project];
  if (process.platform !== "win32") {
    const inspected = await query("docker", ["container", "inspect", "mixin-chatbot"], { signal });
    if (inspected.code !== 0 || inspected.timedOut) throw new Error("请先完成部署；查询需要已部署的机器人镜像");
    const containers = JSON.parse(inspected.stdout), container = containers[0];
    if (containers.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(container?.Image) || !/^\d+(?::\d+)?$/.test(container?.Config?.User)
      || !ownsDataMount(project, container.Mounts)) throw new Error("机器人镜像或运行身份不属于此部署，未开始查询");
    command = "docker"; argv = ["run", "--rm", "-i", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=64m", "--user", container.Config.User,
      "-e", "HOME=/app/data/runtime/home", "-v", `${join(project, "data")}:/app/data:ro`, "-v", `${join(SOURCE_DIR, "scripts")}:/app/scripts:ro`,
      "-v", `${join(SOURCE_DIR, "src")}:/app/src:ro`,
      ...["pyproject.toml", "uv.lock", ".python-version"].flatMap(name => ["--mount", `type=bind,source=${join(SOURCE_DIR, name)},target=/app/${name},readonly`]),
      container.Image, "bun", "run", `scripts/config/${entry}.ts`, action, "/app"];
  }
  return query(command, argv, { input: input === undefined ? undefined : JSON.stringify(input), signal, timeout: 90_000 });
}
