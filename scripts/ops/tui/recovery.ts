// Recovery UI intentionally imports no business views, configuration or statistics.
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { inspectDataVersion } from "../../../src/core/data-version.ts";
import { hostPlatform, loadDeployment, opsCommand, PROJECT_DIR, type Deployment } from "./platform.ts";
import { describePendingTransaction, loadPendingTransaction, type PendingTransaction } from "./transaction.ts";

/**
 * 入口判断：需要恢复菜单时返回原因，否则返回 null。
 * 有未完成的事务时先读记录：群根取记录，普通设置损坏也进入恢复菜单；普通设置留给正常界面加载。
 */
export function recoveryReason(): string | null {
  let pending: PendingTransaction | null;
  try { pending = loadPendingTransaction(); }
  catch (error) { return `事务记录无法读取：${(error as Error).message}`; }
  if (!pending) {
    const state = inspectDataVersion(PROJECT_DIR, loadDeployment().groupDataRoot);
    return state.current ? null : state.detail;
  }
  // 正常界面要加载普通设置；损坏时只能先在恢复菜单里继续或回滚。
  let saved: Deployment;
  try { saved = loadDeployment(); }
  catch (error) { return `普通设置无法读取（${(error as Error).message}）：先继续或回滚上次操作`; }
  const state = inspectDataVersion(PROJECT_DIR, pending.record?.target_group_root ?? saved.groupDataRoot);
  return state.current ? null : state.detail;
}

/** 有未完成的事务时先继续或回滚；否则由升级完成迁移。 */
function menu(): { prompt: string; commands: Record<string, string> } {
  let pending: ReturnType<typeof loadPendingTransaction>;
  try { pending = loadPendingTransaction(); }
  catch (error) {
    console.log(`事务记录无法读取：${(error as Error).message}`);
    return { prompt: "1 继续上次操作  2 回滚  3 诊断  0 退出", commands: { "1": "resume", "2": "rollback", "3": "doctor" } };
  }
  if (!pending) return { prompt: "1 升级（含迁移）  2 诊断  0 退出", commands: { "1": "update", "2": "doctor" } };
  const { subject, record } = describePendingTransaction(pending);
  console.log([subject, ...record].join("\n"));
  if (pending.codeRestorePending) {
    console.log("数据、配置和容器已经回滚，只剩代码待恢复：只能完成回滚");
    return { prompt: "2 完成回滚（只恢复代码）  3 诊断  0 退出", commands: { "2": "rollback", "3": "doctor" } };
  }
  if (pending.committed) {
    console.log("数据已经提交：只能继续完成新实例启动");
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
