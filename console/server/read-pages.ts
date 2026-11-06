// Read-only host pages. Kept bootstrap-safe; all paths are relative to the chosen deployment, never browser supplied.
import { join } from "node:path";
import { readRelayIndex } from "../../src/integrations/relay-index.ts";
import { loadAppBotSummary, loadAuxiliarySummary, loadLogTail, loadMcpSummary, loadModelSummary, loadRelaySummary,
  loadRuntimeSettings, loadTmp, probeService } from "./data.ts";
import { redactSecrets } from "../../src/lib/redact.ts";
import type { ReadPage } from "../ui/src/contract.ts";
import { serviceView } from "./status.ts";
import { dateTime, spaceLabel } from "../../ops/lib/format.ts";
import { runtimeOption } from "../../ops/core/runtime-options.ts";

export const READ_PAGES = ["logs", "storage", "relay", "directory", "settings"] as const;
export type ReadPageName = typeof READ_PAGES[number];
export interface ReadFilters { keyword?: string; level?: string; task?: string }
const clean = (value: unknown) => redactSecrets(String(value ?? "—")).replace(/\b1[3-9]\d{9}\b/g, number => `${number.slice(0, 3)}****${number.slice(-4)}`);
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// Host local time, as the other pages show their times.
const date = (value: number | string | undefined) => value ? dateTime(value) : "—";
/** Saved at deployment, not on the advanced form; named as the deployment pages name them. */
const DEPLOYMENT_LABELS: Record<string, string> = { BOT_PORT: "本机端口", BOT_HOST: "监听地址", WORKSPACE_ROOT: "共享资料目录" };

type Summaries = [Awaited<ReturnType<typeof loadModelSummary>>, Awaited<ReturnType<typeof loadAuxiliarySummary>>, Awaited<ReturnType<typeof loadAppBotSummary>>,
  Awaited<ReturnType<typeof loadRelaySummary>>, Awaited<ReturnType<typeof loadMcpSummary>>, Awaited<ReturnType<typeof loadRuntimeSettings>>];
/** Each summary as labelled rows. The shared readers return summaries only, never raw credentials or MCP commands. */
function settingRows(index: number, value: Summaries[number]): [string, string][] {
  switch (index) {
    case 0: {
      const model = value as Summaries[0];
      if (!model) return [["模型", "未配置"]];
      const thinking = model.thinking ? `${model.thinking.level}（${model.thinking.source === "model" ? "此模型单独设置" : "全局默认"}）` : "未设置（按模型默认）";
      return [["模型", `${model.provider}/${model.model}`], ["模型 · 推理级别", thinking]];
    }
    case 1: {
      const auxiliary = value as Summaries[1];
      return auxiliary.enabled ? [["辅助模型 · 分类", auxiliary.classifier ?? "未设置"], ["辅助模型 · 识图", auxiliary.image ?? "未设置"],
        ["辅助模型 · 并发上限", String(auxiliary.maxConcurrent)], ["辅助模型 · 分类重试", `${auxiliary.classifierRetries} 次`]] : [["辅助模型", "未启用"]];
    }
    case 2: {
      const app = value as Summaries[2];
      return [["应用机器人", app.configured ? `已配置；环境：${app.environment === "production" ? "正式（production）" : "测试（staging）"}` : "未配置"]];
    }
    case 3: {
      const relay = value as Summaries[3];
      return relay.enabled ? [["外链 · 端点", relay.endpoint], ["外链 · 区域", relay.region], ["外链 · 桶", relay.bucket], ["外链 · 对象目录", relay.prefix || "桶根目录"],
        ["外链 · 寻址方式", relay.pathStyle ? "路径式" : "虚拟主机式"], ["外链 · 单个文件上限", size(relay.maxBytes)], ["外链 · 链接有效期", `${relay.expireHours} 小时`],
        ["外链 · 到期后保留", `${relay.cleanupGraceMinutes} 分钟`], ["外链 · 临时会话令牌", relay.sessionToken ? "已设置" : "未使用"]] : [["外链", "未启用"]];
    }
    case 4: {
      const servers = value as Summaries[4];
      if (!servers) return [["MCP", "未配置"]];
      if (!servers.length) return [["MCP", "没有服务器"]];
      return servers.map(server => [`MCP · ${server.name}`, `${server.transport === "stdio" ? "本地进程" : "HTTP"}；${server.tools} 个工具${server.oauth ? "；需要 OAuth 登录" : ""}`]);
    }
    default: {
      const runtime = value as Summaries[5], entries = Object.entries(runtime.values);
      if (!entries.length) return [["运行参数", "全部使用默认值"]];
      return entries.map(([key, setting]) => {
        const option = runtimeOption(key), shown = option?.choices?.find(choice => choice.value === setting)?.label ?? `${setting}${option?.unit ? " " + option.unit : ""}`;
        return [`运行参数 · ${option?.label ?? DEPLOYMENT_LABELS[key] ?? key}`, shown];
      });
    }
  }
}

export async function readPage(project: string, page: ReadPageName, filters: ReadFilters = {}): Promise<ReadPage> {
  const response: ReadPage = { checkedAt: Date.now(), columns: [], rows: [], note: "手机号和凭据已脱敏。" };
  const data = join(project, "data");
  if (page === "logs") {
    response.columns = ["级别", "内容"];
    const lines = await loadLogTail(4000, 2 * 1024 * 1024, join(project, "logs/mixin-bot.log"));
    response.rows = lines.filter(line => (!filters.level || filters.level === "all" || filters.level === line.level)
      && (!filters.keyword || line.text.includes(filters.keyword)) && (!filters.task || line.text.includes(filters.task)))
      .map(line => [line.level, clean(line.text)]);
    response.note += " 显示最近 2 MB 中最多 4000 行；筛选和导出使用同一范围。";
  } else if (page === "storage") {
    response.columns = ["空间", "成员", "文件", "大小", "最后修改"];
    for (const user of await loadTmp(data)) {
      for (const entry of user.entries) response.rows.push([spaceLabel(clean(user.space)), clean(user.user), clean(entry.name), size(entry.bytes), date(entry.newest)]);
    }
  } else if (page === "relay") {
    response.columns = ["名称", "状态", "大小", "记录时间", "链接到期", "计划删除"];
    response.rows = readRelayIndex(join(data, "state/relay.sqlite")).map(row => [clean(row.name), row.state === "uploaded" ? "已上传" : "上传未确认",
      size(row.size), date(row.at), date(row.expiresAt ?? undefined), date(row.deleteAfter ?? undefined)]);
    response.note += " 外链地址可能含签名，不在列表中输出；查看列表不会延长有效期。";
  } else if (page === "directory") {
    response.columns = ["项目", "状态"];
    const savedPort = await Bun.file(join(data, "state/bot-port")).exists() ? (await Bun.file(join(data, "state/bot-port")).text()).trim() : "1011";
    const port = Number(process.env.BOT_PORT || savedPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("机器人端口无效");
    const service = serviceView(await probeService(port, join(data, "state/instance.json")));
    response.rows = [["服务", service.state === "ready" ? "运行中" : "未就绪"]];
    if (service.directory) {
      const directory = service.directory;
      response.rows.push(["同步范围", clean(directory.scope)], ["当前状态", clean(directory.stateText)], ["在册成员", String(directory.mappings)],
        ["最近完成", date(directory.lastCompleteAt)], ["正在处理", clean(directory.running)], ["错误", clean(directory.failure)], ["自动复核", clean(directory.recheck)]);
    } else response.note += " 机器人未运行或没有返回通讯录状态。";
  } else if (page === "settings") {
    response.columns = ["设置", "当前值"];
    const items = await Promise.allSettled([loadModelSummary(project), loadAuxiliarySummary(project), loadAppBotSummary(project),
      loadRelaySummary(project), loadMcpSummary(project), loadRuntimeSettings(project)]);
    const labels = ["模型", "辅助模型", "应用机器人", "外链配置", "MCP", "运行参数"];
    for (const [index, result] of items.entries()) {
      const label = labels[index]!;
      if (result.status === "rejected") { response.rows.push([label, "配置无法读取，请检查格式和权限"]); continue; }
      const value = result.value;
      if (value === null || value === undefined) { response.rows.push([label, "未配置"]); continue; }
      for (const [name, item] of settingRows(index, value)) response.rows.push([name, clean(item)]);
    }
    response.note += " 已保存的密钥不回显。";
  }
  if (response.rows.length > 4000) { response.rows.length = 4000; response.note += " 列表超过 4000 条，已截断。"; }
  return response;
}
