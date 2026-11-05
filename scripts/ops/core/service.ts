import { MaintenanceRefused, type MaintenanceHost, type ServiceFacts } from "./maintenance.ts";
import type { OpsResult } from "./result.ts";

export type ServiceAction = "start" | "stop" | "restart" | "repair";
export type ServiceControlHost = Pick<MaintenanceHost, "locked" | "verify" | "inspect" | "assess" | "stop" | "start" | "waitReady" | "finish">;
const stateOf = (facts: ServiceFacts): OpsResult["finalState"] => !facts.owned || facts.state === "unsupported" ? "unknown"
  : facts.state === "running" ? facts.ready ? "running" : "start-requested" : "stopped";

/** Service controls have no data step or automatic rollback; stop also works with a pending deployment transaction.
 * Repair (Windows) restarts only an instance that is not ready, including a stopped one; a ready instance is left alone. */
export async function runServiceCommand(action: ServiceAction, host: ServiceControlHost, signal?: AbortSignal): Promise<OpsResult> {
  let result: OpsResult = { protocol: "mixin-ops", version: 1, command: action, outcome: "refused", wasRunning: false,
    finalState: "unknown", exitCode: 1, message: "" };
  let original: ServiceFacts | undefined, mutated = false;
  const fail = (error: unknown) => {
    result = { ...result, outcome: !mutated && error instanceof MaintenanceRefused ? "refused" : "failed",
      exitCode: signal?.aborted ? 130 : 1, message: error instanceof Error ? error.message : "服务操作没有完整结果" };
  };
  const settle = async () => {
    try { await host.finish(result); }
    catch { result = { ...result, outcome: "failed", exitCode: result.exitCode || 1, message: "服务操作结果无法落盘，请核对实际运行状态" }; }
    return result;
  };
  const inspectSame = async () => {
    const facts = await host.inspect();
    if (!facts.owned || (facts.state === "unsupported" && action !== "stop") || original && facts.identity !== original.identity)
      throw new MaintenanceRefused("部署身份或运行方式已变化，未继续操作实例");
    return facts;
  };
  try {
    return await host.locked(async () => {
      try {
        signal?.throwIfAborted(); await host.verify(); original = await inspectSame();
        result.wasRunning = original.state === "running";
        if (action !== "stop") {
          if (original.pending) throw new MaintenanceRefused("存在未完成的部署或升级，请先继续或回滚");
          if (original.state === "absent") throw new MaintenanceRefused("机器人尚未部署，不能启动");
          await host.assess("service");
        }
        signal?.throwIfAborted();
        if (action === "repair" && original.state === "running" && original.ready) {
          result = { ...result, outcome: "success", exitCode: 0, finalState: "running", message: "本机实例已就绪，没有需要修复的项（未重启）" };
          return await settle();
        }
        if (action !== "start" && (original.state === "running" || action === "stop" && original.state === "unsupported")) {
          mutated = true; await host.stop();
          if ((await inspectSame()).state === "running") throw new Error("停止请求后实例仍在运行");
        }
        signal?.throwIfAborted();
        if (action !== "stop") {
          const fresh = await inspectSame();
          if (fresh.pending) throw new MaintenanceRefused("部署状态已变化，未继续启动");
          // Restart re-reads disk permission after stop, not just before the first effect.
          if (action === "restart" || action === "repair") await host.assess("service");
          if (fresh.state !== "running") { mutated = true; await host.start(); }
          if (!(await host.waitReady())) throw new Error("已请求启动，实例身份与就绪检查尚未通过");
          signal?.throwIfAborted();
        }
        const final = await inspectSame(); result.finalState = stateOf(final);
        if (result.finalState !== (action === "stop" ? "stopped" : "running")) throw new Error("最终运行状态与请求不一致");
        result = { ...result, outcome: "success", exitCode: 0, message: action === "stop" ? "机器人已停止" : "机器人运行中（实例身份与就绪检查通过）" };
      } catch (error) {
        fail(error);
        try { result.finalState = stateOf(await inspectSame()); } catch { result.finalState = "unknown"; }
      }
      return await settle();
    });
  } catch (error) { fail(error); return result; }
}
