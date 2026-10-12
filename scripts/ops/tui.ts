#!/usr/bin/env bun
import { PROJECT_DIR } from "./tui/platform.ts";
import { recoveryMenu, recoveryReason } from "./tui/recovery.ts";
try {
  process.chdir(PROJECT_DIR);
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("bun run tui — 运维界面；数据未迁移时仅提供升级 / 诊断");
  } else {
    // 有未完成的事务时先按记录判断，普通设置损坏也能进入继续或回滚。
    const reason = recoveryReason();
    if (reason) await recoveryMenu(reason);
    else process.exitCode = await (await import("./tui/full.ts")).main(args);
  }
} catch (error) {
  // 汇总错误的标题只说明类别，逐条列出原因才看得出是哪一步失败。
  const report = (value: unknown, indent: string): void => {
    console.error(indent + (value instanceof Error ? value.message : String(value)));
    if (value instanceof AggregateError) for (const inner of value.errors) report(inner, indent + "  ");
  };
  report(error, "");
  process.exitCode = 1;
}
