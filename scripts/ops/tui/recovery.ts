// Recovery UI intentionally imports no business views, configuration or statistics.
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { deploymentRecord, inspectDataVersion, UnsupportedDataFormat } from "../../../src/core/data-version.ts";
import { hostPlatform, loadDeployment, opsCommand, PROJECT_DIR } from "./platform.ts";
import { describePendingTransaction, loadPendingTransaction, type PendingTransaction } from "./transaction.ts";

/**
 * 入口判断：需要恢复菜单时返回原因，否则返回 null。
 * 有未完成的事务时先读记录，普通设置损坏也进入恢复菜单；普通设置留给正常界面加载。
 */
export function recoveryReason(): string | null {
  let pending: PendingTransaction | null;
  try { pending = loadPendingTransaction(); }
  catch (error) { return `事务记录无法读取：${(error as Error).message}`; }
  if (!pending) {
    const state = inspectDataVersion(PROJECT_DIR);
    return state.current ? null : state.detail;
  }
  // 正常界面要加载普通设置；损坏时只能先在恢复菜单里继续或回滚。
  try { loadDeployment(); }
  catch (error) { return `普通设置无法读取（${(error as Error).message}）：先继续或回滚上次操作`; }
  const state = inspectDataVersion(PROJECT_DIR);
  return state.current ? null : state.detail;
}

/**
 * 没有部署记录的空目录先部署。基础版本字段有效、只是数据格式不受当前代码支持时，可由目标升级器检查（应用绑定也由
 * 目标版本校验）；有数据却没有记录、记录损坏或缺字段（含没有程序版本的旧版 webhook 数据）时不在原地升级或覆盖，
 * 只提供诊断（见 docs/data-migrations.md）。
 * 分类沿用部署校验本身的结果，不在这里另做字段检查。
 */
export function dataMenu(project = PROJECT_DIR): { prompt: string; commands: Record<string, string> } {
  try {
    if (deploymentRecord(project) === null) return { prompt: "1 部署  2 诊断  0 退出", commands: { "1": "deploy", "2": "doctor" } };
  } catch (error) {
    if (error instanceof UnsupportedDataFormat) return { prompt: "1 升级（检查数据格式）  2 诊断  0 退出", commands: { "1": "update", "2": "doctor" } };
    console.log("此目录不能原地安装或升级：请在新目录全新部署（docs/data-migrations.md）。");
  }
  return { prompt: "2 诊断  0 退出", commands: { "2": "doctor" } };
}

/** 有未完成的事务时先继续或回滚；否则按部署记录给出部署、升级或诊断。 */
function menu(): { prompt: string; commands: Record<string, string> } {
  let pending: ReturnType<typeof loadPendingTransaction>;
  try { pending = loadPendingTransaction(); }
  catch (error) {
    console.log(`事务记录无法读取：${(error as Error).message}`);
    return { prompt: "1 继续上次操作  2 回滚  3 诊断  0 退出", commands: { "1": "resume", "2": "rollback", "3": "doctor" } };
  }
  if (!pending) return dataMenu();
  const { subject, record } = describePendingTransaction(pending);
  console.log([subject, ...record].join("\n"));
  if (pending.codeRestorePending) {
    console.log("数据、配置和容器已经回滚，只剩代码待恢复：只能完成回滚");
    return { prompt: "2 完成回滚（只恢复代码）  3 诊断  0 退出", commands: { "2": "rollback", "3": "doctor" } };
  }
  if (pending.committed) {
    console.log("数据已经提交：只能继续完成新实例启动和清理");
    return { prompt: "1 继续上次操作  3 诊断  0 退出", commands: { "1": "resume", "3": "doctor" } };
  }
  return { prompt: "1 继续上次操作  2 回滚  3 诊断  0 退出", commands: { "1": "resume", "2": "rollback", "3": "doctor" } };
}

export async function recoveryMenu(detail: string): Promise<void> {
  console.log(`数据维护：${detail}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("请在交互终端运行 bun run tui，或使用 ops resume / rollback / update / doctor。");
    process.exitCode = 1;
    return;
  }
  while (true) {
    const { prompt, commands } = menu();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let choice: string;
    try { choice = (await rl.question(`${prompt}\n> `)).trim(); }
    finally { rl.close(); }
    if (choice === "0" || !choice) return;
    const selected = commands[choice];
    if (!selected) continue;
    const command = opsCommand(hostPlatform(), [selected]);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, command.args, { cwd: PROJECT_DIR, env: { ...process.env, ...command.env }, stdio: "inherit", windowsHide: true });
      child.once("error", reject); child.once("exit", () => resolve());
    });
    const reason = recoveryReason();
    if (!reason) { console.log("请重新运行 bun run tui 以加载升级后的界面。"); return; }
    console.log(reason);
  }
}
