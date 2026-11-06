// Deployment recovery previews use the exact persisted transaction, never browser-supplied paths or argv.
import { confirmTransaction } from "../lib/confirmed-transaction.ts";
import { describePendingTransaction, loadPendingTransaction } from "./pending-transaction.ts";
import { runCommand, type Runner } from "./hosting.ts";

export type RecoveryOperation = "resume" | "rollback";
const action = (operation: RecoveryOperation) => operation === "resume" ? "continue" : "rollback";

export function recoveryView(project: string) {
  const pending = loadPendingTransaction(project);
  return pending ? { ...describePendingTransaction(pending), committed: pending.committed,
    canResume: !pending.rollbackPending, canRollback: !pending.committed } : null;
}

export function recoveryPlan(project: string, operation: RecoveryOperation, confirmation?: string) {
  const pending = loadPendingTransaction(project);
  if (!pending) throw new Error("没有未完成的部署或升级，请刷新维护页");
  if (operation === "resume" && pending.rollbackPending) throw new Error("上次操作已开始回滚，只能完成回滚");
  if (operation === "rollback" && pending.committed) throw new Error("数据已提交，只能继续完成新实例启动和清理");
  const token = confirmTransaction(pending.confirmation, action(operation));
  if (confirmation !== undefined && confirmation !== token) throw new Error("确认后事务或记录已变化，请刷新预览");
  const description = describePendingTransaction(pending);
  return { confirmation: token, scope: pending.confirmation.digest, target: pending.operation === "upgrade" ? pending.targetSha : null,
    summary: [description.subject, ...description.record, operation === "rollback"
      ? pending.rollbackPending ? "从中断处完成已开始的回滚：恢复操作前的数据、配置、代码和运行状态；失败时保留恢复材料。"
        : "恢复操作前的数据、配置、代码和运行状态；失败时保留恢复材料。"
      : pending.committed ? "数据已提交：只继续启动和收尾，不能回滚。" : "沿用已记录的选择继续；不拉取新目标，不重新选择设置。"] };
}

/** Old CLI releases may ignore console choices/guards. Refuse them before scheduling a web lifecycle task. */
export async function assertLifecycleTarget(project: string, target: string, run: Runner = runCommand): Promise<void> {
  if (!/^[a-f0-9]{40}$/.test(target)) throw new Error("目标提交无效");
  const result = await run(["git", "-C", project, "show", `${target}:scripts/lib/console-lifecycle.json`]);
  let capability: { protocol?: string; version?: number } | undefined;
  try { capability = JSON.parse(result.stdout); } catch { /* missing/unknown versions fail closed */ }
  if (result.code !== 0 || capability?.protocol !== "mixin-console-lifecycle" || capability.version !== 1) {
    throw new Error("目标版本不支持此控制台的运维协议，请使用对应版本的命令行继续或回滚");
  }
}
