import { tmpOptions } from "../lib/tmp-options.ts";
import { runMaintenance } from "./maintenance.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";

export const TMP_ACTIONS = ["tmp-ls", "tmp-preview", "tmp-purge", "tmp-reclaim", "tmp-discard"] as const;
export interface TmpRequest { action: typeof TMP_ACTIONS[number]; args: string[]; mutating: boolean }
export function tmpRequest(action: string, args: string[]): TmpRequest {
  if (!TMP_ACTIONS.includes(action as TmpRequest["action"])) throw new Error("未知临时文件动作");
  const parsed = tmpOptions([action === "tmp-ls" ? "list" : action.slice(4), ...args], true);
  return { action: action as TmpRequest["action"], args: parsed.normalized, mutating: parsed.mutating };
}

export async function runTmp(request: TmpRequest, options: MaintenanceHostOptions, signal?: AbortSignal, create = createMaintenanceHost) {
  const operation = maintenanceRequest(options.source, { command: request.action, intent: "service", label: request.mutating ? "临时文件维护" : "临时文件查询",
    ...(!request.mutating ? { online: true } : {}) });
  const context = create(options, operation);
  return runMaintenance(operation, context.host, {
    async prepare() { await context.prepare(); await context.prepareTaskAccess(); },
    async run(signal) { return (await context.data({ script: "ops/tools/tmp-admin.ts", args: request.args, readOnly: !request.mutating }, signal)).code; },
  }, signal);
}
