import {
  loadAppBotSummary, loadAuxiliarySummary, loadMcpSummary, loadModelSummary, loadRelaySummary,
  type AppBotSummary, type AuxiliarySummary, type McpServerSummary, type ModelSummary, type RelaySummary,
} from "../data.ts";
import { bytes } from "../render/format.ts";
import { spinner } from "../render/widgets.ts";
import type { StatusName } from "../render/theme.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { actionWorkbench, moveSelection } from "./common.ts";
import { LazySetting } from "./settings-state.ts";
import { RuntimeSettingsEditor } from "./runtime-settings.ts";

const ITEMS = ["appbot", "model", "auxiliary", "mcp", "relay", "runtime"] as const;
type ItemId = typeof ITEMS[number];

/** 列表状态的简短说明；未选中时不读取。 */
function brief<T>(state: Loading<T>, ready: (value: T) => string, error = "读取失败"): string {
  return state.kind === "ready" ? ready(state.value) : state.kind === "error" ? error : state.kind === "loading" ? "读取中" : "选中后读取";
}
const mark = (state: Loading<unknown>): StatusName => state.kind === "error" ? "warn" : "idle";

export class SettingsView implements View {
  readonly id = "settings";
  readonly label = "设置";
  private readonly model = new LazySetting<ModelSummary | null>(signal => loadModelSummary(undefined, signal));
  private readonly auxiliary = new LazySetting<AuxiliarySummary>(signal => loadAuxiliarySummary(undefined, signal));
  private readonly mcp = new LazySetting<McpServerSummary[] | null>(signal => loadMcpSummary(undefined, signal));
  private readonly relay = new LazySetting<RelaySummary>(signal => loadRelaySummary(undefined, signal));
  private readonly appBot = new LazySetting<AppBotSummary>(signal => loadAppBotSummary(undefined, signal));
  private readonly runtime = new RuntimeSettingsEditor();
  private editingRuntime = false;
  private selected = 0;

  private get items(): readonly ItemId[] { return ITEMS; }
  private get current(): ItemId { return this.items[Math.min(this.selected, this.items.length - 1)]!; }
  private settings(id: ItemId): { load(app: AppApi, force?: boolean): Promise<void>; onLeave(): boolean }[] {
    return id === "appbot" ? [this.appBot] : id === "model" ? [this.model] : id === "auxiliary" ? [this.auxiliary] : id === "mcp" ? [this.mcp]
      : id === "relay" ? [this.relay] : [this.runtime];
  }
  /** 只保留选中项的读取，其他项的在途读取取消。 */
  private select(id: ItemId, app: AppApi, load = true): void {
    this.selected = this.items.indexOf(id);
    for (const other of this.items) if (other !== id) for (const setting of this.settings(other)) setting.onLeave();
    if (load) for (const setting of this.settings(id)) void setting.load(app);
  }

  hints(): [string, string][] {
    return this.editingRuntime ? this.runtime.hints() : [["↑↓", "选择"], ["Enter", "设置"]];
  }
  hasUnsavedChanges(): boolean { return this.runtime.dirty; }
  activity(): string | null {
    const current = this.current;
    if (this.editingRuntime || current === "runtime") return this.runtime.activity();
    if (current === "appbot" && this.appBot.state.kind === "loading") return "正在读取应用机器人配置…";
    if (current === "model" && this.model.state.kind === "loading") return "正在读取模型配置…";
    if (current === "auxiliary" && this.auxiliary.state.kind === "loading") return "正在读取辅助模型配置…";
    if (current === "mcp" && this.mcp.state.kind === "loading") return "正在读取 MCP 配置…";
    if (current === "relay" && this.relay.state.kind === "loading") return "正在读取外链配置…";
    return null;
  }

  actions(): ViewAction[] {
    if (this.editingRuntime) return this.runtime.actions();
    return [
      { value: "b", label: "应用机器人", description: "填写 AppID 和 AppSecret 并验证；期间机器人暂停" },
      { value: "m", label: "模型配置", description: "运行配置向导，重新选择模型并填写凭证；期间机器人暂停" },
      { value: "e", label: "外链配置", description: "配置私有 S3 存储桶、限时下载和延后清理" },
      { value: "a", label: "高级运行参数", description: "并发、超时、缓存索引、文档处理" },
    ];
  }

  invalidate(): void {
    for (const setting of [this.appBot, this.model, this.auxiliary, this.mcp, this.relay]) setting.invalidate();
    this.runtime.invalidate();
  }
  onLeave(): boolean {
    let pending = false;
    for (const setting of [this.appBot, this.model, this.auxiliary, this.mcp, this.relay, this.runtime]) pending = setting.onLeave() || pending;
    return pending;
  }

  async refresh(app: AppApi): Promise<void> {
    if (this.editingRuntime) return this.runtime.load(app, true);
    await Promise.all(this.settings(this.current).map(setting => setting.load(app, true)));
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    if (this.editingRuntime) {
      const consumed = await this.runtime.onKey(key, app);
      if (key.name === "escape" && !consumed) { this.editingRuntime = false; return true; }
      return consumed;
    }
    const selected = moveSelection(key.name, this.selected, this.items.length);
    if (selected !== null) { this.select(this.items[selected]!, app); return true; }
    if (key.name === "enter") {
      const current = this.current;
      if (current === "auxiliary" || current === "mcp") {
        // 只读状态：重新读取文件，修改方式写在详情里。
        this.select(current, app, false);
        for (const setting of this.settings(current)) void setting.load(app, true);
        app.toast("idle", current === "auxiliary" ? "辅助模型只读：编辑 data/config/auxiliary.json，重启机器人后生效"
          : "MCP 只读：编辑 data/config/mcp.json，重启机器人后生效");
        return true;
      }
      return this.onKey({ name: { appbot: "b", model: "m", relay: "e", runtime: "a" }[current] }, app);
    }
    if (key.name === "a") {
      this.select("runtime", app); this.editingRuntime = true;
      return true;
    }
    if (key.name === "m") return this.configureModel(app);
    if (key.name === "b") return this.configureAppBot(app);
    if (key.name === "e") {
      // 结束后 App 统一失效并刷新当前项，选中外链才能看到新状态。
      this.select("relay", app, false);
      const code = await app.runInteractive("外链配置", ["relay-configure"]);
      if (code === 0) app.toast("ok", "外链配置向导已结束");
      return true;
    }
    return false;
  }

  private async configureAppBot(app: AppApi): Promise<boolean> {
    this.select("appbot", app, false);
    if (!await app.confirm({
      title: "应用机器人", subject: "本实例接收和发送消息所用的开放平台应用",
      steps: [
        "停止正在运行的机器人；已停止时保持停止",
        "填写 AppID、AppSecret 和平台环境，向导取一次应用 token 验证（不连接事件 Stream）",
        "确认后替换应用机器人配置；取消或失败时原配置不变",
        "向导结束后恢复原运行状态；期间群消息由平台保留，恢复后重新投递",
      ],
      untouched: ["会话、统计、模型配置和其他设置"],
      recovery: "换成另一个应用时，通讯录映射随新应用重新同步；可随时再次运行向导改回",
    })) return true;
    const code = await app.runInteractive("应用机器人配置", ["configure-app-bot"]);
    if (code === 0) app.toast("ok", "应用机器人配置向导已结束");
    return true;
  }

  private async configureModel(app: AppApi): Promise<boolean> {
    this.select("model", app, false);
    if (!await app.confirm({
      title: "模型配置", subject: "本实例使用的模型、provider 与凭证",
      steps: [
        "停止正在运行的机器人；已停止时保持停止",
        "运行配置向导：选择 provider 和模型，填写或登录凭证",
        "确认后一起替换模型配置；取消或失败时原配置不变",
        "向导结束后恢复原运行状态；运行中的群消息在此期间不处理",
      ],
      untouched: ["会话、统计、共享资料和其他设置"],
      recovery: "可随时再次运行向导改回；辅助模型引用的模型若不再存在，需同步修改 auxiliary.json",
    })) return true;
    const code = await app.runInteractive("模型配置", ["model-configure"]);
    if (code === 0) app.toast("ok", "模型配置向导已结束");
    return true;
  }

  render(ctx: ViewContext): string[] {
    if (this.editingRuntime) return this.runtime.render(ctx);
    const loading = (state: Loading<unknown>, text: string) => state.kind === "loading" ? [spinner(ctx.theme) + " " + text] : [];
    const failed = (state: Loading<unknown>) => state.kind === "error" ? ["当前：" + state.message] : [];

    const model = this.model.state;
    const modelStatus = brief(model, value => value ? `${value.provider}/${value.model}` : "未配置");
    const auxiliary = this.auxiliary.state;
    const auxiliaryStatus = brief(auxiliary, value => !value.enabled ? "未启用"
      : [value.classifier && "分类", value.image && "图片"].filter(Boolean).join(" + ") || "仅并发设置", "配置无效");
    const mcp = this.mcp.state;
    const mcpStatus = brief(mcp, value => !value ? "未启用" : `${value.length} 台服务器`, "配置无效");
    const relay = this.relay.state;
    const relayStatus = brief(relay, value => value.enabled ? "已启用 · " + value.bucket : "未启用", "配置无效或无法读取");
    const appBot = this.appBot.state;
    const appBotStatus = brief(appBot, value => value.configured ? (value.environment === "staging" ? "已配置 · 预发" : "已配置 · 线上") : "未配置", "配置无效");

    const details: Record<ItemId, () => string[]> = {
      appbot: () => [
        ...loading(appBot, "正在读取应用机器人配置…"), ...failed(appBot),
        ...(appBot.kind === "ready" ? [appBot.value.configured ? `当前：已配置（${appBot.value.environment === "staging" ? "预发环境" : "线上环境"}）；凭据不在界面显示`
          : "当前：未配置；服务拒绝启动"] : []),
        "",
        "消息经开放平台事件 Stream 主动连出接收，不需要入站端口或域名。",
        "AppID 和 AppSecret 在开发者后台「应用信息」中查看；同一应用同时只能有一条 Stream 连接。",
        "运行向导：填写凭据并取一次应用 token 验证，期间机器人停止，结束后恢复原运行状态。",
        "出站需能访问 imtwo.zdxlz.com 与 imfl.zdxlz.com 的 443 端口。",
      ],
      model: () => [
        ...loading(model, "正在读取模型配置…"), ...failed(model),
        ...(model.kind === "ready" ? model.value ? [
          `当前：${model.value.provider}/${model.value.model}`,
          `推理级别：${!model.value.thinking ? "未设置，使用服务默认值" : model.value.thinking.level
            + (model.value.thinking.source === "model" ? "（该模型单独设置）" : "（全局默认）")}；超出模型支持范围时，启动时自动下调`,
        ] : ["当前：未记录所选模型，请运行向导"] : []),
        "",
        "运行模型配置向导：选择 provider 和模型，填写 API key 或登录。",
        "向导期间机器人停止，结束后恢复原运行状态。",
        "确认后一起替换配置；取消或失败不修改。",
        "凭证能否解析由「监控 → 体检」和启动检查确认。",
      ],
      auxiliary: () => [
        ...loading(auxiliary, "正在读取辅助模型配置…"), ...failed(auxiliary),
        ...(auxiliary.kind === "ready" ? !auxiliary.value.enabled ? ["当前：未启用（无 auxiliary.json）"] : [
          `文档分流：${auxiliary.value.classifier ?? "未启用"}`,
          `图片生成：${auxiliary.value.image ?? "未启用"}`,
          `并发上限 ${auxiliary.value.maxConcurrent} · 分类重试 ${auxiliary.value.classifierRetries} 次`,
        ] : []),
        "",
        "可选的文档分流和图片生成模型，引用已配置的模型目录。",
        "只读：编辑 data/config/auxiliary.json，重启机器人后生效。",
        "引用的模型须在模型配置中存在，否则启动检查报错。",
      ],
      mcp: () => [
        ...loading(mcp, "正在读取 MCP 配置…"), ...failed(mcp),
        ...(mcp.kind === "ready" ? !mcp.value ? ["当前：未启用（无 mcp.json）"]
          : mcp.value.map(server => `${server.name} · ${server.transport === "http" ? "HTTP" : "stdio"} · ${server.tools} 个工具${server.oauth ? " · OAuth" : ""}`) : []),
        "",
        "管理员配置的外部工具服务器与工具白名单。",
        "只读：编辑 data/config/mcp.json，重启机器人后生效。",
        ...(mcp.kind === "ready" && mcp.value?.some(server => server.oauth) ? ["OAuth 服务器需停机后登录一次，步骤见 docs/runtime-tools.md。"] : []),
      ],
      relay: () => {
        const current = relay.kind === "ready" ? !relay.value.enabled ? ["当前：未启用；不超过 30 MiB 的文件照常直接发送，更大的文件发送时报错。"] : [
          `当前：已启用 · 桶 ${relay.value.bucket} · 区域 ${relay.value.region}`,
          `端点：${relay.value.endpoint} · ${relay.value.pathStyle ? "Path style" : "Virtual hosted"}`,
          `对象路径：${relay.value.prefix}日期-UUID/原文件名${relay.value.prefix ? "" : "（桶根目录）"}`,
          `下载有效 ${relay.value.expireHours} 小时，再保留 ${relay.value.cleanupGraceMinutes} 分钟后清理；单文件上限 ${bytes(relay.value.maxBytes)}`,
          ...(relay.value.sessionToken ? ["使用临时 Token，需自行续期"] : []),
        ] : [...loading(relay, "正在读取外链配置…"), ...failed(relay)];
        return [
          ...current, ...(current.length ? [""] : []),
          "可选的大文件外链：超过 30 MiB 的文件改发限时下载链接。",
          "填写 S3 端点、区域、桶名及凭据，群成员直接下载。",
          "对象默认放在桶根目录；高级设置可改目录、上限和期限。",
          "保存前预览并确认，取消不修改配置。",
          "确认后重启原本运行中的机器人，已停止时保持停止。",
        ];
      },
      runtime: () => [
        ...(this.runtime.activity() ? [spinner(ctx.theme) + " " + this.runtime.activity()] : []),
        "并发与附件：请求数量、附件上传并发。",
        "超时与退出：整轮、模型、工具、交付与关机时限。",
        "缓存与索引：模型缓存、索引刷新和容量。",
        "文档处理：文档模块、解析环境、默认模板和 LibreOffice。",
        "Enter 进入；修改后按 s 预览并保存。",
        "当前：" + this.runtime.summary,
      ],
    };
    const rows: Record<ItemId, { label: string; summary: string; status: StatusName }> = {
      appbot: { label: "应用机器人", summary: appBotStatus, status: appBot.kind === "ready" && !appBot.value.configured ? "warn" : mark(appBot) },
      model: { label: "模型配置", summary: modelStatus, status: mark(model) },
      auxiliary: { label: "辅助模型", summary: auxiliaryStatus, status: mark(auxiliary) },
      mcp: { label: "MCP 工具", summary: mcpStatus, status: mark(mcp) },
      relay: { label: "外链配置", summary: relayStatus, status: mark(relay) },
      runtime: { label: "高级运行参数", summary: this.runtime.summary, status: this.runtime.dirty ? "warn" : "idle" },
    };
    const notes: Record<ItemId, string> = {
      appbot: "连接状态和通讯录同步：总览；需要外部检查时用「监控 → 体检」",
      model: "首次部署和重新部署也会确认模型；这里只改模型，不改端口和共享资料目录",
      auxiliary: "格式与示例：docs/runtime-tools.md「文档分流与图片生成」",
      mcp: "格式与示例：docs/runtime-tools.md「MCP 外部工具」",
      relay: "测试、查看与清理外链：数据 → 外链",
      runtime: "设置按需读取；显式环境变量优先于保存值，保存时检查冲突",
    };
    const current = this.current;
    return actionWorkbench(ctx, {
      title: "设置", selected: this.items.indexOf(current),
      items: this.items.map(id => rows[id]),
      details: details[current](),
      note: notes[current],
    });
  }
}
