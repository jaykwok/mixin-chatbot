import { join } from "node:path";
import { capture } from "./query.ts";
import { SOURCE_DIR } from "../../ops/core/platform.ts";
import { ownsDataMount } from "../../ops/core/deployment-data.ts";
import { accountIdentity, type Identity, LaunchdPlatform, SERVICE_ACCOUNT, serviceEnvironment, type ServiceDefinition } from "../../ops/core/launchd-host.ts";

/** Where the helpers run: the platform, and on macOS the service account and the installed LaunchDaemon's definition. */
export interface QueryHost { platform: NodeJS.Platform; service(project: string): Promise<{ account: Identity; definition: ServiceDefinition } | null> }
export const localHost: QueryHost = {
  platform: process.platform,
  service: async project => {
    const [account, definition] = [await accountIdentity(SERVICE_ACCOUNT), await new LaunchdPlatform(project).serviceDefinition()];
    return account && definition ? { account, definition } : null;
  },
};

/** Only these read-only runtime helpers may run with deployed dependencies. Never takes a browser-supplied entry. */
export async function runtimeQuery(project: string, entry: "configuration-check" | "directory-query", action: string,
  input: unknown, signal?: AbortSignal, query = capture, host = localHost) {
  let command = process.execPath, argv = [join(SOURCE_DIR, `ops/config/${entry}.ts`), action, project];
  if (host.platform === "darwin") {
    // As the service account, with the service's Bun and PATH: the root console must not open its files as root.
    const service = await host.service(project);
    if (!service) throw new Error("请先完成部署；查询以服务账户运行");
    const { account, definition } = service;
    argv = ["--no-env-file", join(SOURCE_DIR, "ops/core/macos-become.ts"), String(account.uid), String(account.gid), "--", definition.args[0]!, "--no-env-file", ...argv];
    return query(command, argv, { input: input === undefined ? undefined : JSON.stringify(input), signal, timeout: 90_000,
      env: { ...serviceEnvironment(project), PATH: definition.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" } });
  }
  if (host.platform !== "win32") {
    const inspected = await query("docker", ["container", "inspect", "mixin-bot"], { signal });
    if (inspected.code !== 0 || inspected.timedOut) throw new Error("请先完成部署；查询需要已部署的机器人镜像");
    const containers = JSON.parse(inspected.stdout), container = containers[0];
    if (containers.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(container?.Image) || !/^\d+(?::\d+)?$/.test(container?.Config?.User)
      || !ownsDataMount(project, container.Mounts)) throw new Error("机器人镜像或运行身份不属于此部署，未开始查询");
    command = "docker"; argv = ["run", "--rm", "-i", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777,size=64m", "--user", container.Config.User,
      "-e", "HOME=/app/data/runtime/home", "-v", `${join(project, "data")}:/app/data:ro`, "-v", `${join(SOURCE_DIR, "ops")}:/app/ops:ro`,
      "-v", `${join(SOURCE_DIR, "src")}:/app/src:ro`,
      ...["pyproject.toml", "uv.lock", ".python-version"].flatMap(name => ["--mount", `type=bind,source=${join(SOURCE_DIR, name)},target=/app/${name},readonly`]),
      container.Image, "bun", "run", `ops/config/${entry}.ts`, action, "/app"];
  }
  return query(command, argv, { input: input === undefined ? undefined : JSON.stringify(input), signal, timeout: 90_000 });
}
