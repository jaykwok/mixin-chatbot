import { parseOptions } from "../../lib/maintenance-protocol.ts";
import { REVISION_SPECS } from "../../lib/revision-options.ts";
import { spaceName } from "../../../src/durable/read/protocol.ts";
import { MaintenanceRefused, runMaintenance, type MaintenanceRequest } from "./maintenance.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";
import { maintenanceResult as revisionResult } from "./data-result.ts";

const INTENTS = { apply: "cleanup", skip: "skip", abandon: "rollback", restore: "restore", shrink: "shrink" } as const;
export interface RevisionRequest { action: keyof typeof INTENTS; args: string[]; intent: MaintenanceRequest["intent"] }
export function revisionRequest(action: string, args: string[]): RevisionRequest {
  if (!Object.hasOwn(INTENTS, action)) throw new Error("此入口只接受 apply、skip、abandon、restore 或 shrink");
  const parsed = parseOptions(action, args, { ...REVISION_SPECS[action], flags: [], values: REVISION_SPECS[action]!.values?.filter(value => value !== "--project") });
  for (const value of parsed.values.get("--space") ?? []) spaceName(value);
  return { action: action as RevisionRequest["action"], args, intent: INTENTS[action as RevisionRequest["action"]] };
}

export async function runRevision(request: RevisionRequest, options: MaintenanceHostOptions, signal?: AbortSignal,
  create = createMaintenanceHost) {
  const operation = maintenanceRequest(options.source, { command: "revision-cleanup", intent: request.intent, label: `revision-cleanup ${request.action}` });
  const context = create(options, operation);
  const call = async (action: string, args: string[], readOnly: boolean, signal?: AbortSignal) => revisionResult(await context.data({
    script: "scripts/runtime/revision-cleanup.ts", args: [action, "--project", context.dataProject(), ...args, "--json"], readOnly, protocol: true,
  }, signal), action);
  return runMaintenance(operation, context.host, {
    async prepare(signal) {
      await context.prepare();
      if (request.action !== "shrink") await context.prepareCleanupBackups();
      if (request.action === "apply") {
        const preview = await call("preview", [], true, signal);
        if (preview.code !== 0) throw new MaintenanceRefused("修订整理预检未完成，机器人未停止", preview.code);
        const { backupBytes, walBytes } = (preview.data ?? {}) as Record<string, unknown>;
        if (![backupBytes, walBytes].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw new Error("修订整理预检缺少空间需求");
        const space = await call("space", ["--backup-bytes", String(backupBytes), "--wal-bytes", String(walBytes)], true, signal);
        if (space.code !== 0) throw new MaintenanceRefused("修订整理空间检查未通过；请释放空间或显式跳过，机器人未停止", space.code);
      }
    },
    async run(signal) { return (await call(request.action, request.args, false, signal)).code; },
  }, signal);
}
