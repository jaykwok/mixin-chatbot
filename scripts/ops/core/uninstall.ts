// Uninstall stays in the entries (the questions, removing the container or the scheduled task, archiving data/); the core
// decides under deploy.lock, which the entry holds for the whole uninstall, whether anything still needs this deployment:
// an unfinished deployment or upgrade (its rollback container, image tag and records), an unfinished ops task or configuration.
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfigurationState } from "../../../src/core/configuration-state.ts";
import { readOpsMaintenanceRecord } from "../../../src/core/ops-maintenance-state.ts";
import { DeploymentBusy, withDeploymentLock } from "./deployment-lock.ts";
import { loadDeploymentState } from "./deployment-state.ts";
import { MaintenanceRefused } from "./maintenance.ts";
import type { OpsResult } from "./result.ts";

/**
 * Linux adopts the entry's descriptor 9 (acquire_deploy_lock). On Windows the entry holds the file open with FileShare.None and
 * names it in BOT_DEPLOY_LOCK_HELD: while it does, nobody else can, so a busy lock at that path is the entry's own.
 */
async function underEntryLock<T>(project: string, env: NodeJS.ProcessEnv, work: () => T): Promise<T> {
  try { return await withDeploymentLock(project, async () => work()); }
  catch (error) {
    if (!(error instanceof DeploymentBusy) || process.platform !== "win32" || !env.BOT_DEPLOY_LOCK_HELD) throw error;
    const held = realpathSync(env.BOT_DEPLOY_LOCK_HELD), own = join(realpathSync(join(project, "data", "state")), "deploy.lock");
    if (held.toLowerCase() !== own.toLowerCase()) throw error;
    return work();
  }
}

export async function checkUninstall(project: string, env: NodeJS.ProcessEnv = process.env): Promise<OpsResult> {
  const base: OpsResult = { protocol: "mixin-ops", version: 1, command: "uninstall", outcome: "failed", exitCode: 1, wasRunning: false, finalState: "unknown", message: "" };
  const root = resolve(project);
  try {
    return await underEntryLock(root, env, () => {
      if (loadDeploymentState(root)) throw new MaintenanceRefused("有未完成的部署或升级：卸载会删除续做和回滚所需的容器与记录；请先继续或回滚，卸载未开始");
      const maintenance = readOpsMaintenanceRecord(root);
      if (maintenance && !maintenance.result) throw new MaintenanceRefused("有未收尾的运维任务；请先用 maintenance-recover 收尾，卸载未开始");
      if (readConfigurationState(root)) throw new MaintenanceRefused("有未结束的配置提交；请先在控制台恢复或收尾，卸载未开始");
      return { ...base, outcome: "success" as const, exitCode: 0, message: "卸载前检查通过：没有未完成的部署、升级、运维任务或配置提交" };
    });
  } catch (error) {
    const refused = error instanceof MaintenanceRefused;
    return { ...base, outcome: refused ? "refused" : "failed", exitCode: refused ? error.exitCode : 1,
      message: error instanceof Error ? `${error.message}${refused ? "" : "；卸载未开始"}` : "卸载前检查失败；卸载未开始" };
  }
}
