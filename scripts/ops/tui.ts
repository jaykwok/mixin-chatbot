#!/usr/bin/env bun
import { PROJECT_DIR } from "./tui/platform.ts";
import { recoveryMenu, recoveryReason } from "./tui/recovery.ts";
try {
  process.chdir(PROJECT_DIR);
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("bun run tui — 运维界面；有未完成的部署事务时先提供继续或回滚；没有部署记录的空目录提供部署，" +
      "基础版本字段有效、只是数据格式不受当前代码支持时提供升级检查（应用绑定由目标版本校验），有数据却没有记录、记录损坏或缺字段（含没有程序版本的旧版）时只提供诊断（需在新目录全新部署）");
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
