// 未完成的部署/升级事务：读取指针和快照中的 transaction 记录，供控制台的概览和部署恢复展示。
// 只读投影；实际执行在部署锁内通过同一核心重新校验记录。

import { PROJECT_DIR } from "./platform.ts";
import { loadDeploymentState, type DeploymentState } from "../core/deployment-state.ts";

export type PendingTransaction = Omit<DeploymentState, "dataPhase">;

/** 读取未完成的事务；没有时返回 null，指针或记录无效时抛出。 */
export function loadPendingTransaction(project = PROJECT_DIR): PendingTransaction | null {
  return loadDeploymentState(project);
}

const shortSha = (sha: string | null) => sha ? sha.slice(0, 7) : "（非 git 部署）";
const workspace = (root: string) => root || "data/workspace";

/** 概览和部署恢复预览共用的摘要：标题一行，记录内容逐行。 */
export function describePendingTransaction(pending: PendingTransaction): { subject: string; record: string[] } {
  const kind = pending.operation === "upgrade" ? "升级" : "部署";
  const record = pending.record;
  return {
    subject: `未完成的${kind}：目标提交 ${shortSha(pending.targetSha)}`,
    record: [
      `共享资料目录：${workspace(record.target_workspace_root)}${record.original_workspace_root !== record.target_workspace_root ? `（原 ${workspace(record.original_workspace_root)}）` : ""}`,
      `本机端口 ${record.bot_port}`,
      `原运行状态：${record.was_running === "1" ? "运行" : "停止"}`,
    ],
  };
}
