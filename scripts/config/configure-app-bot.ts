#!/usr/bin/env bun
// 应用机器人凭据向导：AppID、AppSecret 和环境（默认线上），写入 data/config/app-bot.json（0600）。
// 保存前取一次应用 token 验证凭据；不连接 Stream（同一应用只能有一条服务连接，不能和运行中的服务抢）。
// 凭据只出现在输入框和配置文件里，不打印、不写日志。
import { cancel, intro, isCancel, log, outro, password, select, text } from "@clack/prompts";
import { dirname, join } from "node:path";
import { publishJson } from "../lib/atomic-file.ts";
import { applicationBinding, readDataVersion, VERSION_FILE } from "../../src/core/data-version.ts";
import { APP_BOT_CONFIG_PATH } from "../../src/core/storage.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { parseAppBotConfig, readAppBotConfig, type AppBotConfig, type PlatformEnvironment } from "../../src/integrations/open-platform/config.ts";

function bail<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("已取消");
    throw new DOMException("配置已取消", "AbortError");
  }
  return value as T;
}

/** 取一次应用 token；失败原因不含凭据。 */
export async function checkAppBotCredentials(config: AppBotConfig): Promise<string | undefined> {
  const client = new PlatformClient(config, { timeoutMs: 15_000, retryDelaysMs: [] });
  try { await client.appToken.get(); return undefined; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
  finally { client.close(); }
}

/** 交互收集并保存；`path` 默认当前目录的 data/config/app-bot.json（重置草稿传草稿里的路径）。 */
export async function configureAppBot(path = APP_BOT_CONFIG_PATH): Promise<AppBotConfig> {
  let previous: AppBotConfig | undefined;
  try { previous = readAppBotConfig(path); }
  catch (error) { log.warn(`现有应用机器人配置无效，将重新填写：${(error as Error).message}`); }
  // The deployment record next to this configuration (data/state); an unreadable one stops the wizard.
  const recorded = readDataVersion(join(dirname(path), "..", "state", VERSION_FILE));
  log.info("在量子密信开放平台的开发者后台「应用信息」中查看 AppID 和 AppSecret。");
  for (;;) {
    const appId = bail<string>(await text({
      message: "AppID", initialValue: previous?.appId ?? "",
      validate: value => { try { parseAppBotConfig({ appId: value?.trim(), appSecret: "placeholder-secret" }); return undefined; } catch (error) { return (error as Error).message; } },
    })).trim();
    const secret = bail<string>(await password({
      message: previous ? "AppSecret（留空沿用已保存的值）" : "AppSecret",
      validate: value => {
        if (!value?.trim()) return previous ? undefined : "不能为空";
        try { parseAppBotConfig({ appId: "abcd", appSecret: value.trim() }); return undefined; } catch (error) { return (error as Error).message; }
      },
    })).trim();
    const environment = bail<PlatformEnvironment>(await select({
      message: "平台环境", initialValue: previous?.environment ?? "production",
      options: [{ value: "production", label: "线上（默认）" }, { value: "staging", label: "预发" }],
    }));
    const config = parseAppBotConfig({ environment, appId, appSecret: secret || previous!.appSecret });
    // 已部署的数据属于登记的应用：这里只能更换同一应用的 AppSecret，不能借改配置把数据交给另一个应用。
    if (recorded && recorded.application !== applicationBinding(config)) {
      log.error("这个目录的数据登记在另一个应用或平台环境下；会话和成员身份不能跨应用沿用。如需改用另一个应用，请在新目录全新部署。");
      previous = config;
      continue;
    }
    log.step("正在用这组凭据获取应用 token…");
    const failure = await checkAppBotCredentials(config);
    if (failure === undefined) log.success("凭据有效。");
    else {
      log.warn(`获取应用 token 失败：${failure}`);
      const next = bail<"retry" | "save">(await select({
        message: "怎么处理？", initialValue: "retry",
        options: [
          { value: "retry", label: "重新填写" },
          { value: "save", label: "仍然保存", hint: "网络暂不可达时可先保存，之后用 doctor 检查" },
        ],
      }));
      if (next === "retry") { previous = config; continue; }
    }
    await publishJson(path, config);
    return config;
  }
}

if (import.meta.main) {
  const draft = process.argv.indexOf("--project");
  const path = draft < 0 ? APP_BOT_CONFIG_PATH : join(process.argv[draft + 1]!, APP_BOT_CONFIG_PATH);
  intro("应用机器人配置");
  withMaintenance(async () => { await configureAppBot(path); outro(`已保存到 ${path}（仅所有者可读）。重启服务后生效。`); }).catch(error => {
    if (error instanceof Error && error.name === "AbortError") { process.exitCode = 2; return; }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
