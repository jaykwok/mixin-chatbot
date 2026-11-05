// Entry decision of the web console: whether only recovery (continue/rollback/diagnose) is possible.
import { inspectDataVersion } from "../../../src/core/data-version.ts";
import { loadDeployment, PROJECT_DIR } from "./platform.ts";
import { loadPendingTransaction, type PendingTransaction } from "./transaction.ts";

/**
 * 入口判断：只能继续、回滚或诊断时返回原因（概览提示到维护页的「部署恢复」处理），否则返回 null。
 * 有未完成的事务时先读记录，普通设置损坏也算在内；普通设置留给正常页面加载。
 */
export function recoveryReason(): string | null {
  let pending: PendingTransaction | null;
  try { pending = loadPendingTransaction(); }
  catch (error) { return `事务记录无法读取：${(error as Error).message}`; }
  if (!pending) {
    const state = inspectDataVersion(PROJECT_DIR);
    return state.current ? null : state.detail;
  }
  // 正常页面要加载普通设置；损坏时只能先在「部署恢复」里继续或回滚。
  try { loadDeployment(); }
  catch (error) { return `普通设置无法读取（${(error as Error).message}）：先继续或回滚上次操作`; }
  const state = inspectDataVersion(PROJECT_DIR);
  return state.current ? null : state.detail;
}
