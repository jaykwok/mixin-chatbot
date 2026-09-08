import { MAX_CALLBACK_ROUTES } from "../../src/core/config.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { forgetCallbackRoute, listCallbackRoutes, resetCallbackRoute } from "../../src/integrations/callback-route.ts";

function usage(): void {
  console.log("用法：bun run routes <命令>");
  console.log("  list                           列出绑定、冲突、完整指纹和容量");
  console.log("  reset <指纹> --group <群号>     修正平台配置并停机后，清除冲突并绑定到指定群");
  console.log("  forget <指纹>                  停机后移除已废弃 key 的绑定，释放容量");
  console.log("指纹可使用日志里的 12 位前缀；有歧义时须提供完整指纹，不需要原始 callback key。");
}

async function main(args: string[]): Promise<void> {
  const [command, fingerprint, flag, group, ...extra] = args;
  if (command === "list" && args.length === 1) {
    const routes = listCallbackRoutes();
    for (const route of routes) {
      console.log(JSON.stringify({ ...route, status: route.conflictingGroupId ? "conflict" : "bound" }));
    }
    console.log(`容量：${routes.length}/${MAX_CALLBACK_ROUTES}；冲突：${routes.filter(route => route.conflictingGroupId).length}`);
    return;
  }
  if (command === "reset" && fingerprint && flag === "--group" && group && !extra.length) {
    await withMaintenance(async () => {
      const route = resetCallbackRoute(fingerprint, group);
      console.log(`已清除冲突并重绑：${route.fingerprint} -> ${JSON.stringify(route.groupId)}`);
    });
    return;
  }
  if (command === "forget" && fingerprint && args.length === 2) {
    await withMaintenance(async () => {
      forgetCallbackRoute(fingerprint);
      console.log("已移除路由并释放容量；若该 key 再次入站，会重新建立绑定。");
    });
    return;
  }
  usage();
  if (command) throw new Error("无法识别的命令或参数");
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
