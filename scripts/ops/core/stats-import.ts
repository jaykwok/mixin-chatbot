import { resolve } from "node:path";
import { cliArgs } from "../../lib/cli.ts";
import { runMaintenance } from "./maintenance.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";

export interface StatsImportRequest { source: string; expected?: string }
export function statsImportRequest(args: string[]): StatsImportRequest {
  const { values, positionals } = cliArgs(args, { expect: { type: "string" } });
  if (positionals.length !== 1 || !positionals[0] || positionals[0].startsWith("-") || /[\x00-\x1f]/.test(positionals[0])) throw new Error("统计导入需要一个文件路径，不接受多余参数");
  if (values.expect !== undefined && !/^[a-f0-9]{64}$/.test(values.expect)) throw new Error("--expect 需要 SHA-256 摘要");
  return { source: resolve(positionals[0]), ...(values.expect ? { expected: values.expect } : {}) };
}

export async function runStatsImport(request: StatsImportRequest, options: MaintenanceHostOptions, signal?: AbortSignal, create = createMaintenanceHost) {
  const operation = maintenanceRequest(options.source, { command: "stat-import", intent: "service", label: "导入统计" });
  const context = create(options, operation);
  let input: { path: string; digest: string } | undefined;
  return runMaintenance(operation, context.host, {
    async prepare(signal) { await context.prepare(); input = await context.prepareImport(request.source, request.expected, signal); },
    async run(signal) {
      if (!input) throw new Error("统计导入没有经核对的副本");
      return (await context.data({ script: "scripts/ops/stats-import.ts", args: [input.path, "--expect", input.digest] }, signal)).code;
    },
    finalize: context.finalizeImport,
  }, signal);
}
