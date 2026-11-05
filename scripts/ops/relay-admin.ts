import { describeAge } from "../lib/age.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { assertExpectedScope, relayScope } from "../lib/operation-scope.ts";
import { relayOptions } from "../lib/relay-options.ts";
// 外链账本只读展示与停机清理；复用 relay 的后端协议，凭据不传入 shell 参数。
import { formatSize } from "@earendil-works/pi-coding-agent";
import {
  checkRelayBackend,
  getRelayConfig,
  listRelayObjects,
  purgeRelayObjects,
  RELAY_CHECK_BYTES,
} from "../../src/integrations/relay.ts";

function usage(): void {
  console.log("用法：bun run relay <命令>");
  console.log("");
  console.log("  list                列出索引里仍在册的外链（旧的排在前面）");
  console.log("  test                上传并删除一个随机测试文件，验收签名、私有访问和删除权限");
  console.log("  purge --all         停机后删除当前后端的全部在册对象，失败或不匹配记录保留");
  console.log("  purge <关键字>      只删除文件名或地址包含该关键字的对象");
}

/** 「3 小时前」比一个 ISO 时间戳更容易判断该不该清掉它。 */

async function list(): Promise<number> {
  const config = getRelayConfig();
  const objects = await listRelayObjects();
  if (objects.length === 0) {
    console.log("索引里没有在册的外链。");
    return 0;
  }
  // 不排成表格：文件名和「3 天前」都可能是中文，按字符数对齐在终端里反而会错位。
  for (const object of objects) {
    const status = object.state === "planned" ? "上传未确认" : "已上传";
    console.log(`${object.name}（${formatSize(object.size)}，${status}，最后更新于 ${describeAge(object.at)}）`);
    console.log(`  ${object.url}`);
    console.log(`  链接到期：${object.expiresAt ?? "未确认"}；计划删除：${object.deleteAfter ?? "上传超时后回收"}`);
  }
  console.log("");
  console.log(`共 ${objects.length} 条。`);
  if (!config) {
    console.log("未配置外链后端；仅展示账本原始地址，无法验证下载或执行清理。");
  } else {
    console.log("链接和删除时间分别固定保存在账本；查看列表不会续期。过期或未确认的对象只展示存储地址，不能据此下载。");
    console.log("到计划删除时间后由后台扫描清理；停机期间需依赖云端生命周期兜底。");
  }
  if (config) console.log("未完成的上传计划超过 31 分钟后可被回收；以上规则仅适用于当前后端。");
  return 0;
}

// 不需要停机：机器人照常运行时检查的正是它实际使用的网络和配置。测试对象先登记账本，中断也会被后台回收。
async function test(): Promise<number> {
  const config = getRelayConfig();
  if (!config) {
    console.error("未配置外链分发（data/config/relay.json 不存在），无法测试。");
    return 1;
  }
  console.log(`正在用 ${formatSize(RELAY_CHECK_BYTES)} 随机测试文件检查外链后端：桶 ${config.bucket}，对象路径 ${config.prefix}日期-UUID/外链自检-*.bin`);
  const labels = { pass: "[通过]", warn: "[注意]", fail: "[失败]" } as const;
  const passed = await checkRelayBackend((status, text) => console.log(`${labels[status]} ${text}`), { config });
  console.log("");
  console.log(passed ? "外链后端检查通过。" : "外链后端检查未通过：请按上面的提示修正云端设置后重试。");
  return passed ? 0 : 1;
}

async function purge(match: string | undefined): Promise<number> {
  const scope = match ? `包含「${match}」的外链` : "全部外链";
  console.log(`正在清理${scope}...`);
  const result = await purgeRelayObjects({ match });

  if (result.matched === 0) {
    console.log("没有匹配的记录，什么都没做。");
    return 0;
  }
  console.log(`匹配 ${result.matched} 条，已删除 ${result.deleted} 个对象。`);
  if (result.orphaned > 0) {
    console.log(
      `${result.orphaned} 条记录不属于当前 S3 后端（换过端点、区域、桶或目录），` +
        "记录已保留；请使用匹配的 S3 配置处理这些对象。"
    );
  }
  if (result.failed > 0) {
    console.log(
      `${result.failed} 条删除失败，索引记录已保留可以重试；` +
        "请检查对象存储连通性和删除权限。"
    );
    return 1;
  }
  return result.orphaned > 0 ? 1 : 0;
}

async function main(args: string[]): Promise<number> {
  const preflight = args[0] === "check", { command, keyword, expected } = relayOptions(preflight ? args.slice(1) : args);
  const check = () => assertExpectedScope(expected, relayScope("data", command === "purge" ? keyword : undefined));
  if (preflight) {
    if (command === "help") throw new Error("预检需要明确的外链动作");
    if (!getRelayConfig()) throw new Error("未配置外链分发（data/config/relay.json 不存在）");
    check(); return 0;
  }
  switch (command) {
    case "list": return list();
    case "test": check(); return test();
    case "purge": return withMaintenance(async () => { check(); return purge(keyword); });
    default: usage(); return 0;
  }
}
process.exit(await main(process.argv.slice(2)).catch(error => { console.error((error as Error).message); return 1; }));
