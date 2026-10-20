import {
  loadAuxiliarySummary, loadMcpSummary, loadModelSummary, loadRelaySummary, loadTunnelLogging, loadTunnelProtocol,
  type AuxiliarySummary, type McpServerSummary, type ModelSummary, type RelaySummary, type TunnelLogging, type TunnelProtocol,
} from "../data.ts";
import { bytes } from "../render/format.ts";
import { spinner } from "../render/widgets.ts";
import type { StatusName } from "../render/theme.ts";
import type { AppApi, Loading, View, ViewAction, ViewContext } from "../view.ts";
import { actionWorkbench, moveSelection } from "./common.ts";
import { LazySetting } from "./settings-state.ts";
import { RuntimeSettingsEditor } from "./runtime-settings.ts";

const protocolLabels: Record<TunnelProtocol, string> = { auto: "自动（默认）", http2: "HTTP2（TCP）", quic: "QUIC（UDP）" };

type ItemId = "model" | "auxiliary" | "mcp" | "relay" | "tunnel" | "runtime";

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
  private readonly logging = new LazySetting<TunnelLogging>(signal => loadTunnelLogging(undefined, signal));
  private readonly protocol = new LazySetting<TunnelProtocol>(signal => loadTunnelProtocol(undefined, signal));
  private readonly runtime = new RuntimeSettingsEditor();
  private editingRuntime = false;
  private selected = 0;
  /** 直连部署没有隧道，隧道设置不出现；随部署形态刷新。 */
  private cloudflare = true;

  private get items(): ItemId[] {
    return ["model", "auxiliary", "mcp", "relay", ...(this.cloudflare ? ["tunnel" as const] : []), "runtime"];
  }
  private get current(): ItemId { return this.items[Math.min(this.selected, this.items.length - 1)]!; }
  private settings(id: ItemId): { load(app: AppApi, force?: boolean): Promise<void>; onLeave(): boolean }[] {
    return id === "model" ? [this.model] : id === "auxiliary" ? [this.auxiliary] : id === "mcp" ? [this.mcp]
      : id === "relay" ? [this.relay] : id === "tunnel" ? [this.logging, this.protocol] : [this.runtime];
  }
  private sync(cloudflare: boolean): void {
    if (cloudflare === this.cloudflare) return;
    const current = this.current;
    this.cloudflare = cloudflare;
    const index = this.items.indexOf(current);
    this.selected = index >= 0 ? index : 0;
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
    if (current === "model" && this.model.state.kind === "loading") return "正在读取模型配置…";
    if (current === "auxiliary" && this.auxiliary.state.kind === "loading") return "正在读取辅助模型配置…";
    if (current === "mcp" && this.mcp.state.kind === "loading") return "正在读取 MCP 配置…";
    if (current === "relay" && this.relay.state.kind === "loading") return "正在读取外链配置…";
    if (current === "tunnel" && (this.logging.state.kind === "loading" || this.protocol.state.kind === "loading")) return "正在读取隧道设置…";
    return null;
  }

  actions(): ViewAction[] {
    if (this.editingRuntime) return this.runtime.actions();
    return [
      { value: "m", label: "模型配置", description: "运行配置向导，重新选择模型并填写凭证；期间机器人暂停" },
      { value: "e", label: "外链配置", description: "配置私有 S3 存储桶、限时下载和延后清理" },
      ...(this.cloudflare ? [
        { value: "l", label: "隧道日志开关", description: "关闭 / 开启 Cloudflared 日志，默认关闭" },
        { value: "p", label: "隧道连接模式", description: "自动 / HTTP2 / QUIC，默认自动" },
      ] : []),
      { value: "a", label: "高级运行参数", description: "并发、超时、缓存索引、文档处理、日志与诊断" },
    ];
  }

  invalidate(): void {
    for (const setting of [this.model, this.auxiliary, this.mcp, this.relay, this.logging, this.protocol]) setting.invalidate();
    this.runtime.invalidate();
  }
  onLeave(): boolean {
    let pending = false;
    for (const setting of [this.model, this.auxiliary, this.mcp, this.relay, this.logging, this.protocol, this.runtime]) pending = setting.onLeave() || pending;
    return pending;
  }

  async refresh(app: AppApi): Promise<void> {
    this.sync(app.deployment.mode === "cloudflare");
    if (this.editingRuntime) return this.runtime.load(app, true);
    await Promise.all(this.settings(this.current).map(setting => setting.load(app, true)));
  }

  async onKey(key: { name: string }, app: AppApi): Promise<boolean> {
    this.sync(app.deployment.mode === "cloudflare");
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
      if (current === "tunnel") return this.chooseTunnel(app);
      return this.onKey({ name: { model: "m", relay: "e", runtime: "a" }[current] }, app);
    }
    if (key.name === "a") {
      this.select("runtime", app); this.editingRuntime = true;
      return true;
    }
    if (key.name === "m") return this.configureModel(app);
    if (key.name === "e") {
      // 结束后 App 统一失效并刷新当前项，选中外链才能看到新状态。
      this.select("relay", app, false);
      const code = await app.runInteractive("外链配置", ["relay-configure"]);
      if (code === 0) app.toast("ok", "外链配置向导已结束");
      return true;
    }
    if (!this.cloudflare || (key.name !== "l" && key.name !== "p")) return false;
    return key.name === "p" ? this.configureProtocol(app) : this.configureLogging(app);
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
      untouched: ["会话、统计、群目录和其他设置"],
      recovery: "可随时再次运行向导改回；辅助模型引用的模型若不再存在，需同步修改 auxiliary.json",
    })) return true;
    const code = await app.runInteractive("模型配置", ["model-configure"]);
    if (code === 0) app.toast("ok", "模型配置向导已结束");
    return true;
  }

  private async chooseTunnel(app: AppApi): Promise<boolean> {
    const value = await app.choose({
      title: "Cloudflare 隧道",
      choices: [
        { value: "l", label: "隧道日志", description: "关闭 / 开启 Cloudflared 日志，默认关闭" },
        { value: "p", label: "连接模式", description: "自动 / HTTP2 / QUIC，默认自动" },
      ],
    });
    return value === "l" ? this.configureLogging(app) : value === "p" ? this.configureProtocol(app) : true;
  }

  private async configureLogging(app: AppApi): Promise<boolean> {
    this.select("tunnel", app);
    const state = this.logging.state;
    if (state.kind !== "ready") { app.toast("warn", "请等待设置读取完成，读取失败可按 r 重试"); return true; }
    const value = await app.choose({
      title: "Cloudflared 日志", initial: state.value,
      description: "记录隧道连接、请求及回源信息，写入 logs/cloudflared.log 并自动轮转。",
      choices: [{ value: "off", label: "关闭" }, { value: "on", label: "开启" }],
    });
    if ((value !== "off" && value !== "on") || value === state.value) return true;
    if (!await app.confirm({
      title: `${value === "on" ? "开启" : "关闭"} Cloudflared 日志`,
      subject: "本项目的 Cloudflared 隧道",
      steps: [
        value === "on" ? "记录请求、源站响应和连接错误，保存在 logs/cloudflared.log"
          : "停止写入隧道日志，保留已有日志文件",
        "正在运行的隧道会重启，公网访问短暂中断；已停止或未安装时，下次启动生效",
        ...(value === "on" ? ["日志包含完整 URL 和请求头，可能含访问凭据，分享前请脱敏"] : []),
      ],
      recovery: "应用失败会恢复原设置及运行状态；可随时在这里重新切换",
    })) return true;
    await app.run("设置 Cloudflared 日志", ["tunnel-logging", value]);
    // App 已在维护结束后失效并刷新当前项；独立调用时才补一次读取。
    if (this.logging.state === state) void this.logging.load(app, true);
    return true;
  }

  private async configureProtocol(app: AppApi): Promise<boolean> {
    this.select("tunnel", app);
    const state = this.protocol.state;
    if (state.kind !== "ready") { app.toast("warn", "请等待设置读取完成，读取失败可按 r 重试"); return true; }
    const value = await app.choose({
      title: "Cloudflared 连接模式", initial: state.value,
      description: "自动优先 QUIC，无法建立 UDP 连接时回退 HTTP2；UDP 不稳定时可尝试 HTTP2。",
      choices: [
        { value: "auto", label: protocolLabels.auto },
        { value: "http2", label: protocolLabels.http2 },
        { value: "quic", label: protocolLabels.quic },
      ],
    });
    if ((value !== "auto" && value !== "http2" && value !== "quic") || value === state.value) return true;
    if (!await app.confirm({
      title: `连接模式：${protocolLabels[value]}`, subject: "本项目的 Cloudflared 隧道",
      steps: [
        value === "auto" ? "优先 QUIC，无法建立 UDP 连接时回退 HTTP2"
          : value === "http2" ? "固定使用 TCP 7844，适合测试 UDP 路径不稳定的环境"
            : "固定使用 UDP 7844；UDP 不可用时无法通过 HTTP2 回退",
        "正在运行的隧道会重启，公网访问短暂中断；已停止或未安装时，下次启动生效",
      ],
      recovery: "启动失败会尝试恢复原设置及运行状态；网络可用性请结合隧道日志验证，可随时切回自动",
    })) return true;
    await app.run("设置 Cloudflared 连接模式", ["tunnel-protocol", value]);
    if (this.protocol.state === state) void this.protocol.load(app, true);
    return true;
  }

  render(ctx: ViewContext): string[] {
    this.sync(ctx.deployment.mode === "cloudflare");
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
    const logging = this.logging.state, protocol = this.protocol.state;
    const loggingText = brief(logging, value => value === "on" ? "开启" : "关闭");
    const connection = brief(protocol, value => protocolLabels[value]);

    const details: Record<ItemId, () => string[]> = {
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
        const current = relay.kind === "ready" ? !relay.value.enabled ? ["当前：未启用；超过 25 MiB 的文件发送时报错。"] : [
          `当前：已启用 · 桶 ${relay.value.bucket} · 区域 ${relay.value.region}`,
          `端点：${relay.value.endpoint} · ${relay.value.pathStyle ? "Path style" : "Virtual hosted"}`,
          `对象路径：${relay.value.prefix}日期-UUID/原文件名${relay.value.prefix ? "" : "（桶根目录）"}`,
          `下载有效 ${relay.value.expireHours} 小时，再保留 ${relay.value.cleanupGraceMinutes} 分钟后清理；单文件上限 ${bytes(relay.value.maxBytes)}`,
          ...(relay.value.sessionToken ? ["使用临时 Token，需自行续期"] : []),
        ] : [...loading(relay, "正在读取外链配置…"), ...failed(relay)];
        return [
          ...current, ...(current.length ? [""] : []),
          "可选的大文件外链：启用、修改或停用。",
          "填写 S3 端点、区域、桶名及凭据，群成员直接下载。",
          "对象默认放在桶根目录；高级设置可改目录、上限和期限。",
          "保存前预览并确认，取消不修改配置。",
          "确认后重启原本运行中的机器人，已停止时保持停止。",
        ];
      },
      tunnel: () => [
        ...(logging.kind === "loading" || protocol.kind === "loading" ? [spinner(ctx.theme) + " 正在读取隧道设置…"]
          : [`隧道日志：${loggingText}（默认关闭） · 连接模式：${connection}`]),
        ...(logging.kind === "error" ? [logging.message] : []),
        ...(protocol.kind === "error" ? [protocol.message] : []),
        "",
        "隧道日志：记录连接、HTTP 请求及源站响应，写入 logs/cloudflared.log 并自动轮转；可能含访问凭据，分享前请脱敏。",
        "连接模式：自动优先 QUIC 并回退 HTTP2；HTTP2 走 TCP 7844，QUIC 走 UDP 7844。",
        "切换会重启正在运行的隧道；已停止时保持停止。",
      ],
      runtime: () => [
        ...(this.runtime.activity() ? [spinner(ctx.theme) + " " + this.runtime.activity()] : []),
        "并发与附件：请求数量、附件上传并发。",
        "超时与退出：整轮、模型、工具、交付与关机时限。",
        "缓存与索引：模型缓存、索引刷新和容量。",
        "文档处理：文档模块、解析环境、默认模板和 LibreOffice。",
        "日志与诊断：机器人详细日志。",
        "Enter 进入；修改后按 s 预览并保存。",
        "当前：" + this.runtime.summary,
      ],
    };
    const rows: Record<ItemId, { label: string; summary: string; status: StatusName }> = {
      model: { label: "模型配置", summary: modelStatus, status: mark(model) },
      auxiliary: { label: "辅助模型", summary: auxiliaryStatus, status: mark(auxiliary) },
      mcp: { label: "MCP 工具", summary: mcpStatus, status: mark(mcp) },
      relay: { label: "外链配置", summary: relayStatus, status: mark(relay) },
      tunnel: { label: "Cloudflare 隧道", summary: `日志 ${loggingText} · ${connection}`, status: logging.kind === "error" || protocol.kind === "error" ? "warn" : "idle" },
      runtime: { label: "高级运行参数", summary: this.runtime.summary, status: this.runtime.dirty ? "warn" : "idle" },
    };
    const notes: Record<ItemId, string> = {
      model: "首次部署和重新部署也会确认模型；这里只改模型，不改端口、入口和群目录",
      auxiliary: "格式与示例：docs/runtime-tools.md「文档分流与图片生成」",
      mcp: "格式与示例：docs/runtime-tools.md「MCP 外部工具」",
      relay: "测试、查看与清理外链：数据 → 外链",
      tunnel: "查看隧道日志：监控 → 隧道日志；界面显示本机时间，原始文件使用 UTC",
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
