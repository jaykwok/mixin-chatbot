import { describeAge } from "../lib/age.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
// 外链账本只读展示与停机清理；复用 relay 的后端协议，凭据不传入 shell 参数。
import { formatSize } from "@earendil-works/pi-coding-agent";
import {
  getRelayConfig,
  listRelayObjects,
  purgeRelayObjects,
} from "../../src/integrations/relay.ts";

function usage(): void {
  console.log("用法：bun run relay <命令>");
  console.log("");
  console.log("  list                列出索引里仍在册的外链（旧的排在前面）");
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

const [command, argument, keyword, ...extra] = process.argv.slice(2);

let exitCode = 0;
switch (command) {
  case "list":
  case "ls":
    exitCode = await list();
    break;
  case "purge":
    if (extra.length || (keyword !== undefined && argument !== "--keyword") || (argument === "--keyword" && !keyword)) {
      console.error("用法：purge --all 或 purge --keyword <关键字>");
      exitCode = 1;
      break;
    }
    // --all 必须显式给出：一条不带参数的 purge 太容易在手滑时清空所有人的下载链接。
    if (argument === "--all") {
      exitCode = await withMaintenance(() => purge(undefined));
    } else if (argument === "--keyword") {
      exitCode = await withMaintenance(() => purge(keyword));
    } else if (argument) {
      exitCode = await withMaintenance(() => purge(argument));
    } else {
      console.error("purge 需要一个关键字，或用 --all 表示清理全部。");
      exitCode = 1;
    }
    break;
  default:
    usage();
    exitCode = command ? 1 : 0;
}
process.exit(exitCode);
