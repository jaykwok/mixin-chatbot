// Recovery UI intentionally imports no business views, configuration or statistics.
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { inspectDataVersion } from "../../../src/core/data-version.ts";
import { loadDeployment, opsCommand, PROJECT_DIR } from "./platform.ts";

export async function recoveryMenu(detail: string): Promise<void> {
  console.log(`数据维护：${detail}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("请在交互终端运行 bun run tui，或使用 ops update / doctor。");
    process.exitCode = 1;
    return;
  }
  while (true) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let choice: string;
    try { choice = (await rl.question("1 升级（含迁移 / 中断续做）  2 诊断  0 退出\n> ")).trim(); }
    finally { rl.close(); }
    if (choice === "0" || !choice) return;
    if (!["1", "2"].includes(choice)) continue;
    const command = opsCommand(loadDeployment().platform, [choice === "1" ? "update" : "doctor"]);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command.command, command.args, { cwd: PROJECT_DIR, env: { ...process.env, ...command.env }, stdio: "inherit", windowsHide: true });
      child.once("error", reject); child.once("exit", () => resolve());
    });
    const state = inspectDataVersion(PROJECT_DIR, loadDeployment().groupDataRoot);
    console.log(state.detail);
    if (state.current) { console.log("请重新运行 bun run tui 以加载升级后的界面。"); return; }
  }
}
