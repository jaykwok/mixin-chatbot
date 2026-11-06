// The shared policy for a stop/data/restore operation. Adapters supply effects, not a second ordering/recovery policy.
import type { MaintenanceIntent } from "../../src/core/maintenance-state.ts";
import type { MaintenanceCheckpoint, MaintenanceRequest, ServiceFacts } from "../../src/core/ops-maintenance-state.ts";
import type { OpsResult } from "./result.ts";

export type { MaintenanceCheckpoint, MaintenanceRequest, ServiceFacts };

export interface MaintenanceHost {
  /** Holds the existing platform deployment lock until the body and result publication have finished. */
  locked<T>(body: () => Promise<T>): Promise<T>;
  verify(): Promise<void>;
  inspect(): Promise<ServiceFacts>;
  /** Re-read disk state each time; never use a data child's result as startup permission. */
  assess(intent: MaintenanceIntent): Promise<void>;
  save(checkpoint: MaintenanceCheckpoint): Promise<void>;
  stop(): Promise<void>;
  start(): Promise<void>;
  waitReady(): Promise<boolean>;
  /** Atomically closes this operation's checkpoint and publishes its complete result. Failure must retain recovery evidence. */
  finish(result: OpsResult): Promise<void>;
}
export interface MaintenanceWork {
  prepare?(signal?: AbortSignal): Promise<void>;
  /** The adapter owns cancellation/child supervision and resolves only once no writer remains. */
  run(signal?: AbortSignal): Promise<number>;
  recover?(): Promise<void>;
  /**
   * After the restart that follows a successful action is ready: proves the change works (new app credentials connected).
   * A failure is handled like a failed start: recover, then start again without this check.
   */
  started?(): Promise<void>;
  complete?(): Promise<void>;
  /** Settle owned temporary inputs even if preflight failed; must refuse while any data writer remains. */
  finalize?(): Promise<void>;
}

export class MaintenanceRefused extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    if (!Number.isSafeInteger(exitCode) || exitCode < 1 || exitCode > 255) throw new Error("拒绝结果必须有非零退出码");
  }
}
/** Checks under the lock before any change (console task, confirmed plan): whatever stops them, nothing was done. */
export async function refusing<T>(check: () => Promise<T>): Promise<T> {
  try { return await check(); }
  catch (error) { throw error instanceof MaintenanceRefused ? error : new MaintenanceRefused(error instanceof Error ? error.message : "复核未通过，未执行操作"); }
}
const exit = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new Error("维护步骤没有有效退出码");
  return value;
};
const detail = (error: unknown) => error instanceof Error ? error.message : "维护步骤没有返回可核对的结果";
const finalState = (facts: ServiceFacts): OpsResult["finalState"] => !facts.owned || facts.state === "unsupported" ? "unknown"
  : facts.state === "running" ? facts.ready ? "running" : "start-requested" : "stopped";

/** Recovery is shielded from ordinary cancellation. Hard-kill recovery is a separate entry using save()'s durable state. */
export async function runMaintenance(request: MaintenanceRequest, host: MaintenanceHost, work: MaintenanceWork, signal?: AbortSignal): Promise<OpsResult> {
  const base: OpsResult = { protocol: "mixin-ops", version: 1, command: request.command, outcome: "refused", wasRunning: false,
    finalState: "unknown", exitCode: 1, message: "" };
  try {
    return await host.locked(async () => {
      let original: ServiceFacts | undefined, stopAttempted = false, actionStarted = false, recovered = false, recoveryOkay = true;
      let result = { ...base }, mutated = false;
      const fail = (error: unknown, code = 1) => {
        result.exitCode = !mutated && error instanceof MaintenanceRefused && !signal?.aborted ? error.exitCode : result.exitCode || code;
        result.outcome = mutated || !(error instanceof MaintenanceRefused) ? "failed" : "refused";
        result.message = detail(error);
      };
      const checkpoint = async (phase: MaintenanceCheckpoint["phase"]) => {
        if (!original) throw new Error("维护尚未核对原运行状态");
        await host.save({ version: 1, request: { ...request }, original: { ...original }, phase });
      };
      const inspectSame = async () => {
        const facts = await host.inspect();
        if (!facts.owned || !original || facts.identity !== original.identity || facts.state === "unsupported")
          throw new MaintenanceRefused("部署身份或运行方式已变化，保留恢复材料；未继续操作实例");
        return facts;
      };
      const stop = async () => {
        await inspectSame(); await checkpoint("stopping");
        stopAttempted = true; mutated = true;
        await host.stop();
        if ((await inspectSame()).state === "running") throw new Error("停止请求结束后实例仍在运行，未执行数据步骤");
      };
      const recover = async () => {
        try {
          if ((await inspectSame()).state === "running") await stop();
          await checkpoint("recovering"); await work.recover!(); recovered = true;
        } catch (error) { recoveryOkay = false; fail(error); }
      };
      const restart = async () => {
        // The assessment is repeated even after a successful rollback of configuration.
        await inspectSame(); await host.assess("service"); await checkpoint("starting");
        await host.start();
        if (!(await host.waitReady())) throw new Error("已请求启动，实例身份与就绪检查尚未通过");
        const after = await inspectSame();
        if (after.state !== "running" || !after.ready) throw new Error("就绪检查后实例状态已变化，不能报告运行中");
        if (actionStarted && !recovered) await work.started?.();
      };
      try {
        signal?.throwIfAborted(); await host.verify();
        original = { ...await host.inspect() };
        if (!original.owned || original.state === "unsupported") throw new MaintenanceRefused("实例不属于当前部署或运行方式不支持自动恢复");
        result.wasRunning = original.state === "running";
        if (original.pending) throw new MaintenanceRefused("存在未完成的部署或升级，请先继续或回滚；未停止机器人");
        await checkpoint("prepared");
        await work.prepare?.(signal); signal?.throwIfAborted();
        // The deployment lock protects cooperating operations; also detect a changed external instance before stopping.
        const fresh = await inspectSame();
        if (fresh.state !== original.state || fresh.pending) throw new MaintenanceRefused("预检期间运行状态已变化，请重新预览");
        if (result.wasRunning) { await host.assess(request.intent); signal?.throwIfAborted(); if (!request.online) await stop(); }
        signal?.throwIfAborted(); await checkpoint("acting");
        actionStarted = true; mutated = true; result.outcome = "failed";
        result.exitCode = exit(await work.run(signal));
        if (signal?.aborted && result.exitCode === 0) result.exitCode = 130;
        if (result.exitCode !== 0) result.message = `${request.label}未完成（退出码 ${result.exitCode}）`;
      } catch (error) { if (signal?.aborted) result.exitCode = 130; fail(error); }

      if (result.exitCode !== 0 && actionStarted && work.recover) await recover();
      if (stopAttempted && result.wasRunning && recoveryOkay) {
        try { await restart(); }
        catch (error) {
          fail(error);
          if (actionStarted && work.recover && !recovered) {
            await recover();
            if (recoveryOkay) { try { await restart(); } catch (again) { fail(again); } }
          }
        }
      }
      if (actionStarted && recoveryOkay && work.complete && (result.exitCode === 0 || recovered)) {
        try { await checkpoint("completing"); await work.complete(); } catch (error) { fail(error); }
      }
      try { await work.finalize?.(); } catch (error) { fail(error); }
      try {
        // Before any change the instance is only described: identity checks guard the one this run touched, and a refusal
        // or early failure keeps its own reason when the final read does not succeed.
        const facts = mutated ? await inspectSame() : await host.inspect(); result.finalState = finalState(facts);
        if (result.exitCode === 0 && (result.finalState === "unknown" || (result.wasRunning
          ? result.finalState !== "running" : facts.state === "running"))) fail(new Error("最终运行状态与维护前不一致，不能报告成功"));
      } catch (error) { result.finalState = "unknown"; if (mutated || result.exitCode === 0) fail(error); }
      if (result.exitCode === 0) result = { ...result, outcome: "success", message: `${request.label}已完成` };
      try { await host.finish(result); }
      catch { result = { ...result, outcome: "failed", exitCode: result.exitCode || 1, message: "维护结果无法落盘，保留恢复材料，请核对实际状态" }; }
      return result;
    });
  } catch (error) {
    return { ...base, outcome: error instanceof MaintenanceRefused ? "refused" : "failed",
      exitCode: error instanceof MaintenanceRefused ? error.exitCode : 1, message: detail(error) };
  }
}
