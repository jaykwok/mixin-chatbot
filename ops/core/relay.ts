import { relayOptions } from "../lib/relay-options.ts";
import { runMaintenance } from "./maintenance.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";

export interface RelayRequest { action: "relay-ls" | "relay-test" | "relay-purge"; args: string[]; online: boolean }
export function relayRequest(action: string, args: string[]): RelayRequest {
  if (action !== "relay-ls" && action !== "relay-test" && action !== "relay-purge") throw new Error("未知外链维护动作");
  const parsed = relayOptions([action === "relay-ls" ? "list" : action.slice(6), ...args]);
  return { action, args: parsed.normalized, online: action !== "relay-purge" };
}
export async function runRelay(request: RelayRequest, options: MaintenanceHostOptions, signal?: AbortSignal, create = createMaintenanceHost) {
  const operation = maintenanceRequest(options.source, { command: request.action, intent: "service", label: request.action === "relay-purge" ? "清理外链" : request.action === "relay-test" ? "测试外链" : "查询外链",
    ...(request.online ? { online: true } : {}) });
  const context = create(options, operation), script = "ops/tools/relay-admin.ts";
  return runMaintenance(operation, context.host, {
    async prepare(signal) {
      await context.prepare();
      if ((await context.data({ script, args: ["check", ...request.args], readOnly: true, currentCode: true }, signal)).code !== 0) throw new Error("外链预检未通过，未停止机器人");
    },
    async run(signal) { return (await context.data({ script, args: request.args, currentCode: true,
      ...(request.online ? { online: true } : {}), ...(request.action !== "relay-ls" ? { network: "service" as const } : {}) }, signal)).code; },
  }, signal);
}
