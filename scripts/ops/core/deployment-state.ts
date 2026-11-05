// One captured disk state for the host workflow and the recovery UI. Child stdout is never a commit receipt.
import { readTransaction, type TransactionReadSet } from "../../lib/confirmed-transaction.ts";
import { parseTransactionRecord, TRANSACTION_NAME, type TransactionRecord } from "./transaction-record.ts";
import { parseDeploymentExecution, type DeploymentExecution } from "./deployment-contract.ts";
import { OPS_DEPLOYMENT_FILE, readOpsDeploymentRecord } from "../../../src/core/ops-deployment-state.ts";

export type DeploymentDataPhase = "unprepared" | "prepared" | "committed";
export interface DeploymentState {
  confirmation: TransactionReadSet;
  operation: "deploy" | "upgrade";
  snapshot: string;
  record: TransactionRecord;
  targetSha: string | null;
  dataPhase: DeploymentDataPhase;
  committed: boolean;
  execution?: DeploymentExecution;
  rollbackPending?: boolean;
}

function dataPhase(read: TransactionReadSet, snapshot: string): DeploymentDataPhase {
  const text = read.text("data/state/release-data.json");
  if (text === null) return "unprepared";
  let release: Record<string, unknown>;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== 1
      || typeof value.deployment !== "string" || !TRANSACTION_NAME.test(value.deployment)
      || !["prepared", "committed"].includes(value.phase)
      || value.previous !== null && (!value.previous || typeof value.previous !== "object" || Array.isArray(value.previous)
        || typeof value.previous.appVersion !== "string")) throw new Error();
    release = value;
  } catch { throw new Error("发布状态格式不匹配，不能判定提交边界；事务已保留"); }
  if (release.deployment === snapshot) return release.phase as "prepared" | "committed";
  if (release.phase === "prepared") throw new Error("发布状态属于另一个未完成事务，不能继续或回滚");
  return "unprepared"; // A previous completed deployment is not this transaction's commit.
}

export function loadDeploymentState(project: string): DeploymentState | null {
  const confirmation = readTransaction(project);
  if (!confirmation) {
    const execution = readOpsDeploymentRecord(project);
    if (execution && !execution.completion) throw new Error("部署执行尚未收尾但事务指针缺失，保留现场；不能开始另一部署");
    return null;
  }
  const deploy = confirmation.text("data/state/deploy-transaction")?.trim();
  const upgrade = confirmation.text("data/state/upgrade-transaction")?.trim();
  if (deploy && upgrade && deploy !== upgrade) throw new Error("部署与升级指针不一致，不能选择其中一个执行");
  const snapshot = (upgrade ?? deploy)!;
  const directory = "backup/snapshots/" + snapshot + "/", text = confirmation.text(directory + "transaction");
  if (text === null) throw new Error("事务格式不匹配，请用对应版本完成原操作");
  const record = parseTransactionRecord(text);
  if (record.snapshot !== snapshot) throw new Error("事务记录与快照不一致");
  if (upgrade && record.operation !== "upgrade") throw new Error("升级指针与记录的操作不一致");
  const phase = dataPhase(confirmation, snapshot);
  let execution = parseDeploymentExecution(confirmation.text(OPS_DEPLOYMENT_FILE));
  if (execution && execution.checkpoint.snapshot !== snapshot) {
    if (!execution.completion) throw new Error("存在另一份未收尾的部署执行记录，不能覆盖");
    execution = null;
  }
  if (execution?.result && execution.result.wasRunning !== (record.was_running === "1")) throw new Error("部署执行记录与原运行状态不一致");
  if (execution?.checkpoint.direction === "rollback" && phase === "committed") throw new Error("部署回滚记录与数据提交回执冲突，事务已保留");
  return { confirmation, operation: record.operation as "deploy" | "upgrade", snapshot, record, targetSha: record.target_sha || null,
    dataPhase: phase, committed: phase === "committed", ...(execution ? { execution, rollbackPending: execution.checkpoint.direction === "rollback" } : {}) };
}
