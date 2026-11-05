import { cliArgs } from "../../lib/cli.ts";
import { runMaintenance } from "./maintenance.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";

export interface HistoryRequest { action: "history-clear" | "history-compact"; args: string[]; expected?: string }
export function historyRequest(action: string, args: string[]): HistoryRequest {
  if (action !== "history-clear" && action !== "history-compact") throw new Error("未知会话维护动作");
  const parsed = cliArgs(args, { all: { type: "boolean" }, direct: { type: "boolean" }, "storage-segment": { type: "boolean" },
    "group-id": { type: "boolean" }, expect: { type: "string" } });
  const { values, positionals } = parsed;
  if (values.all && (values.direct || action === "history-compact") || values["storage-segment"] && values["group-id"]
    || (values.all || values.direct) && (values["storage-segment"] || values["group-id"])) throw new Error("会话选择参数冲突");
  if (values.expect !== undefined && !/^[a-f0-9]{64}$/.test(values.expect)) throw new Error("--expect 需要 SHA-256 摘要");
  const count = (values.all || values.direct ? 0 : 1) + (action === "history-compact" ? 1 : 0);
  if (positionals.length !== count || positionals.some(value => !value || value.startsWith("-") || /[\x00-\x1f]/.test(value))) throw new Error("会话维护需要明确的空间及对应成员，不接受多余参数");
  const selected = values.all ? "--all" : values.direct ? "--direct" : positionals[0]!;
  const normalized = [selected, ...(action === "history-compact" ? [positionals.at(-1)!] : []),
    ...(values["storage-segment"] ? ["--storage-segment"] : values["group-id"] ? ["--group-id"] : [])];
  return { action, args: normalized, ...(values.expect ? { expected: values.expect } : {}) };
}

export async function runHistory(request: HistoryRequest, options: MaintenanceHostOptions, signal?: AbortSignal,
  create = createMaintenanceHost) {
  const operation = maintenanceRequest(options.source, { command: request.action, intent: "conversation-write",
    label: request.action === "history-clear" ? "清空会话历史" : "登记成员压缩" });
  const context = create(options, operation);
  return runMaintenance(operation, context.host, {
    prepare: context.prepare,
    async run(signal) {
      const args = [request.action === "history-clear" ? "clear" : "compact", ...request.args,
        ...(request.expected ? ["--expect", request.expected] : [])];
      return (await context.data({ script: "scripts/ops/history-admin.ts", args }, signal)).code;
    },
  }, signal);
}
