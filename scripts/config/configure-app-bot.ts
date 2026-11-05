#!/usr/bin/env bun
// 应用机器人凭据向导：AppID、AppSecret 和环境（默认线上），写入 data/config/app-bot.json（0600）。
// 保存前取一次应用 token 验证凭据；不连接 Stream（同一应用只能有一条服务连接，不能和运行中的服务抢）。
// 凭据只出现在输入框和配置文件里，不打印、不写日志。
// --stage <目录>：部署和运维的 configure-app-bot 使用（服务仍在运行，不取维护租约，不改项目文件），只读现有配置作为基准，把回答
// 写进暂存目录的 configuration-app.json（0600），停止服务后由部署或运维核心写入。没有参数时（本地开发）在维护租约下直接写入。
//
// 用法：configure-app-bot.ts [--stage <暂存目录>]
import { cancel, intro, isCancel, log, outro, password, select, text } from "@clack/prompts";
import { dirname, join, resolve } from "node:path";
import { jsonText, publish, publishJson } from "../lib/atomic-file.ts";
import { applicationBinding, readDataVersion, VERSION_FILE } from "../../src/core/data-version.ts";
import { APP_BOT_CONFIG_PATH } from "../../src/core/storage.ts";
import { withMaintenance } from "../../src/core/maintenance.ts";
import { PlatformClient } from "../../src/integrations/open-platform/client.ts";
import { parseAppBotConfig, parseAppBotText, readAppBotConfig, type AppBotConfig, type PlatformEnvironment } from "../../src/integrations/open-platform/config.ts";
import { configurationSnapshot } from "./configuration-form.ts";
import { serializeConfigurationStage, stageName } from "./configuration-stage.ts";

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

/** 现有配置作为输入框的初始值；无效时提示后重新填写。 */
function previousConfig(read: () => AppBotConfig | undefined): AppBotConfig | undefined {
  try { return read(); }
  catch (error) { log.warn(`现有应用机器人配置无效，将重新填写：${(error as Error).message}`); return undefined; }
}

/** 交互收集一组凭据。`binding` 是数据登记的应用（没有部署记录时为 null）：已部署的目录只接受同一应用。 */
async function askAppBot(previous: AppBotConfig | undefined, binding: string | null): Promise<AppBotConfig> {
  log.info("在量子密信开放平台的开发者后台「应用信息」中查看 AppID 和 AppSecret。");
  for (;;) {
    const appId = bail<string>(await text({
      message: "AppID", initialValue: previous?.appId ?? "",
      validate: value => { try { parseAppBotConfig({ appId: value?.trim(), appSecret: "placeholder-secret" }); return undefined; } catch (error) { return (error as Error).message; } },
    })).trim();
    const secret = bail<string>(await password({
      message: previous ? "AppSecret（AppID 和平台环境都不变时可留空，沿用上一次的值）" : "AppSecret",
      validate: value => {
        if (!value?.trim()) return previous ? undefined : "不能为空";
        try { parseAppBotConfig({ appId: "abcd", appSecret: value.trim() }); return undefined; } catch (error) { return (error as Error).message; }
      },
    })).trim();
    const environment = bail<PlatformEnvironment>(await select({
      message: "平台环境", initialValue: previous?.environment ?? "production",
      options: [{ value: "production", label: "线上（默认）" }, { value: "staging", label: "预发" }],
    }));
    // A blank stands for the previous secret of the same application and environment only: never send it to another one.
    if (!secret && (previous!.appId !== appId || previous!.environment !== environment)) {
      log.error("换了 AppID 或平台环境，请填写这组凭据的 AppSecret；上一次的 AppSecret 只用于原来的应用和环境。");
      continue;
    }
    const config = parseAppBotConfig({ environment, appId, appSecret: secret || previous!.appSecret });
    // 已部署的数据属于登记的应用：这里只能更换同一应用的 AppSecret，不能借改配置把数据交给另一个应用。
    if (binding !== null && binding !== applicationBinding(config)) {
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
    return config;
  }
}

/** 交互收集并保存；`path` 默认当前目录的 data/config/app-bot.json（重置草稿传草稿里的路径）。 */
export async function configureAppBot(path = APP_BOT_CONFIG_PATH): Promise<AppBotConfig> {
  const previous = previousConfig(() => readAppBotConfig(path));
  // The deployment record next to this configuration (data/state); an unreadable one stops the wizard.
  const binding = readDataVersion(join(dirname(path), "..", "state", VERSION_FILE))?.application ?? null;
  const config = await askAppBot(previous, binding);
  await publishJson(path, config);
  return config;
}

/** 部署停机前：基准取自项目（受限读取），回答写进暂存目录，项目文件不变。 */
export async function stageAppBot(project: string, stage: string): Promise<AppBotConfig> {
  const base = configurationSnapshot(project, "app"), raw = base.files.app ?? null;
  const config = await askAppBot(previousConfig(() => raw === null ? undefined : parseAppBotText(raw)), base.binding);
  await publish(join(stage, stageName("app")), serializeConfigurationStage({ version: 1, base,
    next: { kind: "app", binding: base.binding, files: { app: jsonText(config) } } }), { createOnly: true });
  return config;
}

/** 严格参数：没有参数或 `--stage <目录>`。 */
export function parseAppBotArgs(argv: readonly string[]): { stage?: string } {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === "--stage" && argv[1] && !argv[1].startsWith("--")) return { stage: argv[1] };
  throw new Error("用法：configure-app-bot.ts [--stage <暂存目录>]");
}

if (import.meta.main) {
  const run = async () => {
    const args = parseAppBotArgs(process.argv.slice(2));
    if (args.stage !== undefined) {
      intro("应用机器人配置（停止服务后写入）");
      await stageAppBot(".", resolve(args.stage));
      outro("已暂存应用机器人配置，停止服务后写入 data/config/app-bot.json（仅所有者可读）。");
      return;
    }
    intro("应用机器人配置");
    await withMaintenance(async () => { await configureAppBot(); outro(`已保存到 ${APP_BOT_CONFIG_PATH}（仅所有者可读）。重启服务后生效。`); });
  };
  run().catch(error => {
    if (error instanceof Error && error.name === "AbortError") { process.exitCode = 2; return; }
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
