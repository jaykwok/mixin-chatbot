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
function describeAge(at: string): string {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return "时间未知";
  const minutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

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
  }
  console.log("");
  console.log(`共 ${objects.length} 条。`);
  if (!config) {
    console.log("未配置外链后端；仅展示账本原始地址，无法验证下载或执行清理。");
  } else if (!config.expireHours) {
    console.log("未配置 expireHours，本项目不主动过期已上传对象或链接。");
  } else if (config.signSecret) {
    // 上面打印的地址是刚签出来的，跟当初发进群里那条不是同一个 sign，别让人以为链接变了。
    console.log(
      `链接有效期 ${config.expireHours} 小时（上面列出的地址是刚签发的，从现在起算）；` +
        "到期只是签名失效，文件仍留在后端，不会被自动回收——要腾空间用 purge。"
    );
  } else {
    console.log(`有效期 ${config.expireHours} 小时，从上面的时间起算；到期后对象会被自动删除。`);
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
      `${result.orphaned} 条记录的地址与当前 publicBaseUrl 对不上（换过后端或目录），` +
        "记录已保留；请使用原后端配置处理这些对象。"
    );
  }
  if (result.failed > 0) {
    console.log(
      `${result.failed} 条删除失败，索引记录已保留可以重试；` +
        "常见原因是后端不可达或挂载的网盘授权已过期。"
    );
    return 1;
  }
  return result.orphaned > 0 ? 1 : 0;
}

const [command, argument] = process.argv.slice(2);

let exitCode = 0;
switch (command) {
  case "list":
  case "ls":
    exitCode = await list();
    break;
  case "purge":
    // --all 必须显式给出：一条不带参数的 purge 太容易在手滑时清空所有人的下载链接。
    if (argument === "--all") {
      exitCode = await withMaintenance(() => purge(undefined));
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
