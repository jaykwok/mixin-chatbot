// CLI applies a checked statistics snapshot while holding the service maintenance lease.
import { withMaintenance } from "../../src/core/maintenance.ts";
import { assertExpectedScope, statsFileScope, takeExpected } from "../lib/operation-scope.ts";
import { importLegacyStats } from "./stats-import-core.ts";

async function main(rawArgs: string[]): Promise<number> {
  const { args, expected } = takeExpected(rawArgs);
  if (args.length !== 1 || args[0]!.startsWith("-")) {
    console.log("用法：bun run stat-import <统计账本 stats.sqlite 的路径>");
    console.log("");
    console.log("  schema 2：导入按天、成员的提问数及模型 token 用量；其他字段不导入。");
    console.log("  schema 3：恢复提问及模型、工具用量汇总，只能导入空账本；不会恢复会话。");
    console.log("  需先停止机器人。同一份旧账本重复执行不会重复计入。");
    console.log("  也可在控制台「统计 → 导入统计」上传或填写路径导入；Windows 上 ops.ps1 stat-import 不带路径会弹出文件选择框。");
    return args.length === 0 ? 0 : 1;
  }
  const { result, rows } = await withMaintenance(async () => {
    if (expected !== undefined) assertExpectedScope(expected, statsFileScope(args[0]!));
    return importLegacyStats(args[0]!, undefined, expected);
  });
  const asks = rows.asks.reduce((sum, row) => sum + row.asks, 0);
  console.log(result === "already"
    ? "这份统计已经导入过，未重复计入。"
    : `已导入 ${asks} 次提问（${rows.asks.length} 个成员日）和 ${rows.usage.length} 行 token 用量。`);
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); return 1; }));
}
