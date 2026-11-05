import { DRAFT_NAME } from "../../config/runtime-draft.ts";
import { createMaintenanceHost, maintenanceRequest, type MaintenanceHostOptions } from "./maintenance-host.ts";
import { MaintenanceRefused, runMaintenance } from "./maintenance.ts";
import { maintenanceResult } from "./data-result.ts";
import { configurationStep } from "./configuration.ts";

export function runtimeRequest(args: string[]): string {
  if (args.length !== 1 || !DRAFT_NAME.test(args[0]!)) throw new Error("运行参数只接受一个已确认的草稿名称");
  return args[0]!;
}
export async function runRuntime(draft: string, options: MaintenanceHostOptions, signal?: AbortSignal, create = createMaintenanceHost) {
  runtimeRequest([draft]);
  const operation = maintenanceRequest(options.source, { command: "runtime-configure", intent: "configuration", label: "高级运行参数" });
  operation.configuration = "config-" + operation.id;
  const context = create(options, operation); let input: Uint8Array | undefined, digest = "";
  const call = async (action: string, signal?: AbortSignal) => {
    if (!input) throw new Error("运行参数尚未读取");
    return maintenanceResult(await context.data({ script: "scripts/config/runtime-apply.ts", args: [action, "--id", operation.configuration!, "--digest", digest, "--stdin", "--json"],
      input, currentCode: true, runtimeEnvironment: true, protocol: true, ...(action === "check" ? { readOnly: true } : {}) }, signal), action).code;
  };
  return runMaintenance(operation, context.host, {
    async prepare(signal) {
      await context.prepare(); ({ input, digest } = await context.prepareRuntimeInput(draft));
      if (await call("check", signal)) throw new MaintenanceRefused("运行参数预检未通过；请检查草稿、配置摘要和环境覆盖，机器人未停止");
    },
    run: signal => call("apply", signal),
    async recover() { if (await configurationStep(context, operation.configuration!, "restore")) throw new Error("原运行参数恢复失败，保留恢复材料"); },
    async complete() { if (await configurationStep(context, operation.configuration!, "finish")) throw new Error("运行参数收尾失败，保留恢复材料"); },
    finalize: () => context.finalizeRuntimeInput(),
  }, signal);
}
