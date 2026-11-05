// Shared execution policy for an already published deployment snapshot. Platform adapters perform individual effects;
// they do not choose rollback/startup order. Preflight and snapshot creation happen before this executor is entered.
import { MaintenanceRefused } from "./maintenance.ts";
import type { OpsResult } from "./result.ts";
import type { DeploymentState } from "./deployment-state.ts";
import { serializeTransactionRecord, TRANSACTION_NAME } from "./transaction-record.ts";
import { validateDeploymentCheckpoint, type DeploymentCheckpoint, type DeploymentDirection, type DeploymentStep } from "./deployment-contract.ts";
export type { DeploymentCheckpoint, DeploymentDirection, DeploymentStep } from "./deployment-contract.ts";
export interface DeploymentRequest {
  command: "deploy" | "repair" | "update" | "resume" | "rollback";
  action: "continue" | "rollback";
  snapshot: string;
  /** Digest of the fixed host orchestration package, not the mutable checkout. */
  runtime: string;
}
export interface DeploymentService {
  state: "running" | "stopped" | "absent";
  ready: boolean;
  role: "original" | "candidate" | "absent";
  owned: boolean;
}
export interface DeploymentHost {
  locked<T>(body: () => Promise<T>): Promise<T>;
  /** Verify confirmation, fixed runtime, project and snapshot identity under the deployment lock. No service/data writes. */
  verify(request: DeploymentRequest): Promise<void>;
  state(): Promise<DeploymentState>;
  checkpoint(): Promise<DeploymentCheckpoint | null>;
  save(checkpoint: DeploymentCheckpoint): Promise<void>;
  /** Reap the recorded native process/container, including a writer surviving a killed host. Never guess from a PID. */
  reap(): Promise<void>;
  inspect(): Promise<DeploymentService>;
  preflight(direction: DeploymentDirection, signal?: AbortSignal): Promise<void>;
  /** Resolves only after observing a complete successful result and collecting its writer; otherwise throws. */
  perform(step: DeploymentStep, signal?: AbortSignal): Promise<void>;
  /** Fresh on-disk maintenance assessment, ignoring only the caller's own deployment pointer. */
  assess(intent: "verification" | "commit" | "candidate" | "original"): Promise<void>;
  waitReady(role: "verification" | "candidate" | "original", signal?: AbortSignal): Promise<boolean>;
  /** Operator progress only, never part of the outcome. */
  notice?(message: string): void;
  /** Persist the result before closing pointers. completion is omitted when recovery materials must remain. */
  finish(result: OpsResult, completion?: DeploymentDirection): Promise<void>;
}

/** Clauses are joined with "；": a reason's own closing full stop would otherwise stand before the separator. */
const clause = (text: string) => text.replace(/。$/, "");
const message = (error: unknown) => error instanceof Error ? error.message : "部署步骤没有可核对的结果";
const finalState = (facts: DeploymentService): OpsResult["finalState"] => !facts.owned ? "unknown"
  : facts.state === "running" ? facts.ready ? "running" : "start-requested" : "stopped";
/** The operator's closing line. An upgrade names its commits, as the entries did before the shared core. */
const conclusion = (state: DeploymentState, action: DeploymentRequest["action"]) => {
  const original = state.record.original_sha.slice(0, 7), target = state.record.target_sha.slice(0, 7);
  if (state.operation !== "upgrade") return action === "rollback" ? "部署已回滚" : "部署已完成";
  return action === "rollback" ? `升级已回滚：代码恢复到 ${original}，数据、配置和原运行状态已恢复` : `升级完成：${original} -> ${target}`;
};

export async function runDeployment(request: DeploymentRequest, host: DeploymentHost, signal?: AbortSignal): Promise<OpsResult> {
  const base: OpsResult = { protocol: "mixin-ops", version: 1, command: request.command, outcome: "refused", wasRunning: false,
    finalState: "unknown", exitCode: 1, message: "" };
  try {
    if (!TRANSACTION_NAME.test(request.snapshot) || !/^[a-f0-9]{64}$/.test(request.runtime)
      || !["deploy", "repair", "update", "resume", "rollback"].includes(request.command) || !["continue", "rollback"].includes(request.action)
      || (request.command === "rollback") !== (request.action === "rollback")) throw new MaintenanceRefused("部署执行请求无效");
    return await host.locked(async () => {
      // mutation: the transaction holds changes, from this run or an earlier one. effected: this run performed a step itself.
      let initial: DeploymentState | undefined, mutation = false, effected = false, direction: DeploymentDirection = "forward", completion: DeploymentDirection | undefined;
      let opened = false;
      let result = { ...base };
      const failed = (error: unknown) => {
        result = { ...result, outcome: !mutation && error instanceof MaintenanceRefused ? "refused" : "failed",
          exitCode: signal?.aborted ? 130 : error instanceof MaintenanceRefused ? error.exitCode : 1, message: message(error) };
      };
      const state = async () => {
        const value = await host.state();
        if (value.snapshot !== request.snapshot || initial && serializeTransactionRecord(value.record) !== serializeTransactionRecord(initial.record))
          throw new Error("部署选择或快照已变化，未继续操作");
        return value;
      };
      const inspect = async () => {
        const value = await host.inspect();
        if (!value.owned || (value.state === "absent") !== (value.role === "absent")) throw new Error("实例归属或状态无法确认，未继续操作");
        return value;
      };
      const step = async (name: DeploymentStep, cancellation?: AbortSignal) => {
        cancellation?.throwIfAborted(); const current = await state();
        const afterCommit = ["retire-previous-writers", "disable-verification", "start-candidate", "publish-target"].includes(name);
        if (direction === "rollback" ? current.committed : current.committed !== afterCommit)
          throw new Error("磁盘提交边界不允许当前部署步骤，事务已保留");
        // All mutation intent is durable before its native effect. A failed save cannot authorize that effect.
        await host.save({ version: 1, snapshot: request.snapshot, runtime: request.runtime, direction, step: name });
        mutation = effected = true; await host.perform(name, cancellation);
        if (name === "prepare-data" && (await state()).dataPhase !== "prepared") throw new Error("数据准备未留下完整回执，未启动验证实例");
      };
      const stop = async (cancellation?: AbortSignal) => {
        await inspect(); await step("stop", cancellation);
        if ((await inspect()).state === "running") throw new Error("停止请求结束后实例仍在运行，未继续改动数据");
      };
      const ready = async (role: "candidate" | "original", running: boolean, cancellation?: AbortSignal) => {
        const before = await inspect();
        if (before.role !== role && !(role === "original" && !running && before.role === "absent")) throw new Error("恢复的实例不是记录的目标身份");
        if (!running) {
          if (before.state === "running") throw new Error("实例意外运行，不能报告保持停止");
          return;
        }
        await host.assess(role); await state();
        // A running but unready instance is a supervisor or restart policy retrying a failed start; the service refuses those
        // retries until this step's checkpoint is saved, so start it again under the checkpoint (the platform restarts it).
        if (before.state !== "running" || !before.ready) await step(role === "candidate" ? "start-candidate" : "start-original", cancellation);
        if (!await host.waitReady(role, cancellation)) throw new Error("已请求启动，实例身份与就绪检查尚未通过");
        const after = await inspect();
        if (after.role !== role || after.state !== "running" || !after.ready) throw new Error("就绪检查后实例状态已变化，不能报告运行中");
      };
      const rollback = async (restored = false, automatic = false) => {
        // Ordinary cancellation cannot interrupt restoration. A later hard kill resumes from these same checkpoints.
        direction = "rollback";
        // An explicit rollback refuses conflicting code before any new effect. During automatic failure recovery,
        // first settle the data work already attempted, then refuse overwriting an operator's concurrent code changes.
        if (!automatic) await host.preflight(direction);
        if ((await state()).committed) throw new Error("数据已经提交，只能继续完成新实例启动，禁止回滚");
        if (restored && (await state()).dataPhase !== "unprepared") throw new Error("恢复完成标记与数据状态不符，事务已保留");
        if (!restored) {
          await stop(); await step("settle-revisions");
          if ((await state()).committed) throw new Error("数据已经提交，禁止恢复旧数据");
          await step("restore-data");
          if ((await state()).dataPhase !== "unprepared") throw new Error("数据恢复尚未完成，未恢复旧代码或启动服务");
          await step("disable-verification");
          if (automatic) await host.preflight(direction);
          await step("restore-code");
          await step("restore-dependencies"); await step("restore-configuration"); await step("restore-service");
        }
        await ready("original", initial!.record.was_running === "1");
        if ((await state()).dataPhase !== "unprepared") throw new Error("数据恢复状态发生变化，事务已保留");
        completion = "rollback";
      };
      try {
        signal?.throwIfAborted(); await host.verify(request);
        initial = await state(); result.wasRunning = initial.record.was_running === "1";
        const saved = await host.checkpoint();
        if (saved) {
          validateDeploymentCheckpoint(saved);
          if (saved.snapshot !== request.snapshot || saved.runtime !== request.runtime) throw new MaintenanceRefused("请使用此事务固定的运维运行包恢复");
          direction = saved.direction; mutation = true;
        }
        // A data child may have committed after its host died. Reap first, then read the authoritative commit receipt.
        await host.reap(); opened = true; const current = await state();
        if (request.action === "rollback") {
          if (current.committed) throw new MaintenanceRefused("数据已提交，不能回滚；请继续完成新实例启动和收尾");
          await rollback(saved?.direction === "rollback" && saved.step === "start-original"
            || current.execution?.completion === "rollback");
        } else {
          if (direction === "rollback") throw new MaintenanceRefused("上次操作已经开始回滚，请完成回滚，不能继续发布");
          await host.preflight("forward", signal); signal?.throwIfAborted();
          if (!current.committed) {
            await stop(signal);
            for (const name of ["switch-code", "prepare-dependencies", "configure-runtime", "configure-app", "configure-models", "configure-directory",
              "prepare-data", "cleanup-revisions", "enable-verification", "install-candidate"] as const) await step(name, signal);
            const candidate = await inspect();
            if (candidate.role !== "candidate" || candidate.state !== "stopped") throw new Error("验证实例的身份或停止状态不符");
            await host.assess("verification"); await step("start-verification", signal);
            if (!await host.waitReady("verification", signal)) throw new Error("验证实例未就绪，未提交数据");
            if ((await inspect()).role !== "candidate") throw new Error("验证实例已被替换，未提交数据");
            await stop(signal); await host.assess("commit"); await step("commit-data", signal);
            if (!(await state()).committed) throw new Error("数据步骤未留下本事务的完整提交回执");
          }
          // No data apply/cleanup/install on committed resume, and no rollback after this boundary.
          await step("retire-previous-writers", signal); await step("disable-verification", signal);
          await ready("candidate", initial.operation === "deploy" || result.wasRunning, signal);
          await step("publish-target", signal);
          if (!(await state()).committed) throw new Error("提交回执在启动期间变化，事务已保留");
          completion = "forward";
        }
        result = { ...result, outcome: "success", exitCode: 0, message: conclusion(initial, request.action) };
      } catch (error) {
        failed(error);
        // Never interpret unreadable state or a failed command as "not committed". Reap failure also forbids restoration.
        // Only a failure after this run's own first step rolls back automatically: a resume refused by its preflight leaves the
        // transaction as the earlier run left it, to fix and resume or to roll back explicitly.
        if (opened && effected && direction === "forward" && initial && request.action !== "rollback") {
          try {
            await host.reap(); const current = await state();
            if (!current.committed) {
              // The cause comes first: otherwise the operator watches the restoration steps without knowing why.
              host.notice?.(`${clause(result.message)}；正在自动恢复到操作前的状态`);
              await rollback(false, true); result.message = clause(result.message) + "；已自动恢复到操作前的状态";
            }
          } catch (recovery) { result.message = clause(result.message) + "；恢复未完成：" + message(recovery); }
        }
      }
      try {
        const facts = await inspect(); result.finalState = finalState(facts);
        // Stopped before the transaction was read: nothing changed, so the instance is still as this run found it.
        if (!initial) result.wasRunning = facts.state === "running";
        if (completion) {
          const expectedRunning = completion === "forward" ? initial!.operation === "deploy" || result.wasRunning : result.wasRunning;
          const expectedRole = completion === "forward" ? "candidate" : "original";
          if (expectedRunning ? facts.state !== "running" || !facts.ready || facts.role !== expectedRole : facts.state === "running")
            throw new Error("最终运行状态不符，事务已保留");
        }
      } catch (error) {
        completion = undefined; result.finalState = "unknown";
        // A refusal before any change stays a refusal with its own reason: the unconfirmed state is no failure of this run.
        const keep = !mutation && result.outcome === "refused";
        const reason = keep ? "" : clause(result.message); if (!keep) failed(error);
        if (reason && reason !== result.message) result.message = reason + "；最终状态：" + result.message;
      }
      try { await host.finish(result, completion); }
      catch { result = { ...result, outcome: "failed", exitCode: result.exitCode || 1, message: "部署结果或事务收尾无法落盘，请核对磁盘状态后继续恢复" }; }
      return result;
    });
  } catch (error) {
    return { ...base, outcome: error instanceof MaintenanceRefused ? "refused" : "failed",
      exitCode: error instanceof MaintenanceRefused ? error.exitCode : 1, message: message(error) };
  }
}
