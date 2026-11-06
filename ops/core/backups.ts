import { backupOptions } from "../lib/backup-options.ts";
import { runMaintenance } from "./maintenance.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";

export interface BackupRequest { action: "backup-scan" | "backup-clean"; args: string[] }
export function backupRequest(action: string, args: string[]): BackupRequest {
  if (action !== "backup-scan" && action !== "backup-clean") throw new Error("未知备份维护动作");
  const parsed = backupOptions([action === "backup-scan" ? "scan" : "apply", ...args]);
  return { action, args: parsed.normalized };
}
export async function runBackups(request: BackupRequest, options: MaintenanceHostOptions, signal?: AbortSignal, create = createMaintenanceHost) {
  const operation = maintenanceRequest(options.source, { command: request.action, intent: "service", label: request.action === "backup-scan" ? "扫描备份" : "清理备份", online: true });
  const context = create(options, operation);
  return runMaintenance(operation, context.host, {
    async prepare() { await context.prepare(); await context.prepareReports(); },
    async run(signal) { return (await context.data({ script: "ops/tools/backup-cleanup.ts", args: request.args, online: true, currentCode: true, reports: true }, signal)).code; },
  }, signal);
}
